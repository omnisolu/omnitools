import type { ExpenseLine } from "../types";
import "./AttachmentGallery.css";

export interface AttachmentItem {
  /** 稳定键（同一明细多附件时唯一） */
  itemKey: string;
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
          <li key={item.itemKey} className="attachment-gallery__item">
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
  urls: Map<string, string[]>
): AttachmentItem[] {
  const items: AttachmentItem[] = [];
  for (const e of expenses) {
    const urlList = urls.get(e.id) ?? [];
    e.files.forEach((file, idx) => {
      items.push({
        itemKey: `${e.id}-${idx}`,
        expenseId: e.id,
        label: `${e.date} · ${e.description} · ${file.name}`,
        url: urlList[idx] ?? "",
        isPdf:
          file.type === "application/pdf" ||
          file.name.toLowerCase().endsWith(".pdf"),
      });
    });
  }
  return items;
}
