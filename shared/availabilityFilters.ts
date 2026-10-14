/**
 * Disponibilidade (hub de gestão) — filtros, contagens e destinatários do
 * ecrã "Disponibilidade dos extras". Regras PURAS, partilhadas para serem
 * testadas sem browser (o ecrã só as chama).
 *
 * Redesenho de 14 out 2026 (Jorge: "é uma grande confusão, não se percebe
 * nada"). O ecrã passou a ter quatro blocos, por esta ordem:
 *   1. a semana + os quadrados de estado (Todos · Disponíveis · Indisponíveis
 *      · Sem resposta), que SÃO o filtro de estado;
 *   2. uma barra de filtros: pesquisa, cidade e "Filtros" (dia/horas e "sem
 *      mensagem nas últimas 24h"), com o número de filtros ligados;
 *   3. a barra de envio, que diz sempre a QUEM vai (selecionados ou filtrados);
 *   4. a grelha por cidade, com "Disponíveis" aberto e "Sem resposta" /
 *      "Indisponíveis" fechados (237 linhas de "·" eram só ruído).
 *
 * Invariante que se mantém desde set 2026: o que se envia é o que se vê —
 * sem seleção, o alvo é exatamente o conjunto filtrado da grelha.
 */

import type { CityKey } from "./city";
import { matchesContactQuery, nameMatchScore } from "./contactSearch";
import { formatHourWindow, isAvailableOnDay, matchesAvailabilityWindow, type AvailabilityDayLike } from "./availabilityWindow";
import {
  AVAILABILITY_PAGE_SIZE,
  AVAILABILITY_STATUS_LABELS,
  availabilityStatus,
  countAvailabilityStatuses,
  matchesAvailabilityStatus,
  sortByAvailability,
  type AvailabilityStatus,
  type AvailabilityStatusFilter,
  type CityGroupKey,
} from "./availabilityGroups";

/** "all" = sem filtro; "none" = fichas sem cidade identificada. */
export type AvailabilityCityFilter = CityKey | "all" | "none";

export interface AvailabilityFilters {
  city: AvailabilityCityFilter;
  status: AvailabilityStatusFilter;
  /** Só quem NÃO recebeu WhatsApp nem email nosso nas últimas 24 h. */
  onlyNotContacted24h: boolean;
  /** "any" = qualquer dia da semana; senão o dia (YYYY-MM-DD). */
  windowDay: string;
  windowFrom: number | null;
  windowTo: number | null;
  search: string;
}

export const DEFAULT_AVAILABILITY_FILTERS: AvailabilityFilters = {
  city: "all",
  status: "all",
  onlyNotContacted24h: false,
  windowDay: "any",
  windowFrom: null,
  windowTo: null,
  search: "",
};

/** O mínimo que cada linha da grelha tem de trazer para ser filtrada. */
export interface AvailabilityFilterRow {
  fullName: string;
  phone: string | null;
  phoneE164: string | null;
  city: CityKey | null;
  responded: boolean;
  availableDays: number;
  contactedWithin24h: boolean;
  days: AvailabilityDayLike[];
}

/**
 * Filtro "disponível em" (dia + horas):
 *   - `hours`      → as duas horas escolhidas (num dia certo ou em qualquer dia);
 *   - `day`        → só o dia, sem horas (quem marcou algo nesse dia);
 *   - `incomplete` → só uma das horas: ainda não filtra (o ecrã pede a outra);
 *   - `off`        → nada escolhido.
 */
export type AvailabilityWindowMode = "off" | "day" | "hours" | "incomplete";

export function availabilityWindowMode(f: Pick<AvailabilityFilters, "windowDay" | "windowFrom" | "windowTo">): AvailabilityWindowMode {
  if (f.windowFrom != null && f.windowTo != null) return "hours";
  if (f.windowFrom != null || f.windowTo != null) return "incomplete";
  return f.windowDay !== "any" ? "day" : "off";
}

/** A linha passa no filtro "disponível em"? (regra das horas em availabilityWindow.ts). */
export function matchesWindowFilter(
  days: AvailabilityDayLike[],
  f: Pick<AvailabilityFilters, "windowDay" | "windowFrom" | "windowTo">,
): boolean {
  const mode = availabilityWindowMode(f);
  if (mode === "hours") return matchesAvailabilityWindow(days, f.windowDay === "any" ? null : f.windowDay, f.windowFrom!, f.windowTo!);
  if (mode === "day") return isAvailableOnDay(days, f.windowDay);
  return true;
}

/**
 * Pesquisa livre por pessoa — nome (sem acentos/maiúsculas) ou número. O
 * número é tentado nas DUAS formas que a ficha tem: o E.164 normalizado pelo
 * servidor e o texto em bruto (só assim se encontra quem tem o número escrito
 * de forma que a normalização não reconhece).
 */
export function matchesExtraQuery(
  query: string,
  ex: { fullName: string; phone: string | null; phoneE164: string | null },
): boolean {
  if (matchesContactQuery(query, { name: ex.fullName, phone: ex.phoneE164 })) return true;
  return !!ex.phone && matchesContactQuery(query, { name: ex.fullName, phone: ex.phone });
}

/**
 * Todos os filtros COMPÕEM-SE (AND): cidade → estado → 24 h → dia/horas →
 * pesquisa. `ignoreStatus` serve para os quadrados de estado: contam o que os
 * outros filtros deixam passar, para que carregar num deles mostre esse número.
 */
export function matchesAvailabilityFilters(
  row: AvailabilityFilterRow,
  f: AvailabilityFilters,
  opts: { ignoreStatus?: boolean } = {},
): boolean {
  if (f.city === "none" ? row.city !== null : f.city !== "all" && row.city !== f.city) return false;
  if (!opts.ignoreStatus && !matchesAvailabilityStatus(row, f.status)) return false;
  if (f.onlyNotContacted24h && row.contactedWithin24h) return false;
  if (!matchesWindowFilter(row.days, f)) return false;
  const q = f.search.trim();
  if (q && !matchesExtraQuery(q, row)) return false;
  return true;
}

/**
 * O conjunto que a grelha mostra E o alvo de "enviar aos filtrados". Ordem:
 * disponíveis → sem resposta → indisponíveis, por nome; a pesquisar, quem
 * começa pelo que se escreveu vem primeiro (44a, "começa sempre com o A e o B").
 */
export function applyAvailabilityFilters<T extends AvailabilityFilterRow>(rows: readonly T[], f: AvailabilityFilters): T[] {
  const sorted = sortByAvailability(rows.filter((r) => matchesAvailabilityFilters(r, f)));
  const q = f.search.trim();
  if (!q) return sorted;
  const score = (e: T) => nameMatchScore(q, e.fullName) || 1; // 0 = bateu pelo número
  return sorted
    .map((e, i) => ({ e, i, s: score(e) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.e);
}

/** Números dos quadrados de estado: os outros filtros aplicados, o estado não. */
export function availabilityStatusTiles(rows: readonly AvailabilityFilterRow[], f: AvailabilityFilters): Record<AvailabilityStatusFilter, number> {
  return countAvailabilityStatuses(rows.filter((r) => matchesAvailabilityFilters(r, f, { ignoreStatus: true })));
}

/** Carregar num quadrado já escolhido volta a "Todos" (é um interruptor). */
export function toggleStatusTile(current: AvailabilityStatusFilter, clicked: AvailabilityStatusFilter): AvailabilityStatusFilter {
  return clicked !== "all" && current === clicked ? "all" : clicked;
}

/** Quantos filtros estão ligados DENTRO do botão "Filtros" (o número do botão). */
export function availabilityPopoverFilterCount(f: AvailabilityFilters): number {
  const mode = availabilityWindowMode(f);
  return (mode === "day" || mode === "hours" ? 1 : 0) + (f.onlyNotContacted24h ? 1 : 0);
}

/**
 * Há algum filtro a esconder gente? (mostra "Limpar filtros"). Com a cidade
 * presa à de cima (`cityLocked`), a cidade não conta — não se limpa daqui.
 */
export function hasActiveAvailabilityFilters(f: AvailabilityFilters, opts: { cityLocked?: boolean } = {}): boolean {
  return (
    f.search.trim().length > 0 ||
    f.status !== "all" ||
    (!opts.cityLocked && f.city !== "all") ||
    f.onlyNotContacted24h ||
    availabilityWindowMode(f) !== "off"
  );
}

/** Rótulo curto do filtro "disponível em", para o chip de filtro ativo. */
export function windowFilterLabel(
  f: Pick<AvailabilityFilters, "windowDay" | "windowFrom" | "windowTo">,
  dayLabel: (day: string) => string,
): string | null {
  const mode = availabilityWindowMode(f);
  if (mode === "off" || mode === "incomplete") return null;
  const day = f.windowDay === "any" ? "qualquer dia" : dayLabel(f.windowDay);
  return mode === "hours" ? `${day} · ${formatHourWindow(f.windowFrom!, f.windowTo!)}` : `${day} · qualquer hora`;
}

// ─── Destinatários ──────────────────────────────────────────────────────────

/**
 * - `selected` → os marcados à mão;
 * - `filtered` → sem ninguém marcado, os que os filtros deixam ver;
 * - `all`      → sem ninguém marcado e SEM filtro nenhum: toda a gente (da
 *   cidade de cima, se houver). A barra di-lo assim ("todos os N"), nunca
 *   "filtrados" quando não há filtro (auditoria 14 out 2026).
 */
export type AvailabilitySendScope = "selected" | "filtered" | "all";

/**
 * A quem vai o envio (email e WhatsApp): com gente marcada, só os marcados —
 * tirados da lista COMPLETA, porque quem foi marcado e depois saiu da pesquisa
 * continua no envio (e conta-se à parte em `hiddenSelected`); sem ninguém
 * marcado, exatamente os filtrados — INCLUINDO quem está em secções fechadas
 * da grelha (por isso a barra mostra sempre a divisão por estado).
 */
export function availabilitySendTarget<T extends { employeeId: number }>(
  all: readonly T[],
  shown: readonly T[],
  selected: ReadonlySet<number>,
  opts: { filtersActive?: boolean } = {},
): { scope: AvailabilitySendScope; rows: T[]; hiddenSelected: number } {
  if (selected.size === 0) return { scope: opts.filtersActive ? "filtered" : "all", rows: shown.slice(), hiddenSelected: 0 };
  const visible = new Set(shown.map((e) => e.employeeId));
  const rows = all.filter((e) => selected.has(e.employeeId));
  return { scope: "selected", rows, hiddenSelected: rows.filter((e) => !visible.has(e.employeeId)).length };
}

/**
 * O envio precisa do passo explícito? (auditoria 14 out 2026) Só sem ninguém
 * marcado, com o estado em "Todos" E quando o alvo é TODA a gente (`all`) ou
 * mistura MAIS DE UM estado (`statesCount`) — ex.: disponíveis e sem resposta
 * de uma vez, quase nunca é o que se quer. Um conjunto filtrado só com "sem
 * resposta" (ex.: "Sem mensagem 24h" + Faro) não trava.
 */
export function sendNeedsAllConfirm(scope: AvailabilitySendScope, status: AvailabilityStatusFilter, statesCount: number): boolean {
  return scope !== "selected" && status === "all" && (scope === "all" || statesCount > 1);
}

/**
 * Travão: com `sendNeedsAllConfirm`, os botões ficam desligados com esta razão
 * até se escolher um estado, marcar pessoas ou carregar no link de desbloqueio
 * (`unlocked`, com o texto de `sendAllLabel`). null = pode enviar.
 */
export function sendBlockReason(opts: { scope: AvailabilitySendScope; status: AvailabilityStatusFilter; count: number; statesCount: number; unlocked: boolean }): string | null {
  if (opts.count === 0) return "Ninguém a quem enviar com estes filtros.";
  if (opts.unlocked || !sendNeedsAllConfirm(opts.scope, opts.status, opts.statesCount)) return null;
  return `Escolhe primeiro um estado nos quadrados em cima (ex.: Sem resposta) ou seleciona pessoas. Para enviar assim mesmo, carrega em “${sendAllLabel(opts.scope, opts.count, opts.statesCount)}”.`;
}

/** "Enviar a todos os 320 extras" / "Enviar aos 12 extras filtrados (2 estados)" — link de desbloqueio e botão final dos diálogos. */
export function sendAllLabel(scope: AvailabilitySendScope, count: number, statesCount: number): string {
  return `Enviar ${sendTargetPhrase(scope, count)}${scope !== "all" && statesCount > 1 ? ` (${statesCount} estados)` : ""}`;
}

/** "aos 12 extras selecionados" / "aos 40 extras filtrados" / "a todos os 317 extras" — frase única de botões e confirmações. */
export function sendTargetPhrase(scope: AvailabilitySendScope, count: number): string {
  if (scope === "all") return count === 1 ? "ao único extra" : `a todos os ${count} extras`;
  const what = scope === "selected" ? "selecionado" : "filtrado";
  return count === 1 ? `ao extra ${what}` : `aos ${count} extras ${what}s`;
}

/** "Para: …" da barra de envio. */
export function sendTargetShort(scope: AvailabilitySendScope, count: number): string {
  if (scope === "all") return `todos os ${count} extras`;
  if (scope === "selected") return `${count} selecionado${count === 1 ? "" : "s"}`;
  return `${count} filtrado${count === 1 ? "" : "s"}`;
}

/**
 * Divisão por estado dos destinatários + quantos vão no envio SEM estarem à
 * vista na grelha (cidade/secção fechada ou ainda por mostrar — "Mostrar
 * mais"). `isHidden` diz se a linha não se vê; linhas fora da grelha
 * (`shownIds`) não contam aqui — são os "fora dos filtros" (`hiddenSelected`).
 * `statesCount` = quantos estados diferentes há no alvo.
 */
export function sendTargetBreakdown<T extends { employeeId: number; responded: boolean; availableDays: number }>(
  rows: readonly T[],
  shownIds: ReadonlySet<number>,
  isHidden: (row: T) => boolean,
): { counts: Record<AvailabilityStatus, number>; notVisible: number; statesCount: number; text: string } {
  const counts: Record<AvailabilityStatus, number> = { available: 0, no_answer: 0, unavailable: 0 };
  let notVisible = 0;
  for (const r of rows) {
    counts[availabilityStatus(r)]++;
    if (shownIds.has(r.employeeId) && isHidden(r)) notVisible++;
  }
  const present = STATUS_SECTION_ORDER.filter((s) => counts[s] > 0);
  const text = present.map((s) => statusCountLabel(s, counts[s])).join(" · ");
  return { counts, notVisible, statesCount: present.length, text };
}

/** "inclui 237 que não estão à vista (…)" — nota da barra e dos diálogos (null = vê-se toda a gente). */
export function closedSectionsNote(notVisible: number): string | null {
  return notVisible > 0 ? `inclui ${notVisible} que não ${notVisible === 1 ? "está" : "estão"} à vista (secções fechadas ou por mostrar)` : null;
}

/** Chave da lista única de uma cidade quando se está a pesquisar (para o "Mostrar mais"). */
export function searchListKey(city: CityGroupKey): string {
  return `${city}:search`;
}

/** O que está aberto/fechado e quantas linhas se mostram em cada lista da grelha. */
export interface GridViewState {
  closedCities: ReadonlySet<CityGroupKey>;
  sectionOverrides: Readonly<Record<string, boolean>>;
  /** Linhas pedidas por lista (`sectionKey` / `searchListKey`); falta = uma página. */
  shownPer: Readonly<Record<string, number>>;
}

/**
 * Ids das linhas da grelha que NÃO se veem: cidade fechada, secção fechada ou
 * além das linhas mostradas ("Mostrar mais"). `rows` vem pela ordem da grelha
 * (filtrada e ordenada). Espelha exatamente o que AvailabilityGrid desenha.
 */
export function hiddenGridRowIds<T extends { employeeId: number; city: CityKey | null; responded: boolean; availableDays: number }>(
  rows: readonly T[],
  view: GridViewState,
  opts: { status: AvailabilityStatusFilter; searching: boolean; pageSize?: number },
): Set<number> {
  const page = opts.pageSize ?? AVAILABILITY_PAGE_SIZE;
  const seen = new Map<string, number>();
  const hidden = new Set<number>();
  for (const r of rows) {
    const city: CityGroupKey = r.city ?? "none";
    const st = availabilityStatus(r);
    const key = opts.searching ? searchListKey(city) : sectionKey(city, st);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const open = !view.closedCities.has(city) && (opts.searching || isSectionOpen(view.sectionOverrides, city, st, opts.status));
    const limit = Math.max(0, Math.trunc(view.shownPer[key] ?? page));
    if (!open || index >= limit) hidden.add(r.employeeId);
  }
  return hidden;
}

/** Texto do passo "Confirmar" do envio por email. */
export function emailConfirmText(scope: AvailabilitySendScope, count: number, weekLabel: string, breakdown = ""): string {
  return `Vais enviar o pedido de disponibilidade por email ${sendTargetPhrase(scope, count)}${breakdown ? ` (${breakdown})` : ""}, semana ${weekLabel}. Confirmas?`;
}

/** A secção (cidade × estado) está aberta? A escolha explícita manda; senão `defaultOpenStatuses`. */
export function isSectionOpen(
  overrides: Readonly<Record<string, boolean>>,
  city: CityGroupKey,
  status: AvailabilityStatus,
  filter: AvailabilityStatusFilter,
): boolean {
  return overrides[sectionKey(city, status)] ?? defaultOpenStatuses({ status: filter }).has(status);
}

// ─── Grelha: secções por estado dentro de cada cidade ───────────────────────

/** Ordem das secções dentro de cada cidade (a mesma da ordenação da lista). */
export const STATUS_SECTION_ORDER: readonly AvailabilityStatus[] = ["available", "no_answer", "unavailable"];

/**
 * Parte as linhas de uma cidade pelas três secções, mantendo a ordem de
 * entrada (a ordenação por coluna continua a valer dentro de cada secção).
 * Secções vazias não aparecem.
 */
export function splitByStatus<T extends { responded: boolean; availableDays: number }>(
  rows: readonly T[],
): { status: AvailabilityStatus; rows: T[] }[] {
  const buckets: Record<AvailabilityStatus, T[]> = { available: [], no_answer: [], unavailable: [] };
  for (const r of rows) buckets[availabilityStatus(r)].push(r);
  return STATUS_SECTION_ORDER.filter((s) => buckets[s].length > 0).map((status) => ({ status, rows: buckets[status] }));
}

/** Chave de uma secção (cidade × estado) para lembrar se está aberta e quantas linhas mostra. */
export function sectionKey(city: CityGroupKey, status: AvailabilityStatus): string {
  return `${city}:${status}`;
}

/**
 * Que secções abrem por defeito:
 *   - com um estado escolhido nos quadrados → esse (é o que se pediu para ver);
 *   - senão → só "Disponíveis". "Sem resposta" e "Indisponíveis" ficam
 *     fechadas com o número à vista (não têm dias marcados — eram só "·").
 * A pesquisar não há secções: cada cidade é uma lista só, por relevância.
 */
export function defaultOpenStatuses(opts: { status: AvailabilityStatusFilter }): Set<AvailabilityStatus> {
  if (opts.status !== "all") return new Set([opts.status]);
  return new Set<AvailabilityStatus>(["available"]);
}

/** Frase da secção fechada, para se perceber o que lá está sem a abrir. */
export const STATUS_SECTION_HINTS: Record<AvailabilityStatus, string> = {
  available: "marcaram pelo menos um dia nesta semana",
  no_answer: "ainda não responderam para esta semana",
  unavailable: "responderam que não podem nesta semana",
};

/** "1 disponível" / "3 indisponíveis" / "237 sem resposta" — contagens do cabeçalho de cada cidade. */
export function statusCountLabel(status: AvailabilityStatus, count: number): string {
  const word = status === "no_answer" ? "sem resposta" : status === "available" ? (count === 1 ? "disponível" : "disponíveis") : count === 1 ? "indisponível" : "indisponíveis";
  return `${count} ${word}`;
}

/** "Disponíveis · 2" — título da secção. */
export function statusSectionTitle(status: AvailabilityStatus, count: number): string {
  return `${AVAILABILITY_STATUS_LABELS[status]} · ${count}`;
}

// ─── Cabeçalhos dos dias e mensagens ────────────────────────────────────────

/**
 * "Segunda 19/10" → { weekday: "Seg", date: "19/10" } — cabeçalho curto das
 * colunas (o rótulo inteiro fica no `title`). Formatos inesperados ficam como
 * vieram.
 */
export function shortDayHeader(label: string): { weekday: string; date: string } {
  const m = /^(\S+)\s+(\d{1,2}\/\d{1,2})$/.exec(label.trim());
  if (!m) return { weekday: label, date: "" };
  return { weekday: m[1].slice(0, 3), date: m[2] };
}

/** Totais por dia (manhã / noite) de um conjunto de linhas, pelos dias da semana visível. */
export function perDayShiftTotals(
  dayKeys: readonly string[],
  rows: readonly { days: { day: string; morning: boolean; night: boolean }[] }[],
): { day: string; morning: number; night: number }[] {
  return dayKeys.map((day) => {
    let morning = 0;
    let night = 0;
    for (const e of rows) {
      const d = e.days.find((x) => x.day === day);
      if (d?.morning) morning++;
      if (d?.night) night++;
    }
    return { day, morning, night };
  });
}

/** Mensagem da grelha vazia — diz QUAL filtro deixou a lista sem ninguém. */
export function emptyAvailabilityMessage(f: AvailabilityFilters): string {
  const q = f.search.trim();
  if (q) return `Sem resultados para “${q}”.`;
  const mode = availabilityWindowMode(f);
  if (mode === "hours") {
    return `Ninguém disponível das ${formatHourWindow(f.windowFrom!, f.windowTo!)}${f.windowDay !== "any" ? " nesse dia" : " em nenhum dia da semana"}.`;
  }
  if (mode === "day") return "Ninguém marcou disponibilidade nesse dia.";
  if (f.onlyNotContacted24h) return "Todos os extras deste filtro já receberam mensagem nas últimas 24 h.";
  if (f.city !== "all") return "Nenhum extra neste filtro de cidade.";
  if (f.status !== "all") return `Nenhum extra com o estado “${AVAILABILITY_STATUS_LABELS[f.status]}” nesta semana.`;
  return "Não há extras ativos (RH → colaboradores com função “extra”).";
}
