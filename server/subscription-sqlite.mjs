import crypto from "crypto";

/**
 * 金额以「该币种最小单位」整数存储（如 USD/CAD 均为分），避免浮点误差。
 * CAD → USD 汇总：使用环境变量 OMNITOOLS_FX_CAD_PER_USD（1 USD 兑多少 CAD，默认 1.37）。
 */

const DEFAULT_CAD_PER_USD = 1.37;

export function getCadPerUsd() {
  const raw = process.env.OMNITOOLS_FX_CAD_PER_USD;
  if (raw == null || raw === "") return DEFAULT_CAD_PER_USD;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAD_PER_USD;
}

/**
 * @param {number} amountMinor 该币种分
 * @param {'USD'|'CAD'} currency
 * @returns {number} 折合 USD 的分（四舍五入）
 */
export function amountMinorToUsdMinor(amountMinor, currency) {
  const m = Math.trunc(Number(amountMinor));
  if (!Number.isFinite(m)) return 0;
  if (currency === "USD") return m;
  const cadPerUsd = getCadPerUsd();
  const major = m / 100;
  const usdMajor = major / cadPerUsd;
  return Math.round(usdMajor * 100);
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function ensureSubscriptionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      service_name TEXT NOT NULL,
      project TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      cycle TEXT NOT NULL,
      next_billing_date TEXT NOT NULL,
      card_last_four TEXT NOT NULL,
      card_expiry_mm_yy TEXT,
      company TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subs_next_date ON subscriptions(next_billing_date);
    CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);
  `);
}

/**
 * 已有库补充 company 列（旧版仅有 card_expiry 等）
 * @param {import("better-sqlite3").Database} db
 */
export function migrateSubscriptionSchema(db) {
  const cols = db.prepare(`PRAGMA table_info(subscriptions)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("company")) {
    db.exec(`ALTER TABLE subscriptions ADD COLUMN company TEXT NOT NULL DEFAULT ''`);
  }
}

/**
 * 订阅联系人目录：姓名、别名、邮箱（供新建订阅时选择）
 * @param {import("better-sqlite3").Database} db
 */
export function ensureSubscriptionContactsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_contacts (
      id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      other_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sub_contacts_email ON subscription_contacts(lower(email));
  `);
}

function contactRowToApi(r) {
  return {
    id: r.id,
    userName: r.user_name,
    otherName: r.other_name || "",
    userEmail: r.email,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function listSubscriptionContactsForApi(db) {
  const rows = db
    .prepare(
      `SELECT * FROM subscription_contacts ORDER BY lower(user_name) ASC, lower(email) ASC, id ASC`
    )
    .all();
  return rows.map((r) => contactRowToApi(r));
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {object} body
 */
export function insertSubscriptionContact(db, body) {
  const userName = normStr(body.userName, 200);
  const otherName = normStr(body.otherName ?? body.other_name, 200);
  const email = normStr(body.email ?? body.userEmail, 320);
  if (!userName) throw new Error("姓名不能为空");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("邮箱无效");
  }
  const dup = db
    .prepare(`SELECT id FROM subscription_contacts WHERE lower(email) = lower(?)`)
    .get(email);
  if (dup) throw new Error("该邮箱已在联系人列表中");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO subscription_contacts (id, user_name, other_name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  ).run(id, userName, otherName, email, now, now);
  return contactRowToApi(db.prepare(`SELECT * FROM subscription_contacts WHERE id = ?`).get(id));
}

function normStr(s, max = 500) {
  return String(s ?? "")
    .trim()
    .slice(0, max);
}

/** 仅保留数字，取末四位（卡号不落库完整号码） */
export function sanitizeCardLastFour(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 0) return "";
  return digits.slice(-4).padStart(4, "0").slice(-4);
}

function parseAmountToMinor(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.round(raw * 100);
  }
  const t = String(raw).trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const STATUS = new Set(["active", "paused", "pending"]);
const CURRENCY = new Set(["USD", "CAD"]);
const CYCLE = new Set(["monthly", "yearly"]);

function validateIsoDate(d) {
  if (!d || typeof d !== "string") return "nextBillingDate 无效";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) return "nextBillingDate 须为 YYYY-MM-DD";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, day));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== day
  ) {
    return "nextBillingDate 不是合法日期";
  }
  return null;
}

function rowToApi(r) {
  const currency = r.currency === "CAD" ? "CAD" : "USD";
  const amountMinor = Math.trunc(r.amount_minor);
  const amountUsdMinor = amountMinorToUsdMinor(amountMinor, currency);
  return {
    id: r.id,
    userName: r.user_name,
    userEmail: r.user_email,
    serviceName: r.service_name,
    project: r.project,
    amountMinor,
    currency,
    amountUsdMinor,
    cycle: r.cycle,
    nextBillingDate: r.next_billing_date,
    cardLastFour: r.card_last_four,
    company: r.company != null && r.company !== undefined ? String(r.company) : "",
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function listSubscriptionsForApi(db) {
  const rows = db
    .prepare(`SELECT * FROM subscriptions ORDER BY next_billing_date ASC, id ASC`)
    .all();
  const items = rows.map((r) => rowToApi(r));
  const totalUsdMinor = items.reduce((s, it) => s + it.amountUsdMinor, 0);
  return {
    items,
    summary: {
      totalUsdMinor,
      cadPerUsd: getCadPerUsd(),
      baseCurrency: "USD",
    },
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function getSubscriptionById(db, id) {
  const r = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  return r ? rowToApi(r) : null;
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {object} body
 */
export function insertSubscription(db, body) {
  const userName = normStr(body.userName, 200);
  const userEmail = normStr(body.userEmail, 320);
  const serviceName = normStr(body.serviceName, 200);
  const project = normStr(body.project, 200);
  const currency = CURRENCY.has(body.currency) ? body.currency : "USD";
  const cycle = CYCLE.has(body.cycle) ? body.cycle : null;
  const nextBillingDate = normStr(body.nextBillingDate, 32);
  const cardLastFour = sanitizeCardLastFour(body.cardLastFour);
  const company = normStr(body.company, 200);
  const status = STATUS.has(body.status) ? body.status : "pending";

  if (!userName) throw new Error("userName 不能为空");
  if (!userEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
    throw new Error("userEmail 无效");
  }
  if (!serviceName) throw new Error("serviceName 不能为空");
  if (!project) throw new Error("project 不能为空");
  if (!cycle) throw new Error("cycle 须为 monthly 或 yearly");
  const errD = validateIsoDate(nextBillingDate);
  if (errD) throw new Error(errD);
  const amountMinor = parseAmountToMinor(body.amountMinor ?? body.amount);
  if (amountMinor == null || amountMinor < 0) throw new Error("amount 无效");
  if (cardLastFour.length !== 4) throw new Error("卡号仅保存后四位数字");
  if (!company) throw new Error("Company 不能为空");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO subscriptions (
      id, user_name, user_email, service_name, project,
      amount_minor, currency, cycle, next_billing_date,
      card_last_four, card_expiry_mm_yy, company, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    userName,
    userEmail,
    serviceName,
    project,
    amountMinor,
    currency,
    cycle,
    nextBillingDate,
    cardLastFour,
    null,
    company,
    status,
    now,
    now
  );
  return getSubscriptionById(db, id);
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function updateSubscription(db, id, body) {
  const existing = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!existing) throw new Error("记录不存在");

  const patch = {};
  if (body.userName !== undefined) patch.user_name = normStr(body.userName, 200);
  if (body.userEmail !== undefined) {
    const em = normStr(body.userEmail, 320);
    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error("userEmail 无效");
    patch.user_email = em;
  }
  if (body.serviceName !== undefined) patch.service_name = normStr(body.serviceName, 200);
  if (body.project !== undefined) patch.project = normStr(body.project, 200);
  if (body.amountMinor !== undefined || body.amount !== undefined) {
    const am = parseAmountToMinor(body.amountMinor ?? body.amount);
    if (am == null || am < 0) throw new Error("amount 无效");
    patch.amount_minor = am;
  }
  if (body.currency !== undefined) {
    if (!CURRENCY.has(body.currency)) throw new Error("currency 须为 USD 或 CAD");
    patch.currency = body.currency;
  }
  if (body.cycle !== undefined) {
    if (!CYCLE.has(body.cycle)) throw new Error("cycle 须为 monthly 或 yearly");
    patch.cycle = body.cycle;
  }
  if (body.nextBillingDate !== undefined) {
    const d = normStr(body.nextBillingDate, 32);
    const errD = validateIsoDate(d);
    if (errD) throw new Error(errD);
    patch.next_billing_date = d;
  }
  if (body.cardLastFour !== undefined) {
    const c = sanitizeCardLastFour(body.cardLastFour);
    if (c.length !== 4) throw new Error("卡号仅保存后四位数字");
    patch.card_last_four = c;
  }
  if (body.company !== undefined) {
    const co = normStr(body.company, 200);
    if (!co) throw new Error("Company 不能为空");
    patch.company = co;
  }
  if (body.status !== undefined) {
    if (!STATUS.has(body.status)) throw new Error("status 无效");
    patch.status = body.status;
  }

  if (Object.keys(patch).length === 0) return getSubscriptionById(db, id);

  patch.updated_at = new Date().toISOString();
  const keys = Object.keys(patch);
  const cols = keys.map((k) => `${k} = ?`).join(", ");
  const params = [...keys.map((k) => patch[k]), id];
  db.prepare(`UPDATE subscriptions SET ${cols} WHERE id = ?`).run(...params);
  return getSubscriptionById(db, id);
}

/**
 * 在使用中与已暂停之间切换；若当前为 pending，则切为 active。
 * @param {import("better-sqlite3").Database} db
 */
export function toggleSubscriptionActivePaused(db, id) {
  const existing = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  if (!existing) throw new Error("记录不存在");
  let next;
  if (existing.status === "active") next = "paused";
  else if (existing.status === "paused") next = "active";
  else next = "active";
  return updateSubscription(db, id, { status: next });
}

/**
 * @param {import("better-sqlite3").Database} db
 */
export function deleteSubscription(db, id) {
  const r = db.prepare(`DELETE FROM subscriptions WHERE id = ?`).run(id);
  if (r.changes === 0) throw new Error("记录不存在");
}
