/**
 * Parcerias a partir da Multipark (decisão do dono, 29 set 2026: "fica tudo
 * por lá"). Cada parceiro (agência/agregador), cliente Pro e avença da
 * Multipark fica preso a UM registo das nossas Parcerias pelo id de lá
 * (`multiparkPartnerId`):
 *   - parceiro → "Partner".userId (a empresa; as linhas por parque são altKeys);
 *   - Pro      → "pro:<Client.id>";
 *   - avença   → "plan:<ClientPlan.id>".
 * Correspondência: 1) pelo id já gravado; 2) pelo nome (sem "Pro ", "Avença ",
 * "Agência ") quando há UM só registo compatível; 3) senão cria-se. Com mais
 * de um candidato não se adivinha: fica para escolher à mão.
 * Registos antigos destes tipos sem par na Multipark → arquivados (nunca
 * apagados). O que é só nosso (NIF, acordo, notas, campanha) não se toca.
 * PURO.
 */
import { matchKey } from "./textKey";
import { normalizePartnerTypeId } from "./partnerTypes";

export type MpKind = "partner" | "pro" | "plan";

export interface MpPartnerPark { parkName: string; feeType: string | null; feePct: number | null; feeFixed: number | null; active: boolean }

export interface MpEntity {
  key: string;
  /** Outros ids que também identificam a entidade (linhas "Partner" por parque). */
  altKeys: string[];
  kind: MpKind;
  name: string;
  /** Tipo nosso (agregador, agencia_viagem, cliente_pro, avenca_mensal…); null = manter o do registo. */
  partnerType: string | null;
  active: boolean;
  /** O que está na Multipark (só leitura): taxas por parque, desconto, preço da avença. */
  snapshot: Record<string, unknown>;
}

export interface OurPartnerRecord {
  id: number;
  name: string;
  partnerType: string | null;
  multiparkPartnerId: string | null;
  archivedAt: string | null;
  /** 'own' = o dono disse que é só nosso: nunca se arquiva por falta de par. */
  multiparkKind?: string | null;
}

export interface SyncPlan {
  links: Array<{ recordId: number; recordName: string; key: string; kind: MpKind; mpName: string; by: "id" | "nome"; partnerType: string | null; active: boolean; snapshot: Record<string, unknown> }>;
  creates: Array<{ key: string; kind: MpKind; name: string; partnerType: string; active: boolean; snapshot: Record<string, unknown> }>;
  ambiguous: Array<{ key: string; kind: MpKind; name: string; candidates: Array<{ id: number; name: string }> }>;
  archives: Array<{ recordId: number; name: string; partnerType: string | null; reason: string }>;
}

/** Tipos que passam a vir da Multipark (os outros — hotel, operacional, campanha… — são só nossos). */
export const SYNCED_TYPES = new Set(["agregador", "agencia_viagem", "cliente_pro", "avenca_mensal", "avenca_anual"]);

/** Tipo "Partner".partnerType da Multipark → o nosso. PURA. */
export function ourTypeForPartner(mpType: string | null | undefined): string | null {
  const t = String(mpType ?? "").toUpperCase();
  if (t === "AGGREGATOR") return "agregador";
  if (t === "AGENCY") return "agencia_viagem";
  return null; // PARTNER (empresa): fica o tipo que o registo já tem
}

/** Cadência da avença → o nosso tipo. PURA. */
export function ourTypeForPlan(cadence: string | null | undefined): string {
  return /year|annual|anual/i.test(String(cadence ?? "")) ? "avenca_anual" : "avenca_mensal";
}

const PREFIX_RE = /^\s*(pro|cliente pro|avença( anual| mensal)?|avenca( anual| mensal)?|agência( de viagens?)?|agencia( de viagens?)?)\b\s*/i;

/** Chave do nome sem o prefixo que o nosso registo cola ("Pro Cabopol" → "cabopol"). PURA. */
export function partnerNameKey(name: string | null | undefined): string {
  let s = String(name ?? "");
  for (let i = 0; i < 2; i++) s = s.replace(PREFIX_RE, "");
  return matchKey(s);
}

/** O registo pode ser desta entidade? (Pro só com Pro, avença só com avença, parceiro com o resto.) PURA. */
export function compatible(kind: MpKind, partnerType: string | null): boolean {
  const t = normalizePartnerTypeId(partnerType);
  if (kind === "pro") return t === "cliente_pro";
  if (kind === "plan") return t === "avenca_mensal" || t === "avenca_anual";
  return !["cliente_pro", "avenca_mensal", "avenca_anual", "operacional", "campanha_propria"].includes(t);
}

/**
 * O plano: que registo fica com cada entidade, o que se cria, o que fica à
 * mão e o que se arquiva. `complete` = a leitura da Multipark veio toda (sem
 * isso nada se arquiva). PURA.
 */
export function planPartnerSync(entities: readonly MpEntity[], records: readonly OurPartnerRecord[], complete = true): SyncPlan {
  const plan: SyncPlan = { links: [], creates: [], ambiguous: [], archives: [] };
  const live = records.filter((r) => !r.archivedAt);
  const byMpId = new Map<string, OurPartnerRecord>();
  for (const r of live) {
    const k = String(r.multiparkPartnerId ?? "").trim().toLowerCase();
    if (k && !byMpId.has(k)) byMpId.set(k, r);
  }
  const taken = new Set<number>();
  const pending: MpEntity[] = [];

  // 1) pelo id já gravado (a chave principal ou uma das linhas por parque)
  for (const e of entities) {
    const hit = [e.key, ...e.altKeys].map((k) => byMpId.get(k.trim().toLowerCase())).find((r) => r && !taken.has(r.id));
    if (hit) {
      taken.add(hit.id);
      plan.links.push({ recordId: hit.id, recordName: hit.name, key: e.key, kind: e.kind, mpName: e.name, by: "id", partnerType: e.partnerType, active: e.active, snapshot: e.snapshot });
    } else pending.push(e);
  }

  // 2) pelo nome, só com UM candidato livre e compatível; 3) senão cria-se
  const nameIndex = new Map<string, OurPartnerRecord[]>();
  for (const r of live) {
    if (r.multiparkPartnerId && String(r.multiparkPartnerId).trim()) continue;
    const k = partnerNameKey(r.name);
    if (k) nameIndex.set(k, [...(nameIndex.get(k) ?? []), r]);
  }
  for (const e of pending) {
    const k = partnerNameKey(e.name);
    const cands = (k ? nameIndex.get(k) ?? [] : []).filter((r) => !taken.has(r.id) && compatible(e.kind, r.partnerType));
    if (cands.length === 1) {
      taken.add(cands[0].id);
      plan.links.push({ recordId: cands[0].id, recordName: cands[0].name, key: e.key, kind: e.kind, mpName: e.name, by: "nome", partnerType: e.partnerType, active: e.active, snapshot: e.snapshot });
    } else if (cands.length > 1) {
      plan.ambiguous.push({ key: e.key, kind: e.kind, name: e.name, candidates: cands.map((c) => ({ id: c.id, name: c.name })) });
      for (const c of cands) taken.add(c.id); // não se arquivam enquanto não se escolher
    } else {
      const partnerType = e.partnerType ?? "outro";
      plan.creates.push({ key: e.key, kind: e.kind, name: e.name, partnerType, active: e.active, snapshot: e.snapshot });
    }
  }

  // 4) arquivar: registos dos tipos que vêm da Multipark sem par lá
  if (complete) {
    const keys = new Set(entities.flatMap((e) => [e.key, ...e.altKeys].map((k) => k.trim().toLowerCase())));
    for (const r of live) {
      if (taken.has(r.id) || r.multiparkKind === "own") continue;
      const t = normalizePartnerTypeId(r.partnerType);
      const mp = String(r.multiparkPartnerId ?? "").trim().toLowerCase();
      if (mp && !keys.has(mp)) plan.archives.push({ recordId: r.id, name: r.name, partnerType: r.partnerType, reason: "Já não existe na Multipark" });
      else if (!mp && SYNCED_TYPES.has(t)) plan.archives.push({ recordId: r.id, name: r.name, partnerType: r.partnerType, reason: "Sem par na Multipark" });
    }
  }
  return plan;
}

/** Texto curto da comissão na Multipark (para mostrar, só leitura). PURA. */
export function feeSummary(parks: readonly MpPartnerPark[]): string {
  const fmt = (p: MpPartnerPark) =>
    p.feeType === "FIXED" && p.feeFixed != null ? `${p.feeFixed.toFixed(2).replace(".", ",")} €`
    : p.feePct != null ? `${String(p.feePct).replace(".", ",")} %` : "sem taxa";
  const distinct = [...new Set(parks.map(fmt))];
  if (distinct.length === 1) return distinct[0];
  return parks.map((p) => `${p.parkName}: ${fmt(p)}`).join(" · ");
}
