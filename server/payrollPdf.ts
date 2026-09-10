/**
 * Payroll PDF generation using PDFKit
 * Generates a formatted payroll report for accountants
 */
import PDFDocument from "pdfkit";
import { getPayrollData } from "./db";

const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

const fmt = (v: number) => v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function generatePayrollPdf(year: number, month: number): Promise<Buffer> {
  const payroll = await getPayrollData(year, month);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 30,
      info: {
        Title: `Folha de Ordenados - ${MONTH_NAMES[month - 1]} ${year}`,
        Author: "Dashboard Multipark",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width - 60; // margins
    const startX = 30;
    let y = 30;

    // ─── HEADER ─────────────────────────────────────────────────────────
    doc.fontSize(18).font("Helvetica-Bold").fillColor("#1a1a2e")
      .text("Dashboard Multipark", startX, y);
    y += 25;
    doc.fontSize(14).font("Helvetica")
      .text(`Folha de Ordenados — ${MONTH_NAMES[month - 1]} ${year}`, startX, y);
    y += 18;
    doc.fontSize(9).fillColor("#666")
      .text(`Gerado em: ${new Date().toLocaleDateString("pt-PT")} às ${new Date().toLocaleTimeString("pt-PT")}`, startX, y);
    y += 25;

    // ─── SEPARATOR ──────────────────────────────────────────────────────
    doc.moveTo(startX, y).lineTo(startX + pageW, y).strokeColor("#ddd").lineWidth(1).stroke();
    y += 10;

    // ─── TOTALS SUMMARY ────────────────────────────────────────────────
    const totals = payroll.reduce((acc, r) => ({
      totalHours: acc.totalHours + r.totalHours,
      baseSalary: acc.baseSalary + r.baseSalary,
      extraPayment: acc.extraPayment + r.extraPayment,
      overtimePayment: acc.overtimePayment + r.overtimePayment,
      thirteenthProvision: acc.thirteenthProvision + r.thirteenthProvision,
      totalPayment: acc.totalPayment + r.totalPayment,
    }), { totalHours: 0, baseSalary: 0, extraPayment: 0, overtimePayment: 0, thirteenthProvision: 0, totalPayment: 0 });

    const summaryBoxW = pageW / 4;
    const summaryItems = [
      { label: "Total Horas", value: `${fmt(totals.totalHours)}h` },
      { label: "Salários Base", value: `${fmt(totals.baseSalary)}€` },
      { label: "Extras + H.Extra", value: `${fmt(totals.extraPayment + totals.overtimePayment)}€` },
      { label: "Total a Pagar", value: `${fmt(totals.totalPayment)}€` },
    ];

    summaryItems.forEach((item, i) => {
      const bx = startX + i * summaryBoxW;
      doc.save();
      doc.roundedRect(bx + 2, y, summaryBoxW - 4, 40, 4).fillColor("#f8f9fa").fill();
      doc.restore();
      doc.fontSize(8).fillColor("#888").text(item.label, bx + 10, y + 8);
      doc.fontSize(12).font("Helvetica-Bold").fillColor("#1a1a2e").text(item.value, bx + 10, y + 20);
      doc.font("Helvetica");
    });
    y += 52;

    // ─── TABLE ──────────────────────────────────────────────────────────
    // Column definitions [label, width, align]
    const cols: [string, number, string][] = [
      ["Nome", 140, "left"],
      ["Posto", 70, "left"],
      ["Dept.", 60, "left"],
      ["NIF", 70, "left"],
      ["Horas", 45, "right"],
      ["Dias", 35, "right"],
      ["Sal. Base", 60, "right"],
      ["Extra", 55, "right"],
      ["H.Extra", 45, "right"],
      ["Pag.H.Extra", 60, "right"],
      ["Prov.13º", 55, "right"],
      ["Total", 65, "right"],
    ];

    // Scale columns to fit page
    const totalColW = cols.reduce((s, c) => s + c[1], 0);
    const scale = pageW / totalColW;
    const scaledCols = cols.map(([l, w, a]) => [l, Math.floor(w * scale), a] as [string, number, string]);

    // Header row
    doc.save();
    doc.rect(startX, y, pageW, 18).fillColor("#1a1a2e").fill();
    doc.restore();
    let cx = startX;
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#fff");
    scaledCols.forEach(([label, w, align]) => {
      if (align === "right") {
        doc.text(label, cx, y + 5, { width: w - 4, align: "right" });
      } else {
        doc.text(label, cx + 4, y + 5, { width: w - 4, align: "left" });
      }
      cx += w;
    });
    y += 18;

    // Data rows
    doc.font("Helvetica").fillColor("#333");
    const posLabels: Record<string, string> = {
      director: "Diretor", supervisor: "Supervisor", team_leader: "Chefe Eq.",
      backoffice: "Backoffice", driver: "Motorista", valet: "Valet",
      dispatcher: "Dispatcher", extra: "Extra",
    };

    payroll.forEach((r, idx) => {
      // Check if we need a new page
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = 30;
      }

      const bgColor = idx % 2 === 0 ? "#ffffff" : "#f8f9fa";
      doc.save();
      doc.rect(startX, y, pageW, 16).fillColor(bgColor).fill();
      doc.restore();

      const rowData = [
        r.fullName,
        (posLabels[r.position ?? ""] ?? r.position ?? "—") + (r.isExtra && r.extraLevel ? ` N${r.extraLevel}` : ""),
        r.department ?? "—",
        r.nif ?? "—",
        `${fmt(r.totalHours)}h`,
        String(r.daysWorked),
        r.isExtra ? "—" : `${fmt(r.baseSalary)}€`,
        r.isExtra ? `${fmt(r.extraPayment)}€` : "—",
        r.isExtra ? "—" : `${fmt(r.overtimeHours)}h`,
        r.isExtra ? "—" : `${fmt(r.overtimePayment)}€`,
        r.isExtra ? "—" : `${fmt(r.thirteenthProvision)}€`,
        `${fmt(r.totalPayment)}€`,
      ];

      cx = startX;
      doc.fontSize(7).fillColor("#333");
      scaledCols.forEach(([, w, align], ci) => {
        const val = rowData[ci];
        if (ci === scaledCols.length - 1) {
          doc.font("Helvetica-Bold").fillColor("#1a1a2e");
        }
        if (align === "right") {
          doc.text(val, cx, y + 4, { width: w - 4, align: "right" });
        } else {
          doc.text(val, cx + 4, y + 4, { width: w - 4, align: "left" });
        }
        if (ci === scaledCols.length - 1) {
          doc.font("Helvetica").fillColor("#333");
        }
        cx += w;
      });
      y += 16;
    });

    // Totals row
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = 30;
    }
    doc.save();
    doc.rect(startX, y, pageW, 18).fillColor("#e8eaf0").fill();
    doc.restore();
    const totalsRow = [
      "TOTAIS", "", "", "",
      `${fmt(totals.totalHours)}h`, "",
      `${fmt(totals.baseSalary)}€`,
      `${fmt(totals.extraPayment)}€`,
      "", `${fmt(totals.overtimePayment)}€`,
      `${fmt(totals.thirteenthProvision)}€`,
      `${fmt(totals.totalPayment)}€`,
    ];
    cx = startX;
    doc.fontSize(7).font("Helvetica-Bold").fillColor("#1a1a2e");
    scaledCols.forEach(([, w, align], ci) => {
      if (align === "right") {
        doc.text(totalsRow[ci], cx, y + 5, { width: w - 4, align: "right" });
      } else {
        doc.text(totalsRow[ci], cx + 4, y + 5, { width: w - 4, align: "left" });
      }
      cx += w;
    });
    y += 30;

    // ─── FOOTER ─────────────────────────────────────────────────────────
    doc.fontSize(8).font("Helvetica").fillColor("#999")
      .text(`Dashboard Multipark | ${payroll.length} colaboradores | ${MONTH_NAMES[month - 1]} ${year}`, startX, y, { align: "center", width: pageW });

    doc.end();
  });
}
