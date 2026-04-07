import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import Database from "better-sqlite3";

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
  `);
  return { db, dbPath };
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
