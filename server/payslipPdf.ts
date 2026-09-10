/**
 * Individual Payslip PDF generation using PDFKit
 * Generates a formatted payslip for a single employee
 */
import PDFDocument from "pdfkit";
import { getPayrollData } from "./db";

const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

const fmt = (v: number) => v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const POS_LABELS: Record<string, string> = {
  director: "Diretor", supervisor: "Supervisor", team_leader: "Chefe de Equipa",
  backoffice: "Backoffice", driver: "Motorista", valet: "Valet",
  dispatcher: "Dispatcher", extra: "Extra",
};

export async function generatePayslipPdf(year: number, month: number, employeeId: number): Promise<Buffer> {
  const allPayroll = await getPayrollData(year, month);
  const emp = allPayroll.find(e => e.employeeId === employeeId);
  if (!emp) throw new Error("Funcionário não encontrado nos dados de payroll");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "portrait",
      margin: 50,
      info: {
        Title: `Recibo Vencimento - ${emp.fullName} - ${MONTH_NAMES[month - 1]} ${year}`,
        Author: "Dashboard Multipark",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageW = doc.page.width - 100; // margins 50 each side
    const startX = 50;
    let y = 50;

    // ─── COMPANY HEADER ─────────────────────────────────────────────────
    doc.save();
    doc.rect(startX, y, pageW, 70).fillColor("#1a1a2e").fill();
    doc.restore();

    doc.fontSize(20).font("Helvetica-Bold").fillColor("#ffffff")
      .text("Dashboard Multipark", startX + 20, y + 15);
    doc.fontSize(10).font("Helvetica").fillColor("#c0c0d0")
      .text("Recibo de Vencimento", startX + 20, y + 42);
    doc.fontSize(12).font("Helvetica-Bold").fillColor("#ffffff")
      .text(`${MONTH_NAMES[month - 1]} ${year}`, startX + pageW - 150, y + 25, { width: 130, align: "right" });
    y += 85;

    // ─── EMPLOYEE INFO ──────────────────────────────────────────────────
    doc.save();
    doc.rect(startX, y, pageW, 90).fillColor("#f4f5f7").fill();
    doc.restore();

    const colW = pageW / 2;
    const infoStartY = y + 12;

    // Left column
    doc.fontSize(8).font("Helvetica").fillColor("#888").text("NOME COMPLETO", startX + 15, infoStartY);
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#1a1a2e").text(emp.fullName, startX + 15, infoStartY + 12);

    doc.fontSize(8).font("Helvetica").fillColor("#888").text("CARGO / POSIÇÃO", startX + 15, infoStartY + 35);
    const posLabel = POS_LABELS[emp.position ?? ""] ?? emp.position ?? "—";
    const posText = emp.isExtra && emp.extraLevel ? `${posLabel} — Nível ${emp.extraLevel}` : posLabel;
    doc.fontSize(10).font("Helvetica").fillColor("#333").text(posText, startX + 15, infoStartY + 47);

    // Right column
    doc.fontSize(8).font("Helvetica").fillColor("#888").text("NIF", startX + colW + 15, infoStartY);
    doc.fontSize(10).font("Helvetica").fillColor("#333").text(emp.nif ?? "—", startX + colW + 15, infoStartY + 12);

    doc.fontSize(8).font("Helvetica").fillColor("#888").text("DEPARTAMENTO / PROJETO", startX + colW + 15, infoStartY + 35);
    doc.fontSize(10).font("Helvetica").fillColor("#333").text(
      [emp.department, emp.projectName].filter(Boolean).join(" — ") || "—",
      startX + colW + 15, infoStartY + 47
    );

    y += 105;

    // ─── WORK SUMMARY ───────────────────────────────────────────────────
    doc.fontSize(12).font("Helvetica-Bold").fillColor("#1a1a2e").text("Resumo de Trabalho", startX, y);
    y += 20;

    // Summary boxes
    const boxW = pageW / 3;
    const boxes = [
      { label: "Dias Trabalhados", value: String(emp.daysWorked), unit: "dias" },
      { label: "Horas Totais", value: fmt(emp.totalHours), unit: "horas" },
      { label: "Valor/Hora", value: `${fmt(emp.hourlyRate)}€`, unit: "" },
    ];

    boxes.forEach((box, i) => {
      const bx = startX + i * boxW;
      doc.save();
      doc.roundedRect(bx + (i > 0 ? 5 : 0), y, boxW - 10, 55, 6)
        .lineWidth(1).strokeColor("#e0e0e0").stroke();
      doc.restore();
      doc.fontSize(8).font("Helvetica").fillColor("#888")
        .text(box.label, bx + (i > 0 ? 15 : 10), y + 10);
      doc.fontSize(16).font("Helvetica-Bold").fillColor("#1a1a2e")
        .text(box.value, bx + (i > 0 ? 15 : 10), y + 25);
      if (box.unit) {
        doc.fontSize(8).font("Helvetica").fillColor("#888")
          .text(box.unit, bx + (i > 0 ? 15 : 10), y + 42);
      }
    });
    y += 70;

    // ─── EARNINGS TABLE ─────────────────────────────────────────────────
    doc.fontSize(12).font("Helvetica-Bold").fillColor("#1a1a2e").text("Detalhes de Vencimento", startX, y);
    y += 20;

    // Table header
    doc.save();
    doc.rect(startX, y, pageW, 24).fillColor("#1a1a2e").fill();
    doc.restore();
    doc.fontSize(9).font("Helvetica-Bold").fillColor("#ffffff");
    doc.text("Descrição", startX + 10, y + 7, { width: pageW * 0.55 });
    doc.text("Valor", startX + pageW * 0.55, y + 7, { width: pageW * 0.4, align: "right" });
    y += 24;

    // Table rows
    const rows: [string, string, boolean?][] = [];

    // TODAS as componentes que o cálculo soma aparecem aqui — as linhas têm
    // de reconciliar com o total (auditoria RH set 2026).
    if (emp.isExtra) {
      rows.push(["Pagamento por Horas (Extra)", `${fmt(emp.extraPayment)} €`]);
      rows.push([`  ${fmt(emp.totalHours)}h × ${fmt(emp.hourlyRate)}€/h`, "", false]);
    } else {
      rows.push(["Salário Base", `${fmt(emp.baseSalary)} €`]);
      if ((emp as any).contractDays != null && (emp as any).daysInMonth != null && (emp as any).contractDays < (emp as any).daysInMonth) {
        rows.push([`  vínculo parcial: ${(emp as any).contractDays}/${(emp as any).daysInMonth} dias`, "", false]);
      }
      if ((emp as any).unpaidDays > 0) rows.push([`  ${(emp as any).unpaidDays} dia(s) sem remuneração descontado(s)`, "", false]);
      if (emp.overtimeHours > 0) {
        rows.push(["Horas Extra", `${fmt(emp.overtimePayment)} €`]);
        rows.push([`  ${fmt(emp.overtimeHours)}h acima do horário esperado`, "", false]);
      }
      if ((emp.nightPayment ?? 0) > 0) {
        rows.push(["Acréscimo Noturno (22h–07h, +25%)", `${fmt(emp.nightPayment)} €`]);
        rows.push([`  ${fmt(emp.nightHours)}h`, "", false]);
      }
      if ((emp.weekendPayment ?? 0) > 0) {
        rows.push(["Acréscimo Fim de Semana (+50%)", `${fmt(emp.weekendPayment)} €`]);
        rows.push([`  ${fmt(emp.weekendHours)}h`, "", false]);
      }
      if (emp.thirteenthProvision > 0) {
        rows.push(["Provisão Subsídio de Natal (13º)", `${fmt(emp.thirteenthProvision)} €`]);
        rows.push([`  1/12 do salário base`, "", false]);
      }
      if ((emp.fourteenthProvision ?? 0) > 0) {
        rows.push(["Provisão Subsídio de Férias (14º)", `${fmt(emp.fourteenthProvision)} €`]);
        rows.push([`  1/12 do salário base`, "", false]);
      }
      if ((emp.mealAllowance ?? 0) > 0) {
        rows.push(["Subsídio de Alimentação", `${fmt(emp.mealAllowance)} €`]);
        rows.push([`  ${fmt(emp.mealAllowancePerDay)}€/dia × ${emp.daysWorked} dia(s)`, "", false]);
      }
    }

    rows.forEach(([desc, val, isBold], idx) => {
      const bgColor = idx % 2 === 0 ? "#ffffff" : "#f8f9fa";
      const rowH = 22;
      doc.save();
      doc.rect(startX, y, pageW, rowH).fillColor(bgColor).fill();
      doc.restore();

      if (isBold === false) {
        // Sub-detail row
        doc.fontSize(8).font("Helvetica").fillColor("#888")
          .text(desc, startX + 10, y + 6, { width: pageW * 0.55 });
      } else {
        doc.fontSize(9).font("Helvetica").fillColor("#333")
          .text(desc, startX + 10, y + 6, { width: pageW * 0.55 });
      }

      if (val) {
        doc.fontSize(9).font("Helvetica").fillColor("#333")
          .text(val, startX + pageW * 0.55, y + 6, { width: pageW * 0.4, align: "right" });
      }
      y += rowH;
    });

    // Total BRUTO (soma das linhas acima) + deduções ESTIMADAS + líquido estimado.
    // Não é um recibo fiscal: o IRS por tabelas é do processamento salarial.
    y += 5;
    doc.save();
    doc.rect(startX, y, pageW, 30).fillColor("#1a1a2e").fill();
    doc.restore();
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#ffffff")
      .text("TOTAL BRUTO", startX + 10, y + 9, { width: pageW * 0.55 });
    doc.fontSize(14).font("Helvetica-Bold").fillColor("#ffffff")
      .text(`${fmt(emp.totalPayment)} €`, startX + pageW * 0.55, y + 8, { width: pageW * 0.4, align: "right" });
    y += 36;
    const ded: [string, string][] = [
      ["Segurança Social (trabalhador, 11%) — estimativa", `− ${fmt(emp.tsuEmployee ?? 0)} €`],
      ["IRS — estimativa simplificada (15%), não é retenção por tabela", `− ${fmt(emp.irsEstimate ?? 0)} €`],
    ];
    for (const [d, v] of ded) {
      doc.fontSize(8).font("Helvetica").fillColor("#666").text(d, startX + 10, y + 4, { width: pageW * 0.7 });
      doc.fontSize(9).font("Helvetica").fillColor("#666").text(v, startX + pageW * 0.55, y + 3, { width: pageW * 0.4, align: "right" });
      y += 16;
    }
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#1a1a2e").text("LÍQUIDO ESTIMADO (não fiscal)", startX + 10, y + 4, { width: pageW * 0.55 });
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#1a1a2e").text(`${fmt(emp.netEstimate ?? 0)} €`, startX + pageW * 0.55, y + 3, { width: pageW * 0.4, align: "right" });
    y += 24;
    if ((emp as any).suspiciousHours > 0 || (emp as any).openShifts > 0) {
      doc.fontSize(8).font("Helvetica").fillColor("#b45309").text(`Atenção: ${fmt((emp as any).suspiciousHours ?? 0)}h em registos de ponto por rever e ${(emp as any).openShifts ?? 0} entrada(s) sem saída — não incluídas neste valor.`, startX + 10, y, { width: pageW - 20 });
      y += 18;
    }

    // ─── NIB / PAYMENT INFO ─────────────────────────────────────────────
    if (emp.nib) {
      doc.save();
      doc.roundedRect(startX, y, pageW, 40, 6).fillColor("#f0f4ff").fill();
      doc.restore();
      doc.fontSize(8).font("Helvetica").fillColor("#888").text("NIB / IBAN PARA TRANSFERÊNCIA", startX + 15, y + 8);
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#1a1a2e").text(emp.nib, startX + 15, y + 22);
      y += 55;
    }

    // ─── SIGNATURES ─────────────────────────────────────────────────────
    y = Math.max(y, doc.page.height - 160);

    doc.moveTo(startX, y).lineTo(startX + pageW, y).strokeColor("#ddd").lineWidth(0.5).stroke();
    y += 20;

    // Two signature lines
    const sigW = (pageW - 40) / 2;
    doc.moveTo(startX, y + 40).lineTo(startX + sigW, y + 40).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.fontSize(8).font("Helvetica").fillColor("#888")
      .text("A Empresa", startX, y + 45, { width: sigW, align: "center" });

    doc.moveTo(startX + sigW + 40, y + 40).lineTo(startX + pageW, y + 40).strokeColor("#ccc").lineWidth(0.5).stroke();
    doc.fontSize(8).font("Helvetica").fillColor("#888")
      .text("O Trabalhador", startX + sigW + 40, y + 45, { width: sigW, align: "center" });

    y += 70;

    // ─── FOOTER ─────────────────────────────────────────────────────────
    doc.fontSize(7).font("Helvetica").fillColor("#aaa")
      .text(
        `Documento gerado automaticamente em ${new Date().toLocaleDateString("pt-PT")} às ${new Date().toLocaleTimeString("pt-PT")} | Dashboard Multipark`,
        startX, y, { align: "center", width: pageW }
      );

    doc.end();
  });
}

/**
 * Generate all payslips for a given month as individual PDFs
 * Returns an array of { employeeId, fullName, buffer }
 */
export async function generateAllPayslipsPdf(year: number, month: number): Promise<Array<{ employeeId: number; fullName: string; buffer: Buffer }>> {
  const allPayroll = await getPayrollData(year, month);
  const results: Array<{ employeeId: number; fullName: string; buffer: Buffer }> = [];

  for (const emp of allPayroll) {
    if (emp.totalHours === 0 && emp.totalPayment === 0) continue; // Skip employees with no activity
    const buffer = await generatePayslipPdf(year, month, emp.employeeId);
    results.push({ employeeId: emp.employeeId, fullName: emp.fullName, buffer });
  }

  return results;
}
