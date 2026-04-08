import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { formatIsoDateDisplay } from "./formatIsoDate";
import {
  createSubscription,
  deleteSubscription,
  fetchSubscriptions,
  patchSubscription,
  sendSubscriptionReminder,
  toggleSubscriptionStatus,
} from "./subscriptionApi";
import type {
  CreateSubscriptionRequest,
  Subscription,
  SubscriptionCurrency,
  SubscriptionCycle,
  SubscriptionStatus,
} from "./subscriptionTypes";

const SERVICE_PRESETS = ["Cursor", "Claude", "Windsurf", "OpenAI"];
const PROJECT_PRESETS = ["Polyflow", "Pelago", "Roam"];

function formatMinorMajor(minor: number): string {
  return (Math.trunc(minor) / 100).toFixed(2);
}

function cycleLabel(c: SubscriptionCycle): string {
  return c === "monthly" ? "月付" : "年付";
}

function statusLabel(s: SubscriptionStatus): string {
  if (s === "active") return "使用中";
  if (s === "paused") return "已暂停";
  return "申请中";
}

/** 仅保留数字并取末四位，不落库完整卡号 */
function sanitizeCardLastFourInput(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.slice(-4);
}

function parseAmountToMinor(raw: string): number | null {
  const t = raw.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

const emptyForm = {
  userName: "",
  userEmail: "",
  serviceName: "",
  project: "",
  amountStr: "",
  currency: "USD" as SubscriptionCurrency,
  cycle: "monthly" as SubscriptionCycle,
  nextBillingDate: "",
  cardLastFour: "",
  cardExpiryMmYy: "",
  status: "pending" as SubscriptionStatus,
};

export interface SubscriptionPanelProps {
  /** 为 true 时仅展示列表与汇总，不提供增删改、提醒与状态切换（用于首页） */
  readOnly?: boolean;
}

export default function SubscriptionPanel({ readOnly = false }: SubscriptionPanelProps) {
  const [items, setItems] = useState<Subscription[]>([]);
  const [summary, setSummary] = useState<{
    totalUsdMinor: number;
    cadPerUsd: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<Record<string, string | undefined>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSubscriptions();
      setItems(res.items);
      setSummary(res.summary);
    } catch (e) {
      setError((e as Error)?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recordBusy = useCallback((id: string, key: string | undefined) => {
    setRowBusy((prev) => {
      const next = { ...prev };
      if (key === undefined) delete next[id];
      else next[id] = key;
      return next;
    });
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const amountMinor = parseAmountToMinor(form.amountStr);
    if (amountMinor == null) {
      window.alert("请输入有效金额");
      return;
    }
    const cardLastFour = sanitizeCardLastFourInput(form.cardLastFour);
    if (cardLastFour.length !== 4) {
      window.alert("卡号仅保存后四位数字");
      return;
    }
    const body: CreateSubscriptionRequest = {
      userName: form.userName.trim(),
      userEmail: form.userEmail.trim(),
      serviceName: form.serviceName.trim(),
      project: form.project.trim(),
      amountMinor,
      currency: form.currency,
      cycle: form.cycle,
      nextBillingDate: form.nextBillingDate,
      cardLastFour,
      cardExpiryMmYy: form.cardExpiryMmYy.trim() || null,
      status: form.status,
    };
    setSaveBusy(true);
    try {
      if (editId) {
        await patchSubscription(editId, body);
      } else {
        await createSubscription(body);
      }
      setForm(emptyForm);
      setEditId(null);
      setFormOpen(false);
      await load();
    } catch (err) {
      window.alert((err as Error)?.message || "保存失败");
    } finally {
      setSaveBusy(false);
    }
  }

  function startEdit(s: Subscription) {
    setEditId(s.id);
    setFormOpen(true);
    setForm({
      userName: s.userName,
      userEmail: s.userEmail,
      serviceName: s.serviceName,
      project: s.project,
      amountStr: formatMinorMajor(s.amountMinor),
      currency: s.currency,
      cycle: s.cycle,
      nextBillingDate: s.nextBillingDate,
      cardLastFour: s.cardLastFour,
      cardExpiryMmYy: s.cardExpiryMmYy ?? "",
      status: s.status,
    });
  }

  function cancelForm() {
    setForm(emptyForm);
    setEditId(null);
    setFormOpen(false);
  }

  async function onToggleStatus(s: Subscription) {
    recordBusy(s.id, "toggle");
    try {
      await toggleSubscriptionStatus(s.id);
      await load();
    } catch (err) {
      window.alert((err as Error)?.message || "切换失败");
    } finally {
      recordBusy(s.id, undefined);
    }
  }

  async function onRemind(s: Subscription) {
    recordBusy(s.id, "remind");
    try {
      await sendSubscriptionReminder(s.id);
      window.alert("提醒邮件已发送。");
    } catch (err) {
      window.alert((err as Error)?.message || "发送失败");
    } finally {
      recordBusy(s.id, undefined);
    }
  }

  async function onDelete(s: Subscription) {
    if (!window.confirm(`确定删除「${s.serviceName}」订阅记录？`)) return;
    recordBusy(s.id, "delete");
    try {
      await deleteSubscription(s.id);
      await load();
    } catch (err) {
      window.alert((err as Error)?.message || "删除失败");
    } finally {
      recordBusy(s.id, undefined);
    }
  }

  const totalUsdDisplay = useMemo(() => {
    if (!summary) return "—";
    return formatMinorMajor(summary.totalUsdMinor);
  }, [summary]);

  return (
    <div className={`subscription-panel${readOnly ? " subscription-panel--readonly" : ""}`}>
      <div className="subscription-toolbar">
        <p className="subscription-summary-line">
          {readOnly ? (
            <span className="subscription-readonly-badge">只读</span>
          ) : null}
          折合 USD 总成本（按 OMNITOOLS_FX_CAD_PER_USD 换算 CAD）：
          <strong> {totalUsdDisplay} USD</strong>
          {summary ? (
            <span className="subscription-fx-hint">
              （1 USD = {summary.cadPerUsd.toFixed(4)} CAD）
            </span>
          ) : null}
        </p>
        {!readOnly ? (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              cancelForm();
              setFormOpen(true);
            }}
          >
            添加订阅
          </button>
        ) : null}
      </div>

      {!readOnly && formOpen ? (
        <form className="card subscription-form" onSubmit={(e) => void handleSubmit(e)}>
          <h3 className="subscription-form-title">{editId ? "编辑订阅" : "新建订阅"}</h3>
          <div className="field-grid subscription-form-grid">
            <label className="field">
              <span className="field-label">使用者姓名</span>
              <input
                className="field-input"
                value={form.userName}
                onChange={(e) => setForm((f) => ({ ...f, userName: e.target.value }))}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">邮箱</span>
              <input
                className="field-input"
                type="email"
                value={form.userEmail}
                onChange={(e) => setForm((f) => ({ ...f, userEmail: e.target.value }))}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">订阅服务</span>
              <input
                className="field-input"
                list="subscription-service-presets"
                value={form.serviceName}
                onChange={(e) => setForm((f) => ({ ...f, serviceName: e.target.value }))}
                required
              />
              <datalist id="subscription-service-presets">
                {SERVICE_PRESETS.map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span className="field-label">项目</span>
              <input
                className="field-input"
                list="subscription-project-presets"
                value={form.project}
                onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}
                required
              />
              <datalist id="subscription-project-presets">
                {PROJECT_PRESETS.map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span className="field-label">金额（税前）</span>
              <input
                className="field-input"
                inputMode="decimal"
                value={form.amountStr}
                onChange={(e) => setForm((f) => ({ ...f, amountStr: e.target.value }))}
                required
                placeholder="如 20.00"
              />
            </label>
            <label className="field">
              <span className="field-label">币种</span>
              <select
                className="field-input"
                value={form.currency}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    currency: e.target.value as SubscriptionCurrency,
                  }))
                }
              >
                <option value="USD">USD</option>
                <option value="CAD">CAD</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">收费方式</span>
              <select
                className="field-input"
                value={form.cycle}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    cycle: e.target.value as SubscriptionCycle,
                  }))
                }
              >
                <option value="monthly">月付</option>
                <option value="yearly">年付</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">下次扣款日</span>
              <input
                className="field-input"
                type="date"
                value={form.nextBillingDate}
                onChange={(e) => setForm((f) => ({ ...f, nextBillingDate: e.target.value }))}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">卡号后四位</span>
              <input
                className="field-input"
                inputMode="numeric"
                autoComplete="off"
                value={form.cardLastFour}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    cardLastFour: sanitizeCardLastFourInput(e.target.value),
                  }))
                }
                placeholder="仅末四位"
                maxLength={4}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">卡过期（MM/YY）</span>
              <input
                className="field-input"
                value={form.cardExpiryMmYy}
                onChange={(e) => setForm((f) => ({ ...f, cardExpiryMmYy: e.target.value }))}
                placeholder="如 07/29"
                pattern="\d{2}/\d{2}"
              />
            </label>
            <label className="field">
              <span className="field-label">状态</span>
              <select
                className="field-input"
                value={form.status}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    status: e.target.value as SubscriptionStatus,
                  }))
                }
              >
                <option value="pending">申请中</option>
                <option value="active">使用中</option>
                <option value="paused">已暂停</option>
              </select>
            </label>
          </div>
          <div className="subscription-form-actions">
            <button type="submit" className="btn btn--primary" disabled={saveBusy}>
              {saveBusy ? "保存中…" : editId ? "保存修改" : "创建"}
            </button>
            <button type="button" className="btn btn--ghost" onClick={cancelForm}>
              取消
            </button>
          </div>
        </form>
      ) : null}

      {loading ? (
        <div className="admin-empty">正在加载订阅…</div>
      ) : error ? (
        <div className="admin-empty">加载失败：{error}</div>
      ) : items.length === 0 ? (
        <div className="admin-empty">
          {readOnly ? "暂无订阅数据。" : "暂无订阅。点击「添加订阅」创建一条记录。"}
        </div>
      ) : (
        <div className="table-wrap subscription-table-wrap">
          <table className="admin-table subscription-table">
            <thead>
              <tr>
                <th>#</th>
                <th>使用者</th>
                <th>邮箱</th>
                <th>订阅内容</th>
                <th>项目</th>
                <th className="num">费用</th>
                <th>折合 USD</th>
                <th>收费方式</th>
                <th>日期</th>
                <th>卡号后四位</th>
                <th>卡过期</th>
                <th>状态</th>
                {!readOnly ? <th className="subscription-actions-col">操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((s, i) => (
                <tr key={s.id}>
                  <td>{i + 1}</td>
                  <td>{s.userName}</td>
                  <td className="subscription-email-cell">{s.userEmail}</td>
                  <td>
                    <span className="sub-tag sub-tag--svc">{s.serviceName}</span>
                  </td>
                  <td>
                    <span className="sub-tag sub-tag--proj">{s.project}</span>
                  </td>
                  <td className="num">
                    {formatMinorMajor(s.amountMinor)} {s.currency}
                  </td>
                  <td className="num subscription-usd-cell">
                    {formatMinorMajor(s.amountUsdMinor)}
                  </td>
                  <td>{cycleLabel(s.cycle)}</td>
                  <td>{formatIsoDateDisplay(s.nextBillingDate)}</td>
                  <td>
                    <code className="admin-code">****{s.cardLastFour}</code>
                  </td>
                  <td>{s.cardExpiryMmYy || "—"}</td>
                  <td>
                    {readOnly ? (
                      <span className={`sub-status sub-status--${s.status} sub-status--static`}>
                        {statusLabel(s.status)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`sub-status sub-status--${s.status}`}
                        disabled={Boolean(rowBusy[s.id])}
                        title="点击在使用中与已暂停之间切换；申请中将变为使用中"
                        onClick={() => void onToggleStatus(s)}
                      >
                        {statusLabel(s.status)}
                      </button>
                    )}
                  </td>
                  {!readOnly ? (
                    <td className="subscription-actions-cell">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={Boolean(rowBusy[s.id])}
                        onClick={() => void onRemind(s)}
                      >
                        {rowBusy[s.id] === "remind" ? "发送中…" : "提醒"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={Boolean(rowBusy[s.id])}
                        onClick={() => startEdit(s)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={Boolean(rowBusy[s.id])}
                        onClick={() => void onDelete(s)}
                      >
                        {rowBusy[s.id] === "delete" ? "…" : "删除"}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="subscription-record-count">{items.length} 条记录</p>
        </div>
      )}
    </div>
  );
}
