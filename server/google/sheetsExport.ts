/**
 * "Exportar para Sheets" e "Relatórios ao vivo" — um só exportador:
 *
 *  1. os dados vêm do MESMO procedimento tRPC da página (chamado com o
 *     utilizador do pedido: mesma matriz de acessos, mesmo âmbito de cidade,
 *     mesmos cortes de totais financeiros) e, por cima, exige-se a ação
 *     "exportar" do módulo (onde a matriz a tem);
 *  2. o resultado vira separadores (linhas/colunas) — as mesmas folhas do
 *     Excel da Faturação quando existem (finance/export.ts);
 *  3. a folha é criada pela app (drive.file chega) e escrita em blocos
 *     (chunkSheetWrites), sempre com prazo; RAW = sem fórmulas.
 */
import { TRPCError } from "@trpc/server";
import { can } from "../../shared/access";
import {
  GOOGLE_MIME, SHEET_EXPORT_GATES, chunkSheetWrites, sanitizeSheetTitle, type SheetExportInput, type SheetExportReport, type SheetTab, type SheetCell, type LiveReportKey,
} from "../../shared/drive";
import { METRIC_KEYS, METRIC_LABELS } from "../../shared/evaluationRules";
import type { DriveApiLike, DriveFileMeta, SheetsApiLike } from "./driveApi";

export type ProcedureCall = (path: string, input?: unknown) => Promise<any>;

interface ReportDef {
  load(call: ProcedureCall, input: any, deadlineAt: number): Promise<SheetTab[]>;
}

/** Exportação de clientes: até 25 páginas × 200 = 5 000 linhas por folha. */
export const EXPORT_CLIENT_PAGES = 25;
const r2 = (v: unknown) => Math.round((Number(v ?? 0) || 0) * 100) / 100;
const tabOf = (name: string, header: SheetCell[], rows: SheetCell[][]): SheetTab => ({ name, rows: [header, ...rows] });

export const SHEET_REPORTS: Record<SheetExportReport, ReportDef> = {
  financeiro: {
    async load(call, input) {
      const f = await call("invoices.financeSummary", { from: input.from, to: input.to, projectId: input.projectId });
      const resumo: SheetCell[][] = [
        ["Período", `${input.from} a ${input.to}`],
        ["Entregues s/ IVA", r2(f.revenue?.producedNet)], ["Entregues (nº)", Number(f.revenue?.producedCount ?? 0)],
        ["Recolhidos c/ IVA", r2(f.revenue?.collected)],
        ["Despesas s/ IVA", r2(f.costs?.expensesNet)], ["Pessoal", r2(f.costs?.personnel)], ["Equipa do dia", r2(f.costs?.extrasDia)],
        ["Comissões", r2(f.costs?.commissions)], ["Custos s/ IVA", r2(f.costs?.totalNet)],
        ["Margem", r2(f.margin?.margin)], ["Margem %", f.margin?.marginPct == null ? null : r2(f.margin.marginPct)],
        ["Despesas excluídas da margem", r2(f.excludedExpenses)],
      ];
      if (f.projection?.applies) resumo.push(["Fecho previsto — margem", r2(f.projection.margin)]);
      return [
        tabOf("Resumo", ["Indicador", "Valor"], resumo),
        tabOf("Mensal", ["Mês", "Receita s/ IVA", "Custos s/ IVA", "Margem", "Receita prevista s/ IVA", "Custos previstos"],
          (f.monthly ?? []).map((m: any) => [m.month, r2(m.revenueNet), r2(m.costsNet), r2(m.margin), r2(m.revenueForecastNet), r2(m.costForecast)])),
        tabOf("Despesas por categoria", ["Categoria", "s/ IVA"], Object.entries(f.expensesByCategory ?? {}).map(([k, v]) => [k, r2(v)])),
      ];
    },
  },
  faturacao: {
    async load(call, input) {
      const data = await call("invoices.billing", { from: input.from, to: input.to, projectId: input.projectId, granularity: input.granularity });
      const { billingExportSheets } = await import("../finance/export");
      return billingExportSheets(data, { from: input.from, to: input.to, projectLabel: input.projectId != null ? `#${input.projectId}` : null })
        .map((s) => ({ name: s.name, rows: s.rows }));
    },
  },
  extras_metricas: {
    async load(call, input) {
      const m = await call("extrasDia.metrics", { days: input.days ?? 30 });
      return [
        tabOf("Resumo", ["Indicador", "Valor"], [
          ["Período", `${m.period?.from ?? ""} a ${m.period?.to ?? ""}`],
          ["Custo previsto", r2(m.cost?.planned)], ["Custo pago", r2(m.cost?.paid)],
          ["Horas previstas", r2(m.cost?.plannedHours)], ["Horas pagas", r2(m.cost?.paidHours)],
          ["Aprovados", Number(m.timeToFirstShift?.approved ?? 0)], ["Já trabalharam", Number(m.timeToFirstShift?.worked ?? 0)],
          ["Mediana até ao 1.º turno (dias)", m.timeToFirstShift?.medianDays ?? null],
        ]),
        tabOf("Resposta por semana", ["Semana", "Pedidos", "Responderam", "%"],
          (m.responseRate ?? []).map((w: any) => [w.weekStart, w.total, w.responded, w.total ? r2((w.responded / w.total) * 100) : null])),
        tabOf("Faltas", ["Colaborador", "Pendentes", "Confirmadas"], (m.noShows ?? []).map((x: any) => [x.fullName, x.pending, x.confirmed])),
        tabOf("Sem trabalhar", ["Colaborador", "Último turno", "Criado em", "Dias parado"], (m.stale ?? []).map((x: any) => [x.fullName, x.lastWorked, x.createdAt, x.idleDays])),
      ];
    },
  },
  clientes: {
    // Fichas do CRM, no âmbito de cidade de quem exporta. 21a: exatamente o conjunto da
    // lista (todos os filtros, a pesquisa no campo escolhido e a ordem) — antes só ia o
    // texto livre e um segmento, e o corte às 5 000 não era avisado.
    async load(call, input, deadlineAt) {
      const rows: SheetCell[][] = [];
      let totals = false;
      let total = 0;
      const base = input.query
        ? { ...input.query, tab: "clients" as const }
        : {
          tab: "clients" as const,
          search: input.search?.trim() ? { text: input.search.trim(), field: "all" as const } : null,
          groups: input.segment && input.segment !== "all" && input.segment !== "shared" ? { segment: [input.segment] } : undefined,
          sort: "lastVisit" as const, dir: "desc" as const,
        };
      let warnings: string[] = [];
      let stopped = false;
      for (let page = 0; page < EXPORT_CLIENT_PAGES; page++) {
        if (Date.now() > deadlineAt - 20_000) { stopped = true; break; }
        const res = await call("crm.list", { ...base, offset: page * 200, limit: 200, includeContacts: true });
        totals = !!res.canSeeTotals;
        total = Number(res.total ?? 0);
        if (page === 0) warnings = Array.isArray(res.warnings) ? res.warnings : [];
        for (const c of res.rows ?? []) {
          const avg = c.totalSpent != null && c.completed ? c.totalSpent / c.completed : null;
          rows.push([c.id, c.displayName, c.kind === "company" ? "Empresa" : "Pessoa", c.primaryEmail, c.primaryPhone, c.bookings, c.completed, c.upcoming, c.cancelled, ...(totals ? [c.totalSpent == null ? null : r2(c.totalSpent), avg == null ? null : r2(avg)] : []), c.firstVisit, c.lastVisit]);
        }
        if (!res.rows?.length || res.rows.length < 200) break;
      }
      const header: SheetCell[] = ["N.º cliente", "Nome", "Tipo", "Email", "Telefone", "Reservas", "Estadias", "Futuras", "Canceladas", ...(totals ? ["Gasto total", "Gasto médio"] : []), "Primeira estadia", "Última estadia"];
      const tab = tabOf("Clientes", header, rows);
      const notes = [...warnings];
      if (rows.length < total) notes.unshift(`Incompleta: ${rows.length.toLocaleString("pt-PT")} de ${total.toLocaleString("pt-PT")} clientes${stopped ? " (acabou o tempo)" : ` (máximo ${(EXPORT_CLIENT_PAGES * 200).toLocaleString("pt-PT")} por folha)`}.`);
      if (notes.length) tab.note = notes.join(" ");
      return [tab];
    },
  },
  avaliacoes: {
    async load(call, input) {
      const list = await call("evaluation.ranking", { from: input.from, to: input.to });
      const header: SheetCell[] = ["Colaborador", "Função", "Dias", "Pontos", "Positivos", "Negativos", "Contestações abertas", ...METRIC_KEYS.map((k) => METRIC_LABELS[k])];
      return [tabOf("Ranking", header, (list ?? []).map((x: any) => [
        x.employeeName, x.position, x.days, r2(x.score?.totalPoints), r2(x.score?.positivePoints), r2(x.score?.negativePoints), x.openDisputes,
        ...METRIC_KEYS.map((k) => (x.metrics?.[k] == null ? null : r2(x.metrics[k]))),
      ]))];
    },
  },
};

/** A pessoa pode exportar este relatório? (a origem ainda verifica o resto). */
export function assertCanExportReport(user: { id?: number; role: string; accessOverrides?: any }, report: SheetExportReport): void {
  const g = SHEET_EXPORT_GATES[report];
  if (!can(user as any, g.module, g.action)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem permissão para exportar este relatório." });
}

/** Dados de um relatório em separadores. */
export async function loadReportTabs(call: ProcedureCall, input: SheetExportInput, deadlineAt: number): Promise<SheetTab[]> {
  return SHEET_REPORTS[input.report].load(call, input, deadlineAt);
}

/** Separadores com títulos válidos e únicos. PURA. */
export function normalizeTabs(tabs: readonly SheetTab[]): SheetTab[] {
  const used = new Set<string>();
  const list = tabs.length ? tabs : [{ name: "Folha", rows: [["Sem dados"]] }];
  return list.map((t) => ({ name: sanitizeSheetTitle(t.name, used), rows: t.rows.length ? t.rows : [["Sem dados"]] }));
}

/** Garante os separadores (renomeia o 1.º, acrescenta os que faltam). */
async function ensureTabs(sheets: SheetsApiLike, spreadsheetId: string, tabs: readonly SheetTab[], opts: { renameFirst: boolean }): Promise<void> {
  const existing = await sheets.listSheets(spreadsheetId);
  const have = new Set(existing.map((s) => s.title));
  const requests: any[] = [];
  let pending = [...tabs];
  if (opts.renameFirst && existing[0] && !have.has(pending[0].name)) {
    requests.push({ updateSheetProperties: { properties: { sheetId: existing[0].sheetId, title: pending[0].name }, fields: "title" } });
    have.add(pending[0].name);
    pending = pending.slice(1);
  }
  for (const t of pending) if (!have.has(t.name)) requests.push({ addSheet: { properties: { title: t.name } } });
  await sheets.batchUpdate(spreadsheetId, requests);
}

export interface WriteResult { file: DriveFileMeta; chunks: number; written: number; partial: boolean }

/**
 * Cria a folha na pasta dada e escreve os separadores em blocos. Se o prazo
 * apertar, para e devolve `partial` (a folha fica com o que já foi escrito).
 */
export async function createSpreadsheet(
  apis: { drive: DriveApiLike; sheets: SheetsApiLike },
  o: { name: string; parentId: string | null; tabs: readonly SheetTab[]; deadlineAt: number; now?: () => number },
): Promise<WriteResult> {
  const now = o.now ?? Date.now;
  const tabs = normalizeTabs(o.tabs);
  const file = await apis.drive.createFile({ name: o.name, mimeType: GOOGLE_MIME.sheet, ...(o.parentId ? { parents: [o.parentId] } : {}) });
  await ensureTabs(apis.sheets, file.id, tabs, { renameFirst: true });
  return { file, ...(await writeChunks(apis.sheets, file.id, tabs, o.deadlineAt, now)) };
}

/** Relatório ao vivo: garante separadores, limpa-os e reescreve. */
export async function refreshSpreadsheet(
  sheets: SheetsApiLike, spreadsheetId: string, rawTabs: readonly SheetTab[], deadlineAt: number, now: () => number = Date.now,
): Promise<{ chunks: number; written: number; partial: boolean }> {
  const tabs = normalizeTabs(rawTabs);
  await ensureTabs(sheets, spreadsheetId, tabs, { renameFirst: false });
  await sheets.clearValues(spreadsheetId, tabs.map((t) => `'${t.name.replace(/'/g, "''")}'`));
  return writeChunks(sheets, spreadsheetId, tabs, deadlineAt, now);
}

async function writeChunks(sheets: SheetsApiLike, spreadsheetId: string, tabs: readonly SheetTab[], deadlineAt: number, now: () => number) {
  const chunks = chunkSheetWrites(tabs);
  let written = 0;
  for (const c of chunks) {
    if (now() > deadlineAt - 5_000) return { chunks: chunks.length, written, partial: true };
    await sheets.writeValues(spreadsheetId, c);
    written++;
  }
  return { chunks: chunks.length, written, partial: false };
}

/** Relatórios ao vivo → entrada de cada relatório (período relativo ao dia). PURA. */
export function liveReportInput(key: LiveReportKey, today: string): SheetExportInput {
  const monthStart = `${today.slice(0, 8)}01`;
  const minus = (days: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };
  switch (key) {
    case "financeiro": return { report: "financeiro", from: monthStart, to: today };
    case "faturacao": return { report: "faturacao", from: monthStart, to: today, granularity: "day" };
    case "extras_metricas": return { report: "extras_metricas", days: 30 };
    case "avaliacoes": return { report: "avaliacoes", from: minus(29), to: today };
  }
}
