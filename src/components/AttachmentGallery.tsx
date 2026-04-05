import type { ExpenseLine } from "../types";
import "./AttachmentGallery.css";

export interface AttachmentItem {
  expenseId: string;
  label: string;
  url: string;
  isPdf: boolean;
}

export default function AttachmentGallery({ items }: { items: AttachmentItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="attachment-gallery" aria-label="Receipt attachments">
      <h2 className="attachment-gallery__title">Receipts / 收据附件</h2>
      <p className="attachment-gallery__hint">
        打印或合并 PDF 时，下列内容与表格一并输出。
      </p>
      <ul className="attachment-gallery__list">
        {items.map((item) => (
          <li key={item.expenseId} className="attachment-gallery__item">
            <div className="attachment-gallery__caption">{item.label}</div>
            {item.isPdf ? (
              <iframe
                title={item.label}
                src={item.url}
                className="attachment-gallery__pdf"
              />
            ) : (
              <img
                src={item.url}
                alt={item.label}
                className="attachment-gallery__img"
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function attachmentItemsFromExpenses(
  expenses: ExpenseLine[],
  urls: Map<string, string>
): AttachmentItem[] {
  return expenses.map((e) => ({
    expenseId: e.id,
    label: `${e.date} · ${e.description} · ${e.file.name}`,
    url: urls.get(e.id) ?? "",
    isPdf:
      e.file.type === "application/pdf" ||
      e.file.name.toLowerCase().endsWith(".pdf"),
  }));
}
