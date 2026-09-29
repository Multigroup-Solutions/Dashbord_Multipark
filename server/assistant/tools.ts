/**
 * Ferramentas do assistente da EQUIPA (só leitura). Cada uma embrulha um
 * procedimento tRPC que JÁ existe e chama-o como a própria pessoa (`ctx.call`
 * = appRouter.createCaller com o utilizador do pedido): passam pelo mesmo
 * middleware (cidades do centro de custos, overrides, bloqueios) e pelo mesmo
 * requireAccess da página. Por cima disso, cada ferramenta:
 *  - só é declarada ao modelo se a pessoa tiver o módulo (`available`);
 *  - valida a cidade pedida contra as cidades da pessoa ANTES de chamar;
 *  - devolve só agregados ou listas curtas (≤ 20 linhas), sem emails,
 *    telefones, matrículas nem nomes completos de clientes.
 */
import { can, roleRank, ROLE_RANK, type AccessOverrides } from "../../shared/access";
import type { CityAccess } from "../cityAccess";
import { capRows, MAX_TOOL_ROWS, ToolUserError, type ChatTool } from "../_core/ai/chat/tools";
import type { HelpDoc } from "../_core/ai/chat/retrieval";

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
}

// ─── Cidades ────────────────────────────────────────────────────────────────

export const CITY_NAMES = ["Lisboa", "Porto", "Faro"] as const;
const CITY_ALIASES: Record<string, string> = { lisbon: "lisboa", lisboa: "lisboa", oporto: "porto", porto: "porto", faro: "faro" };
const normCity = (s: string) => {
  const k = s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return CITY_ALIASES[k] ?? k;
};
const EXTRAS_CITY: Record<string, "lisbon" | "porto" | "faro"> = { lisboa: "lisbon", porto: "porto", faro: "faro" };

/**
 * Cidade pedida → id do projeto (cidade) SE a pessoa tiver acesso a ela.
 * Sem cidade → undefined (as consultas já ficam nas cidades da pessoa).
 * Cidade desconhecida ou fora das cidades da pessoa → ToolUserError. PURA.
 */
export function resolveCityArg(access: CityAccess | undefined, cidade: unknown): { projectId: number; name: string } | undefined {
  if (!access || access.missingCostCenter) throw new ToolUserError("Sem cidade atribuída (centro de custos): não consigo consultar dados.");
  if (cidade == null || String(cidade).trim() === "") return undefined;
  const wanted = normCity(String(cidade));
  const names = access.cityNames ?? (access.cityName ? [access.cityName] : []);
  const ids = access.cityNames ? access.cityIds : access.defaultCityId != null ? [access.defaultCityId] : [];
  const i = names.findIndex((n) => normCity(n) === wanted);
  if (i < 0 || ids[i] == null) {
    const known = (CITY_NAMES as readonly string[]).map(normCity).includes(wanted);
    throw new ToolUserError(known ? `Não tens acesso aos dados de ${String(cidade).trim()}.` : `Cidade desconhecida: ${String(cidade).trim()}.`);
  }
  return { projectId: ids[i], name: names[i] };
}

/** Cidade das páginas de extras ("lisbon" | "porto" | "faro"). Sem cidade: a única da pessoa. */
export function extrasCityArg(access: CityAccess | undefined, cidade: unknown): { id: "lisbon" | "porto" | "faro"; name: string } {
  const r = resolveCityArg(access, cidade);
  const names = access?.cityNames ?? (access?.cityName ? [access.cityName] : []);
  const name = r?.name ?? (names.length === 1 ? names[0] : null);
  if (!name) throw new ToolUserError("Indica a cidade (Lisboa, Porto ou Faro).");
  const id = EXTRAS_CITY[normCity(name)];
  if (!id) throw new ToolUserError(`Sem Extras-Dia para ${name}.`);
  return { id, name };
}

// ─── Datas ──────────────────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayArg(v: unknown, fallback: string, label: string): string {
  if (v == null || v === "") return fallback;
  const s = String(v).trim();
  if (!ISO.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new ToolUserError(`${label} inválida (usa AAAA-MM-DD).`);
  return s;
}
/** Intervalo [de, até] com teto de dias. PURA. */
export function rangeArgs(args: Record<string, unknown>, today: string, opts: { defaultFrom?: string; maxDays?: number } = {}): { from: string; to: string } {
  const from = dayArg(args.de, opts.defaultFrom ?? today, "Data inicial");
  const to = dayArg(args.ate, from, "Data final");
  if (to < from) throw new ToolUserError("A data final é anterior à inicial.");
  const max = opts.maxDays ?? 93;
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 >= max) {
    throw new ToolUserError(`Intervalo demasiado grande (máximo ${max} dias).`);
  }
  return { from, to };
}

const firstName = (s: unknown) => String(s ?? "").trim().split(/\s+/)[0] || null;
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

const cityParam = { type: "string", enum: [...CITY_NAMES], description: "Cidade (opcional). Omite para todas as cidades a que a pessoa tem acesso." };
const rangeParams = {
  de: { type: "string", description: "Primeiro dia (AAAA-MM-DD). Omissão: hoje." },
  ate: { type: "string", description: "Último dia, inclusivo (AAAA-MM-DD). Omissão: igual a `de`." },
};

// ─── Ferramentas ────────────────────────────────────────────────────────────

const OPEN_COMPLAINT = ["new", "analyzing", "waiting_client"];
const OPEN_INCIDENT = ["open", "investigating"];
const OPEN_LOST = ["new", "investigating", "found"];

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
      properties: { modulo: { type: "string", description: "Módulo, como aparece entre parênteses no índice da ajuda (ex.: extras_dia, tarefas)." } },
      required: ["modulo"],
    },
    available: () => true,
    async run(args, ctx) {
      const m = String(args.modulo ?? "").trim().toLowerCase();
      const doc = ctx.helpDocs.find((d) => d.module === m || d.file === `${m}.md` || d.title.toLowerCase() === m);
      if (!doc) return { error: "Não há ajuda para esse módulo.", modulos: ctx.helpDocs.map((d) => d.module) };
      return { titulo: doc.title, ajuda: doc.body.slice(0, 3500) };
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
        pessoas: capRows(list.map((x) => ({ nome: firstName(x.personName), turno: x.shift, inicio: hour(num(x.startHour)), fim: hour(num(x.endHour)), tl: !!x.isTeamLeader }))).rows,
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
      if (want("ocorrencias") && can(ctx.user, "ocorrencias", "view")) {
        const rows = ((await ctx.call("incidents.list", filter)) as any[]).filter((c) => OPEN_INCIDENT.includes(c.status));
        out.ocorrencias = {
          abertas: rows.length, porEstado: countBy(rows, (c) => c.status), porTipo: countBy(rows, (c) => c.incidentType),
          recentes: rows.slice(0, 10).map((c) => ({ id: c.id, tipo: c.incidentType, gravidade: c.severity, estado: c.status, criada: String(c.createdAt ?? "").slice(0, 10) })),
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
    description: "A avaliação individual da PRÓPRIA pessoa num intervalo: pontos, horas, recolhas, entregas, movimentos, atrasos, excessos de velocidade, reclamações e acidentes. Omissão: últimos 30 dias.",
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
        metricas: { horas: num(m.hoursWorked), recolhas: num(m.recolhas), entregas: num(m.entregas), movimentos: num(m.movements), atrasos: num(m.delays), excessosVelocidade: num(m.speedingEvents), reclamacoes: num(m.complaints), acidentes: num(m.accidents) },
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
