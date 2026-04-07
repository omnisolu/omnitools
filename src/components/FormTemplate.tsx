import { forwardRef } from "react";
import { currenciesMatch, normalizeCurrency } from "../currencies";
import type { ExpenseLine, HeaderInfo } from "../types";
import "./FormTemplate.css";

export interface FormTemplateProps {
  header: HeaderInfo;
  expenses: ExpenseLine[];
  cashAdvance: number;
  businessPurpose?: string;
  managerName?: string;
  /** 提交后由服务器分配的编号 EXPYYMMXX */
  reimbursementCode?: string | null;
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${y}/${m}/${d}`;
}

function lineSubtotal(gross: number, gst: number): number {
  return Math.max(0, gross - gst);
}

function toBase(amount: number, rate: number): number {
  return amount * rate;
}

/** 明细表额外列：存在任一行币种与基准不一致时显示 */
function needsFxColumns(base: string, expenses: ExpenseLine[]): boolean {
  const b = normalizeCurrency(base);
  if (!b) return false;
  return expenses.some((e) => !currenciesMatch(e.lineCurrency, b));
}

const FormTemplate = forwardRef<HTMLDivElement, FormTemplateProps>(
  function FormTemplate(
    { header, expenses, cashAdvance, businessPurpose, managerName, reimbursementCode },
    ref
  ) {
    const baseCode = normalizeCurrency(header.baseCurrency);
    const showFx = needsFxColumns(header.baseCurrency, expenses);
    const metaRows = reimbursementCode ? 7 : 6;

    const subtotalBase = expenses.reduce(
      (s, e) => s + toBase(e.grossAmount, e.exchangeRate),
      0
    );
    const safeAdvance = Math.max(0, cashAdvance);
    const reimbursementBase = Math.max(0, subtotalBase - safeAdvance);

    return (
      <div ref={ref} className="form-template">
        <header className="form-template__banner">
          <h1 className="form-template__title">
            Expense Reimbursement Form
          </h1>
          <div className="form-template__company">
            {header.companyName.trim() || "—"}
          </div>
        </header>

        <table className="form-template__meta" aria-label="Employee and period">
          <tbody>
            <tr>
              <th scope="row" className="form-template__meta-label">
                Employee Name
              </th>
              <td className="form-template__meta-value">
                {header.employeeName.trim() || "—"}
              </td>
              <td className="form-template__period" rowSpan={metaRows}>
                <div className="form-template__period-title">Expense Period</div>
                <div className="form-template__period-fields">
                  <div>
                    <span className="form-template__period-key">From:</span>{" "}
                    {formatDate(header.periodFrom)}
                  </div>
                  <div>
                    <span className="form-template__period-key">To:</span>{" "}
                    {formatDate(header.periodTo)}
                  </div>
                </div>
              </td>
            </tr>
            {reimbursementCode ? (
              <tr>
                <th scope="row" className="form-template__meta-label">
                  Submission No.
                </th>
                <td className="form-template__meta-value">{reimbursementCode}</td>
              </tr>
            ) : null}
            <tr>
              <th scope="row" className="form-template__meta-label">
                Manager Name
              </th>
              <td className="form-template__meta-value">
                {managerName?.trim() || "—"}
              </td>
            </tr>
            <tr>
              <th scope="row" className="form-template__meta-label">
                Department
              </th>
              <td className="form-template__meta-value">
                {header.department.trim() || "—"}
              </td>
            </tr>
            <tr>
              <th scope="row" className="form-template__meta-label">
                Company
              </th>
              <td className="form-template__meta-value">
                {header.companyName.trim() || "—"}
              </td>
            </tr>
            <tr>
              <th scope="row" className="form-template__meta-label">
                Base currency
              </th>
              <td className="form-template__meta-value">
                {baseCode || "—"}
                <span className="form-template__meta-hint">
                  （本次结算与合计均以该币种为准）
                </span>
              </td>
            </tr>
            <tr>
              <th scope="row" className="form-template__meta-label">
                Business Purpose
              </th>
              <td className="form-template__meta-value form-template__meta-purpose">
                {businessPurpose?.trim() || "—"}
              </td>
            </tr>
          </tbody>
        </table>

        {showFx && (
          <p className="form-template__fx-note">
            Subtotal / GST / TOTAL 列为<strong>本行币种</strong>金额；Home
            Currency（{baseCode}）列为按汇率折算后的<strong>基准币种</strong>金额。
          </p>
        )}

        <table className="form-template__grid" aria-label="Expense lines">
          <thead>
            <tr>
              <th className="col-date">DATE</th>
              <th className="col-desc">DESCRIPTION</th>
              <th className="col-cat">CATEGORY</th>
              {showFx && (
                <>
                  <th className="col-ccy">Curr</th>
                  <th className="col-rate">Rate</th>
                </>
              )}
              <th className="col-num">Subtotal</th>
              <th className="col-num">GST</th>
              <th className="col-num">PST</th>
              <th className="col-num">TOTAL</th>
              {showFx && (
                <th className="col-home">
                  Home Currency
                  <span className="form-template__th-sub">({baseCode})</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => {
              const sub = lineSubtotal(e.grossAmount, e.gst);
              const r = e.exchangeRate;
              return (
                <tr key={e.id}>
                  <td>{formatDate(e.date)}</td>
                  <td>{e.description}</td>
                  <td>{e.category}</td>
                  {showFx && (
                    <>
                      <td className="ccy">{normalizeCurrency(e.lineCurrency)}</td>
                      <td className="num rate-cell">{r.toFixed(6)}</td>
                    </>
                  )}
                  <td className="num">{sub.toFixed(2)}</td>
                  <td className="num">{e.gst.toFixed(2)}</td>
                  <td className="num">—</td>
                  <td className="num">{e.grossAmount.toFixed(2)}</td>
                  {showFx && (
                    <td className="form-template__home-cell num">
                      <div className="form-template__home-stack">
                        <span>Sub {toBase(sub, r).toFixed(2)}</span>
                        <span>GST {toBase(e.gst, r).toFixed(2)}</span>
                        <span>Tot {toBase(e.grossAmount, r).toFixed(2)}</span>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="form-template__totals-wrap">
          <table className="form-template__totals-table">
            <tbody>
              <tr>
                <th scope="row">SUBTOTAL ({baseCode || "—"})</th>
                <td className="num">{subtotalBase.toFixed(2)}</td>
              </tr>
              <tr>
                <th scope="row">Less Cash Advance ({baseCode || "—"})</th>
                <td className="num">{safeAdvance.toFixed(2)}</td>
              </tr>
              <tr className="form-template__total-row">
                <th scope="row">TOTAL REIMBURSEMENT ({baseCode || "—"})</th>
                <td className="num form-template__total-amount">
                  {reimbursementBase.toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="form-template__receipt-note">
          Don&apos;t forget to attach receipts!
        </p>

        <div className="form-template__signatures">
          <div className="form-template__sig-block">
            <div className="form-template__sig-row">
              <div className="form-template__sig-line-wrap">
                <span className="form-template__sig-line" />
              </div>
              <div className="form-template__date-slot">
                <span className="form-template__date-label">Date</span>
                <span className="form-template__date-line" />
              </div>
            </div>
            <span className="form-template__sig-caption">Employee Signature</span>
          </div>
          <div className="form-template__sig-block">
            <div className="form-template__sig-row">
              <div className="form-template__sig-line-wrap">
                <span className="form-template__sig-line" />
              </div>
              <div className="form-template__date-slot">
                <span className="form-template__date-label">Date</span>
                <span className="form-template__date-line" />
              </div>
            </div>
            <span className="form-template__sig-caption">Approval Signature</span>
          </div>
        </div>
      </div>
    );
  }
);

FormTemplate.displayName = "FormTemplate";

export default FormTemplate;
