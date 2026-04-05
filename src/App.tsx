import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AttachmentGallery, {
  attachmentItemsFromExpenses,
} from "./components/AttachmentGallery";
import FormTemplate from "./components/FormTemplate";
import { COMPANY_PRESETS } from "./company";
import { COMMON_CURRENCY_CODES, normalizeCurrency } from "./currencies";
import { EXPENSE_CATEGORIES } from "./categories";
import { buildMergedReimbursementPdf } from "./pdf/buildMergedPdf";
import { saveReimbursement } from "./db";
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
  const [lineFile, setLineFile] = useState<File | null>(null);
  const [fileTick, setFileTick] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [cashAdvanceStr, setCashAdvanceStr] = useState("0");
  const [managerName, setManagerName] = useState("");
  const [businessPurpose, setBusinessPurpose] = useState("");
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMessage, setDbMessage] = useState<string | null>(null);
  const [blobUrlByExpenseId, setBlobUrlByExpenseId] = useState<
    Map<string, string>
  >(() => new Map());
  const [pdfBusy, setPdfBusy] = useState(false);

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
    lineFile !== null &&
    isAllowedAttachment(lineFile);

  const canFinish = expenses.length > 0;

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

  const revokeBlobUrls = useCallback((m: Map<string, string>) => {
    m.forEach((url) => URL.revokeObjectURL(url));
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
    setLineFile(null);
    setFileTick((k) => k + 1);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function goNextStep() {
    if (!headerValid) return;
    setLineCurrency(normalizeCurrency(header.baseCurrency));
    setLineExchangeRate("1");
    setStep(2);
  }

  function goPreviousStep() {
    setStep(1);
  }

  function appendExpense() {
    if (
      !lineValid ||
      !lineFile ||
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
      file: lineFile,
    };
    setExpenses((prev) => [...prev, row]);
    resetLineForm();
  }

  function openConfirm() {
    const m = new Map<string, string>();
    expenses.forEach((e) => m.set(e.id, URL.createObjectURL(e.file)));
    setBlobUrlByExpenseId(m);
    setConfirmOpen(true);
  }

  function closeConfirm() {
    setBlobUrlByExpenseId(new Map());
    setConfirmOpen(false);
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
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Expense-Reimbursement-${header.employeeName.trim().replace(/\s+/g, "_") || "draft"}.pdf`;
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

  async function handleSaveToDatabase() {
    setDbBusy(true);
    setDbMessage(null);
    try {
      await saveReimbursement({
        id: randomId(),
        header,
        cashAdvance: cashAdvanceNum,
        managerName,
        businessPurpose,
        expenses,
      });
      setDbMessage("已保存到本地数据库。");
    } catch (error) {
      console.error(error);
      setDbMessage("保存失败，请确认浏览器支持 IndexedDB。请在支持 IndexedDB 的浏览器中重试。");
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
      <header className="app-header no-print">
        <div>
          <h1 className="app-title">Expense Reimbursement Form</h1>
          <p className="app-sub">费用报销单</p>
        </div>
        <div className="app-header-right">
          <div className="app-brand">{header.companyName.trim() || "—"}</div>
          <button
            type="button"
            className="btn btn--ghost app-admin-toggle"
            onClick={handleAdminToggle}
          >
            {isAuthenticated ? (isAdminView ? "返回报销" : "查看后台") : "查看后台"}
          </button>
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
                全部收据）或使用打印。
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
                    每条须上传附件；信息齐全后「下一个」才可点。
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
                      <span className="field-label">附件（图片或 PDF）</span>
                      <div className="file-row">
                        <input
                          key={fileTick}
                          ref={fileInputRef}
                          type="file"
                          accept="image/*,.pdf,application/pdf"
                          className="file-input"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            setLineFile(f && isAllowedAttachment(f) ? f : null);
                            if (f && !isAllowedAttachment(f)) {
                              window.alert("仅支持图片或 PDF 文件。");
                              e.target.value = "";
                            }
                          }}
                        />
                        {lineFile && (
                          <span className="file-name" title={lineFile.name}>
                            {lineFile.name}
                          </span>
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
                              <td className="attach-cell" title={e.file.name}>
                                {e.file.name}
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
              disabled={dbBusy}
              onClick={() => void handleSaveToDatabase()}
            >
              {dbBusy ? "正在保存…" : "保存到数据库"}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={pdfBusy}
              onClick={() => void handleDownloadMergedPdf()}
            >
              {pdfBusy ? "正在生成…" : "下载合并 PDF"}
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
