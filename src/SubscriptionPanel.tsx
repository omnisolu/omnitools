import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { formatIsoDateDisplay } from "./formatIsoDate";
import { COMPANY_PRESETS } from "./company";
import {
  createSubscription,
  createSubscriptionContact,
  deleteSubscription,
  fetchSubscriptionContacts,
  fetchSubscriptions,
  patchSubscription,
  sendSubscriptionReminder,
  toggleSubscriptionStatus,
} from "./subscriptionApi";
import { fetchFormPresets } from "./emailApi";
import type {
  CreateSubscriptionRequest,
  Subscription,
  SubscriptionContact,
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
  company: "",
  status: "pending" as SubscriptionStatus,
};

const emptyNewContact = {
  userName: "",
  otherName: "",
  email: "",
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
  const [contacts, setContacts] = useState<SubscriptionContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  /** 组合框内文字：搜索或已选姓名 */
  const [contactComboInput, setContactComboInput] = useState("");
  const [contactComboOpen, setContactComboOpen] = useState(false);
  const [contactSelectValue, setContactSelectValue] = useState("");
  const comboWrapRef = useRef<HTMLDivElement>(null);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [newContact, setNewContact] = useState(emptyNewContact);
  const [newContactBusy, setNewContactBusy] = useState(false);
  const [companyPresets, setCompanyPresets] = useState<string[]>(() => [
    ...COMPANY_PRESETS,
  ]);

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

  useEffect(() => {
    if (!formOpen || readOnly) return;
    let canceled = false;
    (async () => {
      setContactsLoading(true);
      try {
        const list = await fetchSubscriptionContacts();
        if (!canceled) setContacts(list);
      } catch {
        if (!canceled) setContacts([]);
      } finally {
        if (!canceled) setContactsLoading(false);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [formOpen, readOnly]);

  useEffect(() => {
    if (!formOpen || readOnly) return;
    let canceled = false;
    (async () => {
      try {
        const p = await fetchFormPresets();
        if (!canceled) setCompanyPresets(p.companies);
      } catch {
        /* 保留内置公司列表 */
      }
    })();
    return () => {
      canceled = true;
    };
  }, [formOpen, readOnly]);

  /** 根据邮箱与联系人表同步选中；有匹配时组合框显示姓名（邮箱为空时不清空搜索框，便于先搜索再选） */
  useEffect(() => {
    if (!formOpen || readOnly) return;
    const em = form.userEmail.trim().toLowerCase();
    if (!em) {
      setContactSelectValue("");
      return;
    }
    const m = contacts.find((c) => c.userEmail.toLowerCase() === em);
    setContactSelectValue(m ? m.id : "");
    if (m) setContactComboInput(m.userName);
  }, [formOpen, readOnly, form.userEmail, contacts]);

  const filteredContacts = useMemo(() => {
    const q = contactComboInput.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const blob = `${c.userName} ${c.otherName} ${c.userEmail}`.toLowerCase();
      return blob.includes(q);
    });
  }, [contacts, contactComboInput]);

  useEffect(() => {
    if (!contactComboOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (comboWrapRef.current && !comboWrapRef.current.contains(e.target as Node)) {
        setContactComboOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setContactComboOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [contactComboOpen]);

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
    const company = form.company.trim();
    if (!company) {
      window.alert("请填写 Company（公司）");
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
      company,
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
    setContactComboInput("");
    setContactComboOpen(false);
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
      company: s.company ?? "",
      status: s.status,
    });
  }

  function cancelForm() {
    setForm(emptyForm);
    setEditId(null);
    setFormOpen(false);
    setContactComboInput("");
    setContactComboOpen(false);
    setContactSelectValue("");
    setAddContactOpen(false);
    setNewContact(emptyNewContact);
  }

  function selectContactRow(c: SubscriptionContact) {
    setForm((f) => ({
      ...f,
      userName: c.userName,
      userEmail: c.userEmail,
    }));
    setContactSelectValue(c.id);
    setContactComboInput(c.userName);
    setContactComboOpen(false);
  }

  function openAddContactFromCombo() {
    const q = contactComboInput.trim();
    setNewContact({ userName: q, otherName: "", email: "" });
    setAddContactOpen(true);
    setContactComboOpen(false);
  }

  async function handleSaveNewContact(e: FormEvent) {
    e.preventDefault();
    const userName = newContact.userName.trim();
    const email = newContact.email.trim();
    if (!userName) {
      window.alert("请填写姓名");
      return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      window.alert("请填写有效邮箱");
      return;
    }
    setNewContactBusy(true);
    try {
      const created = await createSubscriptionContact({
        userName,
        otherName: newContact.otherName.trim(),
        email,
      });
      const list = await fetchSubscriptionContacts();
      setContacts(list);
      setForm((f) => ({
        ...f,
        userName: created.userName,
        userEmail: created.userEmail,
      }));
      setContactSelectValue(created.id);
      setContactComboInput(created.userName);
      setAddContactOpen(false);
      setNewContact(emptyNewContact);
    } catch (err) {
      window.alert((err as Error)?.message || "保存失败");
    } finally {
      setNewContactBusy(false);
    }
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
            <div className="field field-span-2 subscription-contact-picker">
              <p className="subscription-contact-hint">
                搜索或点选联系人；首行 <strong>+ Add new</strong>{" "}
                可录入姓名、Other Name 与邮箱。
              </p>
              <div className="subscription-contact-top-row">
                <div
                  className="subscription-combo-wrap"
                  ref={comboWrapRef}
                >
                  <span className="field-label" id="subscription-combo-label">
                    选择使用者
                  </span>
                  <div className="subscription-combo-input-row">
                    <input
                      className="field-input subscription-combo-input"
                      type="text"
                      placeholder={
                        contactsLoading
                          ? "加载联系人…"
                          : "搜索姓名、Other Name 或邮箱…"
                      }
                      value={contactComboInput}
                      onChange={(e) => {
                        setContactComboInput(e.target.value);
                        setContactComboOpen(true);
                      }}
                      onFocus={() => setContactComboOpen(true)}
                      autoComplete="off"
                      aria-labelledby="subscription-combo-label"
                      aria-expanded={contactComboOpen}
                      aria-controls="subscription-combo-listbox"
                      role="combobox"
                    />
                    <button
                      type="button"
                      className="subscription-combo-chevron"
                      aria-label="展开列表"
                      tabIndex={-1}
                      onClick={() => setContactComboOpen((o) => !o)}
                    >
                      ▾
                    </button>
                  </div>
                  {contactComboOpen ? (
                    <div
                      className="subscription-combo-dropdown"
                      id="subscription-combo-listbox"
                      role="listbox"
                    >
                      <button
                        type="button"
                        className="subscription-combo-add"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={openAddContactFromCombo}
                      >
                        + Add new
                        {contactComboInput.trim()
                          ? ` ${contactComboInput.trim()}`
                          : ""}
                      </button>
                      <div className="subscription-combo-divider" role="separator" />
                      {filteredContacts.length === 0 ? (
                        <div className="subscription-combo-empty">
                          {contactsLoading ? "加载中…" : "无匹配联系人"}
                        </div>
                      ) : (
                        <ul className="subscription-combo-list">
                          {filteredContacts.map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                className={
                                  contactSelectValue === c.id
                                    ? "subscription-combo-row is-active"
                                    : "subscription-combo-row"
                                }
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => selectContactRow(c)}
                              >
                                <span className="subscription-combo-name">
                                  {c.userName}
                                </span>
                                <span className="subscription-combo-meta">
                                  {c.otherName.trim()
                                    ? c.otherName.trim()
                                    : c.userEmail}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
                <label className="field subscription-email-inline">
                  <span className="field-label">邮箱</span>
                  <input
                    className="field-input"
                    type="email"
                    value={form.userEmail}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, userEmail: e.target.value }))
                    }
                    required
                    placeholder="name@example.com"
                  />
                </label>
              </div>
              <label className="field subscription-name-below">
                <span className="field-label">使用者姓名</span>
                <input
                  className="field-input"
                  value={form.userName}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, userName: e.target.value }))
                  }
                  required
                />
                <span className="subscription-field-note">
                  与上方选择联动，也可直接修改
                </span>
              </label>
            </div>
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
              <span className="field-label">Company（公司）</span>
              <input
                className="field-input"
                list="subscription-company-presets"
                value={form.company}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="如 Omnisolu"
                required
              />
              <datalist id="subscription-company-presets">
                {companyPresets.map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
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
                <th>Company</th>
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
                  <td>{s.company?.trim() || "—"}</td>
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

      {!readOnly && addContactOpen ? (
        <div
          className="subscription-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="subscription-new-contact-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setAddContactOpen(false);
              setNewContact(emptyNewContact);
            }
          }}
        >
          <div
            className="subscription-modal card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="subscription-new-contact-title" className="subscription-modal-title">
              新建联系人
            </h3>
            <p className="subscription-modal-hint">
              保存后将写入联系人表，并自动填入本订阅的姓名与邮箱。
            </p>
            <form className="subscription-modal-form" onSubmit={handleSaveNewContact}>
              <label className="field">
                <span className="field-label">姓名</span>
                <input
                  className="field-input"
                  value={newContact.userName}
                  onChange={(e) =>
                    setNewContact((n) => ({ ...n, userName: e.target.value }))
                  }
                  autoComplete="name"
                  required
                />
              </label>
              <label className="field">
                <span className="field-label">Other Name</span>
                <input
                  className="field-input"
                  value={newContact.otherName}
                  onChange={(e) =>
                    setNewContact((n) => ({ ...n, otherName: e.target.value }))
                  }
                  placeholder="可选"
                />
              </label>
              <label className="field">
                <span className="field-label">邮箱</span>
                <input
                  className="field-input"
                  type="email"
                  value={newContact.email}
                  onChange={(e) =>
                    setNewContact((n) => ({ ...n, email: e.target.value }))
                  }
                  autoComplete="email"
                  required
                />
              </label>
              <div className="subscription-modal-actions">
                <button type="submit" className="btn btn--primary" disabled={newContactBusy}>
                  {newContactBusy ? "保存中…" : "保存"}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={newContactBusy}
                  onClick={() => {
                    setAddContactOpen(false);
                    setNewContact(emptyNewContact);
                  }}
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
