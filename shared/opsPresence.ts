/**
 * Alertas "a trabalhar sem PDA ou Zello ligado" (passo 4 do plano dos PDAs,
 * docs/auditoria/pdas-identidade.md §4). Só regras PURAS — a leitura da BD,
 * do Zello e da Multipark está em server/opsPresence.ts.
 *
 *  - Quem: só o operacional (team leader, condutor sénior, condutor, extra).
 *  - Quando:
 *    · ponto aberto sem PDA, ou com PDA/Zello mas o Zello desligado;
 *    · movimentação na Multipark feita pela pessoa sem ponto aberto, ou com o
 *      Zello desligado.
 *  - Um alerta por pessoa × tipo enquanto o problema durar. Fecha sozinho
 *    quando o problema desaparece.
 */

export const OPERATIONAL_POSITIONS = ["team_leader", "senior_driver", "driver", "extra"] as const;

export function isOperationalPosition(position: string | null | undefined): boolean {
  return (OPERATIONAL_POSITIONS as readonly string[]).includes(String(position ?? ""));
}

export const PRESENCE_KINDS = ["clock_no_pda", "clock_zello_off", "move_no_clock", "move_zello_off"] as const;
export type PresenceKind = (typeof PRESENCE_KINDS)[number];

export const PRESENCE_KIND_LABELS: Record<PresenceKind, string> = {
  clock_no_pda: "Ponto aberto sem PDA",
  clock_zello_off: "Ponto aberto com o Zello desligado",
  move_no_clock: "Movimento na Multipark sem ponto aberto",
  move_zello_off: "Movimento na Multipark com o Zello desligado",
};

/** Minutos depois de abrir o ponto até se exigir o PDA (tempo de o ir buscar). */
export const CLOCK_GRACE_MINUTES = 10;
/** Ponto aberto há mais do que isto = esquecido (não conta como aberto). */
export const STALE_CLOCK_HOURS = 16;
/** Sem reporte do Zello há mais do que isto = desligado. */
export const ZELLO_STALE_SECONDS = 15 * 60;
/** Janela de leitura dos movimentos da Multipark (a cron corre de 5 em 5 min). */
export const MOVEMENT_LOOKBACK_MINUTES = 15;
/** Alertas de movimento ainda abertos passado isto fecham como "expirado". */
export const MOVEMENT_ALERT_EXPIRE_HOURS = 12;

/** Tipos de movimento da Multipark que contam (feitos por um agente no terreno). */
export const MOVEMENT_CHANGE_TYPES = ["CHECKING_IN", "CHECK_IN", "MOVEMENT", "PENDING_CHECKOUT", "CHECKING_OUT", "CHECK_OUT", "UPDATE"] as const;

export interface ZelloStatus {
  username: string;
  status?: string | null;
  /** segundos desde o último reporte */
  lastReportDelay?: number | null;
}

/** O Zello desta conta está ligado? `null` = não sabemos (Zello em baixo). PURA. */
export function zelloOnline(username: string | null | undefined, locations: ReadonlyMap<string, ZelloStatus> | null): boolean | null {
  if (!locations) return null;
  const u = String(username ?? "").trim().toLowerCase();
  if (!u) return false;
  const l = locations.get(u);
  if (!l) return false;
  if (String(l.status ?? "").toLowerCase() === "offline") return false;
  const d = Number(l.lastReportDelay ?? NaN);
  return Number.isFinite(d) && d <= ZELLO_STALE_SECONDS;
}

export interface PresencePerson {
  employeeId: number;
  name: string;
  position: string | null;
  city: string | null;
  /** Ponto aberto: instante (ms) da entrada; `null` = sem ponto aberto. */
  clockOpenSince: number | null;
  /** PDA na mão (check-in do PDA aberto). */
  pdaName: string | null;
  /** Conta Zello a vigiar: a do PDA, senão a da ficha. */
  zelloUsername: string | null;
  /** Conta Zello excluída do GPS (Definições) → não se vigia. */
  zelloExcluded?: boolean;
}

export interface PresenceMovement {
  employeeId: number;
  changeType: string;
  /** UTC ms */
  at: number;
  bookingCode?: string | null;
  plate?: string | null;
}

export interface PresenceProblem {
  employeeId: number;
  kind: PresenceKind;
  city: string | null;
  detail: string;
}

/** Ponto aberto e ainda válido (não esquecido). PURA. */
export function clockIsOpen(since: number | null, now: number): boolean {
  return since != null && now - since <= STALE_CLOCK_HOURS * 3_600_000;
}

/**
 * Problemas no instante `now`. `locations = null` → Zello em baixo: não se
 * produzem (nem se fecham) alertas do Zello. PURA.
 */
export function evaluatePresence(input: {
  now: number;
  people: readonly PresencePerson[];
  movements: readonly PresenceMovement[];
  locations: ReadonlyMap<string, ZelloStatus> | null;
}): PresenceProblem[] {
  const { now, people, movements, locations } = input;
  const out: PresenceProblem[] = [];
  const byId = new Map(people.map((p) => [p.employeeId, p]));
  const zelloOff = (p: PresencePerson): boolean => {
    if (p.zelloExcluded || !p.zelloUsername) return false;
    return zelloOnline(p.zelloUsername, locations) === false;
  };

  for (const p of people) {
    if (!isOperationalPosition(p.position)) continue;
    if (!clockIsOpen(p.clockOpenSince, now)) continue;
    // 43b: sem PDA mas com o Zello fixo (o telemóvel dele ou o PDA de que é dono) não é "sem PDA"
    if (!p.pdaName && !p.zelloUsername) {
      if (now - (p.clockOpenSince as number) >= CLOCK_GRACE_MINUTES * 60_000) {
        out.push({ employeeId: p.employeeId, kind: "clock_no_pda", city: p.city, detail: `Ponto aberto às ${hhmmLisbon(p.clockOpenSince as number)} e sem PDA.` });
      }
      continue;
    }
    if (zelloOff(p)) {
      out.push({ employeeId: p.employeeId, kind: "clock_zello_off", city: p.city, detail: p.pdaName
        ? `Tem o ${p.pdaName}, mas o Zello (${p.zelloUsername}) não reporta há mais de ${ZELLO_STALE_SECONDS / 60} min.`
        : `O Zello (${p.zelloUsername}) não reporta há mais de ${ZELLO_STALE_SECONDS / 60} min.` });
    }
  }

  const seen = new Set<string>();
  const latest = [...movements].sort((a, b) => b.at - a.at);
  for (const m of latest) {
    const p = byId.get(m.employeeId);
    if (!p || !isOperationalPosition(p.position)) continue;
    const what = `${movementWord(m.changeType)}${m.bookingCode ? ` da reserva ${m.bookingCode}` : ""}${m.plate ? ` (${m.plate})` : ""} às ${hhmmLisbon(m.at)}`;
    if (!clockIsOpen(p.clockOpenSince, now)) {
      const k = `${p.employeeId}:move_no_clock`;
      if (!seen.has(k)) { seen.add(k); out.push({ employeeId: p.employeeId, kind: "move_no_clock", city: p.city, detail: `${what}, sem ponto aberto.` }); }
    } else if (zelloOff(p)) {
      const k = `${p.employeeId}:move_zello_off`;
      if (!seen.has(k)) { seen.add(k); out.push({ employeeId: p.employeeId, kind: "move_zello_off", city: p.city, detail: `${what}, com o Zello desligado.` }); }
    }
  }
  return out;
}

export interface OpenPresenceAlert {
  id: number;
  employeeId: number;
  kind: PresenceKind;
  openedAt: number;
}

/**
 * O que fazer aos alertas abertos face aos problemas de agora. PURA.
 *  - problema novo → abre;
 *  - alerta cujo problema desapareceu → fecha ("resolvido"). Os de movimento
 *    fecham quando o ponto abre / o Zello liga, ou expiram;
 *  - sem Zello (`zelloKnown = false`) não se fecham os alertas do Zello;
 *  - sem Multipark (`movesKnown = false`) os de movimento só fecham pelo ponto.
 */
export function diffPresenceAlerts(input: {
  now: number;
  open: readonly OpenPresenceAlert[];
  problems: readonly PresenceProblem[];
  people: readonly PresencePerson[];
  locations: ReadonlyMap<string, ZelloStatus> | null;
}): { toOpen: PresenceProblem[]; toTouch: number[]; toResolve: { id: number; resolution: "resolvido" | "expirado" }[] } {
  const { now, open, problems, people, locations } = input;
  const key = (e: number, k: string) => `${e}:${k}`;
  const openBy = new Map(open.map((a) => [key(a.employeeId, a.kind), a]));
  const probBy = new Map(problems.map((p) => [key(p.employeeId, p.kind), p]));
  const personBy = new Map(people.map((p) => [p.employeeId, p]));

  const toOpen = problems.filter((p) => !openBy.has(key(p.employeeId, p.kind)));
  const toTouch: number[] = [];
  const toResolve: { id: number; resolution: "resolvido" | "expirado" }[] = [];

  for (const a of open) {
    if (probBy.has(key(a.employeeId, a.kind))) { toTouch.push(a.id); continue; }
    const p = personBy.get(a.employeeId);
    const clockOpen = !!p && clockIsOpen(p.clockOpenSince, now);
    const zOn = p?.zelloUsername && !p.zelloExcluded ? zelloOnline(p.zelloUsername, locations) : true;
    switch (a.kind) {
      case "clock_no_pda":
        toResolve.push({ id: a.id, resolution: "resolvido" });
        break;
      case "clock_zello_off":
        if (zOn === null && clockOpen) toTouch.push(a.id);
        else toResolve.push({ id: a.id, resolution: "resolvido" });
        break;
      case "move_no_clock":
        if (clockOpen) toResolve.push({ id: a.id, resolution: "resolvido" });
        else if (now - a.openedAt >= MOVEMENT_ALERT_EXPIRE_HOURS * 3_600_000) toResolve.push({ id: a.id, resolution: "expirado" });
        break;
      case "move_zello_off":
        if (zOn === true || !clockOpen) toResolve.push({ id: a.id, resolution: zOn === true ? "resolvido" : "expirado" });
        else if (now - a.openedAt >= MOVEMENT_ALERT_EXPIRE_HOURS * 3_600_000) toResolve.push({ id: a.id, resolution: "expirado" });
        break;
    }
  }
  return { toOpen, toTouch, toResolve };
}

/** Passa ao WhatsApp? Aberto, sem "visto", ainda não escalado e há `minutes` ou mais. PURA. */
export function dueForEscalation(a: { openedAt: number; acknowledgedAt: number | null; escalatedAt: number | null; resolvedAt: number | null }, now: number, minutes: number): boolean {
  if (a.resolvedAt != null || a.acknowledgedAt != null || a.escalatedAt != null) return false;
  return now - a.openedAt >= Math.max(1, minutes) * 60_000;
}

/** Texto numa só linha (os parâmetros dos modelos do WhatsApp não aceitam quebras). PURA. */
export function presenceOneLine(kind: PresenceKind, name: string, cityLabel: string | null, detail: string): string {
  const s = `${PRESENCE_KIND_LABELS[kind]}: ${name}${cityLabel ? ` (${cityLabel})` : ""}. ${detail}`;
  return s.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 900);
}

export interface RecipientPools {
  /** userIds dos team leaders escalados neste turno, na cidade */
  scheduledTeamLeaders: readonly number[];
  /** userIds com papel team_leader e ponto aberto na cidade */
  clockedTeamLeaders: readonly number[];
  /** userIds com papel supervisor que veem a cidade */
  supervisors: readonly number[];
}

/** Quem recebe no sino: TL escalado + TL com ponto aberto + supervisor, sem a própria pessoa. PURA. */
export function presenceRecipients(pools: RecipientPools, selfUserIds: readonly number[]): number[] {
  const self = new Set(selfUserIds);
  return Array.from(new Set([...pools.scheduledTeamLeaders, ...pools.clockedTeamLeaders, ...pools.supervisors])).filter((id) => !self.has(id));
}

function movementWord(changeType: string): string {
  const t = String(changeType ?? "").toUpperCase();
  if (t === "CHECK_IN" || t === "CHECKING_IN") return "Recolha";
  if (t === "CHECK_OUT" || t === "CHECKING_OUT" || t === "PENDING_CHECKOUT") return "Entrega";
  if (t === "MOVEMENT") return "Movimento";
  return "Alteração";
}

/** "HH:MM" em Lisboa. PURA. */
export function hhmmLisbon(ms: number): string {
  return new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}
