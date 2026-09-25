/**
 * Importação CSV de extras (condutores casuais) para a tabela employees.
 *
 * Formato CSV esperado (cabeçalho em qualquer ordem):
 *   nome, nivel, salario_mensal, subsidio_alim_dia, nif, nib, telefone,
 *   email, morada, nacionalidade, data_nascimento
 *
 * Linhas em branco são ignoradas. Erros por linha são reportados.
 * A cidade (centro de custos) é obrigatória e aplica-se a todas as linhas;
 * quem já tem ficha (mesmo email, NIF ou telemóvel) é saltado, não duplicado.
 */

import { createEmployee, getDb } from "./db";
import { employees } from "../drizzle/schema";
import { normalizeEmail } from "../shared/email";
import { normalizePhoneE164 } from "../shared/phone";

const NIVEL_TO_EXTRA: Record<string, number> = {
  junior: 1,
  júnior: 1,
  senior: 2,
  sénior: 2,
  terminal: 3,
  master: 4,
};

const KNOWN_COLUMNS = new Set([
  "nome",
  "nivel",
  "nível",
  "salario_mensal",
  "salário_mensal",
  "subsidio_alim_dia",
  "subsídio_alim_dia",
  "nif",
  "nib",
  "telefone",
  "email",
  "morada",
  "nacionalidade",
  "data_nascimento",
]);

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normHeader(h: string): string {
  return h.toLowerCase().trim().replace(/\s+/g, "_");
}

function pick(row: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function parseDecimal(s: string | undefined): string | null {
  if (!s) return null;
  const normalized = s.replace(",", ".");
  const n = parseFloat(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

export interface ImportReport {
  parsed: number;
  created: number;
  /** Linhas saltadas por já existir ficha (ou por repetirem outra linha do ficheiro). */
  duplicates: { rowIndex: number; nome: string; reason: string }[];
  errors: { rowIndex: number; nome?: string; reason: string }[];
  unknownColumns: string[];
}

/** Chaves de identidade de uma pessoa (email, NIF, telemóvel) normalizadas. */
export function identityKeys(p: { email?: string | null; nif?: string | null; phone?: string | null }): string[] {
  const keys: string[] = [];
  const email = p.email ? normalizeEmail(p.email) : null;
  if (email) keys.push(`email:${email}`);
  const nif = (p.nif ?? "").replace(/\D/g, "");
  if (nif.length >= 9) keys.push(`nif:${nif}`);
  const phone = p.phone ? normalizePhoneE164(p.phone) : null;
  if (phone) keys.push(`tel:${phone}`);
  return keys;
}

const KEY_LABEL: Record<string, string> = { email: "email", nif: "NIF", tel: "telemóvel" };

/**
 * Duplicado? Procura primeiro nas fichas existentes, depois nas linhas já lidas
 * do mesmo ficheiro. PURA — devolve o motivo ou null.
 */
export function duplicateReason(
  keys: string[],
  existing: Map<string, { id: number; fullName: string }>,
  seen: Map<string, number>,
): string | null {
  for (const k of keys) {
    const hit = existing.get(k);
    if (hit) return `Já existe a ficha ${hit.fullName} (#${hit.id}) com o mesmo ${KEY_LABEL[k.split(":")[0]]}.`;
  }
  for (const k of keys) {
    const row = seen.get(k);
    if (row != null) return `Repete a linha ${row} (mesmo ${KEY_LABEL[k.split(":")[0]]}).`;
  }
  return null;
}

export async function importExtrasFromCsv(
  csvText: string,
  createdById?: number | null,
  opts: { projectId?: number | null } = {},
): Promise<ImportReport> {
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const report: ImportReport = { parsed: 0, created: 0, duplicates: [], errors: [], unknownColumns: [] };
  if (!opts.projectId) {
    report.errors.push({ rowIndex: 0, reason: "Escolhe a cidade (centro de custos) dos extras a importar." });
    return report;
  }

  // Fichas existentes (ativas ou não) por email / NIF / telemóvel
  const existing = new Map<string, { id: number; fullName: string }>();
  const db = await getDb();
  if (db) {
    const rows = await db.select({ id: employees.id, fullName: employees.fullName, email: employees.email, nif: employees.nif, phone: employees.phone }).from(employees);
    for (const r of rows) for (const k of identityKeys(r)) if (!existing.has(k)) existing.set(k, { id: r.id, fullName: r.fullName });
  }
  const seen = new Map<string, number>();

  if (lines.length < 2) {
    report.errors.push({ rowIndex: 0, reason: "CSV vazio ou sem linhas de dados." });
    return report;
  }

  const headers = parseCsvLine(lines[0]).map(normHeader);
  for (const h of headers) {
    if (!KNOWN_COLUMNS.has(h)) report.unknownColumns.push(h);
  }
  if (!headers.includes("nome")) {
    report.errors.push({ rowIndex: 0, reason: "Falta coluna obrigatória 'nome'." });
    return report;
  }
  if (!headers.includes("nivel") && !headers.includes("nível")) {
    report.errors.push({ rowIndex: 0, reason: "Falta coluna obrigatória 'nivel'." });
    return report;
  }

  for (let i = 1; i < lines.length; i++) {
    report.parsed++;
    const cols = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j] ?? "";

    const nome = pick(row, "nome");
    if (!nome) {
      report.errors.push({ rowIndex: i + 1, reason: "Nome em falta." });
      continue;
    }

    const nivelRaw = pick(row, "nivel", "nível")?.toLowerCase() ?? "";
    const extraLevel = NIVEL_TO_EXTRA[nivelRaw];
    if (!extraLevel) {
      report.errors.push({
        rowIndex: i + 1,
        nome,
        reason: `Nível inválido '${nivelRaw}'. Usa junior, senior, terminal ou master.`,
      });
      continue;
    }

    const keys = identityKeys({ email: pick(row, "email"), nif: pick(row, "nif"), phone: pick(row, "telefone") });
    const dup = duplicateReason(keys, existing, seen);
    if (dup) {
      report.duplicates.push({ rowIndex: i + 1, nome, reason: dup });
      continue;
    }
    for (const k of keys) seen.set(k, i + 1);

    try {
      const created = await createEmployee({
        fullName: nome,
        email: pick(row, "email") ?? null,
        phone: pick(row, "telefone") ?? null,
        nif: pick(row, "nif") ?? null,
        nib: pick(row, "nib") ?? null,
        address: pick(row, "morada") ?? null,
        birthDate: pick(row, "data_nascimento") ?? null,
        nationality: pick(row, "nacionalidade") ?? null,
        position: "extra",
        extraLevel,
        contractType: "extra",
        monthlySalary: parseDecimal(pick(row, "salario_mensal", "salário_mensal")),
        mealAllowancePerDay: parseDecimal(pick(row, "subsidio_alim_dia", "subsídio_alim_dia")),
        projectId: opts.projectId,
        isActive: 1,
      } as any);
      report.created++;
      // Fase 1: toda a ficha nova com email fica com utilizador
      const newId = Number((created as any)?.[0]?.insertId ?? (created as any)?.insertId);
      const email = pick(row, "email");
      if (db && newId && email) {
        try {
          const { ensureUserForEmployee } = await import("./identity");
          await ensureUserForEmployee(db as any, { id: newId, fullName: nome, email, position: "extra", userId: null });
        } catch { /* a ficha fica criada; o sweep horário tenta outra vez */ }
      }
    } catch (err: any) {
      report.errors.push({ rowIndex: i + 1, nome, reason: err.message || String(err) });
    }
  }

  return report;
}
