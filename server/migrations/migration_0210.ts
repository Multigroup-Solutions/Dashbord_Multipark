// Migration 0210 — Comunicação: o Google Workspace real (dono, 27 set 2026)
//
// Duas contas partilhadas no Workspace multipark.pt:
//  - reservas@multipark.pt, com os aliases reclamacoes@, perdidos@, criticas@,
//    recursos-humanos@ e escala@;
//  - info@multipark.pt, com os aliases redpark@, airpark@, skypark@,
//    airparkfaro@ e driver@.
// Os domínios alternativos (skypark.pt, redpark.pt, multibags.pt,
// multivalet.pt, multibags.app, multipark.app) funcionam sozinhos — ver
// `mail.aliasDomains` e shared/mail.ts resolveAlias.
//
// Passo de DADOS, UMA vez (marca `0210_mail_workspace_aliases` em
// app_notification_maintenance), sobre as caixas semeadas pela 0145:
//  - caixa `info`: passa a ler de info@multipark.pt (só se ainda estiver na
//    omissão reservas@multipark.pt) e recebe os aliases da conta info@;
//  - caixa `reservas`: recebe escala@;
//  - responsáveis (equipa) e destino por omissão onde ainda não há nenhum.
// NUNCA sobrepõe o que um administrador já mudou: só preenche responsáveis
// vazios, só muda o destino de reservas@ se ainda estiver "como a caixa", só
// acrescenta endereços que não estão em NENHUMA caixa, e não toca em caixas
// apagadas. ocorrencias@, campanhas@ e comercial@ não existem no Workspace —
// as caixas ficam como estão (sem nada novo).
//
// As migrações deste repositório são listas de SQL; o passo de dados (ler
// JSON, juntar, escrever) é código — `runMigration0210Data`, chamado por
// ensureRecentSchema (server/db.ts) depois do SQL. Seguro com vários
// arranques a frio em simultâneo: numa transação, a marca é inserida
// PRIMEIRO (INSERT simples — o segundo processo espera pelo bloqueio da
// chave e recebe ER_DUP_ENTRY → sai sem fazer nada) e as caixas são lidas
// com FOR UPDATE; se algo falhar, a transação desfaz tudo (incluindo a
// marca) e o passo volta a correr no arranque seguinte.

import { sql } from "drizzle-orm";
import { matchCityKey } from "../../shared/city";

export const MIGRATION_0210_NAME = "0210_mail_workspace_aliases";

export const DATA_0210_ID = "0210_mail_workspace_aliases";

export const MIGRATION_0210_STATEMENTS: string[] = [
  // A tabela de marcas nasceu na 0140; aqui só por segurança (o passo de dados precisa dela).
  "CREATE TABLE IF NOT EXISTS `app_notification_maintenance` (" +
    "`id` VARCHAR(64) NOT NULL, " +
    "`ranAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

export const IDEMPOTENT_ERROR_CODES_0210 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_ENTRY"]);

// ─── Parte pura ─────────────────────────────────────────────────────────────

const RESERVAS = "reservas@multipark.pt";
const INFO = "info@multipark.pt";

/** Linha de mail_mailboxes (só o que o passo lê). */
export interface MailboxRow0210 {
  mailboxKey: string;
  sourceKind: string | null;
  sourceEmail: string | null;
  /** addressesJson já lido (array cru — linhas antigas podem não ter todos os campos). */
  addresses: unknown;
}

export interface MailboxPatch0210 {
  mailboxKey: string;
  /** Presente só quando muda. */
  sourceEmail?: string;
  /** Presente só quando muda (lista completa, pela ordem existente + novos no fim). */
  addresses?: Array<Record<string, unknown>>;
  changes: string[];
}

type NewAlias = { address: string; brand: string; destination: string; owner: string | null; tag: string; cityId?: "faro" };

const INFO_ALIASES: NewAlias[] = [
  { address: "redpark@multipark.pt", brand: "redpark", destination: "geral", owner: null, tag: "Redpark" },
  { address: "skypark@multipark.pt", brand: "skypark", destination: "geral", owner: null, tag: "Skypark" },
  { address: "airpark@multipark.pt", brand: "airpark", destination: "geral", owner: null, tag: "Airpark" },
  { address: "airparkfaro@multipark.pt", brand: "airpark", destination: "geral", owner: null, tag: "Airpark Faro", cityId: "faro" },
  { address: "driver@multipark.pt", brand: "multidriver", destination: "recursos-humanos", owner: "role:admin", tag: "Condutores" },
];
const RESERVAS_ALIASES: NewAlias[] = [
  { address: "escala@multipark.pt", brand: "multipark", destination: "geral", owner: "role:supervisor", tag: "Escala" },
];

/** Responsável a preencher (só se o endereço não tiver nenhum), por caixa → endereço. */
const DEFAULT_OWNERS: Record<string, Record<string, string>> = {
  info: { [INFO]: "role:admin" },
  reservas: { [RESERVAS]: "role:backoffice" },
  reclamacoes: { "reclamacoes@multipark.pt": "role:backoffice" },
  perdidos: { "perdidos@multipark.pt": "role:backoffice" },
  criticas: { "criticas@multipark.pt": "role:backoffice" },
  rh: { "recursos-humanos@multipark.pt": "role:admin" },
};

const norm = (a: unknown) => String(a ?? "").trim().replace(/^<|>$/g, "").toLowerCase();
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * Nó "cidade" de Faro na árvore de projetos (nós `level='city'`, como a
 * resolução de cidades da app): só quando há exatamente um (preferindo os
 * ativos); senão null (sem cidade). PURA.
 */
export function faroCityIdOf(nodes: ReadonlyArray<{ id: number; name: string; level: string | null; isActive?: number | boolean | null }>): number | null {
  const hits = nodes.filter((n) => n.level === "city" && matchCityKey(n.name) === "faro");
  if (hits.length === 1) return Number(hits[0].id);
  const active = hits.filter((n) => n.isActive == null || Number(n.isActive) === 1);
  return active.length === 1 ? Number(active[0].id) : null;
}

/**
 * Junta a configuração real do Workspace às caixas existentes. Devolve só as
 * caixas que mudam. Nunca apaga nem sobrepõe: responsáveis só onde não há,
 * destino de reservas@ só se estiver "como a caixa", endereços novos só se
 * não existirem em nenhuma caixa, conta de origem de `info` só se ainda for
 * a omissão (dwd reservas@). Caixas em falta ou com JSON inválido são
 * ignoradas. PURA (idempotente: correr duas vezes não muda mais nada).
 */
export function mergeMailboxes0210(rows: readonly MailboxRow0210[], opts: { faroCityId: number | null }): MailboxPatch0210[] {
  const everywhere = new Set<string>();
  for (const r of rows) {
    if (!Array.isArray(r.addresses)) continue;
    for (const a of r.addresses) if (isObj(a)) everywhere.add(norm(a.address));
  }
  const out: MailboxPatch0210[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.addresses)) continue;
    const key = r.mailboxKey;
    const changes: string[] = [];
    const patch: MailboxPatch0210 = { mailboxKey: key, changes };
    let touched = false;
    const addresses = r.addresses.map((a) => (isObj(a) ? { ...a } : a)) as Array<Record<string, unknown>>;

    const owners = DEFAULT_OWNERS[key] ?? {};
    for (const a of addresses) {
      if (!isObj(a)) continue;
      const addr = norm(a.address);
      const owner = owners[addr];
      if (owner && !String(a.owner ?? "").trim()) {
        a.owner = owner;
        touched = true;
        changes.push(`${addr}: responsável ${owner}`);
      }
      if (key === "reservas" && addr === RESERVAS && (a.destination == null || a.destination === "" || a.destination === "caixa")) {
        a.destination = "reservas";
        touched = true;
        changes.push(`${addr}: destino reservas`);
      }
    }

    const toAdd = key === "info" ? INFO_ALIASES : key === "reservas" ? RESERVAS_ALIASES : [];
    for (const n of toAdd) {
      if (everywhere.has(n.address)) continue;
      addresses.push({
        address: n.address, brand: n.brand, cityId: n.cityId === "faro" ? opts.faroCityId ?? null : null,
        destination: n.destination, owner: n.owner, tag: n.tag, active: true,
      });
      everywhere.add(n.address);
      touched = true;
      changes.push(`+ ${n.address}`);
    }
    if (touched) patch.addresses = addresses;

    if (key === "info" && (r.sourceKind ?? "dwd") === "dwd" && norm(r.sourceEmail) === RESERVAS) {
      patch.sourceEmail = INFO;
      changes.push(`conta de origem ${INFO}`);
    }
    if (changes.length) out.push(patch);
  }
  return out;
}

// ─── Passo de dados (BD) ────────────────────────────────────────────────────

type Executor = { execute: (q: any) => Promise<unknown> };
type Db0210 = Executor & { transaction: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T> };

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};

/**
 * Aplica `mergeMailboxes0210` uma única vez (ver o topo do ficheiro).
 * "applied" = correu agora; "skipped" = já tinha corrido (ou outro arranque
 * está a correr). Lança em erro (a transação desfaz-se e volta a tentar no
 * próximo arranque).
 */
export async function runMigration0210Data(db: Db0210): Promise<{ status: "applied" | "skipped"; patches: MailboxPatch0210[] }> {
  const done = rowsOf(await db.execute(sql`SELECT id FROM app_notification_maintenance WHERE id = ${DATA_0210_ID} LIMIT 1`));
  if (done.length) return { status: "skipped", patches: [] };
  return db.transaction(async (tx) => {
    try {
      await tx.execute(sql`INSERT INTO app_notification_maintenance (id) VALUES (${DATA_0210_ID})`);
    } catch (err: any) {
      const code = err?.code ?? err?.cause?.code;
      if (code === "ER_DUP_ENTRY") return { status: "skipped" as const, patches: [] };
      throw err;
    }
    const raw = rowsOf(await tx.execute(sql`SELECT mailboxKey, sourceKind, sourceEmail, addressesJson FROM mail_mailboxes FOR UPDATE`));
    const rows: MailboxRow0210[] = raw.map((r) => {
      let addresses: unknown = null;
      try { addresses = JSON.parse(String(r.addressesJson ?? "null")); } catch { addresses = null; }
      return { mailboxKey: String(r.mailboxKey), sourceKind: r.sourceKind ?? null, sourceEmail: r.sourceEmail ?? null, addresses };
    });
    let faroCityId: number | null = null;
    try {
      faroCityId = faroCityIdOf(rowsOf(await tx.execute(sql`SELECT id, name, level, isActive FROM projects WHERE level = 'city'`)));
    } catch { faroCityId = null; }
    const patches = mergeMailboxes0210(rows, { faroCityId });
    for (const p of patches) {
      if (p.addresses) await tx.execute(sql`UPDATE mail_mailboxes SET addressesJson = ${JSON.stringify(p.addresses)} WHERE mailboxKey = ${p.mailboxKey}`);
      if (p.sourceEmail) {
        await tx.execute(sql`UPDATE mail_mailboxes SET sourceEmail = ${p.sourceEmail}
          WHERE mailboxKey = ${p.mailboxKey} AND sourceKind = 'dwd' AND LOWER(sourceEmail) = ${RESERVAS}`);
      }
    }
    return { status: "applied" as const, patches };
  });
}
