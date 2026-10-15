/**
 * Mapa de férias em PDF (plano 63, passo 11). A lei pede o mapa feito até 15
 * de abril e afixado de 15 de abril a 31 de outubro (CT, art. 241.º, n.º 9).
 * Só FÉRIAS aprovadas — nunca baixas nem ausências. Uma linha por pessoa,
 * com os períodos e os dias úteis.
 */
import PDFDocument from "pdfkit";
import { shortDayPt } from "../shared/leaves";

const CITY_LABEL: Record<string, string> = { lisbon: "Lisboa", porto: "Porto", faro: "Faro", all: "Todas as cidades" };

export interface LeaveMapPdfInput {
  year: number;
  cityKey: string;
  rows: Array<{ fullName: string; city: string | null; periods: Array<{ fromDate: string; toDate: string; workingDays: number }>; total: number }>;
}

const period = (p: { fromDate: string; toDate: string }) =>
  p.fromDate === p.toDate ? `${shortDayPt(p.fromDate)}` : `${shortDayPt(p.fromDate)} a ${shortDayPt(p.toDate)}`;

export function renderLeaveMapPdf(input: LeaveMapPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36, info: { Title: `Mapa de férias ${input.year}`, Author: "Dashboard Multipark" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 36, width = doc.page.width - 72;
    const colName = 190, colTotal = 50, colPeriods = width - colName - colTotal;
    let y = 36;
    const header = () => {
      doc.fontSize(16).font("Helvetica-Bold").fillColor("#0055D2").text(`Mapa de férias ${input.year}`, left, y);
      y += 22;
      doc.fontSize(10).font("Helvetica").fillColor("#333").text(`${CITY_LABEL[input.cityKey] ?? input.cityKey} · só férias aprovadas`, left, y);
      y += 14;
      doc.fontSize(8).fillColor("#666").text(`Afixar de 15 de abril a 31 de outubro (Código do Trabalho, art. 241.º, n.º 9). Gerado a ${new Date().toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" })}.`, left, y);
      y += 18;
      doc.moveTo(left, y).lineTo(left + width, y).strokeColor("#d0d7e2").lineWidth(1).stroke();
      y += 6;
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#1a1a2e");
      doc.text("Nome", left, y, { width: colName });
      doc.text("Períodos de férias", left + colName, y, { width: colPeriods });
      doc.text("Dias úteis", left + colName + colPeriods, y, { width: colTotal, align: "right" });
      y += 14;
      doc.font("Helvetica").fontSize(9);
    };
    header();
    if (!input.rows.length) {
      doc.fillColor("#666").text("Ninguém neste mapa.", left, y);
    }
    let zebra = false;
    for (const r of input.rows) {
      const text = r.periods.length ? r.periods.map(period).join(" · ") : "—";
      const h = Math.max(doc.heightOfString(r.fullName, { width: colName - 6 }), doc.heightOfString(text, { width: colPeriods - 6 })) + 6;
      if (y + h > doc.page.height - 40) {
        doc.addPage();
        y = 36;
        header();
      }
      if (zebra) { doc.save(); doc.rect(left, y - 2, width, h).fillColor("#f4f7fc").fill(); doc.restore(); }
      zebra = !zebra;
      doc.fillColor("#1a1a2e").text(r.fullName, left + 2, y, { width: colName - 6 });
      doc.fillColor("#333").text(text, left + colName, y, { width: colPeriods - 6 });
      doc.fillColor("#1a1a2e").text(String(r.total), left + colName + colPeriods, y, { width: colTotal, align: "right" });
      y += h;
    }
    doc.end();
  });
}
