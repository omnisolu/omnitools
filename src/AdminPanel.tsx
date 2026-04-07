import { useEffect, useState } from "react";
import type { ReimbursementRecord, ExpenseLineRecord } from "./records";
import type { SmtpSettings } from "./types";
import {
  fetchReimbursementsFromServer,
  getSmtpSettings,
  reimbursementMergedPdfUrl,
  saveSmtpSettings,
  sendSmtpTestEmail,
} from "./emailApi";
import { normalizeCurrency } from "./currencies";
import { formatIsoDateDisplay, formatIsoDateRange } from "./formatIsoDate";
import ProfileSettings from "./ProfileSettings";

interface AdminPanelProps {
  onClose: () => void;
  /** 公司/类别变更后刷新报销页下拉 */
  onFormPresetsChanged?: () => void;
}

interface ReimbursementWithExpenses {
  reimbursement: ReimbursementRecord;
  expenses: ExpenseLineRecord[];
}

const emptySmtp: SmtpSettings = {
  host: "",
  port: 587,
  secure: false,
  user: "",
  pass: "",
  fromEmail: "",
  defaultToEmail: "",
};

function formatMoney(value: number, currency: string) {
  const code = currency.trim() || "";
  return `${value.toFixed(2)} ${code}`.trim();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function totalBaseAmount(expenses: ExpenseLineRecord[]): number {
  return expenses.reduce((s, e) => s + e.grossAmount * e.exchangeRate, 0);
}

function smtpFromFormState(s: SmtpSettings): SmtpSettings {
  const port = Number(s.port);
  return {
    ...s,
    port: Number.isFinite(port) && port > 0 ? port : 587,
  };
}

export default function AdminPanel({
  onClose,
  onFormPresetsChanged,
}: AdminPanelProps) {
  const [records, setRecords] = useState<ReimbursementWithExpenses[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [smtp, setSmtp] = useState<SmtpSettings>(emptySmtp);
  /** 已从服务端载入且包含有效主机时视为已配置 */
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [smtpLoading, setSmtpLoading] = useState(true);
  const [smtpMessage, setSmtpMessage] = useState<string | null>(null);
  const [smtpSaveBusy, setSmtpSaveBusy] = useState(false);
  const [smtpTestBusy, setSmtpTestBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"report" | "smtp" | "profile">(
    "report"
  );
  /** 报表列表中选中的报销单，null 表示显示列表 */
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const list = await fetchReimbursementsFromServer();
        if (!canceled) {
          setRecords(list);
        }
      } catch (err) {
        if (!canceled) {
          setError((err as Error)?.message || "读取数据失败");
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    async function loadSmtp() {
      setSmtpLoading(true);
      setSmtpMessage(null);
      try {
        const saved = await getSmtpSettings();
        if (canceled) return;
        if (saved) {
          setSmtp(saved);
          setSmtpConfigured(Boolean(saved.host?.trim()));
        } else {
          setSmtp(emptySmtp);
          setSmtpConfigured(false);
        }
      } catch (e) {
        if (!canceled) {
          setSmtp(emptySmtp);
          setSmtpConfigured(false);
          setSmtpMessage((e as Error)?.message || "无法从服务器加载 SMTP 配置。");
        }
      } finally {
        if (!canceled) {
          setSmtpLoading(false);
        }
      }
    }
    loadSmtp();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "report") {
      setDetailId(null);
    }
  }, [activeTab]);

  function patchSmtp<K extends keyof SmtpSettings>(key: K, value: SmtpSettings[K]) {
    setSmtp((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSaveSmtp() {
    const cfg = smtpFromFormState(smtp);
    if (!cfg.host.trim()) {
      setSmtpMessage("请填写 SMTP 主机。");
      return;
    }
    setSmtpSaveBusy(true);
    setSmtpMessage(null);
    try {
      await saveSmtpSettings(cfg);
      setSmtp(cfg);
      setSmtpConfigured(Boolean(cfg.host?.trim()));
      setSmtpMessage("SMTP 已保存到 SQLite（data/omnitools.sqlite）。您可以继续发送测试邮件。");
    } catch (e) {
      setSmtpMessage((e as Error)?.message || "保存失败");
    } finally {
      setSmtpSaveBusy(false);
    }
  }

  async function handleTestSmtp() {
    const cfg = smtpFromFormState(smtp);
    if (!cfg.host.trim()) {
      setSmtpMessage("请先填写 SMTP 主机并保存。");
      return;
    }
    const toHint = cfg.defaultToEmail.trim() || cfg.user.trim();
    if (!toHint) {
      setSmtpMessage("请填写「默认收件邮箱」或 SMTP 用户名（邮箱），以便接收测试邮件。");
      return;
    }
    setSmtpTestBusy(true);
    setSmtpMessage(null);
    try {
      await sendSmtpTestEmail(cfg);
      setSmtpMessage("测试邮件已发送，请查收收件箱或垃圾邮件。");
    } catch (e) {
      setSmtpMessage(
        (e as Error)?.message ||
          "发送失败。请确认已用 npm run dev 启动（含邮件 API），并检查 SMTP 与网络。"
      );
    } finally {
      setSmtpTestBusy(false);
    }
  }

  function renderReimbursementDetail({
    reimbursement,
    expenses,
  }: ReimbursementWithExpenses) {
    return (
      <div className="admin-record">
        <div className="admin-record-header">
          <div className="admin-record-header-row">
            <div>
              <p className="admin-record-meta">
                提交时间：{formatDate(reimbursement.createdAt)}
              </p>
              <h3 className="admin-record-title">
                {reimbursement.header.employeeName} 的报销单
              </h3>
            </div>
            <a
              className="btn btn--primary btn--sm admin-record-pdf-link"
              href={reimbursementMergedPdfUrl(reimbursement.id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看合并 PDF
            </a>
          </div>
          <div className="admin-record-summary">
            <span>{reimbursement.header.department}</span>
            <span>{reimbursement.header.companyName}</span>
            <span>{reimbursement.header.baseCurrency}</span>
          </div>
        </div>

        <div className="admin-fields">
          <div className="admin-field">
            <strong>编号</strong>
            <span>{reimbursement.id}</span>
          </div>
          <div className="admin-field">
            <strong>期间</strong>
            <span>
              {formatIsoDateRange(
                reimbursement.header.periodFrom,
                reimbursement.header.periodTo
              )}
            </span>
          </div>
          <div className="admin-field">
            <strong>经理</strong>
            <span>{reimbursement.managerName || "（未填写）"}</span>
          </div>
          <div className="admin-field">
            <strong>预支抵扣</strong>
            <span>
              {formatMoney(
                reimbursement.cashAdvance,
                reimbursement.header.baseCurrency
              )}
            </span>
          </div>
          <div className="admin-field admin-field-full">
            <strong>事由</strong>
            <span>{reimbursement.businessPurpose || "（未填写）"}</span>
          </div>
        </div>

        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>类别</th>
                <th>说明</th>
                <th>币种</th>
                <th>汇率</th>
                <th>含税金额</th>
                <th>本位币</th>
                <th>附件</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id}>
                  <td>{formatIsoDateDisplay(expense.date)}</td>
                  <td>{expense.category}</td>
                  <td>{expense.description}</td>
                  <td>{expense.lineCurrency}</td>
                  <td className="num">{expense.exchangeRate.toFixed(4)}</td>
                  <td className="num">{expense.grossAmount.toFixed(2)}</td>
                  <td className="num">
                    {(expense.grossAmount * expense.exchangeRate).toFixed(2)}
                  </td>
                  <td>
                    {expense.attachments.map((a) => a.fileName).join("； ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const reportView = (
    <>
      {!smtpLoading && !smtpConfigured ? (
        <p className="admin-smtp-banner" role="status">
          尚未配置 SMTP：请切换到左侧「SMTP 设置」填写邮件服务器并保存，否则无法在报销页发送合并 PDF。
        </p>
      ) : null}
      {loading ? (
        <div className="admin-empty">正在加载提交记录…</div>
      ) : error ? (
        <div className="admin-empty">读取失败：{error}</div>
      ) : records.length === 0 ? (
        <div className="admin-empty">当前尚未保存任何报销单。</div>
      ) : detailId ? (
        (() => {
          const entry = records.find((r) => r.reimbursement.id === detailId);
          if (!entry) {
            return (
              <div className="admin-empty">
                <p>未找到该记录。</p>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setDetailId(null)}
                >
                  返回列表
                </button>
              </div>
            );
          }
          return (
            <>
              <div className="admin-report-detail-toolbar">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => setDetailId(null)}
                >
                  返回列表
                </button>
              </div>
              {renderReimbursementDetail(entry)}
            </>
          );
        })()
      ) : (
        <div className="table-wrap">
          <table className="admin-table admin-report-list">
            <thead>
              <tr>
                <th>编号</th>
                <th>提交人</th>
                <th>币种</th>
                <th className="num">金额</th>
                <th className="admin-report-actions-col" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {records.map(({ reimbursement, expenses }) => {
                const base = normalizeCurrency(reimbursement.header.baseCurrency);
                const total = totalBaseAmount(expenses);
                return (
                  <tr key={reimbursement.id}>
                    <td>
                      <code className="admin-code">{reimbursement.id}</code>
                    </td>
                    <td>{reimbursement.header.employeeName.trim() || "—"}</td>
                    <td>{base || "—"}</td>
                    <td className="num">{total.toFixed(2)}</td>
                    <td className="admin-report-actions-cell">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setDetailId(reimbursement.id)}
                      >
                        VIEW
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  const smtpView = (
    <div className="admin-smtp">
      <h3 className="admin-smtp-title">邮件发送（SMTP）</h3>
      <p className="card-hint admin-smtp-hint">
        浏览器无法直接连接 SMTP；开发时运行{" "}
        <code className="admin-code">npm run dev</code>{" "}
        会同时启动前端与邮件 API。配置保存在服务端{" "}
        <code className="admin-code">data/omnitools.sqlite</code>（与报销数据同一库），密码使用 AES-GCM
        加密存储。生产环境建议由 Nginx 将{" "}
        <code className="admin-code">/api</code> 反代到该服务。
      </p>
      {!smtpLoading && !smtpConfigured ? (
        <p className="admin-smtp-banner" role="alert">
          当前<strong>没有</strong>有效的 SMTP 配置。请填写下方表单并点击「保存 SMTP」。
        </p>
      ) : null}
      {smtpLoading ? (
        <p className="admin-empty admin-smtp-inner">正在加载 SMTP 配置…</p>
      ) : (
        <div className="field-grid admin-smtp-inner">
          <label className="field field-span-2">
            <span className="field-label">SMTP 主机</span>
            <input
              className="field-input"
              value={smtp.host}
              onChange={(e) => patchSmtp("host", e.target.value)}
              placeholder="如 smtp.example.com"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field-label">端口</span>
            <input
              className="field-input"
              inputMode="numeric"
              value={smtp.port === 0 ? "" : String(smtp.port)}
              onChange={(e) => {
                const t = e.target.value.trim();
                if (t === "") {
                  patchSmtp("port", 0);
                  return;
                }
                const n = Number.parseInt(t, 10);
                patchSmtp("port", Number.isFinite(n) ? n : smtp.port);
              }}
              placeholder="587 或 465"
            />
          </label>
          <label className="field admin-smtp-check">
            <span className="field-label">SSL/TLS（465 常选）</span>
            <input
              type="checkbox"
              checked={smtp.secure}
              onChange={(e) => patchSmtp("secure", e.target.checked)}
            />
          </label>
          <label className="field field-span-2">
            <span className="field-label">用户名（通常即邮箱）</span>
            <input
              className="field-input"
              value={smtp.user}
              onChange={(e) => patchSmtp("user", e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="field field-span-2">
            <span className="field-label">密码 / 应用专用密码</span>
            <input
              className="field-input"
              type="password"
              value={smtp.pass}
              onChange={(e) => patchSmtp("pass", e.target.value)}
              autoComplete="current-password"
              placeholder="加载后不显示已存密码；不改主机/用户名时留空仍会使用已保存密码"
            />
          </label>
          <p className="card-hint admin-smtp-pass-hint field-span-2">
            出于安全，接口不会在页面上回填密码；若已在服务器保存过，测试发信与保存（主机、用户名未变）会使用库内密码。若修改了 SMTP
            主机或用户名，请重新输入密码。
          </p>
          <label className="field field-span-2">
            <span className="field-label">发件人 From（邮箱）</span>
            <input
              className="field-input"
              value={smtp.fromEmail}
              onChange={(e) => patchSmtp("fromEmail", e.target.value)}
              placeholder="可与用户名相同"
            />
          </label>
          <label className="field field-span-2">
            <span className="field-label">默认收件邮箱（发给自己）</span>
            <input
              className="field-input"
              type="email"
              value={smtp.defaultToEmail}
              onChange={(e) => patchSmtp("defaultToEmail", e.target.value)}
              placeholder="留空则在发送时再输入"
            />
          </label>
          <div className="field field-span-2 admin-smtp-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={smtpSaveBusy}
              onClick={() => void handleSaveSmtp()}
            >
              {smtpSaveBusy ? "保存中（连接邮件 API）…" : "保存 SMTP"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={smtpTestBusy}
              onClick={() => void handleTestSmtp()}
            >
              {smtpTestBusy ? "发送中…" : "发送测试邮件"}
            </button>
          </div>
          {smtpMessage ? (
            <p className="admin-smtp-msg field-span-2" role="status">
              {smtpMessage}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );

  return (
    <section className="admin-page">
      <aside className="admin-sidebar card">
        <div className="admin-sidebar-title">管理菜单</div>
        <button
          type="button"
          className={`admin-sidebar-button ${activeTab === "report" ? "active" : ""}`}
          onClick={() => setActiveTab("report")}
        >
          Expense Reim Report
        </button>
        <button
          type="button"
          className={`admin-sidebar-button ${activeTab === "smtp" ? "active" : ""}`}
          onClick={() => setActiveTab("smtp")}
        >
          SMTP 设置
        </button>
        <button
          type="button"
          className={`admin-sidebar-button ${activeTab === "profile" ? "active" : ""}`}
          onClick={() => setActiveTab("profile")}
        >
          Profile Setting
        </button>
      </aside>
      <div className="admin-main">
        <section className="card admin-main-card">
          <div className="admin-header admin-main-header">
            <div>
              <h2 className="card-title">
                {activeTab === "report"
                  ? "后台提交记录"
                  : activeTab === "smtp"
                    ? "SMTP 设置"
                    : "Profile Setting"}
              </h2>
              <p className="card-hint">
                {activeTab === "report"
                  ? "查看已提交到服务端 SQLite 的报销单及明细。"
                  : activeTab === "smtp"
                    ? "配置 SMTP 后可将合并 PDF 发到邮箱。"
                    : "维护公司列表与费用类别；启用项会出现在报销表单的下拉中。"}
              </p>
            </div>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              返回报销表单
            </button>
          </div>
          {activeTab === "report"
            ? reportView
            : activeTab === "smtp"
              ? smtpView
              : (
                  <ProfileSettings onFormPresetsChanged={onFormPresetsChanged} />
                )}
        </section>
      </div>
    </section>
  );
}
