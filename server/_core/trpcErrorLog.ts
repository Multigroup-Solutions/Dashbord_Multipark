/**
 * Registo dos 500 do tRPC (onError dos createExpressMiddleware da Vercel e do
 * Railway). Sem isto o log só dizia "500" — o tRPC não regista os erros do
 * servidor (ex.: complaints.vehicleAgents, out 2026).
 *
 *  - Só INTERNAL_SERVER_ERROR: FORBIDDEN, NOT_FOUND, BAD_REQUEST, UNAUTHORIZED…
 *    são respostas normais e não se registam.
 *  - Caminho do procedimento, código e a mensagem de cada causa (com o código
 *    do driver: ER_…, SQLSTATE, QUERY_FAILED…). NUNCA o input nem o contexto
 *    (dados pessoais): a mensagem perde o "params:" das consultas do drizzle e
 *    passa pela máscara de dados pessoais (redactPii) e de segredos.
 *  - Em produção não vai o stack: só os nomes das funções onde rebentou.
 */
import { redactPii } from "./ai/pii";
import { redactSecrets } from "../multiparkDb/client";

export interface TrpcServerErrorInfo {
  error: { code: string; message: string; name?: string; cause?: unknown; stack?: string };
  path: string | undefined;
  type: string;
}

const MAX_TEXT = 300;
const MAX_CAUSES = 4;
const MAX_FRAMES = 6;

/** Texto de um erro seguro para o log: sem "params:", valores ecoados, segredos nem dados pessoais. PURA. */
export function safeErrorText(raw: unknown): string {
  let s = String(raw ?? "");
  const params = s.search(/\n\s*params:/i); // DrizzleQueryError: "Failed query: …\nparams: a,b"
  if (params >= 0) s = s.slice(0, params);
  // O MySQL ecoa o valor em "Duplicate entry '…'" e "Incorrect/Truncated … value: '…'".
  s = s.replace(/(Duplicate entry |value: )'[^']*'/gi, "$1'***'");
  s = redactSecrets(redactSecrets(s), process.env.DATABASE_URL);
  s = redactPii(s).text.replace(/\s+/g, " ").trim();
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

/** Nomes das funções do stack, da mais funda para fora (sem caminhos, node_modules, node:internal nem anónimas). PURA. */
export function stackFunctions(stack: string | undefined, max = MAX_FRAMES): string[] {
  const out: string[] = [];
  for (const line of String(stack ?? "").split("\n")) {
    const m = /^\s*at (?:async )?(?:new )?([^\s(]+)(?: \[as [^\]]+\])? \((.*)\)\s*$/.exec(line);
    if (!m || m[1].includes("<anonymous>") || !/:\d+:\d+$/.test(m[2]) || /node_modules|^node:|^internal\//.test(m[2])) continue;
    out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

interface Level { name: string; code: string; message: string; stack?: string }

/** Código do erro: o do driver/nosso + errno e SQLSTATE do MySQL. PURA. */
function codeOf(e: any): string {
  const parts = [
    e?.code,
    e?.errno != null && e.errno !== e.code ? `errno ${e.errno}` : null,
    e?.sqlState && e.sqlState !== e.code ? `sqlState ${e.sqlState}` : null,
  ].filter((x) => x != null && String(x).trim() !== "").map((x) => String(x).slice(0, 48));
  return parts.length ? ` [${parts.join(", ")}]` : "";
}

/** O erro e as suas causas (TRPCError → MultiparkDbError / DrizzleQueryError → erro do driver). PURA. */
function levelsOf(error: unknown): Level[] {
  const out: Level[] = [];
  const seen = new Set<unknown>();
  for (let cur: any = error; cur && typeof cur === "object" && !seen.has(cur) && out.length <= MAX_CAUSES; cur = cur.cause) {
    seen.add(cur);
    const name = String(cur.name || cur.constructor?.name || "Error");
    out.push({ name, code: name === "TRPCError" ? "" : codeOf(cur), message: String(cur.message ?? ""), stack: typeof cur.stack === "string" ? cur.stack : undefined });
  }
  return out;
}

/** Linha do log de um 500 (e o stack completo fora de produção). PURA. */
export function describeTrpcServerError(info: TrpcServerErrorInfo, production: boolean): { line: string; stack?: string } {
  const levels = levelsOf(info.error);
  // Um erro qualquer chega embrulhado num TRPCError com a mesma mensagem: mostra-se a causa.
  const shown = levels.length > 1 ? levels.slice(1) : levels;
  let previous = "";
  const causes = shown.map((l) => {
    const msg = safeErrorText(l.message);
    const text = msg && msg !== previous ? `${l.name}${l.code}: ${msg}` : `${l.name}${l.code}`;
    previous = msg;
    return text;
  });
  const deepest = [...levels].reverse().find((l) => stackFunctions(l.stack).length > 0);
  const where = deepest ? stackFunctions(deepest.stack).join(" ← ") : "";
  const line = `[tRPC 500] ${info.path ?? "(sem caminho)"} (${info.type}) ${info.error.code} — ${causes.join(" | causa: ")}${where ? ` | em: ${where}` : ""}`;
  return production ? { line } : { line, stack: deepest?.stack ?? levels[0]?.stack };
}

/** onError do tRPC: regista os INTERNAL_SERVER_ERROR (e só esses). Nunca lança. */
export function logTrpcServerError(info: TrpcServerErrorInfo): void {
  if (info.error?.code !== "INTERNAL_SERVER_ERROR") return;
  try {
    const { line, stack } = describeTrpcServerError(info, process.env.NODE_ENV === "production");
    if (stack) console.error(line, `\n${stack}`);
    else console.error(line);
  } catch {
    console.error(`[tRPC 500] ${info.path ?? "(sem caminho)"} (${info.type}) INTERNAL_SERVER_ERROR`);
  }
}
