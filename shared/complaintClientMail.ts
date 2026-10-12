/**
 * Lote 57 (Jorge, 12 out 2026): "quando há uma reclamação ele só vai buscar o
 * histórico dos emails da reclamação e devia ir buscar o do cliente" — regras
 * PURAS do "Emails do cliente" na ficha da reclamação.
 *
 * Quem é o cliente: os emails da reclamação (o do cliente e os das conversas/
 * emails ligados ao caso), o email do cliente da reserva ligada e os emails da
 * ficha do cliente no CRM. Só contam emails PESSOAIS (regra de identidade do
 * CRM: nem da empresa, nem de balcão — info@, reservas@…) e nunca mais do que
 * CLIENT_MAIL_MAX_EMAILS.
 *
 * Que conversas: as das caixas PARTILHADAS que a pessoa vê (com a regra de
 * cidade de cada caixa). "O meu email" (caixas pessoais), "Por classificar"
 * sem caixa, caixas sem acesso e as arquivadas pela retenção nunca aparecem.
 */
import { canSeeMailbox, mailboxCityRestricted, type MailViewer, type MailboxConfig } from "./mail";
import { emailKey, isPersonalEmail, MAX_AUTO_SHARED, namesMatch } from "./crmIdentity";

/** Conversas por página ("Ver mais" pede mais). */
export const CLIENT_MAIL_PAGE = 10;
/** Teto de conversas de uma vez (nunca pesa). */
export const CLIENT_MAIL_MAX = 100;
/** Teto de emails que identificam o cliente. */
export const CLIENT_MAIL_MAX_EMAILS = 12;

export type IdentitySource = "reclamacao" | "reserva" | "crm";
export const IDENTITY_SOURCE_LABELS: Record<IdentitySource, string> = {
  reclamacao: "reclamação",
  reserva: "reserva ligada",
  crm: "ficha do cliente",
};

/**
 * Junta os emails das várias fontes: forma canónica, só pessoais e de fora da
 * empresa, sem repetir (guarda de onde veio cada um), pela ordem das fontes. PURA.
 */
export function identityEmails(
  found: ReadonlyArray<{ email: string | null | undefined; source: IdentitySource }>,
  isCompany: (email: string) => boolean,
  max: number = CLIENT_MAIL_MAX_EMAILS,
): Array<{ email: string; sources: IdentitySource[] }> {
  const out = new Map<string, IdentitySource[]>();
  for (const f of found) {
    const e = emailKey(f.email);
    if (!e || !isPersonalEmail(e) || isCompany(e)) continue;
    const cur = out.get(e);
    if (cur) { if (!cur.includes(f.source)) cur.push(f.source); continue; }
    if (out.size >= max) continue;
    out.set(e, [f.source]);
  }
  return [...out.entries()].map(([email, sources]) => ({ email, sources }));
}

/** Uma ficha do CRM encontrada por um email ou telefone do cliente. */
export interface CrmIdentityCandidate { clientId: number; name: string | null; kind: string | null }

/**
 * Que fichas do CRM são MESMO deste cliente (regra do dono: junta sozinho só
 * o óbvio — mesmo nome + mesmo email/telefone; nunca empresas). Auditoria do
 * lote 57: o telefone sozinho (família, agência, balcão) juntava os emails de
 * OUTRA pessoa ao histórico do cliente — e as conversas dela apareciam aqui.
 *  - email: uma só ficha com ele → é dela; duas (família) → só a do mesmo nome;
 *    mais do que MAX_AUTO_SHARED → nenhuma;
 *  - telefone: só fichas com o mesmo nome (sem nome na reclamação → nenhuma);
 *  - empresas nunca (o email/telefone de uma empresa é de muitas pessoas). PURA.
 */
export function crmIdentityAccepted(
  by: "email" | "phone",
  rows: readonly CrmIdentityCandidate[],
  complaintName: string | null | undefined,
): number[] {
  const people = rows.filter((r) => Number.isInteger(r.clientId) && r.clientId > 0);
  if (!people.length || people.length > MAX_AUTO_SHARED) return [];
  const persons = people.filter((r) => String(r.kind ?? "person") !== "company");
  if (by === "email" && people.length === 1) return persons.map((r) => r.clientId);
  return persons.filter((r) => namesMatch(r.name, complaintName)).map((r) => r.clientId);
}

/** Uma caixa partilhada que a pessoa vê; `cityIds` null = todas as cidades. */
export interface BoxAccess { key: string; label: string; cityIds: number[] | null }

/**
 * As caixas PARTILHADAS que a pessoa vê (a mesma regra da Comunicação) e, nas
 * caixas "por cidade", as cidades dela. `scopeIds` = cidades de quem pede
 * (undefined = nacional). PURA.
 */
export function visibleSharedBoxes(
  viewer: MailViewer,
  boxes: ReadonlyArray<Pick<MailboxConfig, "key" | "label" | "module" | "visibleRoles" | "active" | "cityRule">>,
  scopeIds: readonly number[] | undefined,
): BoxAccess[] {
  return boxes
    .filter((b) => canSeeMailbox(viewer, b))
    .map((b) => ({ key: b.key, label: b.label, cityIds: mailboxCityRestricted(viewer, b) && scopeIds !== undefined ? [...scopeIds] : null }));
}

export interface ClientThreadRow {
  id: number;
  mailboxKey: string | null;
  ownerUserId?: number | null;
  projectId: number | null;
  archivedAt?: string | null;
  automated?: number | boolean | null;
}

/**
 * Esta conversa pode aparecer? Só de uma caixa partilhada visível (na cidade
 * certa); nunca pessoal, sem caixa, arquivada ou só automática. PURA — o SQL
 * já filtra; isto é a segunda guarda (e o que os testes provam).
 */
export function clientThreadAllowed(t: ClientThreadRow, access: readonly BoxAccess[]): boolean {
  if (!t.mailboxKey) return false;
  if (t.archivedAt) return false;
  if (t.automated === true || Number(t.automated ?? 0) === 1) return false;
  const box = access.find((b) => b.key === t.mailboxKey);
  if (!box) return false;
  if (box.cityIds && (t.projectId == null || !box.cityIds.includes(t.projectId))) return false;
  return true;
}

/** Link da conversa na Comunicação. PURA. */
export function clientThreadLink(t: Pick<ClientThreadRow, "id" | "mailboxKey">): string {
  return `/comunicacao?caixa=${encodeURIComponent(String(t.mailboxKey ?? ""))}&t=${t.id}`;
}

/** Quem escreveu por último: o cliente ("in") ou nós ("out"). PURA. */
export function lastMessageDirection(t: { lastInboundAt?: string | null; lastOutboundAt?: string | null }): "in" | "out" | null {
  const i = t.lastInboundAt ? String(t.lastInboundAt) : "";
  const o = t.lastOutboundAt ? String(t.lastOutboundAt) : "";
  if (!i && !o) return null;
  return o > i ? "out" : "in";
}

/** Quantas pedir ao servidor (limitado, para nunca pesar). PURA. */
export function clientMailLimit(v: number | null | undefined): number {
  const n = Math.floor(Number(v ?? CLIENT_MAIL_PAGE));
  if (!Number.isFinite(n) || n < 1) return CLIENT_MAIL_PAGE;
  return Math.min(CLIENT_MAIL_MAX, n);
}
