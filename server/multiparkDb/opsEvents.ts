/**
 * Plano 64 (B0) — UMA regra para "que parques" e "que reservas" entre as
 * listas das Operações (opsLists.ts: Reservas, Recolhas, Entregas e
 * Cancelados) e as contagens (opsCounts.ts: Geral, Dashboard das Operações,
 * Resumo de /operacoes e MCP). Os dois construtores pedem aqui:
 *
 *   - o PREDICADO de cada acontecimento (opsEventParts): a data que conta, o
 *     pré-filtro nas colunas indexadas e a regra do cancelamento — o mesmo
 *     texto e os mesmos parâmetros nos dois;
 *   - que ESTADOS entram (opsEventStatuses): as canceladas ficam fora das
 *     criadas "ativas", das entradas e das saídas; as compras online por
 *     pagar (PENDING) ficam fora, salvo nas contas operacionais (D6);
 *   - os PARQUES do âmbito (readScopeParks): todos os parques das cidades de
 *     quem pede — os nossos e TODO o Marketplace, operado ou não (os não
 *     operados só levam a etiqueta) — classificados pela regra única
 *     (shared/multiparkParks.ts).
 *
 * Cancelada em: a linha "Cancellation" MAIS RECENTE da reserva (a mesma
 * LATERAL do Financeiro, financeAgg.ts); sem nenhuma linha, a última
 * alteração da reserva (Booking.updatedAt), marcada como data aproximada (≈).
 *
 * Regras de read.ts: SQL parametrizado e construtores PUROS.
 */
import { multiparkDbQuery, type SqlParam } from "./client";
import type { ParamList } from "./read";
import { buildParksSql, mapParks, type DayPark } from "./dayBookings";
import { createLiveCache } from "./liveCache";

type Query = <T = Record<string, unknown>>(sql: string, params?: SqlParam[]) => Promise<T[]>;

/** Os acontecimentos que se contam e se listam. */
export type OpsEventId = "created" | "checkin" | "checkout" | "cancelled";

/** Uma parte (SELECT … FROM … WHERE) de um acontecimento. */
export interface OpsEventPart {
  /** FROM: "Booking" b e, nos cancelados com registo, a última linha "Cancellation" (cx). */
  from: string[];
  /** As condições do acontecimento (a data que conta), já juntas com AND. */
  where: string;
  /** A coluna com a data que conta (dia de Lisboa, ordem da lista). */
  at: string;
  /** Cancelada sem linha "Cancellation": datada pela última alteração (≈). */
  approx: boolean;
  /** Esta parte tem a linha "Cancellation" (alias cx). */
  hasCx: boolean;
}

/** A linha "Cancellation" mais recente da reserva (alias cx: id, createdAt, refund). */
export const LATEST_CANCELLATION_JOIN =
  `JOIN LATERAL (SELECT x."id", x."createdAt", x."refund" FROM "Cancellation" x WHERE x."bookingId" = b."id" ORDER BY x."createdAt" DESC LIMIT 1) cx ON TRUE`;

const BOOKING = `"Booking" b`;

const shiftTs = (ts: string, days: number) =>
  new Date(Date.parse(`${ts.replace(" ", "T")}Z`) + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

/**
 * O predicado de um acontecimento em [start, end) UTC ("YYYY-MM-DD HH:MM:SS").
 * Entradas/saídas: a hora real (checkIn/checkOut) com um pré-filtro de 1 dia
 * de folga na coluna indexada ("…Date"). Cancelados: duas partes (com a linha
 * "Cancellation" mais recente; sem nenhuma, pela última alteração). PURA.
 */
export function opsEventParts(e: OpsEventId, p: ParamList, start: string, end: string): OpsEventPart[] {
  const range = (col: string) => `${col} >= ${p.add(start)}::timestamp AND ${col} < ${p.add(end)}::timestamp`;
  switch (e) {
    case "created":
      return [{ from: [BOOKING], where: range(`b."createdAt"`), at: `b."createdAt"`, approx: false, hasCx: false }];
    case "checkin":
    case "checkout": {
      const col = e === "checkin" ? "checkIn" : "checkOut";
      const pre = `b."${col}Date" >= ${p.add(shiftTs(start, -1))}::timestamp AND b."${col}Date" < ${p.add(shiftTs(end, 1))}::timestamp`;
      return [{ from: [BOOKING], where: `${pre} AND ${range(`b."${col}"`)}`, at: `b."${col}"`, approx: false, hasCx: false }];
    }
    case "cancelled":
      return [
        { from: [BOOKING, LATEST_CANCELLATION_JOIN], where: range(`cx."createdAt"`), at: `cx."createdAt"`, approx: false, hasCx: true },
        {
          from: [BOOKING],
          where: `${range(`b."updatedAt"`)} AND NOT EXISTS (SELECT 1 FROM "Cancellation" c2 WHERE c2."bookingId" = b."id")`,
          at: `b."updatedAt"`, approx: true, hasCx: false,
        },
      ];
  }
}

/** Estados de um acontecimento: só `only`, ou todos menos `exclude`. */
export interface OpsStatusRule { only: string | null; exclude: string[] }

/**
 * Que estados entram em cada acontecimento — a regra das listas e das
 * contagens. `withCancelled`: as criadas TODAS (a lista Reservas mostra as
 * já canceladas à parte; a contagem "createdAll" do Resumo). `includePending`:
 * contas operacionais, as compras por pagar contam (D6). PURA.
 */
export function opsEventStatuses(e: OpsEventId, o: { includePending?: boolean; withCancelled?: boolean } = {}): OpsStatusRule {
  if (e === "cancelled") return { only: "CANCELLED", exclude: [] };
  const exclude: string[] = [];
  if (!(e === "created" && o.withCancelled)) exclude.push("CANCELLED");
  if (!o.includePending) exclude.push("PENDING");
  return { only: null, exclude };
}

/** A regra dos estados em SQL com os estados por extenso (constantes, nunca texto de fora). PURA. */
export function statusSqlLiteral(rule: OpsStatusRule): string {
  const lit = (s: string) => `'${s.replace(/[^A-Z_]/g, "")}'`;
  if (rule.only) return `b."status"::text = ${lit(rule.only)}`;
  if (!rule.exclude.length) return "TRUE";
  if (rule.exclude.length === 1) return `b."status"::text <> ${lit(rule.exclude[0])}`;
  return `b."status"::text NOT IN (${rule.exclude.map(lit).join(", ")})`;
}

/** A mesma regra dos estados, com os estados como parâmetros (uma condição cada). PURA. */
export function statusConds(rule: OpsStatusRule, p: ParamList): string[] {
  if (rule.only) return [`b."status"::text = ${p.add(rule.only)}`];
  return rule.exclude.map((s) => `b."status"::text <> ${p.add(s)}`);
}

// ─── Parques do âmbito ──────────────────────────────────────────────────────

/** A tabela "Park" inteira (~55 linhas, igual para toda a gente): 5 min em memória, como o loadLiveContext. */
const parksCache = createLiveCache(5 * 60_000, 2);

export function resetScopeParksCache(): void { parksCache.clear(); }

/**
 * Os parques das cidades `cities` (undefined = todas), classificados — o
 * universo das listas e das contagens. Só a leitura da tabela "Park" fica em
 * cache; o corte pelas cidades de quem pede faz-se em cada pedido (a cache
 * nunca guarda o âmbito de ninguém). Lança se a BD da Multipark falhar.
 */
export async function readScopeParks(cities?: string[], query: Query = multiparkDbQuery): Promise<DayPark[]> {
  const read = async () => { const ps = buildParksSql(); return query<Record<string, unknown>>(ps.sql, ps.params); };
  // Um leitor de fora (testes, scripts) lê sempre; a cache é só a do leitor da app.
  const rows = query === multiparkDbQuery ? await parksCache.get("Park", read) : await read();
  return mapParks(rows, cities);
}
