import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AttachmentGallery, {
  attachmentItemsFromExpenses,
} from "./components/AttachmentGallery";
import FormTemplate from "./components/FormTemplate";
import { COMPANY_PRESETS } from "./company";
import { COMMON_CURRENCY_CODES, normalizeCurrency } from "./currencies";
import { EXPENSE_CATEGORIES } from "./categories";
import { buildMergedReimbursementPdf } from "./pdf/buildMergedPdf";
import {
  getSmtpSettings,
  sendExpensePdfEmail,
  submitExpenseReimbursementToServer,
} from "./emailApi";
import AdminPanel from "./AdminPanel";
import type { ExpenseLine, HeaderInfo } from "./types";
import "./App.css";

function isAllowedAttachment(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  if (file.type === "application/pdf") return true;
  const n = file.name.toLowerCase();
  return n.endsWith(".pdf");
}

function parseMoney(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** 汇率：须为有限正数；基准金额 = 本行金额 × 汇率 */
function parsePositiveRate(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`;
}

const emptyHeader: HeaderInfo = {
  employeeName: "",
  department: "",
  companyName: "",
  baseCurrency: "",
  periodFrom: "",
  periodTo: "",
};

export default function App() {
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isAdminView, setIsAdminView] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [header, setHeader] = useState<HeaderInfo>(emptyHeader);
  const [expenses, setExpenses] = useState<ExpenseLine[]>([]);

  const [lineDate, setLineDate] = useState("");
  const [lineDescription, setLineDescription] = useState("");
  const [lineCategory, setLineCategory] = useState("");
  const [lineCurrency, setLineCurrency] = useState("");
  const [lineExchangeRate, setLineExchangeRate] = useState("1");
  const [lineGst, setLineGst] = useState("");
  const [lineGross, setLineGross] = useState("");
  const [lineFiles, setLineFiles] = useState<File[]>([]);
  const [fileTick, setFileTick] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [cashAdvanceStr, setCashAdvanceStr] = useState("0");
  const [managerName, setManagerName] = useState("");
  const [businessPurpose, setBusinessPurpose] = useState("");
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMessage, setDbMessage] = useState<string | null>(null);
  const [blobUrlByExpenseId, setBlobUrlByExpenseId] = useState<
    Map<string, string[]>
  >(() => new Map());
  const [pdfBusy, setPdfBusy] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  /** 本次确认页提交成功后由服务器分配的 EXPYYMMXX */
  const [submittedReimbursementId, setSubmittedReimbursementId] = useState<
    string | null
  >(null);

  const formTemplateRef = useRef<HTMLDivElement>(null);

  const headerValid = useMemo(() => {
    const {
      employeeName,
      department,
      companyName,
      baseCurrency,
      periodFrom,
      periodTo,
    } = header;
    if (
      !employeeName.trim() ||
      !department.trim() ||
      !companyName.trim() ||
      !normalizeCurrency(baseCurrency) ||
      !periodFrom ||
      !periodTo
    )
      return false;
    return periodFrom <= periodTo;
  }, [header]);

  const gstNum = parseMoney(lineGst);
  const grossNum = parseMoney(lineGross);
  const rateNum = parsePositiveRate(lineExchangeRate);

  const lineValid =
    Boolean(lineDate) &&
    lineDescription.trim().length > 0 &&
    Boolean(lineCategory) &&
    Boolean(normalizeCurrency(lineCurrency)) &&
    rateNum !== null &&
    gstNum !== null &&
    grossNum !== null &&
    grossNum >= gstNum &&
    lineFiles.length > 0 &&
    lineFiles.every((f) => isAllowedAttachment(f));

  const canFinish =
    expenses.length > 0 && expenses.every((e) => e.files.length > 0);

  const totals = useMemo(() => {
    const subtotalBase = expenses.reduce(
      (s, e) => s + e.grossAmount * e.exchangeRate,
      0
    );
    return { subtotalBase, count: expenses.length };
  }, [expenses]);

  const cashAdvanceNum = useMemo(() => {
    const n = Number.parseFloat(cashAdvanceStr.trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }, [cashAdvanceStr]);

  const revokeBlobUrls = useCallback((m: Map<string, string[]>) => {
    m.forEach((urls) => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    });
  }, []);

  useEffect(() => {
    return () => revokeBlobUrls(blobUrlByExpenseId);
  }, [blobUrlByExpenseId, revokeBlobUrls]);

  function resetLineForm() {
    setLineDate("");
    setLineDescription("");
    setLineCategory("");
    setLineCurrency(normalizeCurrency(header.baseCurrency));
    setLineExchangeRate("1");
    setLineGst("");
    setLineGross("");
    setLineFiles([]);
    setFileTick((k) => k + 1);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function goNextStep() {
    if (!headerValid) return;
    // 从步骤 1 再次进入步骤 2 时，保留已填写中的币种与汇率（避免「上一个」改表头后点「下一个」被重置）
    setLineCurrency((prev) => {
      const t = prev.trim();
      return t ? prev : normalizeCurrency(header.baseCurrency);
    });
    setLineExchangeRate((prev) => (prev.trim() === "" ? "1" : prev));
    setStep(2);
  }

  function goPreviousStep() {
    setStep(1);
  }

  function appendExpense() {
    if (
      !lineValid ||
      lineFiles.length === 0 ||
      gstNum === null ||
      grossNum === null ||
      rateNum === null
    )
      return;
    const row: ExpenseLine = {
      id: randomId(),
      date: lineDate,
      description: lineDescription.trim(),
      category: lineCategory,
      lineCurrency: normalizeCurrency(lineCurrency),
      exchangeRate: rateNum,
      gst: gstNum,
      grossAmount: grossNum,
      files: [...lineFiles],
    };
    setExpenses((prev) => [...prev, row]);
    resetLineForm();
  }

  function openConfirm() {
    setSubmittedReimbursementId(null);
    const m = new Map<string, string[]>();
    expenses.forEach((e) =>
      m.set(
        e.id,
        e.files.map((f) => URL.createObjectURL(f))
      )
    );
    setBlobUrlByExpenseId(m);
    setConfirmOpen(true);
  }

  function closeConfirm() {
    setBlobUrlByExpenseId(new Map());
    setSubmittedReimbursementId(null);
    setConfirmOpen(false);
  }

  function removeLineFileAt(index: number) {
    setLineFiles((prev) => prev.filter((_, i) => i !== index));
    setFileTick((k) => k + 1);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeExpenseFile(expenseId: string, fileIndex: number) {
    setExpenses((prev) =>
      prev
        .map((ex) => {
          if (ex.id !== expenseId) return ex;
          const nextFiles = ex.files.filter((_, i) => i !== fileIndex);
          return { ...ex, files: nextFiles };
        })
        .filter((ex) => ex.files.length > 0)
    );
  }

  function removeExpenseRow(expenseId: string) {
    setExpenses((prev) => prev.filter((e) => e.id !== expenseId));
  }

  function handleFinish() {
    if (step !== 2) return;
    if (lineValid) {
      window.alert(
        "当前明细已填写完整但未加入列表。请先点击「下一个」添加本条，或清空后再完成。"
      );
      return;
    }
    if (!canFinish) {
      window.alert("请至少添加一条报销明细后再完成。");
      return;
    }
    openConfirm();
  }

  async function handleDownloadMergedPdf() {
    const el = formTemplateRef.current;
    if (!el) return;
    setPdfBusy(true);
    try {
      const bytes = await buildMergedReimbursementPdf(el, expenses);
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const slug =
        submittedReimbursementId ||
        header.employeeName.trim().replace(/\s+/g, "_") ||
        "draft";
      a.download = `${slug}-merged.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      window.alert(
        "生成 PDF 失败。若收据为受保护或特殊格式 PDF，可尝试改用打印并「另存为 PDF」。"
      );
    } finally {
      setPdfBusy(false);
    }
  }

  async function handleEmailMergedPdf() {
    const smtp = await getSmtpSettings();
    if (!smtp?.host?.trim()) {
      window.alert("请先在「查看后台」中配置并保存 SMTP。");
      return;
    }
    let to = smtp.defaultToEmail.trim();
    if (!to) {
      const entered = window.prompt("收件邮箱：");
      if (entered === null) return;
      to = entered.trim();
      if (!to) {
        window.alert("未填写收件邮箱。");
        return;
      }
    }
    const el = formTemplateRef.current;
    if (!el) return;
    setEmailBusy(true);
    try {
      const bytes = await buildMergedReimbursementPdf(el, expenses);
      const baseName =
        submittedReimbursementId ||
        header.employeeName.trim().replace(/\s+/g, "_") ||
        "draft";
      const filename = `${baseName}-merged.pdf`;
      await sendExpensePdfEmail({
        smtp,
        to,
        pdfBytes: bytes,
        filename,
        subject: `报销单 PDF ${submittedReimbursementId ? `${submittedReimbursementId} · ` : ""}${header.employeeName.trim() || "draft"}`,
      });
      window.alert("合并 PDF 已发送到邮箱。");
    } catch (e) {
      console.error(e);
      window.alert(
        (e as Error)?.message ||
          "发送失败。请确认已用 npm run dev 启动（含邮件 API），并检查 SMTP 与网络。"
      );
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleSaveToDatabase() {
    const el = formTemplateRef.current;
    if (!el) {
      setDbMessage("无法生成 PDF：模板未就绪。");
      return;
    }
    setDbBusy(true);
    setDbMessage(null);
    try {
      const pdfBytes = await buildMergedReimbursementPdf(el, expenses);
      const { reimbursementId } = await submitExpenseReimbursementToServer({
        pdfBytes,
        expenses,
        manifest: {
          header,
          cashAdvance: cashAdvanceNum,
          managerName,
          businessPurpose,
          lines: expenses.map((e) => ({
            expenseLineId: e.id,
            date: e.date,
            description: e.description,
            category: e.category,
            lineCurrency: e.lineCurrency,
            exchangeRate: e.exchangeRate,
            gst: e.gst,
            grossAmount: e.grossAmount,
            attachmentCount: e.files.length,
          })),
        },
      });
      setSubmittedReimbursementId(reimbursementId);
      setDbMessage(
        `已提交编号 ${reimbursementId}。文件已写入服务器 upload/${reimbursementId}/，报销数据已写入服务端 SQLite。`
      );
    } catch (error) {
      console.error(error);
      setDbMessage(
        (error as Error)?.message ||
          "提交失败。请确认邮件 API 已启动（npm run dev）且可访问 /api/submit-reimbursement。"
      );
    } finally {
      setDbBusy(false);
    }
  }

  function handlePrint() {
    window.print();
  }

  function handleAdminToggle() {
    if (!isAuthenticated) {
      const password = window.prompt("请输入后台密码：");
      if (password === "admin123") {
        setIsAuthenticated(true);
        setIsAdminView(true);
      } else if (password !== null) {
        window.alert("密码错误！");
      }
    } else {
      setIsAdminView(!isAdminView);
    }
  }

  const attachmentItems = useMemo(
    () => attachmentItemsFromExpenses(expenses, blobUrlByExpenseId),
    [expenses, blobUrlByExpenseId]
  );

  return (
    <div className="app">
      <nav className="app-menubar no-print" aria-label="主导航">
        <div className="app-menubar-inner">
          <div className="app-menubar-segment app-menubar-segment--left">
            <span className="app-menubar-logo">OmniTools</span>
            <span className="app-menubar-tag">
              {isAdminView ? "后台" : "报销"}
            </span>
          </div>
          <div className="app-menubar-segment app-menubar-segment--right">
            <span className="app-menubar-company" title={header.companyName.trim() || undefined}>
              {header.companyName.trim() || "—"}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm app-menubar-admin"
              onClick={handleAdminToggle}
            >
              {isAuthenticated ? (isAdminView ? "返回报销" : "查看后台") : "查看后台"}
            </button>
          </div>
        </div>
      </nav>

      <header className="app-header no-print">
        <div className="app-header-titles">
          <h1 className="app-title">
            {isAdminView ? "后台管理" : "Expense Reimbursement Form"}
          </h1>
          <p className="app-sub">
            {isAdminView ? "SMTP 与已保存记录" : "费用报销单"}
          </p>
        </div>
      </header>

      {isAdminView ? (
        <AdminPanel onClose={() => setIsAdminView(false)} />
      ) : (
        <main className="app-main">
        <datalist id="currency-presets">
          {COMMON_CURRENCY_CODES.map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
        {confirmOpen ? (
          <>
            <section className="card no-print confirm-panel" aria-label="确认与选项">
              <h2 className="card-title">确认报销单</h2>
              <p className="card-hint">
                请核对下方模板样式是否与纸质版一致。确认无误后可下载合并 PDF（表格 +
                全部收据）或使用打印。                「保存到数据库」将申请编号{" "}
                <strong>EXPYYMMXX</strong>，把合并 PDF 与全部收据写入服务器{" "}
                <code className="admin-code">upload/</code>{" "}
                下对应文件夹，并将报销明细写入服务端 SQLite。
              </p>
              <div className="confirm-fields field-grid">
                <label className="field">
                  <span className="field-label">经理姓名 Manager</span>
                  <input
                    className="field-input"
                    value={managerName}
                    onChange={(e) => setManagerName(e.target.value)}
                    placeholder="可选"
                  />
                </label>
                <label className="field">
                  <span className="field-label">预支抵扣 Cash advance</span>
                  <input
                    className="field-input"
                    inputMode="decimal"
                    value={cashAdvanceStr}
                    onChange={(e) => setCashAdvanceStr(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <label className="field field-span-2">
                  <span className="field-label">事由 Business purpose</span>
                  <textarea
                    className="field-input field-textarea"
                    rows={2}
                    value={businessPurpose}
                    onChange={(e) => setBusinessPurpose(e.target.value)}
                    placeholder="可选，将显示在模板中"
                  />
                </label>
              </div>
            </section>

            <div id="print-area" className="print-area">
              <FormTemplate
                ref={formTemplateRef}
                header={header}
                expenses={expenses}
                cashAdvance={cashAdvanceNum}
                managerName={managerName}
                businessPurpose={businessPurpose}
                reimbursementCode={submittedReimbursementId}
              />
              <AttachmentGallery items={attachmentItems} />
            </div>
          </>
        ) : (
          <>
            {step === 1 && (
              <section className="card" aria-labelledby="step1-title">
                <h2 id="step1-title" className="card-title">
                  基本信息
                </h2>
                <p className="card-hint">
                  请填写姓名、部门、公司、<strong>基准币种</strong>与报销期间。合计与结算均以基准币种为准。
                </p>
                <datalist id="company-presets">
                  {COMPANY_PRESETS.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <div className="field-grid">
                  <label className="field">
                    <span className="field-label">姓名</span>
                    <input
                      className="field-input"
                      value={header.employeeName}
                      onChange={(e) =>
                        setHeader((h) => ({
                          ...h,
                          employeeName: e.target.value,
                        }))
                      }
                      placeholder="员工姓名"
                      autoComplete="name"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">部门</span>
                    <input
                      className="field-input"
                      value={header.department}
                      onChange={(e) =>
                        setHeader((h) => ({ ...h, department: e.target.value }))
                      }
                      placeholder="例如 Accounting and Admin"
                    />
                  </label>
                  <label className="field field-span-2">
                    <span className="field-label">公司名字</span>
                    <input
                      className="field-input"
                      list="company-presets"
                      value={header.companyName}
                      onChange={(e) =>
                        setHeader((h) => ({
                          ...h,
                          companyName: e.target.value,
                        }))
                      }
                      placeholder="选 Omnisolu / Metablox 或输入其他公司"
                      autoComplete="organization"
                    />
                  </label>
                  <label className="field field-span-2">
                    <span className="field-label">
                      基准币种 Base currency（结算币种）
                    </span>
                    <input
                      className="field-input"
                      list="currency-presets"
                      value={header.baseCurrency}
                      onChange={(e) =>
                        setHeader((h) => ({
                          ...h,
                          baseCurrency: e.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="如 CAD、USD，或从列表选择"
                      autoCapitalize="characters"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">期间自</span>
                    <input
                      className="field-input"
                      type="date"
                      value={header.periodFrom}
                      onChange={(e) =>
                        setHeader((h) => ({ ...h, periodFrom: e.target.value }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">期间至</span>
                    <input
                      className="field-input"
                      type="date"
                      value={header.periodTo}
                      onChange={(e) =>
                        setHeader((h) => ({ ...h, periodTo: e.target.value }))
                      }
                    />
                  </label>
                </div>
                {header.periodFrom &&
                  header.periodTo &&
                  header.periodFrom > header.periodTo && (
                    <p className="field-error" role="alert">
                      「期间至」不能早于「期间自」。
                    </p>
                  )}
              </section>
            )}

            {step === 2 && (
              <>
                <section className="card card--compact" aria-label="已填摘要">
                  <div className="summary-bar">
                    <div>
                      <strong>{header.employeeName.trim() || "—"}</strong>
                      <span className="summary-sep">·</span>
                      <span>{header.department.trim() || "—"}</span>
                      <span className="summary-sep">·</span>
                      <span>{header.companyName.trim() || "—"}</span>
                    </div>
                    <div className="summary-dates">
                      基准 {normalizeCurrency(header.baseCurrency) || "—"} ·{" "}
                      {header.periodFrom} → {header.periodTo}
                    </div>
                  </div>
                </section>

                <section className="card" aria-labelledby="step2-title">
                  <h2 id="step2-title" className="card-title">
                    添加报销明细
                  </h2>
                  <p className="card-hint">
                    GST、总金额为<strong>本行币种</strong>金额。汇率表示：基准金额 = 本行金额 ×
                    汇率（1 单位本行币种兑多少{normalizeCurrency(header.baseCurrency) || "基准"}）。
                    每条至少上传一个附件（可多次「选择文件」追加）；信息齐全后「下一个」才可点。
                  </p>
                  <p className="card-hint card-hint--sub">
                    未点击「完成」并提交到服务器前，附件仅保存在本浏览器内存中；关闭或刷新页面会丢失。
                    成功提交后，服务器会将 PDF 与收据写入{" "}
                    <code className="admin-code">upload/EXPYYMMXX/</code> 正式目录。
                  </p>

                  <div className="field-grid">
                    <label className="field">
                      <span className="field-label">日期</span>
                      <input
                        className="field-input"
                        type="date"
                        value={lineDate}
                        onChange={(e) => setLineDate(e.target.value)}
                      />
                    </label>
                    <label className="field field-span-2">
                      <span className="field-label">说明 Description</span>
                      <input
                        className="field-input"
                        value={lineDescription}
                        onChange={(e) => setLineDescription(e.target.value)}
                        placeholder="费用说明"
                      />
                    </label>
                    <label className="field field-span-2">
                      <span className="field-label">类别 Category</span>
                      <select
                        className="field-input"
                        value={lineCategory}
                        onChange={(e) => setLineCategory(e.target.value)}
                      >
                        <option value="">请选择</option>
                        {EXPENSE_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-label">币种 Line currency</span>
                      <input
                        className="field-input"
                        list="currency-presets"
                        value={lineCurrency}
                        onChange={(e) =>
                          setLineCurrency(e.target.value.toUpperCase())
                        }
                        placeholder={normalizeCurrency(header.baseCurrency) || "币种"}
                        autoCapitalize="characters"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">汇率 Exchange rate</span>
                      <input
                        className="field-input"
                        inputMode="decimal"
                        value={lineExchangeRate}
                        onChange={(e) => setLineExchangeRate(e.target.value)}
                        placeholder="× 基准币"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">GST（本行币种）</span>
                      <input
                        className="field-input"
                        inputMode="decimal"
                        value={lineGst}
                        onChange={(e) => setLineGst(e.target.value)}
                        placeholder="0.00"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">总金额（本行币种）</span>
                      <input
                        className="field-input"
                        inputMode="decimal"
                        value={lineGross}
                        onChange={(e) => setLineGross(e.target.value)}
                        placeholder="0.00"
                      />
                    </label>
                    <div className="field field-span-2">
                      <span className="field-label">附件（图片或 PDF，可多选）</span>
                      <div className="file-row">
                        <input
                          key={fileTick}
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept="image/*,.pdf,application/pdf"
                          className="file-input"
                          onChange={(e) => {
                            const picked = Array.from(e.target.files ?? []);
                            const valid: File[] = [];
                            const invalid: string[] = [];
                            for (const f of picked) {
                              if (isAllowedAttachment(f)) valid.push(f);
                              else invalid.push(f.name);
                            }
                            if (invalid.length) {
                              window.alert(
                                `仅支持图片或 PDF 文件。已跳过：${invalid.join("、")}`
                              );
                            }
                            if (valid.length) {
                              setLineFiles((prev) => {
                                const seen = new Set(prev.map(fileKey));
                                const next = [...prev];
                                for (const f of valid) {
                                  const k = fileKey(f);
                                  if (!seen.has(k)) {
                                    seen.add(k);
                                    next.push(f);
                                  }
                                }
                                return next;
                              });
                            }
                            e.target.value = "";
                          }}
                        />
                        {lineFiles.length > 0 && (
                          <ul className="file-name-list file-chip-list">
                            {lineFiles.map((f, idx) => (
                              <li key={fileKey(f)} className="file-chip">
                                <span className="file-chip-name" title={f.name}>
                                  {f.name}
                                </span>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm file-chip-remove"
                                  aria-label={`移除 ${f.name}`}
                                  onClick={() => removeLineFileAt(idx)}
                                >
                                  移除
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                  {grossNum !== null &&
                    gstNum !== null &&
                    grossNum < gstNum && (
                      <p className="field-error" role="alert">
                        总金额应大于或等于 GST。
                      </p>
                    )}

                  {expenses.length > 0 && (
                    <div className="table-wrap">
                      <table className="expense-table">
                        <thead>
                          <tr>
                            <th>日期</th>
                            <th>说明</th>
                            <th>类别</th>
                            <th>币种</th>
                            <th className="num">汇率</th>
                            <th className="num">GST</th>
                            <th className="num">总金额</th>
                            <th className="num">
                              折合{normalizeCurrency(header.baseCurrency) || "基准"}
                            </th>
                            <th>附件</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expenses.map((e) => (
                            <tr key={e.id}>
                              <td>{e.date}</td>
                              <td>{e.description}</td>
                              <td>{e.category}</td>
                              <td>{e.lineCurrency}</td>
                              <td className="num">{e.exchangeRate}</td>
                              <td className="num">{e.gst.toFixed(2)}</td>
                              <td className="num">{e.grossAmount.toFixed(2)}</td>
                              <td className="num">
                                {(e.grossAmount * e.exchangeRate).toFixed(2)}
                              </td>
                              <td className="attach-cell attach-cell--files">
                                <ul className="attach-file-list">
                                  {e.files.map((f, i) => (
                                    <li key={`${e.id}-${i}-${fileKey(f)}`} className="attach-file-row">
                                      <span className="attach-file-name" title={f.name}>
                                        {f.name}
                                      </span>
                                      <button
                                        type="button"
                                        className="btn btn--ghost btn--sm"
                                        onClick={() => removeExpenseFile(e.id, i)}
                                      >
                                        删除
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm attach-row-delete"
                                  onClick={() => removeExpenseRow(e.id)}
                                >
                                  删除本条明细
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="table-foot">
                    已添加 {totals.count} 条 · 折合基准币合计{" "}
                    <strong>
                      {totals.subtotalBase.toFixed(2)}{" "}
                      {normalizeCurrency(header.baseCurrency)}
                    </strong>
                      </p>
                    </div>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </main>
      )}

      {!isAdminView && !confirmOpen && (
        <footer className="app-footer no-print">
          <div className="footer-buttons">
            {step === 1 ? (
              <span className="footer-spacer" aria-hidden="true" />
            ) : (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={goPreviousStep}
              >
                上一个
              </button>
            )}
            {step === 1 ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={!headerValid}
                onClick={goNextStep}
              >
                下一个
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary"
                disabled={!lineValid}
                onClick={appendExpense}
              >
                下一个
              </button>
            )}
            <button
              type="button"
              className="btn btn--accent"
              disabled={step !== 2 || !canFinish}
              onClick={handleFinish}
            >
              完成
            </button>
          </div>
        </footer>
      )}

      {!isAdminView && confirmOpen && (
        <footer className="app-footer no-print confirm-sticky-footer">
          <div className="footer-buttons confirm-footer-grid">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={closeConfirm}
            >
              返回修改
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={dbBusy || submittedReimbursementId !== null}
              onClick={() => void handleSaveToDatabase()}
            >
              {dbBusy
                ? "正在提交…"
                : submittedReimbursementId
                  ? `已提交 ${submittedReimbursementId}`
                  : "保存到数据库"}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={pdfBusy || emailBusy}
              onClick={() => void handleDownloadMergedPdf()}
            >
              {pdfBusy ? "正在生成…" : "下载合并 PDF"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={pdfBusy || emailBusy}
              onClick={() => void handleEmailMergedPdf()}
            >
              {emailBusy ? "正在发送…" : "发送 PDF 到邮箱"}
            </button>
            <button
              type="button"
              className="btn btn--accent"
              onClick={handlePrint}
            >
              打印
            </button>
          </div>
          {dbMessage ? (
            <div className="confirm-message">
              <p>{dbMessage}</p>
            </div>
          ) : null}
        </footer>
      )}
    </div>
  );
}
