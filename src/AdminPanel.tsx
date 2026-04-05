import { useEffect, useState } from "react";
import { getAllReimbursementData, ReimbursementRecord, ExpenseLineRecord } from "./db";

interface AdminPanelProps {
  onClose: () => void;
}

interface ReimbursementWithExpenses {
  reimbursement: ReimbursementRecord;
  expenses: ExpenseLineRecord[];
}

function formatMoney(value: number, currency: string) {
  const code = currency.trim() || "";
  return `${value.toFixed(2)} ${code}`.trim();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

export default function AdminPanel({ onClose }: AdminPanelProps) {
  const [records, setRecords] = useState<ReimbursementWithExpenses[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const list = await getAllReimbursementData();
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

  return (
    <section className="card admin-page">
      <div className="admin-header">
        <div>
          <h2 className="card-title">后台提交记录</h2>
          <p className="card-hint">查看已保存到本地数据库的报销单及明细。</p>
        </div>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          返回报销表单
        </button>
      </div>

      {loading ? (
        <div className="admin-empty">正在加载提交记录…</div>
      ) : error ? (
        <div className="admin-empty">读取失败：{error}</div>
      ) : records.length === 0 ? (
        <div className="admin-empty">当前尚未保存任何报销单。</div>
      ) : (
        records.map(({ reimbursement, expenses }) => (
          <div key={reimbursement.id} className="admin-record">
            <div className="admin-record-header">
              <div>
                <p className="admin-record-meta">
                  提交时间：{formatDate(reimbursement.createdAt)}
                </p>
                <h3 className="admin-record-title">{reimbursement.header.employeeName} 的报销单</h3>
              </div>
              <div className="admin-record-summary">
                <span>{reimbursement.header.department}</span>
                <span>{reimbursement.header.companyName}</span>
                <span>{reimbursement.header.baseCurrency}</span>
              </div>
            </div>

            <div className="admin-fields">
              <div className="admin-field">
                <strong>期间</strong>
                <span>
                  {reimbursement.header.periodFrom} — {reimbursement.header.periodTo}
                </span>
              </div>
              <div className="admin-field">
                <strong>经理</strong>
                <span>{reimbursement.managerName || "（未填写）"}</span>
              </div>
              <div className="admin-field">
                <strong>预支抵扣</strong>
                <span>{formatMoney(reimbursement.cashAdvance, reimbursement.header.baseCurrency)}</span>
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
                      <td>{expense.date}</td>
                      <td>{expense.category}</td>
                      <td>{expense.description}</td>
                      <td>{expense.lineCurrency}</td>
                      <td className="num">{expense.exchangeRate.toFixed(4)}</td>
                      <td className="num">{expense.grossAmount.toFixed(2)}</td>
                      <td className="num">{(expense.grossAmount * expense.exchangeRate).toFixed(2)}</td>
                      <td>{expense.fileName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
