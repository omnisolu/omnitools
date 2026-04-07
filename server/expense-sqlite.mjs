import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";

const SMTP_SECRET = process.env.SMTP_SECRET || "omnitools-default-secret-please-change";
const ENCRYPTION_KEY = crypto.createHash("sha256").update(SMTP_SECRET).digest();

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

/**
 * 从旧版 server/omnitools.sqlite（sql.js）迁移 SMTP 到本库 app_settings（仅当尚未有 smtp 时）。
 * @param {import("better-sqlite3").Database} db
 * @param {string} rootDir 项目根目录
 */
export function migrateLegacySmtpIfNeeded(db, rootDir) {
  const legacyPath = path.join(rootDir, "server", "omnitools.sqlite");
  if (!fs.existsSync(legacyPath)) return;
  const existing = db.prepare(`SELECT 1 AS ok FROM app_settings WHERE key = 'smtp'`).get();
  if (existing) return;
  let oldDb;
  try {
    oldDb = new Database(legacyPath, { readonly: true, timeout: 5000 });
    const row = oldDb.prepare(`SELECT value FROM settings WHERE key = ?`).get("smtp");
    oldDb.close();
    oldDb = null;
    if (row?.value) {
      db.prepare(`INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)`).run("smtp", row.value);
      try {
        fs.renameSync(legacyPath, `${legacyPath}.migrated.bak`);
      } catch {
        /* 可能无权限重命名，忽略 */
      }
      console.log("Migrated SMTP settings from legacy server/omnitools.sqlite to app database.");
    }
  } catch (e) {
    if (oldDb) {
      try {
        oldDb.close();
      } catch {
        /* ignore */
      }
    }
    console.warn("SMTP legacy migration skipped:", e.message);
  }
}

/**
 * @param {string} rootDir 项目根目录（用于默认 data 路径）
 */
export function createExpenseDb(rootDir) {
  const dbPath = process.env.OMNITOOLS_DB_PATH
    ? path.resolve(process.env.OMNITOOLS_DB_PATH)
    : path.join(rootDir, "data", "omnitools.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reimbursements (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      header_json TEXT NOT NULL,
      cash_advance REAL NOT NULL,
      manager_name TEXT NOT NULL,
      business_purpose TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expense_lines (
      id TEXT PRIMARY KEY,
      reimbursement_id TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      line_currency TEXT NOT NULL,
      exchange_rate REAL NOT NULL,
      gst REAL NOT NULL,
      gross_amount REAL NOT NULL,
      FOREIGN KEY (reimbursement_id) REFERENCES reimbursements(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS expense_line_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_line_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      stored_filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      FOREIGN KEY (expense_line_id) REFERENCES expense_lines(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_exp_lines_reimb ON expense_lines(reimbursement_id);
    CREATE INDEX IF NOT EXISTS idx_exp_att_line ON expense_line_attachments(expense_line_id);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS company_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS expense_category_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_company_presets_sort ON company_presets(sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_exp_cat_presets_sort ON expense_category_presets(sort_order, id);
  `);
  migrateLegacySmtpIfNeeded(db, rootDir);
  seedProfilePresetsIfEmpty(db);
  return { db, dbPath };
}

/** 与 src/company.ts、src/categories.ts 初始列表一致，仅在表为空时写入 */
const DEFAULT_COMPANY_PRESETS = ["Omnisolu", "Metablox"];

const DEFAULT_EXPENSE_CATEGORY_PRESETS = [
  "Advertising",
  "Bank fee",
  "Purchase",
  "AP-VENDOR",
  "subcontractor-labour",
  "Business Meals",
  "Dues",
  "IT Hosting fee",
  "Fuel",
  "Accounting & Legal Fees",
  "License Fees",
  "Marketing",
  "Office Supplies",
  "Packing & Freight",
  "Passport fee",
  "Courier & Postage",
  "Printer Cartridges",
  "Printer Paper",
  "Computer Expenses",
  "Computer equipment",
  "Telephones",
  "Tools",
  "Training Fees",
  "Travel",
  "Other",
];

function seedProfilePresetsIfEmpty(db) {
  const nc = db.prepare(`SELECT COUNT(*) AS c FROM company_presets`).get().c;
  if (nc === 0) {
    const ins = db.prepare(
      `INSERT INTO company_presets (name, sort_order, active) VALUES (?, ?, 1)`
    );
    DEFAULT_COMPANY_PRESETS.forEach((name, i) => ins.run(name, i));
  }
  const nk = db.prepare(`SELECT COUNT(*) AS c FROM expense_category_presets`).get().c;
  if (nk === 0) {
    const ins = db.prepare(
      `INSERT INTO expense_category_presets (name, sort_order, active) VALUES (?, ?, 1)`
    );
    DEFAULT_EXPENSE_CATEGORY_PRESETS.forEach((name, i) => ins.run(name, i));
  }
}

function normName(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {"company" | "category"} kind
 * @param {string} name
 * @param {number} [excludeId]
 */
function activeNameExists(db, kind, name, excludeId) {
  const n = normName(name);
  if (!n) return false;
  const table = kind === "company" ? "company_presets" : "expense_category_presets";
  const row = db
    .prepare(
      `SELECT id FROM ${table} WHERE active = 1 AND lower(name) = lower(?) AND id != ?`
    )
    .get(n, excludeId ?? -1);
  return Boolean(row);
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function getFormPresetsForApi(db) {
  const companies = db
    .prepare(
      `SELECT name FROM company_presets WHERE active = 1 ORDER BY sort_order ASC, id ASC`
    )
    .all()
    .map((r) => r.name);
  const categories = db
    .prepare(
      `SELECT name FROM expense_category_presets WHERE active = 1 ORDER BY sort_order ASC, id ASC`
    )
    .all()
    .map((r) => r.name);
  return { companies, categories };
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function listCompanyPresetsForApi(db) {
  return db
    .prepare(
      `SELECT id, name, sort_order AS sortOrder, active FROM company_presets ORDER BY sort_order ASC, id ASC`
    )
    .all();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function listExpenseCategoryPresetsForApi(db) {
  return db
    .prepare(
      `SELECT id, name, sort_order AS sortOrder, active FROM expense_category_presets ORDER BY sort_order ASC, id ASC`
    )
    .all();
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 */
export function createCompanyPreset(db, name) {
  const n = normName(name);
  if (!n) throw new Error("公司名不能为空");
  if (n.length > 200) throw new Error("公司名过长");
  if (activeNameExists(db, "company", n)) throw new Error("已存在同名的启用公司");
  const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM company_presets`).get();
  const sortOrder = (maxRow?.m ?? -1) + 1;
  const r = db
    .prepare(`INSERT INTO company_presets (name, sort_order, active) VALUES (?, ?, 1)`)
    .run(n, sortOrder);
  return r.lastInsertRowid;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 */
export function createExpenseCategoryPreset(db, name) {
  const n = normName(name);
  if (!n) throw new Error("类别名不能为空");
  if (n.length > 200) throw new Error("类别名过长");
  if (activeNameExists(db, "category", n)) throw new Error("已存在同名的启用类别");
  const maxRow = db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM expense_category_presets`)
    .get();
  const sortOrder = (maxRow?.m ?? -1) + 1;
  const r = db
    .prepare(`INSERT INTO expense_category_presets (name, sort_order, active) VALUES (?, ?, 1)`)
    .run(n, sortOrder);
  return r.lastInsertRowid;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} id
 * @param {{ name?: string, active?: boolean }} patch
 */
export function updateCompanyPreset(db, id, patch) {
  const row = db.prepare(`SELECT id, name, active FROM company_presets WHERE id = ?`).get(id);
  if (!row) throw new Error("记录不存在");
  let name = row.name;
  let active = row.active;
  if (patch.name !== undefined) {
    const n = normName(patch.name);
    if (!n) throw new Error("公司名不能为空");
    if (n.length > 200) throw new Error("公司名过长");
    if (active === 1 || patch.active === true) {
      if (activeNameExists(db, "company", n, id)) throw new Error("已存在同名的启用公司");
    }
    name = n;
  }
  if (patch.active !== undefined) {
    const next = patch.active ? 1 : 0;
    if (next === 1) {
      if (activeNameExists(db, "company", name, id)) throw new Error("已存在同名的启用公司");
    }
    active = next;
  }
  db.prepare(`UPDATE company_presets SET name = ?, active = ? WHERE id = ?`).run(
    name,
    active,
    id
  );
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} id
 * @param {{ name?: string, active?: boolean }} patch
 */
export function updateExpenseCategoryPreset(db, id, patch) {
  const row = db
    .prepare(`SELECT id, name, active FROM expense_category_presets WHERE id = ?`)
    .get(id);
  if (!row) throw new Error("记录不存在");
  let name = row.name;
  let active = row.active;
  if (patch.name !== undefined) {
    const n = normName(patch.name);
    if (!n) throw new Error("类别名不能为空");
    if (n.length > 200) throw new Error("类别名过长");
    if (active === 1 || patch.active === true) {
      if (activeNameExists(db, "category", n, id)) throw new Error("已存在同名的启用类别");
    }
    name = n;
  }
  if (patch.active !== undefined) {
    const next = patch.active ? 1 : 0;
    if (next === 1) {
      if (activeNameExists(db, "category", name, id)) throw new Error("已存在同名的启用类别");
    }
    active = next;
  }
  db.prepare(`UPDATE expense_category_presets SET name = ?, active = ? WHERE id = ?`).run(
    name,
    active,
    id
  );
}

/**
 * 读取 SMTP 配置（密码已解密，供服务端发信使用）。
 * @param {import("better-sqlite3").Database} db
 */
export function loadSmtpSettings(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get("smtp");
  if (!row || row.value == null || row.value === "" || row.value === "undefined") {
    return null;
  }
  try {
    const stored = JSON.parse(row.value);
    if (stored?.pass) {
      try {
        stored.pass = decryptText(stored.pass);
      } catch {
        stored.pass = "";
      }
    }
    return stored;
  } catch (err) {
    console.error("Failed to parse SMTP settings:", err);
    try {
      db.prepare(`DELETE FROM app_settings WHERE key = ?`).run("smtp");
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * 保存 SMTP（密码在库内 AES-GCM 加密存储）。
 * @param {import("better-sqlite3").Database} db
 */
export function saveSmtpSettings(db, settings) {
  const payload = { ...settings };
  if (payload.pass) {
    payload.pass = encryptText(payload.pass);
  }
  const jsonValue = JSON.stringify(payload);
  db.prepare(`INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)`).run("smtp", jsonValue);
}

function smtpStrTrim(s) {
  return String(s ?? "").trim();
}

/**
 * 合并请求体与已存配置（用于测试发信、发 PDF、POST /api/smtp）。
 * 前端加载后密码框恒为空（GET 不返回密码）；若用 { ...stored, ...body } 会把 body.pass=""
 * 覆盖掉已保存密码。当主机/用户名未变且未填写新密码时，应保留库中密码。
 * @param {import("better-sqlite3").Database} db
 */
export function resolveSmtpMerge(db, body) {
  const b = body && typeof body === "object" ? body : {};
  const stored = loadSmtpSettings(db);
  if (!stored) {
    return { ...b };
  }
  const smtp = { ...stored, ...b };
  const hostChanged =
    b.host !== undefined && smtpStrTrim(b.host) !== smtpStrTrim(stored.host);
  const userChanged =
    b.user !== undefined && smtpStrTrim(b.user) !== smtpStrTrim(stored.user);
  const passProvided = b.pass != null && String(b.pass).trim() !== "";
  if (hostChanged || userChanged) {
    smtp.pass = passProvided ? b.pass : "";
  } else if (!passProvided) {
    smtp.pass = stored.pass;
  }
  return smtp;
}

/**
 * 与 upload 目录扫描一致：取当月 EXPYYMMXX 的最大 XX。
 * @param {import("better-sqlite3").Database} db
 * @param {string} uploadDir
 */
export async function allocateNextReimbursementCode(db, uploadDir) {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const prefix = `EXP${yy}${mm}`;
  let max = 0;

  const rows = db.prepare(`SELECT id FROM reimbursements`).all();
  const re = new RegExp(`^EXP(\\d{2})(\\d{2})(\\d{2})$`);
  for (const { id } of rows) {
    const m = re.exec(id);
    if (!m) continue;
    if (m[1] !== yy || m[2] !== mm) continue;
    const n = Number.parseInt(m[3], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }

  try {
    const entries = await fsPromises.readdir(uploadDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const m = re.exec(ent.name);
      if (!m) continue;
      if (m[1] !== yy || m[2] !== mm) continue;
      const n = Number.parseInt(m[3], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  } catch {
    /* upload 目录可能尚不存在 */
  }

  const next = max + 1;
  if (next > 99) {
    throw new Error("本月报销流水号已达上限（99），请联系管理员。");
  }
  return `${prefix}${String(next).padStart(2, "0")}`;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {object} payload
 */
export function insertReimbursementSubmission(db, payload) {
  const {
    id,
    createdAt,
    header,
    cashAdvance,
    managerName,
    businessPurpose,
    lines,
    receiptFiles,
  } = payload;

  const insertR = db.prepare(`
    INSERT INTO reimbursements (id, created_at, header_json, cash_advance, manager_name, business_purpose)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertL = db.prepare(`
    INSERT INTO expense_lines (id, reimbursement_id, line_index, date, description, category, line_currency, exchange_rate, gst, gross_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertA = db.prepare(`
    INSERT INTO expense_line_attachments (expense_line_id, sort_order, stored_filename, original_filename)
    VALUES (?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    insertR.run(
      id,
      createdAt,
      JSON.stringify(header),
      cashAdvance,
      managerName,
      businessPurpose
    );
    let fileOffset = 0;
    lines.forEach((line, lineIndex) => {
      insertL.run(
        line.expenseLineId,
        id,
        lineIndex,
        line.date,
        line.description,
        line.category,
        line.lineCurrency,
        line.exchangeRate,
        line.gst,
        line.grossAmount
      );
      const count = line.attachmentCount;
      for (let k = 0; k < count; k++) {
        const rf = receiptFiles[fileOffset++];
        if (!rf) throw new Error("附件与明细条目不匹配");
        insertA.run(line.expenseLineId, k, rf.storedFilename, rf.originalFilename);
      }
    });
    if (fileOffset !== receiptFiles.length) {
      throw new Error("附件数量与 manifest 不一致");
    }
  });
  run();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function getAllReimbursementsForApi(db) {
  const reimbursements = db
    .prepare(`SELECT * FROM reimbursements ORDER BY created_at DESC`)
    .all();
  const lines = db.prepare(`SELECT * FROM expense_lines ORDER BY reimbursement_id, line_index`).all();
  const attachments = db
    .prepare(`SELECT * FROM expense_line_attachments ORDER BY expense_line_id, sort_order`)
    .all();

  const attByLine = new Map();
  for (const a of attachments) {
    const list = attByLine.get(a.expense_line_id) || [];
    list.push(a);
    attByLine.set(a.expense_line_id, list);
  }

  const linesByReimb = new Map();
  for (const row of lines) {
    const list = linesByReimb.get(row.reimbursement_id) || [];
    list.push(row);
    linesByReimb.set(row.reimbursement_id, list);
  }

  return reimbursements.map((r) => {
    const expRows = (linesByReimb.get(r.id) || []).sort(
      (a, b) => a.line_index - b.line_index
    );
    const expenses = expRows.map((e) => {
      const attRows = attByLine.get(e.id) || [];
      return {
        id: e.id,
        reimbursementId: e.reimbursement_id,
        date: e.date,
        description: e.description,
        category: e.category,
        lineCurrency: e.line_currency,
        exchangeRate: e.exchange_rate,
        gst: e.gst,
        grossAmount: e.gross_amount,
        attachments: attRows.map((a) => ({
          fileName: a.original_filename || a.stored_filename,
          fileType: "application/octet-stream",
        })),
      };
    });
    return {
      reimbursement: {
        id: r.id,
        createdAt: r.created_at,
        header: JSON.parse(r.header_json),
        cashAdvance: r.cash_advance,
        managerName: r.manager_name,
        businessPurpose: r.business_purpose,
      },
      expenses,
    };
  });
}
