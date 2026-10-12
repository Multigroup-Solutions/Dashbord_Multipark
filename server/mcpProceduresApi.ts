/**
 * MCP pessoal — os procedimentos do Dashboard (tRPC) pela /api/v1, em nome de
 * quem criou a chave.
 *
 * Em vez de uma rota REST por cada dado, o MCP local do Jorge pede qualquer
 * LEITURA (query) que os ecrãs usam, e o servidor corre-a como a pessoa que
 * criou a chave: as mesmas permissões, o mesmo alcance de cidade e os mesmos
 * links assinados que essa pessoa tem na app (requireUser em _core/trpc.ts).
 * Nunca vê mais do que essa pessoa vê no Dashboard.
 *
 * Capacidades próprias, "owner:read" e "owner:write": só se marcam à mão no
 * ecrã API Keys; nem "admin" nem as chaves antigas as trazem (ver
 * shared/apiKeyCapabilities.ts). Alterações: só as da lista MCP_ACTIONS; as
 * que saem para fora (Google, email ao cliente) pedem confirmExternal.
 *
 *   GET  /procedures?search=          lista as leituras, com o input de cada uma
 *   POST /procedures/call             { path, input } → corre a leitura
 *   GET  /procedures/actions?search=  lista as alterações abertas ao MCP
 *   POST /procedures/action           { path, input, confirmExternal? } → faz a alteração
 */
import type { Router, Request, Response } from "express";
import { getApiKeyInfo, logApiKeyAction, requireCapability } from "./apiKeyAuth";

type Handler = (fn: (req: Request, res: Response) => Promise<any>) => (req: Request, res: Response) => void;

/** Resposta acima disto → 413 (o Vercel corta a 4,5 MB). */
export const MAX_RESULT_BYTES = 4_000_000;

// ─── Puras (testadas em mcpProceduresApi.test.ts) ───────────────────────────

/**
 * Leituras que nunca saem por aqui, mesmo sendo queries: as chaves de API
 * (gerir chaves por uma chave não faz sentido) e tudo o que trate de tokens.
 */
const DENY: RegExp[] = [/^apiKeys\./, /token/i];

export type ProcedureType = "query" | "mutation" | "subscription";

/**
 * Alterações que o MCP pode fazer (capacidade "owner:write"), escolhidas uma a
 * uma pelo Jorge (12 out 2026). Ficam de fora apagar, carregar ficheiros,
 * salários e tudo o que não esteja aqui. `external` = sai para fora da
 * empresa (Google, email ao cliente): exige `confirmExternal: true` no pedido.
 */
export const MCP_ACTIONS: Record<string, { area: string; external?: true }> = {
  // Faltas e ponto
  "rh.penalties.review": { area: "Faltas" },
  "rh.penalties.reviewMany": { area: "Faltas" },
  "rh.timeRecords.review": { area: "Ponto" },
  // Avaliação (pontos)
  "evaluation.adjust": { area: "Avaliação" },
  "evaluation.voidAdjustment": { area: "Avaliação" },
  "evaluation.disputes.resolve": { area: "Avaliação" },
  "evaluation.setExplanationHidden": { area: "Avaliação" },
  "lostFound.reviewDriverPoints": { area: "Avaliação" },
  "incidents.confirmAccident": { area: "Avaliação" },
  "incidents.voidAccident": { area: "Avaliação" },
  "incidents.confirmDriver": { area: "Avaliação" },
  // Utilizadores e colaboradores: juntar e separar
  "identityLinks.mergeUsers": { area: "Utilizadores" },
  "identityLinks.mergeEmployees": { area: "Utilizadores" },
  "identityLinks.linkUser": { area: "Utilizadores" },
  "identityLinks.detachAccount": { area: "Utilizadores" },
  "identityLinks.linkAgent": { area: "Utilizadores" },
  "identityLinks.detachAgent": { area: "Utilizadores" },
  "identityLinks.removeAccountAlias": { area: "Utilizadores" },
  "identityLinks.removeAgentAlias": { area: "Utilizadores" },
  // Clientes (CRM): juntar e separar
  "crm.merge": { area: "Clientes" },
  "crm.split": { area: "Clientes" },
  "crm.dismissSuggestion": { area: "Clientes" },
  "crm.undismissSuggestion": { area: "Clientes" },
  "crm.update": { area: "Clientes" },
  "crm.relation": { area: "Clientes" },
  // Tarefas
  "tasks.create": { area: "Tarefas" },
  "tasks.update": { area: "Tarefas" },
  "tasks.setStatus": { area: "Tarefas" },
  "tasks.addComment": { area: "Tarefas" },
  // Críticas
  "reviews.create": { area: "Críticas" },
  "reviews.update": { area: "Críticas" },
  "reviews.setPark": { area: "Críticas" },
  "reviews.generateResponse": { area: "Críticas" },
  "reviews.approveResponse": { area: "Críticas" },
  "reviews.convertToComplaint": { area: "Críticas" },
  "reviews.publishReply": { area: "Críticas", external: true },
  // Reclamações
  "complaints.create": { area: "Reclamações" },
  "complaints.update": { area: "Reclamações" },
  "complaints.addMessage": { area: "Reclamações" },
  "complaints.attachDriver": { area: "Reclamações" },
  "complaints.detachDriver": { area: "Reclamações" },
  "complaints.archive": { area: "Reclamações" },
  "complaints.unarchive": { area: "Reclamações" },
  "complaints.convertToLostFound": { area: "Reclamações" },
  "complaints.sendEmailToClient": { area: "Reclamações", external: true },
  // Perdidos e achados
  "lostFound.create": { area: "Perdidos e achados" },
  "lostFound.update": { area: "Perdidos e achados" },
  "lostFound.addMessage": { area: "Perdidos e achados" },
  "lostFound.attachDriver": { area: "Perdidos e achados" },
  "lostFound.detachDriver": { area: "Perdidos e achados" },
  "lostFound.setDriverAccountability": { area: "Perdidos e achados" },
  "lostFound.decideMatch": { area: "Perdidos e achados" },
  "lostFound.archive": { area: "Perdidos e achados" },
  "lostFound.unarchive": { area: "Perdidos e achados" },
  "lostFound.convertToComplaint": { area: "Perdidos e achados" },
  "lostFound.sendEmailToClient": { area: "Perdidos e achados", external: true },
  // Ocorrências
  "incidents.create": { area: "Ocorrências" },
  "incidents.update": { area: "Ocorrências" },
  "incidents.addNote": { area: "Ocorrências" },
  "incidents.convertToComplaint": { area: "Ocorrências" },
  "incidents.convertToLostFound": { area: "Ocorrências" },
};

/** Pode esta alteração passar? Só mutations da lista; as que saem para fora pedem confirmação. */
export function actionAllowed(path: string, type: ProcedureType | undefined, confirmExternal: unknown): { ok: true } | { ok: false; status: 400 | 403 | 404; error: string } {
  if (!type) return { ok: false, status: 404, error: `Procedimento desconhecido: ${path}` };
  if (type !== "mutation") return { ok: false, status: 400, error: "Isto é uma leitura: usa /procedures/call." };
  const a = MCP_ACTIONS[path];
  if (!a) return { ok: false, status: 403, error: `Esta alteração não está aberta ao MCP: ${path}. Pede ao Jorge para a acrescentar à lista (server/mcpProceduresApi.ts).` };
  if (a.external && confirmExternal !== true) {
    return { ok: false, status: 400, error: "Isto sai para fora (Google ou email ao cliente). Confirma o texto com o Jorge e manda confirmExternal: true." };
  }
  return { ok: true };
}

/** Pode esta chamada passar? Só queries, e fora da lista negra. */
export function procedureAllowed(path: string, type: ProcedureType | undefined): { ok: true } | { ok: false; status: 403 | 404; error: string } {
  if (!type) return { ok: false, status: 404, error: `Procedimento desconhecido: ${path}` };
  if (DENY.some((re) => re.test(path))) return { ok: false, status: 403, error: `Este procedimento não está disponível pelo MCP: ${path}` };
  if (type !== "query") return { ok: false, status: 403, error: "Isto é uma alteração: usa /procedures/action (só as da lista aberta ao MCP)." };
  return { ok: true };
}

/** Pesquisa simples por palavras (todas têm de aparecer no caminho, sem acentos nem maiúsculas). */
export function matchesSearch(path: string, search: string | undefined): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = norm(String(search ?? "")).split(/[\s.]+/).filter(Boolean);
  const p = norm(path);
  return words.every((w) => p.includes(w));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Datas em texto → Date (o MCP manda JSON; vários inputs pedem z.date()).
 * Só se usa numa 2.ª tentativa, quando a 1.ª falhou na validação do input.
 * Devolve `changed: false` se não havia nada para converter.
 */
export function reviveIsoDates(value: unknown): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && ISO_DATE.test(v)) {
      const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
      if (!Number.isNaN(d.getTime())) { changed = true; return d; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const out = walk(value);
  return { value: out, changed };
}

/** JSON do resultado (BigInt → número/texto), para medir e enviar. */
export function resultJson(data: unknown): string {
  return JSON.stringify(data === undefined ? null : data, (_k, v) =>
    typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v);
}

/**
 * Conta que a chave representa: quem a criou, ou a conta que ficou se foi
 * junta a outra (`merged_into_<id>`, como em creatorStillActive). null =
 * sem autor ou sem conta ativa.
 */
export async function resolveOwnerId(
  createdById: number | null | undefined,
  load: (id: number) => Promise<{ isActive: unknown; loginMethod?: string | null } | null | undefined>,
): Promise<number | null> {
  if (createdById == null) return null;
  let id = createdById;
  const seen = new Set<number>();
  while (!seen.has(id) && seen.size < 5) {
    seen.add(id);
    const u = await load(id);
    if (!u) return null;
    if (u.isActive === true || Number(u.isActive) === 1) return id;
    const m = /^merged_into_(\d+)$/.exec(String(u.loginMethod ?? ""));
    if (!m) return null;
    id = Number(m[1]);
  }
  return null;
}

// ─── tRPC: lista e chamada ──────────────────────────────────────────────────

type AnyProcedure = { _def: { type?: ProcedureType; inputs?: unknown[]; meta?: unknown } };

async function procedures(): Promise<Record<string, AnyProcedure>> {
  const { appRouter } = await import("./routers");
  return (appRouter as any)._def.procedures as Record<string, AnyProcedure>;
}

/** Input do procedimento em JSON Schema (zod v4); null se não tem input ou não dá para converter. */
async function inputSchemaOf(proc: AnyProcedure): Promise<unknown> {
  const inputs = proc._def.inputs ?? [];
  if (inputs.length === 0) return null;
  const { z } = await import("zod");
  try {
    const schemas = inputs.map((s) => z.toJSONSchema(s as any, { unrepresentable: "any", io: "input" } as any));
    return schemas.length === 1 ? schemas[0] : { allOf: schemas };
  } catch {
    return { description: "Input não convertível para JSON Schema — vê o código do procedimento." };
  }
}

const isInputError = (err: any) =>
  err?.code === "BAD_REQUEST" && (err?.cause?.name === "ZodError" || Array.isArray(err?.cause?.issues));

/**
 * Corre o procedimento como quem criou a chave e responde. As leituras e as
 * alterações passam por aqui; quem chama já confirmou que o caminho é permitido.
 * A 2.ª tentativa com as datas convertidas só acontece quando a 1.ª falhou
 * na validação do input — aí o procedimento nem chegou a correr.
 */
async function runAsOwner(req: Request, res: Response, path: string, input: unknown): Promise<{ ok: boolean }> {
  const key = getApiKeyInfo(req);
  const { loadApiKeyCreator } = await import("./apiKeyAuth");
  const ownerId = await resolveOwnerId(key?.createdById, loadApiKeyCreator);
  if (ownerId == null) { res.status(403).json({ error: "Esta chave não tem um autor ativo; cria uma chave nova no ecrã API Keys." }); return { ok: false }; }
  const { getUserById } = await import("./db");
  const user = await getUserById(ownerId);
  if (!user) { res.status(403).json({ error: "A conta de quem criou a chave já não existe." }); return { ok: false }; }

  const { appRouter } = await import("./routers");
  const caller = (appRouter as any).createCaller({ req, res, user, accessDenied: false });
  const fn = path.split(".").reduce((o: any, k: string) => o?.[k], caller);
  let data: unknown;
  try {
    data = await fn(input);
  } catch (err: any) {
    const revived = isInputError(err) ? reviveIsoDates(input) : { changed: false, value: input };
    if (!revived.changed) { sendTrpcError(res, path, err); return { ok: false }; }
    try { data = await fn(revived.value); } catch (err2: any) { sendTrpcError(res, path, err2); return { ok: false }; }
  }
  const json = resultJson({ success: true, data });
  if (json.length > MAX_RESULT_BYTES) {
    // Numa alteração ela já foi feita: diz-se isso, para não se repetir.
    res.status(413).json({ done: true, error: `Feito, mas o resultado é demasiado grande para devolver (${Math.round(json.length / 1024)} KB). Numa leitura, usa filtros ou paginação no input.` });
    return { ok: true };
  }
  res.type("application/json").send(json);
  return { ok: true };
}

const pathOf = (req: Request) => (typeof req.body?.path === "string" ? req.body.path.trim() : "");

export function registerMcpProcedureRoutes(r: Router, h: Handler): void {
  r.get("/procedures", requireCapability("owner:read"), h(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const withInput = req.query.withInput === "1" || req.query.withInput === "true";
    const procs = await procedures();
    const rows: { path: string; input?: unknown }[] = [];
    for (const [path, proc] of Object.entries(procs)) {
      if (!procedureAllowed(path, proc._def.type).ok || !matchesSearch(path, search)) continue;
      rows.push(withInput ? { path, input: await inputSchemaOf(proc) } : { path });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ success: true, count: rows.length, data: rows });
  }));

  r.post("/procedures/call", requireCapability("owner:read"), h(async (req, res) => {
    const path = pathOf(req);
    if (!path) return res.status(400).json({ error: "Falta o campo path (ex.: \"rh.list\")." });
    const procs = await procedures();
    const allowed = procedureAllowed(path, procs[path]?._def.type);
    if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
    await runAsOwner(req, res, path, req.body?.input);
  }));

  // Alterações abertas ao MCP (lista MCP_ACTIONS), com o input de cada uma.
  r.get("/procedures/actions", requireCapability("owner:write"), h(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const withInput = req.query.withInput === "1" || req.query.withInput === "true";
    const procs = await procedures();
    const rows: { path: string; area: string; external: boolean; input?: unknown }[] = [];
    for (const [path, a] of Object.entries(MCP_ACTIONS)) {
      const proc = procs[path];
      if (proc?._def.type !== "mutation" || !(matchesSearch(path, search) || matchesSearch(a.area, search))) continue;
      const row = { path, area: a.area, external: !!a.external };
      rows.push(withInput ? { ...row, input: await inputSchemaOf(proc) } : row);
    }
    res.json({ success: true, count: rows.length, data: rows });
  }));

  r.post("/procedures/action", requireCapability("owner:write"), h(async (req, res) => {
    const path = pathOf(req);
    if (!path) return res.status(400).json({ error: "Falta o campo path (ex.: \"tasks.setStatus\")." });
    const procs = await procedures();
    const allowed = actionAllowed(path, procs[path]?._def.type, req.body?.confirmExternal);
    if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });
    const { ok } = await runAsOwner(req, res, path, req.body?.input);
    // O procedimento já regista em nome da pessoa; isto marca que foi pelo MCP.
    if (ok) await logApiKeyAction(req, { action: "mcp_action", entity: path, details: `MCP: ${path}`, asKeyEvent: true });
  }));
}

/** Erros do tRPC com o código certo; os internos ficam nos logs (sem fuga de SQL). */
function sendTrpcError(res: Response, path: string, err: any): void {
  const map: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, PRECONDITION_FAILED: 412, TOO_MANY_REQUESTS: 429 };
  const status = map[String(err?.code)];
  if (status) {
    const issues = Array.isArray(err?.cause?.issues) ? err.cause.issues.map((i: any) => ({ path: i.path, message: i.message })) : undefined;
    res.status(status).json({ error: String(err?.message ?? err?.code).slice(0, 2000), ...(issues ? { issues } : {}) });
    return;
  }
  import("./apiKeyAuth").then(({ apiInternalError }) => apiInternalError(res, `v1 procedures ${path}`, err));
}
