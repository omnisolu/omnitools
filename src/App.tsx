import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AttachmentGallery, {
  attachmentItemsFromExpenses,
} from "./components/AttachmentGallery";
import FormTemplate from "./components/FormTemplate";
import { COMPANY_PRESETS } from "./company";
import {
  COMMON_CURRENCY_CODES,
  isCommonCurrencyCode,
  normalizeCurrency,
} from "./currencies";
import { EXPENSE_CATEGORIES } from "./categories";
import { buildMergedReimbursementPdf } from "./pdf/buildMergedPdf";
import {
  fetchFormPresets,
  getSmtpSettings,
  sendExpensePdfEmail,
  submitExpenseReimbursementToServer,
} from "./emailApi";
import AdminPanel from "./AdminPanel";
import SubscriptionPanel from "./SubscriptionPanel";
import { formatIsoDateRange } from "./formatIsoDate";
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
  /** 确认流程：edit = 核对并保存；review = 已保存后的摘要与 PDF/邮件/打印 */
  const [confirmPhase, setConfirmPhase] = useState<"edit" | "review">("edit");
  const [isAdminView, setIsAdminView] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  /** 首页主内容：默认订阅追踪，费用报销为原报销表单 */
  const [homeMode, setHomeMode] = useState<"subscriptions" | "reimbursement">(
    "subscriptions"
  );
  const [header, setHeader] = useState<HeaderInfo>(emptyHeader);
  const [companyPresets, setCompanyPresets] = useState<string[]>(() => [
    ...COMPANY_PRESETS,
  ]);
  const [expenseCategories, setExpenseCategories] = useState<string[]>(() => [
    ...EXPENSE_CATEGORIES,
  ]);
  /** 基准币种：选「其他」时保持下拉为「其他」分支 */
  const [baseCurrencyPickCustom, setBaseCurrencyPickCustom] = useState(false);
  const [expenses, setExpenses] = useState<ExpenseLine[]>([]);

  const [lineDate, setLineDate] = useState("");
  const [lineDescription, setLineDescription] = useState("");
  const [lineCategory, setLineCategory] = useState("");
  const [lineCurrency, setLineCurrency] = useState("");
  /** 币种为空时用户选了「其他」：用于下拉保持「其他」而非 datalist 式无法再次展开 */
  const [lineCurrencyPickCustom, setLineCurrencyPickCustom] = useState(false);
  const [lineExchangeRate, setLineExchangeRate] = useState("1");
  const [lineGst, setLineGst] = useState("");
  const [lineGross, setLineGross] = useState("");
  const [lineFiles, setLineFiles] = useState<File[]>([]);
  /** 正在编辑列表中的某条（null 表示当前为「新的一条」草稿） */
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
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

  const loadFormPresets = useCallback(async () => {
    try {
      const p = await fetchFormPresets();
      setCompanyPresets(p.companies);
      setExpenseCategories(p.categories);
    } catch {
      /* API 未就绪时保留内置列表 */
    }
  }, []);

  useEffect(() => {
    void loadFormPresets();
  }, [loadFormPresets]);

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

  const lineCurrencySelectValue = useMemo(() => {
    if (lineCurrencyPickCustom) return "__custom__";
    const t = lineCurrency.trim();
    if (!t) return "";
    if (isCommonCurrencyCode(lineCurrency)) return normalizeCurrency(lineCurrency);
    return "__custom__";
  }, [lineCurrency, lineCurrencyPickCustom]);

  const baseCurrencySelectValue = useMemo(() => {
    if (baseCurrencyPickCustom) return "__custom__";
    const t = header.baseCurrency.trim();
    if (!t) return "";
    if (isCommonCurrencyCode(header.baseCurrency))
      return normalizeCurrency(header.baseCurrency);
    return "__custom__";
  }, [header.baseCurrency, baseCurrencyPickCustom]);

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

  function buildRowFromForm(id: string): ExpenseLine {
    return {
      id,
      date: lineDate,
      description: lineDescription.trim(),
      category: lineCategory,
      lineCurrency: normalizeCurrency(lineCurrency),
      exchangeRate: rateNum!,
      gst: gstNum!,
      grossAmount: grossNum!,
      files: [...lineFiles],
    };
  }

  function expenseMatchesForm(e: ExpenseLine): boolean {
    if (e.date !== lineDate) return false;
    if (e.description.trim() !== lineDescription.trim()) return false;
    if (e.category !== lineCategory) return false;
    if (normalizeCurrency(e.lineCurrency) !== normalizeCurrency(lineCurrency)) return false;
    if (Math.abs(e.exchangeRate - (rateNum ?? 0)) > 1e-9) return false;
    if (Math.abs(e.gst - (gstNum ?? NaN)) > 1e-6) return false;
    if (Math.abs(e.grossAmount - (grossNum ?? NaN)) > 1e-6) return false;
    if (e.files.length !== lineFiles.length) return false;
    for (let i = 0; i < e.files.length; i++) {
      if (fileKey(e.files[i]) !== fileKey(lineFiles[i])) return false;
    }
    return true;
  }

  function loadExpenseIntoForm(e: ExpenseLine) {
    setLineDate(e.date);
    setLineDescription(e.description);
    setLineCategory(e.category);
    setLineCurrency(e.lineCurrency);
    setLineExchangeRate(String(e.exchangeRate));
    setLineGst(String(e.gst));
    setLineGross(String(e.grossAmount));
    setLineFiles([...e.files]);
    setLineCurrencyPickCustom(!isCommonCurrencyCode(e.lineCurrency));
    setEditingExpenseId(e.id);
    setFileTick((k) => k + 1);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function hasLineDraft(): boolean {
    if (lineDate) return true;
    if (lineDescription.trim()) return true;
    if (lineCategory) return true;
    if (lineFiles.length > 0) return true;
    if (lineGst.trim() !== "") return true;
    if (lineGross.trim() !== "") return true;
    if (lineExchangeRate.trim() !== "" && lineExchangeRate !== "1") return true;
    const bc = normalizeCurrency(header.baseCurrency);
    if (lineCurrency.trim() && normalizeCurrency(lineCurrency) !== bc) return true;
    return false;
  }

  const resetLineForm = useCallback(() => {
    setLineDate("");
    setLineDescription("");
    setLineCategory("");
    setLineCurrency(normalizeCurrency(header.baseCurrency));
    setLineExchangeRate("1");
    setLineGst("");
    setLineGross("");
    setLineFiles([]);
    setFileTick((k) => k + 1);
    setLineCurrencyPickCustom(false);
    setEditingExpenseId(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [header.baseCurrency]);

  /** 列表中的行被删后，若仍指向该行则清空表单 */
  useEffect(() => {
    if (editingExpenseId && !expenses.some((e) => e.id === editingExpenseId)) {
      resetLineForm();
    }
  }, [expenses, editingExpenseId, resetLineForm]);

  function goNextStep() {
    if (!headerValid) return;
    setEditingExpenseId(null);
    setLineCurrencyPickCustom(false);
    // 从步骤 1 再次进入步骤 2 时，保留已填写中的币种与汇率（避免「上一个」改表头后点「下一个」被重置）
    setLineCurrency((prev) => {
      const t = prev.trim();
      return t ? prev : normalizeCurrency(header.baseCurrency);
    });
    setLineExchangeRate((prev) => (prev.trim() === "" ? "1" : prev));
    setStep(2);
  }

  /** 步骤 2：在已添加明细中反向浏览；在编辑上一条时回到步骤 1 */
  function handleStep2Previous() {
    if (step !== 2) return;

    let working = [...expenses];

    if (editingExpenseId !== null) {
      const idx = working.findIndex((e) => e.id === editingExpenseId);
      if (idx < 0) {
        resetLineForm();
        return;
      }
      const cur = working[idx];
      if (!expenseMatchesForm(cur)) {
        if (lineValid) {
          working[idx] = buildRowFromForm(cur.id);
          setExpenses(working);
        } else if (
          !window.confirm(
            "当前修改未通过校验，切换上一条将丢失未保存内容。是否继续？"
          )
        ) {
          return;
        }
      }

      if (idx === 0) {
        resetLineForm();
        setStep(1);
        return;
      }
      const loadIdx = idx - 1;
      loadExpenseIntoForm(working[loadIdx]);
      return;
    }

    if (working.length === 0) {
      setStep(1);
      return;
    }
    if (hasLineDraft() && !lineValid) {
      if (
        !window.confirm(
          "当前明细未保存，切换到已添加明细将丢弃当前填写。是否继续？"
        )
      ) {
        return;
      }
    } else if (lineValid) {
      if (
        !window.confirm(
          "当前明细已填写完整但未加入列表。切换将丢弃本条，是否继续？"
        )
      ) {
        return;
      }
    }
    const loadIdx = working.length - 1;
    loadExpenseIntoForm(working[loadIdx]);
  }

  function commitLineOrAppend() {
    if (
      !lineValid ||
      lineFiles.length === 0 ||
      gstNum === null ||
      grossNum === null ||
      rateNum === null
    )
      return;
    if (editingExpenseId !== null) {
      const row = buildRowFromForm(editingExpenseId);
      setExpenses((prev) =>
        prev.map((ex) => (ex.id === editingExpenseId ? row : ex))
      );
      resetLineForm();
      return;
    }
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

  function openConfirm(expensesForGallery: ExpenseLine[]) {
    setConfirmPhase("edit");
    setSubmittedReimbursementId(null);
    setDbMessage(null);
    const m = new Map<string, string[]>();
    expensesForGallery.forEach((e) =>
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
    setConfirmPhase("edit");
    setDbMessage(null);
    setConfirmOpen(false);
  }

  function goHomeSubscriptions() {
    if (confirmOpen) closeConfirm();
    setHomeMode("subscriptions");
  }

  function goReimbursement() {
    setHomeMode("reimbursement");
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
    if (editingExpenseId === expenseId) {
      resetLineForm();
    }
  }

  function handleFinish() {
    if (step !== 2) return;
    if (lineValid) {
      if (editingExpenseId !== null) {
        const row = buildRowFromForm(editingExpenseId);
        const next = expenses.map((ex) =>
          ex.id === editingExpenseId ? row : ex
        );
        setExpenses(next);
        resetLineForm();
        openConfirm(next);
        return;
      }
      window.alert(
        "当前明细已填写完整但未加入列表。请先点击「下一个」添加本条，或清空后再完成。"
      );
      return;
    }
    if (!canFinish) {
      window.alert("请至少添加一条报销明细后再完成。");
      return;
    }
    openConfirm(expenses);
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
          attachmentFilenames: expenses.flatMap((e) =>
            e.files.map((f) => f.name)
          ),
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
      setConfirmPhase("review");
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
            {!isAdminView ? (
              <div className="app-menubar-nav" role="tablist" aria-label="首页功能">
                <button
                  type="button"
                  role="tab"
                  aria-selected={homeMode === "subscriptions"}
                  className={`app-menubar-nav-btn ${homeMode === "subscriptions" ? "active" : ""}`}
                  onClick={goHomeSubscriptions}
                >
                  订阅追踪
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={homeMode === "reimbursement"}
                  className={`app-menubar-nav-btn ${homeMode === "reimbursement" ? "active" : ""}`}
                  onClick={goReimbursement}
                >
                  费用报销
                </button>
              </div>
            ) : null}
            <span className="app-menubar-tag">
              {isAdminView
                ? "后台"
                : homeMode === "subscriptions"
                  ? "订阅"
                  : "报销"}
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
              {isAuthenticated
                ? isAdminView
                  ? "退出后台"
                  : "查看后台"
                : "查看后台"}
            </button>
          </div>
        </div>
      </nav>

      <header className="app-header no-print">
        <div className="app-header-titles">
          <h1 className="app-title">
            {isAdminView
              ? "后台管理"
              : homeMode === "subscriptions"
                ? "订阅追踪"
                : "Expense Reimbursement Form"}
          </h1>
          <p className="app-sub">
            {isAdminView
              ? "SMTP 与已保存记录"
              : homeMode === "subscriptions"
                ? "订阅管理与邮件提醒"
                : "费用报销单"}
          </p>
        </div>
      </header>

      {isAdminView ? (
        <AdminPanel
          onClose={() => setIsAdminView(false)}
          onFormPresetsChanged={loadFormPresets}
        />
      ) : homeMode === "subscriptions" ? (
        <main className="app-main">
          <section className="card admin-main-card subscription-home">
            <SubscriptionPanel readOnly />
          </section>
        </main>
      ) : (
        <main className="app-main">
        {confirmOpen ? (
          <>
            {confirmPhase === "edit" ? (
              <section className="card no-print confirm-panel" aria-label="确认与选项">
                <h2 className="card-title">确认报销单</h2>
                <p className="card-hint">
                  请核对下方模板样式是否与纸质版一致。填写经理、预支与事由后，点击「保存提交」将分配编号{" "}
                  <strong>EXPYYMMXX</strong>，把合并 PDF 与全部收据写入服务器{" "}
                  <code className="admin-code">upload/</code>{" "}
                  对应文件夹，并将报销明细写入服务端 SQLite。提交成功后可下载 PDF、发邮件或打印。
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
            ) : (
              <section className="card no-print review-panel" aria-label="提交摘要">
                <h2 className="card-title">提交摘要</h2>
                {dbMessage ? (
                  <p className="review-status" role="status">
                    {dbMessage}
                  </p>
                ) : null}
                <dl className="review-dl">
                  <div className="review-dl-row">
                    <dt>申请编号</dt>
                    <dd>
                      <strong>{submittedReimbursementId ?? "—"}</strong>
                    </dd>
                  </div>
                  <div className="review-dl-row">
                    <dt>姓名</dt>
                    <dd>{header.employeeName.trim() || "—"}</dd>
                  </div>
                  <div className="review-dl-row">
                    <dt>部门</dt>
                    <dd>{header.department.trim() || "—"}</dd>
                  </div>
                  <div className="review-dl-row">
                    <dt>公司</dt>
                    <dd>{header.companyName.trim() || "—"}</dd>
                  </div>
                  <div className="review-dl-row">
                    <dt>报销期间</dt>
                    <dd>{formatIsoDateRange(header.periodFrom, header.periodTo)}</dd>
                  </div>
                  <div className="review-dl-row">
                    <dt>基准币种</dt>
                    <dd>{normalizeCurrency(header.baseCurrency) || "—"}</dd>
                  </div>
                  <div className="review-dl-row">
                    <dt>经理</dt>
                    <dd>{managerName.trim() || "—"}</dd>
                  </div>
                  <div className="review-dl-row">
                    <dt>预支抵扣</dt>
                    <dd>{cashAdvanceNum.toFixed(2)}</dd>
                  </div>
                  <div className="review-dl-row review-dl-row--span">
                    <dt>事由</dt>
                    <dd>{businessPurpose.trim() || "—"}</dd>
                  </div>
                </dl>
                {expenses.length > 0 ? (
                  <div className="table-wrap review-table-wrap">
                    <table className="expense-table review-expense-table">
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
                            <td className="attach-cell">
                              <ul className="attach-file-list review-attach-list">
                                {e.files.map((f, i) => (
                                  <li key={`${e.id}-${i}-${fileKey(f)}`}>
                                    <span className="attach-file-name" title={f.name}>
                                      {f.name}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="table-foot">
                      共 {totals.count} 条 · 折合基准币合计{" "}
                      <strong>
                        {totals.subtotalBase.toFixed(2)}{" "}
                        {normalizeCurrency(header.baseCurrency)}
                      </strong>
                    </p>
                  </div>
                ) : null}
                <p className="card-hint review-print-hint">
                  下方为表格与收据预览，可用于生成 PDF、发送邮件或打印。
                </p>
              </section>
            )}

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
                  {companyPresets.map((name) => (
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
                    <div className="currency-line-field">
                      <select
                        className="field-input"
                        aria-label="常用基准币种"
                        value={baseCurrencySelectValue}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "") {
                            setBaseCurrencyPickCustom(false);
                            setHeader((h) => ({ ...h, baseCurrency: "" }));
                          } else if (v === "__custom__") {
                            setBaseCurrencyPickCustom(true);
                          } else {
                            setBaseCurrencyPickCustom(false);
                            setHeader((h) => ({ ...h, baseCurrency: v }));
                          }
                        }}
                      >
                        <option value="">请选择</option>
                        {COMMON_CURRENCY_CODES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                        <option value="__custom__">其他（手动输入）</option>
                      </select>
                      {baseCurrencySelectValue === "__custom__" && (
                        <input
                          className="field-input currency-line-field-input"
                          value={header.baseCurrency}
                          onChange={(e) =>
                            setHeader((h) => ({
                              ...h,
                              baseCurrency: e.target.value.toUpperCase(),
                            }))
                          }
                          placeholder="三字母代码，如 CAD"
                          autoCapitalize="characters"
                          spellCheck={false}
                        />
                      )}
                    </div>
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
                      {formatIsoDateRange(header.periodFrom, header.periodTo)}
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
                  <p className="card-hint card-hint--sub">
                    底部「上一个」从已添加的<strong>最后一条</strong>起载入表单以便修改；再点则载入倒数第二条，依此类推。
                    编辑中修改在切换前会自动保存（校验通过时）；到第一条后再点「上一个」返回基本信息。
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
                        {expenseCategories.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field field-span-2">
                      <span className="field-label">币种 Line currency</span>
                      <div className="currency-line-field">
                        <select
                          className="field-input"
                          aria-label="常用币种"
                          value={lineCurrencySelectValue}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "") {
                              setLineCurrency("");
                              setLineCurrencyPickCustom(false);
                            } else if (v === "__custom__") {
                              setLineCurrencyPickCustom(true);
                            } else {
                              setLineCurrencyPickCustom(false);
                              setLineCurrency(v);
                            }
                          }}
                        >
                          <option value="">请选择</option>
                          {COMMON_CURRENCY_CODES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                          <option value="__custom__">其他（手动输入）</option>
                        </select>
                        {lineCurrencySelectValue === "__custom__" && (
                          <input
                            className="field-input currency-line-field-input"
                            value={lineCurrency}
                            onChange={(e) =>
                              setLineCurrency(e.target.value.toUpperCase())
                            }
                            placeholder="三字母代码，如 KRW"
                            autoCapitalize="characters"
                            spellCheck={false}
                          />
                        )}
                      </div>
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
                            <tr
                              key={e.id}
                              className={
                                editingExpenseId === e.id
                                  ? "expense-table-row expense-table-row--editing"
                                  : "expense-table-row"
                              }
                            >
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

      {!isAdminView && !confirmOpen && homeMode === "reimbursement" && (
        <footer className="app-footer no-print">
          <div className="footer-buttons">
            {step === 1 ? (
              <span className="footer-spacer" aria-hidden="true" />
            ) : (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleStep2Previous}
                title="从最后一条起反向载入编辑；到第一条后再点返回基本信息"
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
                title={
                  editingExpenseId
                    ? "保存对当前条的修改并清空表单以添加新的一条"
                    : "将本条加入下方列表"
                }
                onClick={commitLineOrAppend}
              >
                {editingExpenseId ? "保存本条" : "下一个"}
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

      {!isAdminView && confirmOpen && homeMode === "reimbursement" && (
        <footer className="app-footer no-print confirm-sticky-footer">
          {confirmPhase === "edit" ? (
            <>
              <div className="footer-buttons confirm-footer-grid confirm-footer-edit">
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
                  disabled={dbBusy}
                  onClick={() => void handleSaveToDatabase()}
                >
                  {dbBusy ? "正在提交…" : "保存提交"}
                </button>
              </div>
              {dbMessage ? (
                <div className="confirm-message">
                  <p>{dbMessage}</p>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="footer-buttons confirm-footer-grid confirm-footer-review">
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
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={closeConfirm}
                >
                  关闭
                </button>
              </div>
            </>
          )}
        </footer>
      )}
    </div>
  );
}
