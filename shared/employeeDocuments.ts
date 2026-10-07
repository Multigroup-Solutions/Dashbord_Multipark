/**
 * Documentos da ficha: estado de validação (Jorge, 7 out 2026: "Os
 * utilizadores devem conseguir submeter os seus documentos a 1a vez, não os
 * devem conseguir editar/substituir depois de validados. Quando submetem os
 * documentos deve ficar flagged com 'pendente de validação'").
 *
 * Cada ficheiro tem um estado: pendente (entregue pela própria pessoa ou por
 * um team leader), validado (o RH viu; o que o RH carrega já entra validado)
 * ou recusado (com motivo — a pessoa volta a carregar). Substituir/apagar =
 * ARQUIVAR (nada se apaga). PURO: igual no cliente e no servidor.
 */

export const DOC_STATUSES = ["pending", "validated", "rejected"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  pending: "Pendente de validação",
  validated: "Validado",
  rejected: "Recusado",
};

export const DOC_REJECT_REASON_MAX = 300;

/** Nomes dos tipos (os mesmos da ficha no RH). */
export const DOC_TYPE_LABELS: Record<string, string> = {
  id_card: "Bilhete de Identidade",
  residence_permit: "Título de Residência",
  driving_license: "Carta de Condução",
  nib_proof: "Comprovativo NIB",
  address_proof: "Comprovativo de Morada",
  contract: "Contrato de Trabalho",
  extra_contract: "Contrato Extra",
  contract_annex: "Anexo de Contrato",
  responsibility_term: "Termo de Responsabilidade",
  work_accident_insurance: "Seguro de Acidentes de Trabalho",
  photo: "Fotografia",
  other: "Outro",
};

/** Obrigatórios da checklist (a ordem é a da ficha). */
export const MANDATORY_DOC_TYPES = ["photo", "id_card", "driving_license", "nib_proof", "address_proof", "contract", "responsibility_term"] as const;

/**
 * "Outros" é um saco de documentos soltos: entregar um novo não substitui o
 * que já foi validado, por isso não fica trancado (os validados continuam
 * sem se poder apagar).
 */
export const MULTI_DOC_TYPES = ["other"] as const;
export const isMultiDocType = (docType: string) => (MULTI_DOC_TYPES as readonly string[]).includes(docType);

/** Estado de um TIPO de documento a partir dos ficheiros ATIVOS (não arquivados). */
export type DocTypeState = DocStatus | "missing";

export interface DocRowLike { docType: string; status: DocStatus | string | null | undefined; rejectedReason?: string | null }

/** Normaliza o estado (linhas antigas sem coluna → validado, como o backfill da 0530). */
export function docStatusOf(row: Pick<DocRowLike, "status">): DocStatus {
  return (DOC_STATUSES as readonly string[]).includes(String(row.status)) ? (row.status as DocStatus) : "validated";
}

/** Validado > pendente > recusado > em falta. PURA. */
export function docTypeState(rows: readonly Pick<DocRowLike, "status">[]): DocTypeState {
  const s = new Set(rows.map(docStatusOf));
  if (s.has("validated")) return "validated";
  if (s.has("pending")) return "pending";
  if (s.has("rejected")) return "rejected";
  return "missing";
}

/** Conta como ENTREGUE (lista obrigatória e bloqueio de login)? Pendente conta; recusado não. */
export const docStateDelivered = (st: DocTypeState) => st === "validated" || st === "pending";

export interface ChecklistItem {
  docType: string;
  /** Entregue (validado ou pendente) — o que a regra dos 14/21 dias olha. */
  present: boolean;
  state: DocTypeState;
  /** Motivo da recusa mais recente, quando o tipo está recusado. */
  rejectedReason: string | null;
}

/** Checklist dos obrigatórios a partir dos ficheiros ATIVOS de uma ficha. PURA. */
export function docChecklist(rows: readonly DocRowLike[]): ChecklistItem[] {
  return MANDATORY_DOC_TYPES.map((t) => {
    const mine = rows.filter((r) => r.docType === t);
    const state = docTypeState(mine);
    const rejected = state === "rejected" ? mine.find((r) => docStatusOf(r) === "rejected")?.rejectedReason ?? null : null;
    return { docType: t, present: docStateDelivered(state), state, rejectedReason: rejected };
  });
}

export interface DocsSummary {
  total: number;
  /** Obrigatórios entregues (validados ou pendentes). */
  present: number;
  /** Obrigatórios validados. */
  validated: number;
  missing: string[];
  /** Ficheiros por validar (todos os tipos). */
  pendingCount: number;
}

/** Resumo por ficha para a lista do RH ("Completos", "N em falta", "N por validar"). PURA. */
export function docsSummary(rows: readonly DocRowLike[]): DocsSummary {
  const list = docChecklist(rows);
  return {
    total: list.length,
    present: list.filter((c) => c.present).length,
    validated: list.filter((c) => c.state === "validated").length,
    missing: list.filter((c) => !c.present).map((c) => c.docType),
    pendingCount: rows.filter((r) => docStatusOf(r) === "pending").length,
  };
}

/** Texto curto do resumo para a lista ("Completos", "2 em falta", "Completos · 1 por validar"). PURA. */
export function docsSummaryLabel(s: Pick<DocsSummary, "total" | "present" | "pendingCount">): string {
  const missing = s.total - s.present;
  const head = missing === 0 ? "Completos" : `${missing} em falta`;
  return s.pendingCount > 0 ? `${head} · ${s.pendingCount} por validar` : head;
}
