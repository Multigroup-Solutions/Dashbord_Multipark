/**
 * Plano 05 — ecrã "Identidade partilhada" (super admin), cartão "Conta
 * Multipark" do perfil e página de confirmação: filtros, contagens, CSV e
 * resumos. PURO (testado no servidor).
 */
import { toCsv } from "./csv";
import { matchesSearch } from "./peopleFilters";
import { SHARED_LINK_METHOD_LABEL } from "./sharedIdentity";

/** Uma linha de `sharedIdentity.admin.overview.users`. */
export interface IdentityRow {
  id: number;
  name: string | null;
  email: string | null;
  role: string;
  isActive: boolean;
  hasFicha: boolean;
  lastSignedIn?: string | null;
  sharedUserId: string | null;
  linkMethod: string | null;
  linkedAt: string | null;
  proposal: { sharedEmail: string; expiresAt: string } | null;
}

export type IdentityFilter = "all" | "linked" | "unlinked" | "proposal" | "no_email";

export const IDENTITY_FILTERS: ReadonlyArray<{ value: IdentityFilter; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "linked", label: "Ligadas" },
  { value: "unlinked", label: "Por ligar" },
  { value: "proposal", label: "Com proposta" },
  { value: "no_email", label: "Sem email" },
];

const hasEmail = (r: Pick<IdentityRow, "email">) => !!String(r.email ?? "").trim();

export function matchesIdentityFilter(r: IdentityRow, f: IdentityFilter): boolean {
  switch (f) {
    case "linked": return !!r.sharedUserId;
    case "unlinked": return !r.sharedUserId;
    case "proposal": return !r.sharedUserId && !!r.proposal;
    case "no_email": return !hasEmail(r);
    default: return true;
  }
}

/** Contagem de cada filtro (para os botões). */
export function identityCounts(rows: readonly IdentityRow[]): Record<IdentityFilter, number> {
  const out: Record<IdentityFilter, number> = { all: 0, linked: 0, unlinked: 0, proposal: 0, no_email: 0 };
  for (const r of rows) for (const f of IDENTITY_FILTERS) if (matchesIdentityFilter(r, f.value)) out[f.value]++;
  return out;
}

/**
 * Filtro + pesquisa (nome, email ou #id, sem acentos). Ordena: ativas primeiro,
 * depois pelo nome.
 */
export function filterIdentityRows(rows: readonly IdentityRow[], opts: { filter: IdentityFilter; search: string }): IdentityRow[] {
  const q = opts.search.trim();
  const byId = /^#?\d+$/.test(q) ? Number(q.replace("#", "")) : null;
  return rows
    .filter((r) => matchesIdentityFilter(r, opts.filter))
    .filter((r) => !q || (byId != null ? r.id === byId : matchesSearch(q, r.name, r.email, r.proposal?.sharedEmail)))
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || String(a.name ?? a.email ?? "").localeCompare(String(b.name ?? b.email ?? ""), "pt"));
}

/** Página `page` (0…) com `size` linhas, e o total de páginas (mínimo 1). */
export function pageOf<T>(rows: readonly T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { items: rows.slice(p * size, p * size + size), page: p, pages };
}

/** "Proposta confirmada no email", ou o código se for novo. */
export function linkMethodLabel(method: string | null | undefined): string {
  if (!method) return "—";
  return SHARED_LINK_METHOD_LABEL[method] ?? method;
}

/** dd/mm/aaaa em Lisboa (o CSV não depende do fuso do computador). */
function dmy(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/** CSV (;) da tabela, já filtrada. Sem ids da conta Multipark (não são precisos para gerir). */
export function identityCsv(rows: readonly IdentityRow[], roleLabel: (role: string) => string): string {
  return toCsv(
    ["ID", "Nome", "Email", "Papel", "Ativo", "Ficha", "Ligada", "Como", "Ligada em", "Proposta para", "Proposta expira"],
    rows.map((r) => [
      r.id, r.name ?? "", r.email ?? "", roleLabel(r.role), r.isActive ? "sim" : "não", r.hasFicha ? "sim" : "não",
      r.sharedUserId ? "sim" : "não", r.sharedUserId ? linkMethodLabel(r.linkMethod) : "", dmy(r.linkedAt),
      r.proposal?.sharedEmail ?? "", dmy(r.proposal?.expiresAt),
    ]),
  );
}

/** O relatório de `admin.backfill` em números para o ecrã. */
export function backfillSummary(r: { checked: number; candidates: unknown[]; linked: unknown[]; mismatches: unknown[]; errors: number }) {
  return { checked: r.checked, confirmed: r.candidates.length, linked: r.linked.length, mismatches: r.mismatches.length, errors: r.errors };
}

/** Os interruptores e a configuração deixam usar o ecrã? E o que falta, em texto. */
export function identityReadiness(o: { flags: { link: boolean; login: boolean }; configured: boolean }): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!o.flags.link && !o.flags.login) missing.push("switches");
  if (!o.configured) missing.push("config");
  return { ready: missing.length === 0, missing };
}

/** Utilizadores para o "ligar a uma conta existente" (pedidos de acesso): só os por ligar; o do mesmo email primeiro. */
export function accessRequestCandidates(rows: readonly IdentityRow[], email: string | null | undefined): IdentityRow[] {
  const e = String(email ?? "").trim().toLowerCase();
  return rows
    .filter((r) => !r.sharedUserId)
    .sort((a, b) => {
      const am = !!e && String(a.email ?? "").trim().toLowerCase() === e;
      const bm = !!e && String(b.email ?? "").trim().toLowerCase() === e;
      return Number(bm) - Number(am) || Number(b.isActive) - Number(a.isActive) || String(a.name ?? a.email ?? "").localeCompare(String(b.name ?? b.email ?? ""), "pt");
    });
}

/** Onde se recupera a palavra-passe da conta Multipark. */
export const SHARED_FORGOT_PASSWORD_URL = "https://multipark.pt/pt-PT/forgot-password";
