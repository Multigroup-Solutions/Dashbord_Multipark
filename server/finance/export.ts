/**
 * EXPORTAÇÃO (CSV / XLSX) da Faturação e do Anual — os MESMOS números do ecrã
 * (payload de ./compat.ts). Porta: ação "x" (export) do módulo Faturação.
 * PURO (sem BD): o router vai buscar os dados e chama isto.
 */
import * as XLSX from "xlsx";
import { requireAccess } from "../_core/access";

export type Cell = string | number | null;
export interface Sheet { name: string; rows: Cell[][] }
export type ExportFormat = "xlsx" | "csv";

/** Só quem tem a ação export da Faturação (hoje: super_admin). Lança FORBIDDEN. */
export function assertCanExportFinance(user: { id?: number; role: string } | null | undefined): void {
  requireAccess(user, "faturacao", "export");
}

const r2 = (v: unknown) => Math.round((Number(v ?? 0) || 0) * 100) / 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function billingExportSheets(data: any, meta: { from: string; to: string; projectLabel?: string | null }): Sheet[] {
  const s = data.summary;
  const q = s.quality ?? {};
  const cards: Cell[][] = [
    ["Indicador", "Valor"],
    ["Período", `${meta.from} a ${meta.to}`],
    ["Centro de custos", meta.projectLabel ?? "Todos"],
    ["Recolhidos (c/ IVA)", r2(s.collected)], ["Recolhidos (nº)", s.collectedCount ?? 0],
    ["Entregues (c/ IVA)", r2(s.produced)], ["Entregues (s/ IVA)", r2(s.producedNoVat)], ["Entregues (nº)", s.producedCount ?? 0],
    ["Despesas (c/ IVA)", r2(s.expensesPaid)], ["Despesas (s/ IVA)", r2(s.expensesPaidNoVat)],
    ["Salários (base + provisões + variável)", r2(s.salariesCost)], ["TSU patronal", r2(s.employerTax)],
    ["Equipa do dia", r2(s.extrasDiaCost)], ["Comissões de venda", r2(s.salesCommissions)], ["Comissões operacionais", r2(s.operationalCommissions)],
    ["Custos (s/ IVA)", r2(s.totalCostsNoVat)], ["Margem (s/ IVA)", r2(s.marginNet)], ["Margem %", s.marginPct == null ? null : r2(s.marginPct)],
    ["Despesas a pagar (informativo)", r2(s.expensesPending)],
  ];
  if (s.projection?.applies) {
    cards.push(
      ["Fecho previsto — receita (s/ IVA)", r2(s.projection.revenueNet)],
      ["Fecho previsto — custos (s/ IVA)", r2(s.projection.costsNet)],
      ["Fecho previsto — margem", r2(s.projection.margin)],
    );
  }
  cards.push(["IVA em vigor no fim", s.vatRate], ["TSU em vigor no fim", s.tsuEmployerRate]);

  const series: Cell[][] = [["Período", "Entregues c/ IVA", "Entregues s/ IVA", "Recolhidos", "Despesas s/ IVA", "Salários + TSU", "Parceiros", "Equipa do dia", "Custos", "Margem", "Receita prevista", "Custos previstos", "Fecho previsto"]];
  for (const p of data.timeseries ?? []) series.push([p.bucket, r2(p.produced), r2(p.producedNet), r2(p.collected), r2(p.expensesNet), r2(p.salaries), r2(p.partners), r2(p.extrasCost), r2(p.totalCost), r2(p.margin), r2(p.revenueForecast), r2(p.costForecast), r2(p.marginForecast)]);

  const rows = (header: Cell[], list: any[] | undefined, pick: (x: any) => Cell[]): Cell[][] => [header, ...(list ?? []).map(pick)];
  const quality: Cell[][] = [
    ["Aviso", "Valor", "Detalhe"],
    ["Despesas excluídas da margem", r2(q.excludedExpenses?.total), (q.excludedExpenses?.categories ?? []).map((c: any) => `${c.name}: ${r2(c.total)}`).join("; ")],
    ["Reservas entregues sem centro", r2(q.bookingsWithoutProject?.total), `${q.bookingsWithoutProject?.count ?? 0} reservas`],
    ["Despesas sem centro", r2(q.expensesWithoutProject?.total), `${q.expensesWithoutProject?.count ?? 0} despesas`],
    ["Inativos sem fim de contrato", (q.inactiveWithoutContractEnd ?? []).length, (q.inactiveWithoutContractEnd ?? []).map((e: any) => `${e.fullName} (até ${e.assumedEnd ?? "?"})`).join("; ")],
    ["Comissão de venda não cobrada (operacional)", r2(q.salesCommissionsCoveredByOperational?.revenueGross), `${q.salesCommissionsCoveredByOperational?.count ?? 0} reservas`],
    ["Parceiros sem taxa", (q.partnersRateMissing ?? []).length, (q.partnersRateMissing ?? []).join("; ")],
  ];
  return [
    { name: "Resumo", rows: cards },
    { name: "Série", rows: series },
    { name: "Entregues por centro", rows: rows(["Centro", "Entregas", "Serviços extra", "Total c/ IVA"], data.deliveries, (d) => [d.projectName ?? "Sem centro", d.count, r2(d.extrasRevenue), r2(d.totalRevenue)]) },
    { name: "Recolhidos por centro", rows: rows(["Centro", "Recolhas", "Valor"], data.collected, (d) => [d.projectName ?? "Sem centro", d.count, r2(d.totalRevenue)]) },
    { name: "Despesas", rows: rows(["Centro", "Categoria", "Nº", "c/ IVA", "s/ IVA"], data.expensesPaid, (d) => [d.projectName ?? "Por atribuir", d.categoryName ?? "Sem categoria", d.count, r2(d.totalAmount), r2(d.totalNet)]) },
    { name: "Despesas excluídas", rows: rows(["Centro", "Categoria", "Nº", "c/ IVA"], data.expensesExcluded, (d) => [d.projectName ?? "Por atribuir", d.categoryName ?? "Sem categoria", d.count, r2(d.totalAmount)]) },
    { name: "Comissões venda", rows: rows(["Parceiro", "Centro", "Reservas", "Receita c/ IVA", "Receita s/ IVA", "Base", "%", "Comissão"], data.salesCommissions, (c) => [c.partnerName, c.projectName ?? "Sem centro", c.bookingsCount, r2(c.revenueGross), r2(c.revenueNet), c.commissionBase === "gross" ? "c/ IVA" : "s/ IVA", c.commissionRate, r2(c.commission)]) },
    { name: "Parceiros operacionais", rows: rows(["Parceiro", "Centros", "Reservas", "Receita c/ IVA", "Receita s/ IVA", "Base", "%", "Comissão"], data.operationalPartners, (c) => [c.partnerName, (c.projectNames ?? []).join(", "), c.bookingsCount, r2(c.revenueGross), r2(c.revenueNet), c.commissionBase === "gross" ? "c/ IVA" : "s/ IVA", c.commissionRate, r2(c.commission)]) },
    { name: "Salários por centro", rows: rows(["Centro", "Custo"], data.salaries?.byProject, (x) => [x.projectName ?? "Por atribuir", r2(x.cost)]) },
    { name: "Previsão", rows: rows(["Centro", "Reservas", "Receita prevista c/ IVA"], data.forecast, (f) => [f.projectName ?? "Sem centro", f.count, r2(f.totalRevenue)]) },
    { name: "Qualidade", rows: quality },
  ];
}

const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const STATUS_LABEL: Record<string, string> = { past: "Realizado", current: "Em curso", future: "Previsto" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function annualExportSheets(months: any[], meta: { year: number; projectLabel?: string | null }): Sheet[] {
  const header: Cell[] = ["Mês", "Estado", "Receita c/ IVA", "Receita s/ IVA", "IVA receita", "Despesas c/ IVA", "Despesas s/ IVA", "IVA despesas", "IVA a pagar", "Salários", "TSU", "Equipa do dia", "Comissões", "Custos", "Lucro", "Fecho previsto", "Histórico importado"];
  const rows: Cell[][] = [header];
  const t = new Array(header.length).fill(0) as number[];
  for (const m of months) {
    const vals = [r2(m.revenueWithVat), r2(m.revenueNoVat), r2(m.vatRevenue), r2(m.expensesWithVat), r2(m.expensesNoVat), r2(m.vatExpenses), r2(m.vatToPay), r2(m.salaries), r2(m.employerTax), r2(m.extrasDiaCost), r2((m.salesCommissions ?? 0) + (m.operationalCommissions ?? 0)), r2(m.totalCosts)];
    const future = m.status === "future";
    const profit = future ? null : r2(m.profit);
    const forecast = m.status && m.status !== "past" ? r2(m.forecastProfit) : null;
    vals.forEach((v, i) => { t[i + 2] += v; });
    if (profit != null) t[14] += profit;
    rows.push([MONTHS[(m.month ?? 1) - 1], STATUS_LABEL[m.status ?? "past"] ?? "", ...vals, profit, forecast, m.fromHistory ? "sim" : ""]);
  }
  rows.push(["Total", "", ...t.slice(2, 15).map(r2), null, ""]);
  return [
    { name: `Anual ${meta.year}`, rows },
    { name: "Notas", rows: [["Nota"], [`Centro de custos: ${meta.projectLabel ?? "Todos"}`], ["Receita = reservas entregues (CHECKED_OUT) pelo dia de Lisboa da saída; uma reserva que atravessa meses conta inteira no mês da saída."], ["Meses futuros: sem lucro realizado; a coluna 'Fecho previsto' mostra receita esperada − custos previstos."]] },
  ];
}

function csvCell(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v).replace(".", ",");   // Excel PT
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV (uma secção por folha, separador ";" e vírgula decimal — Excel PT) ou XLSX. */
export function sheetsToFile(sheets: Sheet[], format: ExportFormat, baseName: string): { base64: string; filename: string; mime: string } {
  if (format === "csv") {
    const text = sheets.map((sh) => [`# ${sh.name}`, ...sh.rows.map((r) => r.map(csvCell).join(";"))].join("\r\n")).join("\r\n\r\n");
    // BOM para o Excel abrir em UTF-8
    return { base64: Buffer.from("﻿" + text, "utf8").toString("base64"), filename: `${baseName}.csv`, mime: "text/csv;charset=utf-8" };
  }
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const sh of sheets) {
    let name = sh.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
    while (used.has(name)) name = name.slice(0, 29) + "_" + used.size;
    used.add(name);
    const ws = XLSX.utils.aoa_to_sheet(sh.rows);
    ws["!cols"] = (sh.rows[0] ?? []).map((_, i) => ({ wch: Math.min(60, Math.max(10, ...sh.rows.map((r) => String(r[i] ?? "").length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return { base64: Buffer.from(buffer).toString("base64"), filename: `${baseName}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}
