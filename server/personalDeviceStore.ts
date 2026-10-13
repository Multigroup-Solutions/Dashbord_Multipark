/**
 * Telemóveis pessoais (migração 0650): leituras e escritas de
 * `personal_devices` e as poucas de `pdas`/`pda_checkins` da conversão de um
 * PDA registado por engano. Tudo por SQL; os testes trocam este módulo por uma
 * BD em memória (`personalDeviceStore()`).
 *
 * Nada se apaga: deixar de ser pessoal = `status = 'inactive'`; o PDA
 * convertido passa a Inativo (com nota) e os check-ins abertos fecham.
 */
import { sql } from "drizzle-orm";

const rowsOf = (r: any): any[] => ((Array.isArray(r) ? r[0] : r?.rows ?? r) as any[]) ?? [];
const affected = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const toMs = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const s = String(v).trim();
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
};
const mysqlUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

export interface PersonalDeviceRow {
  id: number;
  deviceToken: string;
  label: string | null;
  status: "active" | "inactive";
  ownerUserId: number | null;
  ownerEmployeeId: number | null;
  currentUserId: number | null;
  currentEmployeeId: number | null;
  /** ms */
  currentSince: number | null;
  lastUserId: number | null;
  lastEmployeeId: number | null;
  /** ms */
  lastSeenAt: number | null;
  convertedFromPdaId: number | null;
}

export interface NewPersonalDevice {
  deviceToken: string;
  label: string | null;
  ownerUserId: number | null;
  ownerEmployeeId: number | null;
  currentUserId: number | null;
  currentEmployeeId: number | null;
  convertedFromPdaId: number | null;
  createdById: number;
  now: number;
}

export interface PdaForConversion { id: number; name: string; status: string; deviceToken: string | null; projectId: number | null; zelloUsername: string | null }

export interface PersonalPeople {
  employees: Map<number, { name: string; zello: string | null; userId: number | null }>;
  users: Map<number, string>;
}

export interface PersonalDeviceStore {
  byToken(token: string): Promise<PersonalDeviceRow | null>;
  byId(id: number): Promise<PersonalDeviceRow | null>;
  /** Novo telemóvel pessoal. `null` = o token já existe (nada mudou). */
  insert(row: NewPersonalDevice): Promise<number | null>;
  /** Quem tem sessão nele agora (e "o último"); `currentSince` só muda quando muda a pessoa. */
  setCurrent(id: number, who: { userId: number; employeeId: number | null }, now: number): Promise<void>;
  /** Sair: "agora" fica vazio — só se ainda for esta conta (outra pode ter entrado entretanto). */
  clearCurrent(id: number, userId: number): Promise<boolean>;
  /** Deixar de ser pessoal (nunca se apaga). false = já estava inativo. */
  deactivate(id: number, byUserId: number, now: number): Promise<boolean>;
  /** Telemóvel sem dono (convertido sem escolher a pessoa): quem o regista fica dono. */
  claimOwner(id: number, userId: number, employeeId: number | null): Promise<boolean>;
  /** Os ativos, com o âmbito de cidade do pedido (pela ficha do dono, de quem está ou esteve). */
  listActive(): Promise<PersonalDeviceRow[]>;
  /** Os PDAs convertidos que ficaram Inativos (para marcar o PDA na lista). */
  convertedPdaIds(): Promise<number[]>;
  /** PDA ATIVO com este token (um PDA não passa a pessoal por aqui). */
  activePdaByToken(token: string): Promise<{ id: number; name: string } | null>;
  pda(id: number): Promise<PdaForConversion | null>;
  /** O PDA larga o token do aparelho — só se ainda for este (outro registo entretanto → false). */
  releasePdaToken(pdaId: number, token: string): Promise<boolean>;
  /** O PDA passa a Inativo, com a nota (o histórico fica). */
  retirePda(pdaId: number, note: string): Promise<void>;
  /** Fecha os check-ins abertos neste PDA (com a nota). */
  closePdaCheckins(pdaId: number, now: number, note: string): Promise<number>;
  /**
   * O Zello do PDA convertido passa para a ficha do dono — só se a ficha não
   * tiver Zello e nenhuma outra ficha tiver este (nunca tira o Zello a ninguém).
   */
  adoptZello(employeeId: number, zello: string): Promise<boolean>;
  /** Nomes e Zello das fichas; nomes das contas. */
  people(employeeIds: readonly number[], userIds: readonly number[]): Promise<PersonalPeople>;
}

async function database(): Promise<any | null> {
  const { getDb } = await import("./db");
  return getDb();
}

const ids = (list: readonly number[]) => sql.join(list.map((id) => sql`${id}`), sql`, `);

function rowFrom(r: any): PersonalDeviceRow {
  return {
    id: Number(r.id),
    deviceToken: String(r.deviceToken),
    label: r.label == null ? null : String(r.label),
    status: String(r.status) === "inactive" ? "inactive" : "active",
    ownerUserId: num(r.ownerUserId),
    ownerEmployeeId: num(r.ownerEmployeeId),
    currentUserId: num(r.currentUserId),
    currentEmployeeId: num(r.currentEmployeeId),
    currentSince: toMs(r.currentSince),
    lastUserId: num(r.lastUserId),
    lastEmployeeId: num(r.lastEmployeeId),
    lastSeenAt: toMs(r.lastSeenAt),
    convertedFromPdaId: num(r.convertedFromPdaId),
  };
}

const COLS = sql.raw("id, deviceToken, label, status, ownerUserId, ownerEmployeeId, currentUserId, currentEmployeeId, currentSince, lastUserId, lastEmployeeId, lastSeenAt, convertedFromPdaId");

export const sqlPersonalDeviceStore: PersonalDeviceStore = {
  async byToken(token) {
    // BD em baixo ≠ "não é pessoal": sem isto, o browser esquecia o registo do telemóvel.
    const d = await database();
    if (!d) throw new Error("BD indisponível");
    const [r] = rowsOf(await d.execute(sql`SELECT ${COLS} FROM personal_devices WHERE deviceToken = ${token} LIMIT 1`));
    return r ? rowFrom(r) : null;
  },
  async byId(id) {
    const d = await database();
    if (!d) throw new Error("BD indisponível");
    const [r] = rowsOf(await d.execute(sql`SELECT ${COLS} FROM personal_devices WHERE id = ${id} LIMIT 1`));
    return r ? rowFrom(r) : null;
  },
  async insert(row) {
    const d = await database();
    if (!d) return null;
    const at = mysqlUtc(row.now);
    try {
      const r = await d.execute(sql`INSERT INTO personal_devices
        (deviceToken, label, status, ownerUserId, ownerEmployeeId, currentUserId, currentEmployeeId, currentSince,
         lastUserId, lastEmployeeId, lastSeenAt, convertedFromPdaId, createdById)
        VALUES (${row.deviceToken}, ${row.label}, 'active', ${row.ownerUserId}, ${row.ownerEmployeeId},
         ${row.currentUserId}, ${row.currentEmployeeId}, ${row.currentUserId != null ? at : null},
         ${row.currentUserId}, ${row.currentEmployeeId}, ${row.currentUserId != null ? at : null}, ${row.convertedFromPdaId}, ${row.createdById})`);
      const res = Array.isArray(r) ? r[0] : r;
      return Number(res?.insertId ?? 0) || null;
    } catch (err: any) {
      if (String(err?.code ?? err?.cause?.code ?? "") === "ER_DUP_ENTRY") return null;
      throw err;
    }
  },
  async setCurrent(id, who, now) {
    const d = await database();
    if (!d) return;
    const at = mysqlUtc(now);
    await d.execute(sql`UPDATE personal_devices
      SET currentSince = IF(currentUserId <=> ${who.userId}, COALESCE(currentSince, ${at}), ${at}),
          currentUserId = ${who.userId}, currentEmployeeId = ${who.employeeId},
          lastUserId = ${who.userId}, lastEmployeeId = ${who.employeeId}, lastSeenAt = ${at}
      WHERE id = ${id} AND status = 'active'`);
  },
  async clearCurrent(id, userId) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE personal_devices SET currentUserId = NULL, currentEmployeeId = NULL, currentSince = NULL
      WHERE id = ${id} AND currentUserId = ${userId}`);
    return affected(r) > 0;
  },
  async deactivate(id, byUserId, now) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE personal_devices
      SET status = 'inactive', deactivatedAt = ${mysqlUtc(now)}, deactivatedById = ${byUserId},
          currentUserId = NULL, currentEmployeeId = NULL, currentSince = NULL
      WHERE id = ${id} AND status = 'active'`);
    return affected(r) > 0;
  },
  async listActive() {
    const d = await database();
    if (!d) return [];
    const { employeeScope, pdaScope, scopedProjectIds } = await import("./cityScope");
    // Pela ficha do dono, de quem está ou esteve; um convertido também pela cidade do PDA que era
    // (senão um convertido sem dono, onde ainda ninguém entrou, só aparecia a quem vê todas as cidades).
    const scope = scopedProjectIds() === undefined ? sql`1 = 1`
      : sql`(${employeeScope(sql`personal_devices.ownerEmployeeId`)} OR ${employeeScope(sql`personal_devices.currentEmployeeId`)}
          OR ${employeeScope(sql`personal_devices.lastEmployeeId`)}
          OR (personal_devices.convertedFromPdaId IS NOT NULL AND ${pdaScope(sql`personal_devices.convertedFromPdaId`)}))`;
    return rowsOf(await d.execute(sql`SELECT ${COLS} FROM personal_devices WHERE status = 'active' AND ${scope}
      ORDER BY COALESCE(lastSeenAt, createdAt) DESC, id DESC`)).map(rowFrom);
  },
  async claimOwner(id, userId, employeeId) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE personal_devices SET ownerUserId = ${userId}, ownerEmployeeId = ${employeeId}
      WHERE id = ${id} AND status = 'active' AND ownerUserId IS NULL AND ownerEmployeeId IS NULL`);
    return affected(r) > 0;
  },
  async convertedPdaIds() {
    const d = await database();
    if (!d) return [];
    // Só os PDAs que passaram mesmo (ficaram Inativos): uma conversão desfeita a meio (o PDA mudou de
    // aparelho entretanto) deixa um telemóvel inativo, mas o PDA continua ativo e com o botão "Pessoal?".
    return rowsOf(await d.execute(sql`SELECT DISTINCT pd.convertedFromPdaId AS id FROM personal_devices pd
      JOIN pdas p ON p.id = pd.convertedFromPdaId WHERE p.status = 'inactive'`))
      .map((r) => Number(r.id)).filter((x) => Number.isInteger(x) && x > 0);
  },
  async activePdaByToken(token) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT id, name FROM pdas WHERE deviceToken = ${token} AND status = 'active' LIMIT 1`));
    return r ? { id: Number(r.id), name: String(r.name ?? "PDA") } : null;
  },
  async pda(id) {
    const d = await database();
    if (!d) return null;
    const [r] = rowsOf(await d.execute(sql`SELECT id, name, status, deviceToken, projectId, zelloUsername FROM pdas WHERE id = ${id} LIMIT 1`));
    return r ? {
      id: Number(r.id), name: String(r.name ?? "PDA"), status: String(r.status ?? "active"), deviceToken: r.deviceToken ? String(r.deviceToken) : null,
      projectId: num(r.projectId), zelloUsername: String(r.zelloUsername ?? "").trim() || null,
    } : null;
  },
  async releasePdaToken(pdaId, token) {
    const d = await database();
    if (!d) return false;
    const r = await d.execute(sql`UPDATE pdas SET deviceToken = NULL WHERE id = ${pdaId} AND deviceToken = ${token}`);
    return affected(r) > 0;
  },
  async retirePda(pdaId, note) {
    const d = await database();
    if (!d) return;
    await d.execute(sql`UPDATE pdas SET status = 'inactive', notes = TRIM(CONCAT(COALESCE(notes, ''), ${`\n${note}`})) WHERE id = ${pdaId}`);
  },
  async closePdaCheckins(pdaId, now, note) {
    const d = await database();
    if (!d) return 0;
    const r = await d.execute(sql`UPDATE pda_checkins SET checkoutAt = ${mysqlUtc(now)}, checkin_status = 'checked_out',
        notes = CONCAT(COALESCE(notes, ''), ${` · ${note}`})
      WHERE pdaId = ${pdaId} AND checkin_status = 'checked_in'`);
    return affected(r);
  },
  async adoptZello(employeeId, zello) {
    const d = await database();
    const z = zello.trim();
    if (!d || !z) return false;
    const [taken] = rowsOf(await d.execute(sql`SELECT id FROM employees WHERE LOWER(TRIM(zelloUsername)) = ${z.toLowerCase()} LIMIT 1`));
    if (taken) return false;
    const r = await d.execute(sql`UPDATE employees SET zelloUsername = ${z} WHERE id = ${employeeId} AND (zelloUsername IS NULL OR TRIM(zelloUsername) = '')`);
    return affected(r) > 0;
  },
  async people(employeeIds, userIds) {
    const out: PersonalPeople = { employees: new Map(), users: new Map() };
    const d = await database();
    if (!d) return out;
    const e = Array.from(new Set(employeeIds.filter((x) => Number.isInteger(x) && x > 0)));
    const u = Array.from(new Set(userIds.filter((x) => Number.isInteger(x) && x > 0)));
    if (e.length) {
      for (const r of rowsOf(await d.execute(sql`SELECT id, fullName, zelloUsername, userId FROM employees WHERE id IN (${ids(e)})`))) {
        out.employees.set(Number(r.id), { name: String(r.fullName ?? ""), zello: r.zelloUsername ? String(r.zelloUsername) : null, userId: num(r.userId) });
      }
    }
    if (u.length) {
      for (const r of rowsOf(await d.execute(sql`SELECT id, name, email FROM users WHERE id IN (${ids(u)})`))) {
        out.users.set(Number(r.id), String(r.name || r.email || `Conta #${r.id}`));
      }
    }
    return out;
  },
};

/** A loja em uso (os testes trocam-na). */
export function personalDeviceStore(): PersonalDeviceStore {
  return sqlPersonalDeviceStore;
}
