/**
 * D39 (Jorge, 3 out 2026): os anexos dos emails do RH passam pela IA.
 * Regras PURAS — o que se lê, o que se aproveita para o candidato e quem vê.
 *
 *  - Lê-se: PDF, imagens (JPEG/PNG/WEBP) e Word (.docx, pelo texto). Outros
 *    formatos ficam "não lido (formato)". Até 8 MB por anexo.
 *  - Do CV aproveita-se: nome completo, NIF, n.º do BI/CC, n.º da carta, a
 *    cidade SÓ quando é certa, e outros contactos. Nada substitui o que o
 *    candidato já tem (só campos vazios).
 *  - NIF e números dos documentos: só o RH (front/back office, admin+) vê.
 *    O resumo é para quem entrevista (todos os que veem o candidato).
 */
import { ROLE_RANK, isNationalRole, roleRank } from "./access";

export const RH_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Só emails recentes: ligar o interruptor não lê anos de CVs de uma vez. */
export const RH_ATTACHMENT_MAX_AGE_DAYS = 14;
/** No máximo estes anexos por email (os outros ficam "não lido"). */
export const RH_ATTACHMENTS_PER_EMAIL = 5;

export type AttachmentInput = "pdf" | "image" | "docx";
const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** O que fazer com um anexo (antes de o descarregar). PURA. */
export function attachmentReadPlan(a: { filename?: string | null; contentType?: string | null; size?: number | null; url?: string | null; key?: string | null }):
  | { ok: true; input: AttachmentInput; mimeType: string }
  | { ok: false; reason: string } {
  if (!a.url && !a.key) return { ok: false, reason: "ficheiro não guardado" };
  if (a.size != null && a.size > RH_ATTACHMENT_MAX_BYTES) return { ok: false, reason: "demasiado grande (máx. 8 MB)" };
  const name = String(a.filename ?? "").toLowerCase();
  let type = String(a.contentType ?? "").toLowerCase().split(";")[0].trim();
  if (!type || type === "application/octet-stream") {
    if (name.endsWith(".pdf")) type = "application/pdf";
    else if (/\.(jpe?g)$/.test(name)) type = "image/jpeg";
    else if (name.endsWith(".png")) type = "image/png";
    else if (name.endsWith(".webp")) type = "image/webp";
    else if (name.endsWith(".docx")) type = DOCX_TYPE;
  }
  if (type === "application/pdf") return { ok: true, input: "pdf", mimeType: type };
  if (IMAGE_TYPES.has(type)) return { ok: true, input: "image", mimeType: type === "image/jpg" ? "image/jpeg" : type };
  if (type === DOCX_TYPE) return { ok: true, input: "docx", mimeType: type };
  return { ok: false, reason: "formato não lido (só PDF, imagem ou Word .docx)" };
}

/** N.º de documento plausível (BI/CC, carta): letras/dígitos, 6–20. PURA. */
export function validDocNumber(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").toUpperCase().replace(/[\s.]/g, "").trim();
  return /^[A-Z0-9-]{6,20}$/.test(s) && /\d/.test(s) ? s : null;
}

/** NIF português com dígito de controlo. PURA. */
export function validLeadNif(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length !== 9) return null;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(d[i]) * (9 - i);
  const check = 11 - (sum % 11);
  return (check >= 10 ? 0 : check) === Number(d[8]) ? d : null;
}

export interface AttachmentExtract {
  docKind?: string | null;
  fullName?: string | null;
  nif?: string | null;
  idDocNumber?: string | null;
  drivingLicenseNumber?: string | null;
  city?: string | null;
  cityCertain?: boolean | null;
  phones?: string[] | null;
  emails?: string[] | null;
  summary?: string | null;
}

/**
 * O que vai para o candidato: só campos VAZIOS e só valores válidos. A cidade
 * só quando a IA diz que é certa E o texto bate numa só cidade nossa
 * (`cityProjectId`, resolvido por quem chama). Contactos novos: telefone/email
 * vazios ficam com o primeiro; os restantes vão para as notas. PURA.
 */
export function planLeadFromAttachment(
  lead: { nif: string | null; idDocNumber: string | null; drivingLicenseNumber: string | null; projectId: number | null; phone: string | null; email: string | null; aiSummary: string | null },
  x: AttachmentExtract,
  opts: { cityProjectId: number | null; normalizePhone: (p: string) => string | null; normalizeEmail: (e: string) => string | null },
): { patch: Record<string, string | number>; otherContacts: string[]; filled: string[] } {
  const patch: Record<string, string | number> = {};
  const filled: string[] = [];
  const empty = (v: string | number | null) => v == null || String(v).trim() === "";
  const nif = validLeadNif(x.nif);
  if (nif && empty(lead.nif)) { patch.nif = nif; filled.push("NIF"); }
  const cc = validDocNumber(x.idDocNumber);
  if (cc && empty(lead.idDocNumber)) { patch.idDocNumber = cc; filled.push("n.º do BI/CC"); }
  const dl = validDocNumber(x.drivingLicenseNumber);
  if (dl && empty(lead.drivingLicenseNumber)) { patch.drivingLicenseNumber = dl; filled.push("n.º da carta"); }
  if (x.cityCertain === true && opts.cityProjectId != null && lead.projectId == null) { patch.projectId = opts.cityProjectId; filled.push("cidade"); }

  const known = new Set([lead.phone, lead.email].filter(Boolean).map((v) => String(v).toLowerCase()));
  const others: string[] = [];
  for (const raw of (x.phones ?? []).slice(0, 5)) {
    const p = opts.normalizePhone(String(raw));
    if (!p || known.has(p.toLowerCase())) continue;
    known.add(p.toLowerCase());
    if (empty(lead.phone) && !patch.phone) { patch.phone = p; filled.push("telefone"); } else others.push(p);
  }
  for (const raw of (x.emails ?? []).slice(0, 5)) {
    const e = opts.normalizeEmail(String(raw));
    if (!e || known.has(e.toLowerCase())) continue;
    known.add(e.toLowerCase());
    if (empty(lead.email) && !patch.email) { patch.email = e; filled.push("email"); } else others.push(e);
  }
  const summary = String(x.summary ?? "").trim();
  // O resumo do CV é para quem entrevista: o mais recente fica.
  if (summary && (x.docKind === "cv" || empty(lead.aiSummary))) patch.aiSummary = summary.slice(0, 2000);
  return { patch, otherContacts: others, filled };
}

/** Vê NIF e números dos documentos do candidato? Só o RH (front/back office, admin+). PURA. */
export function canSeeLeadIdentity(role: string | null | undefined): boolean {
  const r = String(role ?? "");
  return isNationalRole(r) || roleRank(r) >= ROLE_RANK.admin;
}

/** Tira o que só o RH vê de uma linha de candidato. PURA. */
export function redactLeadIdentity<T extends { nif?: unknown; idDocNumber?: unknown; drivingLicenseNumber?: unknown }>(row: T): T {
  return { ...row, nif: null, idDocNumber: null, drivingLicenseNumber: null };
}

export const DOC_KIND_LABEL: Record<string, string> = {
  cv: "CV", id_card: "BI/CC", residence_permit: "Título de residência", driving_license: "Carta de condução", other: "Outro documento",
};
