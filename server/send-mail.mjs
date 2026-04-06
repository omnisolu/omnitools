import express from "express";
import cors from "cors";
import multer from "multer";
import nodemailer from "nodemailer";

const PORT = Number(process.env.PORT) || 3001;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));

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
  return null;
}

app.post("/api/test-smtp", async (req, res) => {
  const errMsg = validateSmtp(req.body);
  if (errMsg) {
    res.status(400).json({ error: errMsg });
    return;
  }
  const smtp = req.body;
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

app.post("/api/send-expense-pdf", upload.single("pdf"), async (req, res) => {
  const to = (req.body.to || "").trim();
  let smtp;
  try {
    smtp = JSON.parse(req.body.smtp || "{}");
  } catch {
    res.status(400).json({ error: "SMTP 配置格式无效" });
    return;
  }
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
});
