/**
 * Lote 45 (Jorge, 7 out 2026: "importar contactos — importante"): ler um
 * ficheiro de contactos para o CRM. Aceita:
 *  - CSV exportado do Google Contactos ("First Name", "E-mail 1 - Value",
 *    "Phone 1 - Value", "Organization Name"…), do Outlook ("E-mail Address",
 *    "Mobile Phone", "Company") ou feito à mão (nome, email, telefone, empresa),
 *    separado por vírgulas ou ponto e vírgula (Excel em PT);
 *  - vCard (.vcf), um ou vários contactos.
 * PURO: o browser lê o ficheiro, o servidor volta a validar cada linha.
 */

export interface ImportRow { name: string; email: string | null; phone: string | null; company: string | null }

/** Máximo de contactos por importação. */
export const CONTACT_IMPORT_MAX = 2000;

/** Uma linha CSV com aspas ("a; b" e "" dentro de aspas). PURA. */
export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Linhas do CSV, respeitando quebras de linha dentro de aspas. PURA. */
function csvRecords(text: string): string[] {
  const recs: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (cur.trim()) recs.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) recs.push(cur);
  return recs;
}

const norm = (h: string) => h.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Que coluna é o quê (nome, primeiro/último nome, email, telefone, empresa). PURA. */
export function mapCsvHeader(header: readonly string[]): { name: number[]; first: number; last: number; email: number[]; phone: number[]; company: number } {
  const h = header.map(norm);
  const find = (...alts: RegExp[]) => h.findIndex((x) => alts.some((r) => r.test(x)));
  const all = (...alts: RegExp[]) => h.map((x, i) => (alts.some((r) => r.test(x)) ? i : -1)).filter((i) => i >= 0);
  return {
    name: all(/^(nome|name|nome completo|full name|display name|nome a apresentar)$/),
    first: find(/^(first name|given name|primeiro nome|nome proprio)$/),
    last: find(/^(last name|family name|apelido|ultimo nome|sobrenome)$/),
    email: all(/^(email|e mail|correio eletronico|email address|e mail address|e mail \d+ value|e mail \d+ address|email \d+)$/),
    phone: all(/^(telefone|telemovel|telemóvel|phone|mobile|mobile phone|telephone|phone \d+ value|business phone|home phone|primary phone|contacto|tel)$/),
    company: find(/^(empresa|company|organization|organization name|organization \d+ name|organizacao)$/),
  };
}

const clean = (v: string | undefined | null, max: number): string | null => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
/** "a@b.pt ::: c@d.pt" (Google junta vários num campo) → o primeiro. */
const firstOf = (v: string | null): string | null => (v ? (v.split(/\s*:::\s*|\s*[;,]\s*/).find((x) => x.trim()) ?? null) : null);

/** CSV → contactos (linhas sem nome, email nem telefone ficam de fora). PURA. */
export function parseContactsCsv(text: string): ImportRow[] {
  const recs = csvRecords(text.replace(/^﻿/, ""));
  if (recs.length < 2) return [];
  const first = recs[0];
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : (first.includes("\t") && !first.includes(",") ? "\t" : ",");
  const cols = mapCsvHeader(splitCsvLine(first, sep));
  const out: ImportRow[] = [];
  for (const rec of recs.slice(1)) {
    const c = splitCsvLine(rec, sep);
    const pick = (idx: number[]) => idx.map((i) => clean(c[i], 320)).find(Boolean) ?? null;
    const joined = [cols.first >= 0 ? c[cols.first] : "", cols.last >= 0 ? c[cols.last] : ""].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
    const name = clean(pick(cols.name) ?? joined, 255);
    const email = firstOf(pick(cols.email));
    const phone = firstOf(pick(cols.phone));
    const company = cols.company >= 0 ? clean(c[cols.company], 255) : null;
    if (!name && !email && !phone) continue;
    out.push({ name: name ?? email ?? phone ?? "", email: email ? email.toLowerCase() : null, phone, company });
  }
  return out;
}

/** vCard (.vcf) → contactos. PURA. */
export function parseVcards(text: string): ImportRow[] {
  // Linhas dobradas (continuação começa por espaço) voltam a juntar-se.
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: ImportRow[] = [];
  let cur: { fn?: string; n?: string; email?: string; tel?: string; org?: string } | null = null;
  const val = (l: string) => l.slice(l.indexOf(":") + 1).replace(/\\,/g, ",").replace(/\\;/g, ";").trim();
  for (const l of lines) {
    const up = l.toUpperCase();
    if (up.startsWith("BEGIN:VCARD")) cur = {};
    else if (up.startsWith("END:VCARD")) {
      if (cur) {
        const name = clean(cur.fn ?? cur.n, 255);
        const email = clean(cur.email, 320);
        const phone = clean(cur.tel, 64);
        if (name || email || phone) out.push({ name: name ?? email ?? phone ?? "", email: email ? email.toLowerCase() : null, phone, company: clean(cur.org, 255) });
      }
      cur = null;
    } else if (cur) {
      const key = up.split(/[;:]/)[0];
      if (key === "FN" && !cur.fn) cur.fn = val(l);
      else if (key === "N" && !cur.n) cur.n = val(l).split(";").slice(0, 2).reverse().filter(Boolean).join(" ");
      else if (key === "EMAIL" && !cur.email) cur.email = val(l);
      else if (key === "TEL" && !cur.tel) cur.tel = val(l).replace(/^tel:/i, "");
      else if (key === "ORG" && !cur.org) cur.org = val(l).split(";")[0];
    }
  }
  return out;
}

/** Pelo nome do ficheiro (ou pelo conteúdo): vCard ou CSV. PURA. */
export function parseContactFile(text: string, fileName: string): ImportRow[] {
  const isVcf = /\.vcf$/i.test(fileName) || /^\s*BEGIN:VCARD/i.test(text);
  return isVcf ? parseVcards(text) : parseContactsCsv(text);
}
