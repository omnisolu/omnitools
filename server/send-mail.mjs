import express from "express";
import cors from "cors";
import multer from "multer";
import nodemailer from "nodemailer";
import initSqlJs from "sql.js";
import crypto from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  createExpenseDb,
  allocateNextReimbursementCode,
  insertReimbursementSubmission,
  getAllReimbursementsForApi,
} from "./expense-sqlite.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");

const PORT = Number(process.env.PORT) || 3001;
const UPLOAD_DIR = path.resolve(
  process.env.OMNITOOLS_UPLOAD_DIR || path.join(ROOT_DIR, "upload")
);

/** SMTP 设置（sql.js），与上游一致，位于 server/omnitools.sqlite */
const DB_FILE = path.join(__dirname, "omnitools.sqlite");
const SMTP_SECRET = process.env.SMTP_SECRET || "omnitools-default-secret-please-change";
const ENCRYPTION_KEY = crypto.createHash("sha256").update(SMTP_SECRET).digest();

const SQL = await initSqlJs();

const { db: expenseDb, dbPath: expenseDbPath } = createExpenseDb(ROOT_DIR);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const submitUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function openSmtpDatabase() {
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    return new SQL.Database(buffer);
  }
  return new SQL.Database();
}

function saveSmtpDatabase(db) {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

const smtpDb = openSmtpDatabase();
smtpDb.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
try {
  smtpDb.run("DELETE FROM settings WHERE value IS NULL OR value = ''");
} catch (err) {
  console.error("Failed to clean old settings rows:", err);
}
saveSmtpDatabase(smtpDb);
smtpDb.close();

function encryptText(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptText(value) {
  const parts = value.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload");
  }
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const encrypted = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function getSetting(key) {
  const db = openSmtpDatabase();
  const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const row = stmt.get(key);
  db.close();
  if (!row || row.value == null || row.value === "" || row.value === "undefined") {
    return null;
  }

  try {
    return JSON.parse(row.value);
  } catch (err) {
    console.error(`Failed to parse stored setting for key=${key}:`, err);
    try {
      const cleanupDb = openSmtpDatabase();
      const cleanupStmt = cleanupDb.prepare("DELETE FROM settings WHERE key = ?");
      cleanupStmt.run(key);
      saveSmtpDatabase(cleanupDb);
      cleanupDb.close();
    } catch (cleanupErr) {
      console.error(`Failed to clean invalid stored setting for key=${key}:`, cleanupErr);
    }
    return null;
  }
}

function saveSetting(key, value) {
  const db = openSmtpDatabase();
  const stmt = db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)");
  const jsonValue = value === undefined ? "{}" : JSON.stringify(value);
  stmt.run(key, jsonValue);
  saveSmtpDatabase(db);
  db.close();
}

function saveSmtpSettingsToDisk(settings) {
  const payload = { ...settings };
  if (payload.pass) {
    payload.pass = encryptText(payload.pass);
  }
  saveSetting("smtp", payload);
}

function loadSmtpSettingsFromDisk() {
  const stored = getSetting("smtp");
  if (!stored) return null;
  if (stored.pass) {
    try {
      stored.pass = decryptText(stored.pass);
    } catch {
      stored.pass = "";
    }
  }
  return stored;
}

function resolveSmtp(body) {
  const stored = loadSmtpSettingsFromDisk();
  const smtp = {
    ...stored,
    ...body,
  };

  if (stored && body.host && body.host !== stored.host) {
    smtp.pass = body.pass || "";
  }
  if (stored && body.user && body.user !== stored.user) {
    smtp.pass = body.pass || "";
  }

  return smtp;
}

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

function sanitizeFilename(name) {
  const base = (name || "file").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base.slice(0, 180) || "file";
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
  return null;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));

app.get("/api/smtp", (req, res) => {
  try {
    const smtp = loadSmtpSettingsFromDisk();
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
  const smtp = req.body;
  const stored = loadSmtpSettingsFromDisk();
  const finalSettings = { ...smtp };
  if (!finalSettings.pass && stored && finalSettings.host === stored.host && finalSettings.user === stored.user) {
    finalSettings.pass = stored.pass;
  }
  const errMsg = validateSmtp(finalSettings);
  if (errMsg) {
    res.status(400).json({ error: errMsg });
    return;
  }

  try {
    saveSmtpSettingsToDisk(finalSettings);
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/smtp failed:", err);
    res.status(500).json({ error: "保存 SMTP 配置失败，请检查后端日志。" });
  }
});

app.post("/api/test-smtp", async (req, res) => {
  const smtp = resolveSmtp(req.body);
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

      const receiptFiles = [];
      for (let i = 0; i < attachmentParts.length; i++) {
        const f = attachmentParts[i];
        const safe = sanitizeFilename(f.originalname);
        const fname = `receipt-${String(i + 1).padStart(3, "0")}-${safe}`;
        await fsPromises.writeFile(path.join(dir, fname), f.buffer);
        receiptFiles.push({
          storedFilename: fname,
          originalFilename: f.originalname || fname,
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

app.get("/api/reimbursements", (_req, res) => {
  try {
    const list = getAllReimbursementsForApi(expenseDb);
    res.json({ ok: true, data: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "读取失败" });
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
  smtp = resolveSmtp(smtp);
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`OmniTools email API listening on http://127.0.0.1:${PORT}`);
  console.log(`SMTP settings (sql.js): ${DB_FILE}`);
  console.log(`Expense uploads directory: ${UPLOAD_DIR}`);
  console.log(`Expense SQLite database: ${expenseDbPath}`);
});
