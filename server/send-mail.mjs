import express from "express";
import cors from "cors";
import multer from "multer";
import nodemailer from "nodemailer";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  createExpenseDb,
  allocateNextReimbursementCode,
  insertReimbursementSubmission,
  getAllReimbursementsForApi,
  loadSmtpSettings,
  saveSmtpSettings,
  resolveSmtpMerge,
  getFormPresetsForApi,
  listCompanyPresetsForApi,
  listExpenseCategoryPresetsForApi,
  createCompanyPreset,
  createExpenseCategoryPreset,
  updateCompanyPreset,
  updateExpenseCategoryPreset,
} from "./expense-sqlite.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");

const PORT = Number(process.env.PORT) || 3001;
const UPLOAD_DIR = path.resolve(
  process.env.OMNITOOLS_UPLOAD_DIR || path.join(ROOT_DIR, "upload")
);

let expenseDb;
let expenseDbPath;
try {
  const opened = createExpenseDb(ROOT_DIR);
  expenseDb = opened.db;
  expenseDbPath = opened.dbPath;
} catch (err) {
  console.error(
    "FATAL: OmniTools 无法启动邮件 API（SQLite / better-sqlite3）。常见原因：\n" +
      "  1) 未在服务器上本机编译 better-sqlite3：在项目根执行 npm rebuild better-sqlite3（需 build-essential）\n" +
      "  2) data/ 目录无写权限或磁盘已满\n" +
      "  3) 见下方 Node 堆栈"
  );
  console.error(err);
  process.exit(1);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const submitUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function createTransportFromSmtp(smtp) {
  const port = Number(smtp.port) || 587;
  const secure = Boolean(smtp.secure);
  const opts = {
    host: smtp.host,
    port,
    secure,
    ...(smtp.user
      ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } }
      : {}),
  };
  if (!secure && port === 587) {
    opts.requireTLS = true;
  }
  return nodemailer.createTransport(opts);
}

function validateSmtp(smtp) {
  if (!smtp || typeof smtp !== "object") return "缺少 SMTP 配置";
  if (!smtp.host || typeof smtp.host !== "string") return "SMTP 主机无效";
  if (smtp.user && !smtp.pass) return "SMTP 密码缺失";
  return null;
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** 与 expense-sqlite 中 allocateNextReimbursementCode 一致 */
const REIMBURSEMENT_ID_RE = /^EXP\d{6}$/;

function resolvedMergedPdfPath(id) {
  if (!id || typeof id !== "string" || !REIMBURSEMENT_ID_RE.test(id)) {
    return null;
  }
  const resolved = path.resolve(UPLOAD_DIR, id, "merged.pdf");
  const uploadRoot = path.resolve(UPLOAD_DIR);
  const rel = path.relative(uploadRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** 磁盘文件名：保留多语种 Unicode，仅去掉路径与非法字符 */
function sanitizeFilename(name) {
  const raw = (name || "file").trim() || "file";
  const base = raw
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "");
  return base.slice(0, 180) || "file";
}

/**
 * multipart 里 filename 常被误当成 latin1；若整串字节恰好是合法 UTF-8，则还原为 Unicode。
 * 含 BMP 以外字符时视为已正确解析，不再转换。
 */
function normalizeMultipartOriginalFilename(name) {
  if (!name || typeof name !== "string") return name || "file";
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 255) return name;
  }
  const buf = Buffer.from(name, "latin1");
  const decoded = buf.toString("utf8");
  try {
    const reencoded = Buffer.from(decoded, "utf8");
    if (reencoded.equals(buf)) return decoded;
  } catch {
    /* ignore */
  }
  return name;
}

function validateSubmitManifest(manifest, attachmentCount) {
  if (!manifest || typeof manifest !== "object") {
    return "缺少 manifest 元数据";
  }
  if (!manifest.header || typeof manifest.header !== "object") {
    return "manifest.header 无效";
  }
  if (!Array.isArray(manifest.lines) || manifest.lines.length === 0) {
    return "manifest.lines 不能为空";
  }
  let sum = 0;
  for (const line of manifest.lines) {
    const c = Number(line?.attachmentCount);
    if (!Number.isFinite(c) || c < 0) {
      return "明细 attachmentCount 无效";
    }
    sum += c;
  }
  if (sum !== attachmentCount) {
    return `附件数量（${attachmentCount}）与明细 manifest 不一致（期望 ${sum}）`;
  }
  const names = manifest.attachmentFilenames;
  if (Array.isArray(names)) {
    if (names.length !== attachmentCount) {
      return `attachmentFilenames 数量（${names.length}）与附件数（${attachmentCount}）不一致`;
    }
  }
  return null;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));

/** 不访问数据库，用于确认 Node 进程与 Nginx /api 反代是否通 */
app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, service: "omnitools-email", port: PORT });
});

app.get("/api/smtp", (req, res) => {
  try {
    const smtp = loadSmtpSettings(expenseDb);
    if (!smtp) {
      res.json(null);
      return;
    }
    res.json({ ...smtp, pass: "" });
  } catch (err) {
    console.error("GET /api/smtp failed:", err);
    res.status(500).json({ error: "读取 SMTP 配置失败，请查看后端日志。" });
  }
});

app.post("/api/smtp", (req, res) => {
  try {
    const merged = resolveSmtpMerge(expenseDb, req.body || {});
    const errMsg = validateSmtp(merged);
    if (errMsg) {
      res.status(400).json({ error: errMsg });
      return;
    }
    saveSmtpSettings(expenseDb, merged);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/smtp failed:", err);
    res.status(500).json({ error: "保存 SMTP 配置失败，请检查后端日志。" });
  }
});

app.post("/api/test-smtp", async (req, res) => {
  const smtp = resolveSmtpMerge(expenseDb, req.body);
  const errMsg = validateSmtp(smtp);
  if (errMsg) {
    res.status(400).json({ error: errMsg });
    return;
  }
  const to = (smtp.defaultToEmail || smtp.user || "").trim();
  if (!to) {
    res.status(400).json({ error: "请填写默认收件邮箱或 SMTP 用户名（邮箱）" });
    return;
  }
  try {
    const transporter = createTransportFromSmtp(smtp);
    const fromAddr = (smtp.fromEmail || smtp.user || "").trim();
    await transporter.sendMail({
      from: fromAddr || smtp.user,
      to,
      subject: "OmniTools SMTP 测试",
      text: "这是一封来自 OmniTools 的 SMTP 测试邮件。若收到说明配置可用。",
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "发送失败" });
  }
});

app.post(
  "/api/submit-reimbursement",
  submitUpload.fields([
    { name: "pdf", maxCount: 1 },
    { name: "attachments", maxCount: 500 },
  ]),
  async (req, res) => {
    let code = null;
    let dir = null;
    try {
      const pdfPart = req.files?.pdf?.[0];
      if (!pdfPart?.buffer?.length) {
        res.status(400).json({ error: "缺少合并后的 PDF（merged.pdf）" });
        return;
      }
      const attachmentParts = req.files?.attachments || [];
      let manifest;
      try {
        manifest = JSON.parse(req.body?.manifest || "{}");
      } catch {
        res.status(400).json({ error: "manifest 不是合法 JSON" });
        return;
      }
      const errMsg = validateSubmitManifest(manifest, attachmentParts.length);
      if (errMsg) {
        res.status(400).json({ error: errMsg });
        return;
      }

      code = await allocateNextReimbursementCode(expenseDb, UPLOAD_DIR);
      dir = path.join(UPLOAD_DIR, code);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(path.join(dir, "merged.pdf"), pdfPart.buffer);

      const manifestNames = Array.isArray(manifest.attachmentFilenames)
        ? manifest.attachmentFilenames
        : null;
      const receiptFiles = [];
      for (let i = 0; i < attachmentParts.length; i++) {
        const f = attachmentParts[i];
        const fromManifest =
          manifestNames &&
          typeof manifestNames[i] === "string" &&
          manifestNames[i].trim() !== ""
            ? manifestNames[i].trim()
            : null;
        const originalLabel =
          fromManifest ?? normalizeMultipartOriginalFilename(f.originalname || "");
        const safe = sanitizeFilename(originalLabel);
        const fname = `receipt-${String(i + 1).padStart(3, "0")}-${safe}`;
        await fsPromises.writeFile(path.join(dir, fname), f.buffer);
        receiptFiles.push({
          storedFilename: fname,
          originalFilename: originalLabel || fname,
        });
      }

      const lines = manifest.lines.map((line) => ({
        expenseLineId: String(line.expenseLineId),
        date: String(line.date),
        description: String(line.description),
        category: String(line.category),
        lineCurrency: String(line.lineCurrency),
        exchangeRate: Number(line.exchangeRate),
        gst: Number(line.gst),
        grossAmount: Number(line.grossAmount),
        attachmentCount: Number(line.attachmentCount),
      }));

      insertReimbursementSubmission(expenseDb, {
        id: code,
        createdAt: new Date().toISOString(),
        header: manifest.header,
        cashAdvance: Number(manifest.cashAdvance) || 0,
        managerName: String(manifest.managerName ?? ""),
        businessPurpose: String(manifest.businessPurpose ?? ""),
        lines,
        receiptFiles,
      });

      res.json({ ok: true, reimbursementId: code, uploadPath: `upload/${code}` });
    } catch (e) {
      console.error(e);
      if (code && dir) {
        try {
          await fsPromises.rm(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      res.status(500).json({ error: e.message || "保存失败" });
    }
  }
);

/** 后台查看已保存的合并报销 PDF（upload 下各编号目录中的 merged.pdf） */
app.get("/api/reimbursements/:id/merged-pdf", async (req, res) => {
  const abs = resolvedMergedPdfPath(req.params.id);
  if (!abs) {
    res.status(400).json({ error: "无效报销编号" });
    return;
  }
  try {
    await fsPromises.access(abs, fs.constants.R_OK);
  } catch {
    res.status(404).json({ error: "未找到合并 PDF" });
    return;
  }
  const safeName = `${req.params.id}-merged.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${safeName}"`
  );
  fs.createReadStream(abs).pipe(res);
});

app.get("/api/reimbursements", (_req, res) => {
  try {
    const list = getAllReimbursementsForApi(expenseDb);
    res.json({ ok: true, data: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "读取失败" });
  }
});

/** 报销表单下拉：仅启用的公司与类别 */
app.get("/api/form-presets", (_req, res) => {
  try {
    const presets = getFormPresetsForApi(expenseDb);
    res.json({ ok: true, ...presets });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "读取失败" });
  }
});

app.get("/api/profile/companies", (_req, res) => {
  try {
    const items = listCompanyPresetsForApi(expenseDb);
    res.json({ ok: true, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "读取失败" });
  }
});

app.post("/api/profile/companies", (req, res) => {
  try {
    const name = req.body?.name;
    createCompanyPreset(expenseDb, name);
    res.json({ ok: true, items: listCompanyPresetsForApi(expenseDb) });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "保存失败" });
  }
});

app.patch("/api/profile/companies/:id", (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "无效 id" });
      return;
    }
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.active !== undefined) patch.active = Boolean(body.active);
    updateCompanyPreset(expenseDb, id, patch);
    res.json({ ok: true, items: listCompanyPresetsForApi(expenseDb) });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "更新失败" });
  }
});

app.get("/api/profile/expense-categories", (_req, res) => {
  try {
    const items = listExpenseCategoryPresetsForApi(expenseDb);
    res.json({ ok: true, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "读取失败" });
  }
});

app.post("/api/profile/expense-categories", (req, res) => {
  try {
    const name = req.body?.name;
    createExpenseCategoryPreset(expenseDb, name);
    res.json({ ok: true, items: listExpenseCategoryPresetsForApi(expenseDb) });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "保存失败" });
  }
});

app.patch("/api/profile/expense-categories/:id", (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "无效 id" });
      return;
    }
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.active !== undefined) patch.active = Boolean(body.active);
    updateExpenseCategoryPreset(expenseDb, id, patch);
    res.json({ ok: true, items: listExpenseCategoryPresetsForApi(expenseDb) });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "更新失败" });
  }
});

app.post("/api/send-expense-pdf", upload.single("pdf"), async (req, res) => {
  const to = (req.body.to || "").trim();
  let smtp;
  try {
    smtp = JSON.parse(req.body.smtp || "{}");
  } catch {
    res.status(400).json({ error: "SMTP 配置格式无效" });
    return;
  }
  smtp = resolveSmtpMerge(expenseDb, smtp);
  const errMsg = validateSmtp(smtp);
  if (errMsg) {
    res.status(400).json({ error: errMsg });
    return;
  }
  if (!to) {
    res.status(400).json({ error: "缺少收件人邮箱" });
    return;
  }
  if (!req.file?.buffer) {
    res.status(400).json({ error: "缺少 PDF 附件" });
    return;
  }
  const subject = (req.body.subject || "报销单 PDF").trim() || "报销单 PDF";
  const filename = (req.body.filename || "expense.pdf").trim() || "expense.pdf";
  try {
    const transporter = createTransportFromSmtp(smtp);
    const fromAddr = (smtp.fromEmail || smtp.user || "").trim();
    await transporter.sendMail({
      from: fromAddr || smtp.user,
      to,
      subject,
      text: "请查收附件中的合并报销单 PDF。",
      attachments: [{ filename, content: req.file.buffer }],
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "发送失败" });
  }
});

const LISTEN_HOST = process.env.OMNITOOLS_LISTEN_HOST || "127.0.0.1";

const server = app.listen(PORT, LISTEN_HOST, () => {
  console.log(`OmniTools email API listening on http://${LISTEN_HOST}:${PORT}`);
  console.log(`SQLite (SMTP + expense): ${expenseDbPath}`);
  console.log(`Expense uploads directory: ${UPLOAD_DIR}`);
});

server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(
      `FATAL: 端口 ${PORT} 已被占用（EADDRINUSE）。请执行: ss -tlnp | grep :${PORT}` +
        ` 查看进程；或设置环境变量 PORT=其它端口，并同步 Nginx upstream（install.sh 可用 EMAIL_API_PORT=新端口 重装站点配置）。`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
