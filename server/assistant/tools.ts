/**
 * Ferramentas do assistente da EQUIPA (só leitura). Cada uma embrulha um
 * procedimento tRPC que JÁ existe e chama-o como a própria pessoa (`ctx.call`
 * = appRouter.createCaller com o utilizador do pedido): passam pelo mesmo
 * middleware (cidades do centro de custos, overrides, bloqueios) e pelo mesmo
 * requireAccess da página. Por cima disso, cada ferramenta:
 *  - só é declarada ao modelo se a pessoa tiver o módulo (`available`);
 *  - valida a cidade pedida contra as cidades da pessoa ANTES de chamar;
 *  - devolve só agregados ou listas curtas (≤ 20 linhas), sem emails,
 *    telefones, matrículas nem nomes completos de clientes; os nomes de
 *    colegas e o texto livre declaram-se em `pii` (plano MPV F0b) e passam
 *    pela redação única do turno ([NOME_n] repostos no fim).
 */
import { can, roleRank, ROLE_RANK, seesBeyondOwn, type AccessOverrides } from "../../shared/access";
import type { CityAccess } from "../cityAccess";
import { capRows, MAX_TOOL_ROWS, ToolUserError, type ChatTool } from "../_core/ai/chat/tools";
import { excerptHelp, type HelpDoc } from "../_core/ai/chat/retrieval";
import { lateArrivalsOf } from "../../shared/evaluationRules";
import { RULES_IN_FORCE_TOOL } from "./rulesTool";
import { HELP_NAV_TOOLS } from "./helpTools";
import { CITY_NAMES, addDays, dayArg, extrasCityArg, num, rangeArgs, resolveCityArg } from "./toolArgs";
import { MPV_DATA_TOOLS } from "./mpvDataTools";

export interface StaffUser {
  id: number;
  role: string;
  accessOverrides?: AccessOverrides | null;
}

export interface StaffToolCtx {
  user: StaffUser;
  /** Cidades da pessoa neste pedido (cityScope); undefined = sem âmbito → recusa. */
  access: CityAccess | undefined;
  /** Chama um procedimento tRPC existente como a pessoa (ex.: "tasks.list"). */
  call: (path: string, input?: unknown) => Promise<any>;
  /** Hoje (dia de Lisboa, AAAA-MM-DD). */
  today: string;
  /** Pode ver totais financeiros (financeiro/faturação + finance.view_totals). */
  financeAllowed: boolean;
  helpDocs: HelpDoc[];
  /** Prazo das leituras lentas das ferramentas do piloto (ms; omissão SLOW_CALL_MS em ./mpvDataTools.ts). Injetável (testes). */
  slowCallMs?: number;
}

// ─── Cidades e datas (./toolArgs.ts, partilhadas com as do piloto) ──────────

export { CITY_NAMES, addDays, extrasCityArg, rangeArgs, resolveCityArg } from "./toolArgs";

const cityParam = { type: "string", enum: [...CITY_NAMES], description: "Cidade (opcional). Omite para todas as cidades a que a pessoa tem acesso." };
const rangeParams = {
  de: { type: "string", description: "Primeiro dia (AAAA-MM-DD). Omissão: hoje." },
  ate: { type: "string", description: "Último dia, inclusivo (AAAA-MM-DD). Omissão: igual a `de`." },
};

// ─── Ferramentas ────────────────────────────────────────────────────────────

const OPEN_COMPLAINT = ["new", "analyzing", "waiting_client"];
const OPEN_LOST = ["new", "investigating", "found"];

/**
 * A ajuda pedida pelo modelo (`abrir_ajuda`): primeiro pelo FICHEIRO
 * ("google-tempo-real", "google-tempo-real.md"), depois pelo módulo só se for
 * o único com esse módulo, depois pelo título. Módulo com várias ajudas →
 * a lista dos candidatos (antes devolvia sempre a 1.ª: definicoes.md,
 * marketing.md, integracoes.md…). PURA.
 */
export function findHelpDoc(docs: HelpDoc[], query: unknown): { doc: HelpDoc } | { candidates: HelpDoc[] } | null {
  const q = String(query ?? "").trim().toLowerCase().replace(/\.md$/, "");
  if (!q) return null;
  const byFile = docs.find((d) => d.file === `${q}.md` || d.file === `${q.replace(/_/g, "-")}.md`);
  if (byFile) return { doc: byFile };
  const byModule = docs.filter((d) => d.module === q || d.module === q.replace(/-/g, "_"));
  if (byModule.length === 1) return { doc: byModule[0] };
  if (byModule.length > 1) return { candidates: byModule };
  const byTitle = docs.filter((d) => d.title.toLowerCase() === q);
  if (byTitle.length === 1) return { doc: byTitle[0] };
  if (byTitle.length > 1) return { candidates: byTitle };
  return null;
}

const helpId = (d: HelpDoc) => d.file.replace(/\.md$/, "");

function countBy<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export const STAFF_TOOLS: ChatTool<StaffToolCtx>[] = [
  {
    name: "abrir_ajuda",
    description: "Abre a ajuda (\"como se usa\") de um módulo da aplicação. Usa quando a ajuda certa não veio em <ajuda>.",
    parameters: {
      type: "object",
      properties: {
        modulo: { type: "string", description: "A ajuda, como aparece entre parênteses no índice: o módulo (ex.: extras_dia, tarefas) ou, quando o índice o mostra, o ficheiro (ex.: google-tempo-real)." },
        tema: { type: "string", description: "O que procuras dentro dessa ajuda (palavras da pergunta) — traz a parte certa de uma ajuda longa." },
      },
      required: ["modulo"],
    },
    available: () => true,
    async run(args, ctx) {
      const hit = findHelpDoc(ctx.helpDocs, args.modulo);
      if (!hit) return { error: "Não há ajuda para esse módulo.", ajudas: ctx.helpDocs.map(helpId) };
      if ("candidates" in hit) {
        return {
          error: "Há várias ajudas com esse nome: chama outra vez com o ficheiro certo.",
          candidatos: hit.candidates.map((d) => ({ ficheiro: helpId(d), titulo: d.title, resumo: d.summary.slice(0, 160) })),
        };
      }
      const doc = hit.doc;
      return { ficheiro: helpId(doc), titulo: doc.title, ajuda: excerptHelp(doc.body, 3500, String(args.tema ?? "").slice(0, 300)) };
    },
  },
  {
    name: "reservas_resumo",
    description: "Contagens de reservas num intervalo de dias (Lisboa): criadas, check-ins (entradas no parque), check-outs (saídas/entregas) e cancelamentos, por cidade e por parque. Sem valores em euros.",
    parameters: { type: "object", properties: { ...rangeParams, cidade: cityParam } },
    available: (ctx) => can(ctx.user, "reservas_operacoes", "view"),
    async run(args, ctx) {
      const { from, to } = rangeArgs(args, ctx.today, { maxDays: 93 });
      const city = resolveCityArg(ctx.access, args.cidade);
      const r = await ctx.call("multipark.operationsSummary", { startDate: from, endDate: to, ...(city ? { projectId: city.projectId } : {}) });
      const a = r?.actions ?? {};
      const pick = (k: string) => {
        const x = a[k] ?? { count: 0, byCity: [], byPark: [] };
        return {
          total: num(x.count),
          porCidade: (x.byCity ?? []).slice(0, MAX_TOOL_ROWS).map((c: any) => ({ cidade: c.name, n: num(c.count) })),
          porParque: (x.byPark ?? []).slice(0, MAX_TOOL_ROWS).map((p: any) => ({ parque: p.name, n: num(p.count) })),
        };
      };
      return {
        periodo: { de: from, ate: to }, cidade: city?.name ?? "todas as tuas cidades",
        criadas: pick("creation"), checkins: pick("checkin"), checkouts: pick("checkout"), cancelamentos: pick("cancelation"),
      };
    },
  },
  {
    name: "extras_escala",
    description: "Extras-Dia de um dia e cidade: quantas pessoas estão escaladas (manhã/noite, team leaders) e as horas em que faltam condutores face à previsão.",
    parameters: {
      type: "object",
      properties: { data: { type: "string", description: "Dia (AAAA-MM-DD). Omissão: amanhã." }, cidade: cityParam },
    },
    available: (ctx) => can(ctx.user, "extras_dia", "view"),
    // Colaboradores: o fornecedor vê [NOME_n]; a pessoa vê o nome completo (dois "João" não se confundem).
    pii: { people: ["nome"] },
    async run(args, ctx) {
      const date = dayArg(args.data, addDays(ctx.today, 1), "Data");
      const city = extrasCityArg(ctx.access, args.cidade);
      const [assignments, gaps] = await Promise.all([
        ctx.call("extrasDia.assignments", { date, city: city.id }),
        ctx.call("extrasDia.coverage", { date, city: city.id }).catch(() => null),
      ]);
      const list: any[] = Array.isArray(assignments) ? assignments : [];
      const drivers = list.filter((x) => !x.isTeamLeader);
      const gapRows: any[] = Array.isArray(gaps) ? gaps : [];
      const hour = (h: number) => `${String(h % 24).padStart(2, "0")}h${h >= 24 ? " (+1)" : ""}`;
      return {
        data: date, cidade: city.name,
        escalados: { total: list.length, condutores: drivers.length, teamLeaders: list.length - drivers.length,
          manha: list.filter((x) => x.shift === "morning").length, noite: list.filter((x) => x.shift === "night").length },
        pessoas: capRows(list.map((x) => ({ nome: String(x.personName ?? "").trim() || null, turno: x.shift, inicio: hour(num(x.startHour)), fim: hour(num(x.endHour)), tl: !!x.isTeamLeader }))).rows,
        faltas: gaps == null ? "indisponível" : capRows(gapRows.map((g) => ({ hora: hour(num(g.hour)), precisos: num(g.needed), escalados: num(g.have) }))).rows,
        horasComFalta: gapRows.length,
      };
    },
  },
  {
    name: "casos_abertos",
    description: "Casos em aberto de Reclamações, Ocorrências e/ou Perdidos e Achados: contagens por estado, fora do prazo, e os mais recentes (sem dados do cliente).",
    parameters: {
      type: "object",
      properties: { tipo: { type: "string", enum: ["reclamacoes", "ocorrencias", "perdidos", "todos"], description: "Omissão: todos." }, cidade: cityParam },
    },
    available: (ctx) => can(ctx.user, "reclamacoes", "view") || can(ctx.user, "ocorrencias", "view") || can(ctx.user, "perdidos", "view"),
    // Títulos e tipos são texto livre escrito à mão (podem ter emails, telefones, matrículas).
    pii: { text: ["titulo", "tipo", "objeto"] },
    async run(args, ctx) {
      const tipo = String(args.tipo ?? "todos");
      const city = resolveCityArg(ctx.access, args.cidade);
      const filter = city ? { projectId: city.projectId } : {};
      const now = Date.now();
      const out: Record<string, unknown> = { cidade: city?.name ?? "todas as tuas cidades" };
      const want = (t: string) => tipo === "todos" || tipo === t;
      if (want("reclamacoes") && can(ctx.user, "reclamacoes", "view")) {
        const rows = ((await ctx.call("complaints.list", filter)) as any[]).filter((c) => OPEN_COMPLAINT.includes(c.complaintStatus));
        out.reclamacoes = {
          abertas: rows.length, porEstado: countBy(rows, (c) => c.complaintStatus),
          foraDoPrazo: rows.filter((c) => c.slaDeadline && Date.parse(String(c.slaDeadline).replace(" ", "T") + "Z") < now).length,
          recentes: rows.slice(0, 10).map((c) => ({ id: c.id, titulo: String(c.title ?? "").slice(0, 80), tipo: c.complaintType, estado: c.complaintStatus, prioridade: c.complaintPriority, criada: String(c.createdAt ?? "").slice(0, 10) })),
        };
      }
      // Ocorrências = as da app Multipark, ao vivo (as mesmas da página
      // /ocorrencias). As antigas `incidents` do dashboard já não contam.
      // Leitura falhada → "indisponível", nunca 0 abertas.
      if (want("ocorrencias") && seesBeyondOwn(ctx.user, "ocorrencias")) {
        const r = await ctx.call("incidents.multipark", { ...filter, resolved: false, limit: 10 });
        out.ocorrencias = !r?.available
          ? { indisponivel: `Não foi possível ler as ocorrências da app Multipark${r?.reason ? ` (${r.reason})` : ""}.` }
          : {
            fonte: "app Multipark (ao vivo)",
            abertas: r.stats ? r.stats.open : "contagem indisponível",
            fechadasSozinhas3Dias: r.stats ? r.stats.autoClosed : undefined,
            altaPrioridadeAbertas: r.stats ? r.stats.highOpen : "contagem indisponível",
            porTipo: r.stats ? Object.fromEntries((r.stats.byType as any[]).map((g) => [g.label, g.count])) : undefined,
            recentes: (r.rows as any[]).slice(0, 10).map((o) => ({ tipo: String(o.title ?? "").slice(0, 80), prioridade: o.priority, parque: o.parkName, criada: String(o.createdAt ?? "").slice(0, 10) })),
          };
      }
      if (want("perdidos") && can(ctx.user, "perdidos", "view")) {
        const rows = ((await ctx.call("lostFound.list", filter)) as any[]).filter((c) => OPEN_LOST.includes(c.status));
        out.perdidos = {
          abertos: rows.length, porEstado: countBy(rows, (c) => c.status),
          recentes: rows.slice(0, 10).map((c) => ({ id: c.id, objeto: c.itemType, estado: c.status, criado: String(c.createdAt ?? "").slice(0, 10) })),
        };
      }
      if (Object.keys(out).length === 1) throw new ToolUserError("Sem acesso a esse tipo de casos.");
      return out;
    },
  },
  {
    name: "whatsapp_pendentes",
    description: "WhatsApp: quantas conversas precisam de atenção (por ler ou por responder) e quantas estão fora do prazo de resposta.",
    parameters: { type: "object", properties: {} },
    available: (ctx) => can(ctx.user, "whatsapp", "view"),
    async run(_args, ctx) {
      const b = await ctx.call("whatsapp.badge");
      return { precisamDeAtencao: num(b?.attention), foraDoPrazo: num(b?.overdue), prazoMinutos: num(b?.slaMinutes) };
    },
  },
  {
    name: "minha_avaliacao",
    description: "A avaliação individual da PRÓPRIA pessoa num intervalo: pontos, horas, recolhas, entregas, movimentos (levar ao parque e entre garagens), mudanças de lugar (mesma garagem: não são movimentos), atrasos ao trabalho (entrada 5 min ou mais depois da hora da escala ou do horário), excessos de velocidade, reclamações e acidentes. Omissão: últimos 30 dias.",
    parameters: { type: "object", properties: { ...rangeParams } },
    available: (ctx) => roleRank(ctx.user.role) >= ROLE_RANK.extra,
    async run(args, ctx) {
      const { from, to } = rangeArgs({ de: args.de, ate: args.ate ?? ctx.today }, ctx.today, { defaultFrom: addDays(ctx.today, -29), maxDays: 93 });
      const r = await ctx.call("evaluation.mine", { from, to });
      if (!r?.employee || !r.totals) return { periodo: { de: from, ate: to }, semDados: true, nota: "Sem ficha de colaborador ligada ou sem dias avaliados." };
      const m = r.totals.metrics ?? {};
      return {
        periodo: { de: from, ate: to }, dias: num(r.totals.days),
        pontos: { total: num(r.totals.score?.totalPoints), positivos: num(r.totals.score?.positivePoints), negativos: num(r.totals.score?.negativePoints) },
        porRegra: (r.totals.score?.lines ?? []).filter((l: any) => num(l.count) !== 0).map((l: any) => ({ regra: l.label, n: num(l.count), pontos: num(l.subtotal) })),
        metricas: { horas: num(m.hoursWorked), recolhas: num(m.recolhas), entregas: num(m.entregas), movimentos: num(m.movements), mudancasDeLugar: num(m.spotChanges), atrasosTrabalho: lateArrivalsOf({ delays: num(m.delays), lateServices: num(m.lateServices) }), excessosVelocidade: num(m.speedingEvents), reclamacoes: num(m.complaints), acidentes: num(m.accidents) },
        pontosPorHora: r.totals.perHour?.pointsPerHour ?? null,
        contestacoesAbertas: (r.disputes ?? []).filter((d: any) => d.status === "open").length,
      };
    },
  },
  {
    name: "minhas_tarefas",
    description: "As tarefas atribuídas à PRÓPRIA pessoa: contagens por estado, em atraso, e a lista (máx. 20).",
    parameters: { type: "object", properties: {} },
    available: (ctx) => can(ctx.user, "tarefas", "view"),
    // Títulos escritos à mão (podem ter emails, telefones, matrículas).
    pii: { text: ["titulo"] },
    async run(_args, ctx) {
      const [rows, stats] = await Promise.all([
        ctx.call("tasks.list", { mine: true }) as Promise<any[]>,
        ctx.call("tasks.stats", { mine: true }).catch(() => null),
      ]);
      const tasks = (rows ?? []).map((r: any) => r.task ?? r);
      const open = tasks.filter((t: any) => t.taskStatus !== "done");
      const list = capRows(open);
      return {
        porFazer: open.length, emAtraso: stats ? num(stats.overdue) : null, porEstado: countBy(tasks, (t: any) => String(t.taskStatus)),
        tarefas: list.rows.map((t) => ({ id: t.id, titulo: String(t.title ?? "").slice(0, 100), estado: t.taskStatus, prioridade: t.taskPriority, prazo: t.dueDate ? String(t.dueDate).slice(0, 16) : null })),
        ...(list.truncated ? { mostradas: list.rows.length, total: list.total } : {}),
      };
    },
  },
  {
    name: "financeiro_totais",
    description: "Totais financeiros de reservas num intervalo: valor das reservas com check-in no período (não canceladas) e valor por cidade. Só para quem tem acesso aos totais financeiros.",
    parameters: { type: "object", properties: { ...rangeParams, cidade: cityParam } },
    available: (ctx) => ctx.financeAllowed,
    async run(args, ctx) {
      if (!ctx.financeAllowed) throw new ToolUserError("Sem permissão para ver totais financeiros.");
      const { from, to } = rangeArgs(args, ctx.today, { maxDays: 366 });
      const city = resolveCityArg(ctx.access, args.cidade);
      const s = await ctx.call("multipark.bookingStats", { from, to, ...(city ? { projectId: city.projectId } : {}) });
      return {
        periodo: { de: from, ate: to }, cidade: city?.name ?? "todas",
        valorReservasComCheckinNoPeriodo: Math.round(num(s?.receitaPeriodo) * 100) / 100,
        porCidade: (s?.byCity ?? []).slice(0, MAX_TOOL_ROWS).map((c: any) => ({ cidade: c.name, reservasCriadas: num(c.bookings), valor: Math.round(num(c.revenue) * 100) / 100 })),
        nota: "Valores em euros tal como vêm das reservas Multipark (totalPrice).",
      };
    },
  },
];

/**
 * Plano MPV (F2/F3): no modo MPV (piloto) o Multis tem também `regras_em_vigor`
 * (./rulesTool.ts) e navega na árvore da ajuda com `ajuda_abrir`/`ajuda_procurar`
 * em vez do `abrir_ajuda`; fora dele, o conjunto de sempre (princípio 1: o Multis não
 * muda para quem não está no piloto).
 */
// F3: ajuda_abrir/ajuda_procurar (./helpTools.ts) no lugar do abrir_ajuda; a ordem é a mesma para toda a gente (uma cache por modelo).
// F4: as ferramentas de dados do piloto (./mpvDataTools.ts) no fim; a `avaliacao_minha` alarga (e substitui) a `minha_avaliacao`.
export const MPV_REPLACED_TOOLS: readonly string[] = ["abrir_ajuda", "minha_avaliacao"];
export const MPV_STAFF_TOOLS: ChatTool<StaffToolCtx>[] = [
  ...HELP_NAV_TOOLS, ...STAFF_TOOLS.filter((t) => !MPV_REPLACED_TOOLS.includes(t.name)), RULES_IN_FORCE_TOOL, ...MPV_DATA_TOOLS,
];
export function staffToolsFor(mode: { pilot: boolean }): ChatTool<StaffToolCtx>[] {
  return mode.pilot ? MPV_STAFF_TOOLS : STAFF_TOOLS;
}
