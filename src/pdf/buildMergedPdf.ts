import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { PDFDocument } from "pdf-lib";
import type { ExpenseLine } from "../types";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

/** Raster receipt → PNG bytes for pdf-lib */
async function rasterFileToPngBytes(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png")
  );
  if (!blob) throw new Error("Failed to encode image");
  return new Uint8Array(await blob.arrayBuffer());
}

function addMultipageImage(
  pdf: jsPDF,
  imgData: string,
  canvasWidth: number,
  canvasHeight: number
): void {
  const margin = 40;
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const contentW = pageW - 2 * margin;
  const contentH = pageH - 2 * margin;
  const imgH = (canvasHeight * contentW) / canvasWidth;

  let heightLeft = imgH;
  pdf.addImage(imgData, "PNG", margin, margin, contentW, imgH);
  heightLeft -= contentH;

  while (heightLeft > 0) {
    const y = margin - (imgH - heightLeft);
    pdf.addPage();
    pdf.addImage(imgData, "PNG", margin, y, contentW, imgH);
    heightLeft -= contentH;
  }
}

/**
 * 1) Renders the form DOM to one or more PDF pages (jsPDF).
 * 2) Appends each receipt: PDF files via pdf-lib copyPages; images as fitted pages.
 */
export async function buildMergedReimbursementPdf(
  formElement: HTMLElement,
  expenses: ExpenseLine[]
): Promise<Uint8Array> {
  const canvas = await html2canvas(formElement, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: "#ffffff",
  });
  const imgData = canvas.toDataURL("image/png");

  const pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
  addMultipageImage(pdf, imgData, canvas.width, canvas.height);
  const formBytes = new Uint8Array(pdf.output("arraybuffer"));

  const merged = await PDFDocument.create();
  const formDoc = await PDFDocument.load(formBytes);
  const formPages = await merged.copyPages(
    formDoc,
    formDoc.getPageIndices()
  );
  formPages.forEach((p) => merged.addPage(p));

  for (const e of expenses) {
    for (const file of e.files) {
      if (isPdfFile(file)) {
        try {
          const raw = await file.arrayBuffer();
          const src = await PDFDocument.load(raw, { ignoreEncryption: true });
          const pages = await merged.copyPages(src, src.getPageIndices());
          pages.forEach((p) => merged.addPage(p));
        } catch {
          // skip unreadable PDF
        }
      } else {
        try {
          const pngBytes = await rasterFileToPngBytes(file);
          const image = await merged.embedPng(pngBytes);
          const pageSize: [number, number] = [595.28, 841.89];
          const page = merged.addPage(pageSize);
          const iw = image.width;
          const ih = image.height;
          const pw = pageSize[0] - 72;
          const ph = pageSize[1] - 72;
          const scale = Math.min(pw / iw, ph / ih);
          const w = iw * scale;
          const h = ih * scale;
          const x = (pageSize[0] - w) / 2;
          const y = (pageSize[1] - h) / 2;
          page.drawImage(image, { x, y, width: w, height: h });
        } catch {
          // skip unsupported image
        }
      }
    }
  }

  return merged.save();
}
