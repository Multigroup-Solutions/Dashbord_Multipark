/**
 * Documentos do RH lidos por IA (Jorge, 24 set 2026): quando se carrega o
 * Cartão de Cidadão, a Autorização de Residência, a Carta de Condução, o
 * comprovativo de IBAN ou de morada, a IA lê o documento e preenche na ficha
 * SÓ os campos que ainda estão vazios — nunca substitui o que já lá está.
 *
 * Usa o LLM configurado na app (server/_core/llm.ts — LLM_API_KEY/LLM_MODEL).
 * Sem LLM configurado, não faz nada. Best-effort: nunca parte o upload.
 */
import { llmConfigured } from "./_core/llm";
import { sql } from "drizzle-orm";
import { getDb } from "./db";

export const AUTOFILL_DOC_TYPES = ["id_card", "residence_permit", "driving_license", "nib_proof", "address_proof"] as const;
const MAX_BYTES = 8 * 1024 * 1024;

export interface ExtractedDoc {
  fullName?: string | null;
  nif?: string | null;
  birthDate?: string | null;
  nationality?: string | null;
  address?: string | null;
  iban?: string | null;
  documentNumber?: string | null;
  expiryDate?: string | null;
}

// ─── Puros ──────────────────────────────────────────────────────────────────

/** NIF português: 9 dígitos com dígito de controlo válido. */
export function validNif(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length !== 9) return null;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(d[i]) * (9 - i);
  const check = 11 - (sum % 11);
  return (check >= 10 ? 0 : check) === Number(d[8]) ? d : null;
}

/** IBAN normalizado (sem espaços, maiúsculas) e com checksum ISO 13616 válido. */
export function validIban(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return null;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? s : null;
}

/** Data ISO YYYY-MM-DD plausível (aceita DD/MM/AAAA e DD.MM.AAAA). */
export function validDate(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let iso = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  if (!iso) {
    m = s.match(/^(\d{2})[/.\- ](\d{2})[/.\- ](\d{4})$/);
    if (m) iso = `${m[3]}-${m[2]}-${m[1]}`;
  }
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  const y = Number(iso.slice(0, 4));
  return y >= 1900 && y <= 2100 ? iso : null;
}

/** Tira o primeiro objeto JSON de uma resposta do modelo. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface FillPlan { patch: Record<string, string>; filled: string[] }

const LABEL: Record<string, string> = { nif: "NIF", birthDate: "data de nascimento", nationality: "nacionalidade", address: "morada", nib: "IBAN" };

/**
 * O que a IA pode preencher nesta ficha: só campos VAZIOS e só valores que
 * passam na validação (NIF com dígito de controlo, IBAN com checksum, datas
 * reais). A morada só vem do comprovativo de morada ou do documento de
 * identificação; o IBAN só do comprovativo de IBAN. PURA.
 */
export function planAutofill(
  current: { nif: string | null; birthDate: string | null; nationality: string | null; address: string | null; nib: string | null },
  docType: string,
  x: ExtractedDoc,
): FillPlan {
  const patch: Record<string, string> = {};
  const empty = (v: string | null) => v == null || String(v).trim() === "";
  const idDoc = docType === "id_card" || docType === "residence_permit" || docType === "driving_license";
  if (idDoc) {
    const nif = validNif(x.nif);
    if (nif && empty(current.nif)) patch.nif = nif;
    const bd = validDate(x.birthDate);
    if (bd && empty(current.birthDate)) patch.birthDate = bd;
    const nat = String(x.nationality ?? "").trim();
    if (nat && nat.length <= 64 && empty(current.nationality)) patch.nationality = nat;
  }
  if (idDoc || docType === "address_proof") {
    const addr = String(x.address ?? "").trim();
    if (addr.length >= 8 && addr.length <= 300 && empty(current.address)) patch.address = addr;
  }
  if (docType === "nib_proof") {
    const iban = validIban(x.iban);
    if (iban && empty(current.nib)) patch.nib = iban;
  }
  return { patch, filled: Object.keys(patch).map((k) => LABEL[k] ?? k) };
}

// ─── I/O ────────────────────────────────────────────────────────────────────

const PROMPT = `És um assistente de recursos humanos português. Lê o documento em anexo e devolve APENAS um objeto JSON (sem texto à volta) com estes campos, usando null quando o campo não aparece ou não é legível:
{"fullName": string|null, "nif": string|null, "birthDate": "YYYY-MM-DD"|null, "nationality": string|null, "address": string|null, "iban": string|null, "documentNumber": string|null, "expiryDate": "YYYY-MM-DD"|null}
Regras: não inventes; copia os números tal como aparecem; nationality em português (ex.: "Portuguesa", "Brasileira"); address numa só linha com código postal e localidade.`;

// Fonte única: server/_core/llm.ts (re-exportado para os chamadores existentes).
export { llmConfigured };

export async function extractDocument(mimeType: string, base64: string): Promise<ExtractedDoc | null> {
  const { invokeLLM } = await import("./_core/llm");
  const isPdf = mimeType === "application/pdf";
  const part: any = isPdf
    ? { type: "file_url", file_url: { url: `data:application/pdf;base64,${base64}`, mime_type: "application/pdf" } }
    : { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" } };
  const r = await invokeLLM({ messages: [{ role: "user", content: [part, { type: "text", text: PROMPT }] }] });
  const content = r.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? "").join("") : "";
  return parseJsonObject(text) as ExtractedDoc | null;
}

/**
 * Lê o documento e preenche os campos vazios da ficha. Devolve os campos
 * preenchidos (para a UI avisar) e os dados lidos do documento.
 */
export async function autofillFromDocument(opts: { employeeId: number; docType: string; mimeType: string; base64: string; userId: number }): Promise<{ filled: string[]; extracted: ExtractedDoc | null; skipped?: string }> {
  if (!(AUTOFILL_DOC_TYPES as readonly string[]).includes(opts.docType)) return { filled: [], extracted: null, skipped: "tipo de documento" };
  if (!llmConfigured()) return { filled: [], extracted: null, skipped: "IA não configurada" };
  if (!/^image\/(jpeg|png|webp|gif)$/.test(opts.mimeType) && opts.mimeType !== "application/pdf") return { filled: [], extracted: null, skipped: "formato" };
  if (opts.base64.length * 0.75 > MAX_BYTES) return { filled: [], extracted: null, skipped: "ficheiro grande" };
  const db = await getDb();
  if (!db) return { filled: [], extracted: null };

  const extracted = await extractDocument(opts.mimeType, opts.base64);
  if (!extracted) return { filled: [], extracted: null, skipped: "leitura falhou" };
  const [cur] = ((await db.execute(sql`SELECT nif, birthDate, nationality, address, nib FROM employees WHERE id = ${opts.employeeId} LIMIT 1`)) as any)[0] as any[];
  if (!cur) return { filled: [], extracted };
  const plan = planAutofill(
    {
      nif: cur.nif ?? null,
      birthDate: cur.birthDate ? String(cur.birthDate) : null,
      nationality: cur.nationality ?? null,
      address: cur.address ?? null,
      nib: cur.nib ?? null,
    },
    opts.docType,
    extracted,
  );
  if (plan.filled.length) {
    const { updateEmployee, logActivity } = await import("./db");
    const data: Record<string, unknown> = { ...plan.patch };
    if (plan.patch.birthDate) data.birthDate = `${plan.patch.birthDate} 00:00:00`;
    await updateEmployee(opts.employeeId, data as any);
    await logActivity({ userId: opts.userId, action: "update", entity: "employee", entityId: opts.employeeId, details: `IA preencheu a partir do documento (${opts.docType}): ${plan.filled.join(", ")}` });
  }
  return { filled: plan.filled, extracted };
}
