import type { ExpenseLine, HeaderInfo, SmtpSettings } from "./types";
import type { ExpenseLineRecord, ReimbursementRecord } from "./records";

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_EMAIL_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";
  return base ? `${base}${path}` : path;
}

function parseErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string };
    return j.error || body;
  } catch {
    return body || "请求失败";
  }
}

export interface SubmitReimbursementManifest {
  header: HeaderInfo;
  cashAdvance: number;
  managerName: string;
  businessPurpose: string;
  lines: Array<{
    expenseLineId: string;
    date: string;
    description: string;
    category: string;
    lineCurrency: string;
    exchangeRate: number;
    gst: number;
    grossAmount: number;
    attachmentCount: number;
  }>;
}

export async function submitExpenseReimbursementToServer(options: {
  pdfBytes: Uint8Array;
  expenses: ExpenseLine[];
  manifest: SubmitReimbursementManifest;
}): Promise<{ reimbursementId: string }> {
  const { pdfBytes, expenses, manifest } = options;
  const form = new FormData();
  form.append(
    "pdf",
    new Blob([pdfBytes as BlobPart], { type: "application/pdf" }),
    "merged.pdf"
  );
  form.append("manifest", JSON.stringify(manifest));
  for (const e of expenses) {
    for (const f of e.files) {
      form.append("attachments", f, f.name);
    }
  }
  const res = await fetch(apiUrl("/api/submit-reimbursement"), {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  const j = JSON.parse(text) as { reimbursementId?: string };
  if (!j.reimbursementId) {
    throw new Error("服务器未返回报销编号。");
  }
  return { reimbursementId: j.reimbursementId };
}

export async function fetchReimbursementsFromServer(): Promise<
  Array<{ reimbursement: ReimbursementRecord; expenses: ExpenseLineRecord[] }>
> {
  const res = await fetch(apiUrl("/api/reimbursements"));
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  const j = JSON.parse(text) as {
    ok?: boolean;
    data?: Array<{ reimbursement: ReimbursementRecord; expenses: ExpenseLineRecord[] }>;
  };
  if (!j.data) {
    throw new Error("服务器未返回报销列表。");
  }
  return j.data;
}

export async function sendExpensePdfEmail(options: {
  smtp: SmtpSettings;
  to: string;
  pdfBytes: Uint8Array;
  filename: string;
  subject: string;
}): Promise<void> {
  const { smtp, to, pdfBytes, filename, subject } = options;
  const form = new FormData();
  form.append("to", to);
  form.append("subject", subject);
  form.append("filename", filename);
  form.append("smtp", JSON.stringify(smtp));
  form.append("pdf", new Blob([pdfBytes as BlobPart], { type: "application/pdf" }), filename);

  const res = await fetch(apiUrl("/api/send-expense-pdf"), {
    method: "POST",
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
}

export async function sendSmtpTestEmail(smtp: SmtpSettings): Promise<void> {
  const res = await fetch(apiUrl("/api/test-smtp"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(smtp),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
}
