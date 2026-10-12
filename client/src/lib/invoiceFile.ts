/**
 * Fatura/talão antes de ir para o servidor — o mesmo caminho nas Despesas e
 * nas Despesas do turno (Passagem de turno). Saiu da página das Despesas.
 *  - fotos acima de 1,5 MB são comprimidas (1600 px, q0.85): o pedido à
 *    Vercel tem limite de ~4,5 MB e o base64 aumenta ~33%;
 *  - PDFs: o PDF original é o que fica guardado; para a IA (e a pré-visualização)
 *    vai uma imagem PNG das primeiras páginas.
 */
import { compressImage } from "@/lib/compressImage";

/** Limite depois de comprimir (acima disto o pedido rebenta no limite da Vercel). */
export const INVOICE_MAX_BYTES = 3_200_000;

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// Converte as primeiras páginas de um PDF numa única imagem PNG (empilhadas
// na vertical) para o preview e o OCR por IA. pdf.js é importado on-demand
// para não pesar no bundle de quem nunca carrega PDFs.
export async function pdfToPngDataUrl(file: File, maxPages = 2): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = Math.min(pdf.numPages, maxPages);
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 }); // A4 → ~1190×1684, bom para OCR
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport } as any).promise;
    canvases.push(canvas);
  }
  if (canvases.length === 1) return canvases[0].toDataURL("image/png");
  const out = document.createElement("canvas");
  out.width = Math.max(...canvases.map((c) => c.width));
  out.height = canvases.reduce((s, c) => s + c.height, 0);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const c of canvases) { ctx.drawImage(c, 0, y); y += c.height; }
  return out.toDataURL("image/png");
}

export interface PreparedInvoice {
  isPdf: boolean;
  /** O que se guarda (o PDF original ou a foto comprimida). */
  upload: { fileName: string; base64: string; mimeType: string };
  /** O que vai para a IA (a foto, ou o PNG das páginas do PDF). */
  ai: { base64: string; mimeType: string };
}

/** Comprime/converte como nas Despesas. Lança Error com a mensagem para o toast se for grande demais. */
export async function prepareInvoiceFile(file: File): Promise<PreparedInvoice> {
  const isPdf = isPdfFile(file);
  let uploadFile = file;
  if (!isPdf && file.type.startsWith("image/") && file.size > 1_500_000) uploadFile = await compressImage(file, 1600, 0.85);
  if (uploadFile.size > INVOICE_MAX_BYTES) {
    throw new Error(isPdf ? "Ficheiro demasiado grande (máx ~3MB) — tenta um PDF mais pequeno ou fotografa o talão." : "Ficheiro demasiado grande (máx ~3MB depois de comprimido).");
  }
  const base64 = await fileToBase64(uploadFile);
  const mimeType = uploadFile.type || (isPdf ? "application/pdf" : "image/jpeg");
  let ai = { base64, mimeType };
  if (isPdf) {
    const png = await pdfToPngDataUrl(file);
    ai = { base64: png.split(",")[1] ?? "", mimeType: "image/png" };
  }
  return { isPdf, upload: { fileName: file.name, base64, mimeType }, ai };
}
