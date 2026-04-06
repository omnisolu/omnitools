import type { SmtpSettings } from "./types";

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
