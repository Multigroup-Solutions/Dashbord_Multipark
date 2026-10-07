/**
 * Lote 40a — Xsi da One Net (Vodafone ativou-o a 7 out 2026). A plataforma
 * BroadWorks por trás da One Net responde em XML simples (sem atributos além
 * do xmlns). Aqui: validar o endereço do servidor e ler as respostas do
 * perfil, do diretório da empresa e dos registos de chamadas. Regras PURAS.
 */

/** Caminho das ações do Xsi (o "Server URL" é só a origem: https://anfitrião[:porta]). */
export const XSI_ACTIONS_PATH = "/com.broadsoft.xsi-actions/v2.0";

/**
 * Endereço do servidor Xsi → origem https normalizada; aceita colarem o URL
 * completo (com /com.broadsoft.xsi-actions/v2.0…). Recusa http, credenciais
 * no URL, localhost e IPs internos (o servidor faz o pedido). PURA.
 */
export function normalizeXsiBase(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return null;
  }
  if (host.startsWith("[")) return null; // IPv6 literal: não
  // o caminho até /com.broadsoft… (alguns operadores põem um prefixo) fica; o resto sai
  const path = u.pathname.replace(/\/com\.broadsoft\.xsi-actions.*$/i, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** Utilizador do BroadWorks (ex.: 351210000000@onenet.vodafone.pt ou nome@dominio). PURA. */
export function normalizeXsiUserId(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return /^[A-Za-z0-9+._@-]{3,120}$/.test(v) ? v : null;
}

// ─── XML simples ────────────────────────────────────────────────────────────

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? _);
}
const tagRe = (tag: string) => `(?:[A-Za-z0-9_]+:)?${tag}`;
/** O conteúdo de cada <tag>…</tag> (com ou sem prefixo de namespace), por ordem. PURA. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tagRe(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagRe(tag)}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}
/** O texto do primeiro <tag> (vazio ou <tag/> → null). PURA. */
export function xmlText(xml: string, tag: string): string | null {
  const b = xmlBlocks(xml, tag)[0];
  if (b == null) return null;
  const t = decodeXml(b.replace(/<[^>]+>/g, "")).trim();
  return t ? t : null;
}

// ─── Respostas ──────────────────────────────────────────────────────────────

export interface XsiProfile { userId: string | null; firstName: string | null; lastName: string | null; number: string | null; extension: string | null; groupId: string | null }
/** GET /user/{id}/profile. PURA. */
export function parseXsiProfile(xml: string): XsiProfile {
  const d = xmlBlocks(xml, "details")[0] ?? xml;
  return {
    userId: xmlText(d, "userId"), firstName: xmlText(d, "firstName"), lastName: xmlText(d, "lastName"),
    number: xmlText(d, "number"), extension: xmlText(d, "extension"), groupId: xmlText(d, "groupId"),
  };
}

export interface XsiDirectoryEntry {
  userId: string | null; name: string; number: string | null; extension: string | null; mobile: string | null; email: string | null; groupId: string | null;
}
/** GET /user/{id}/directories/Enterprise (ou Group): uma entrada por pessoa. PURA. */
export function parseXsiDirectory(xml: string): { total: number | null; entries: XsiDirectoryEntry[] } {
  const totalRaw = xmlText(xml, "totalAvailableRecords");
  const entries = xmlBlocks(xml, "directoryDetails").map((b) => {
    const first = xmlText(b, "firstName");
    const last = xmlText(b, "lastName");
    return {
      userId: xmlText(b, "userId"),
      name: [first, last].filter(Boolean).join(" ") || xmlText(b, "displayName") || xmlText(b, "name") || "(sem nome)",
      number: xmlText(b, "number"), extension: xmlText(b, "extension"), mobile: xmlText(b, "mobile"),
      email: xmlText(b, "emailAddress"), groupId: xmlText(b, "groupId"),
    };
  });
  return { total: totalRaw != null && /^\d+$/.test(totalRaw) ? Number(totalRaw) : null, entries };
}

export type XsiCallType = "placed" | "received" | "missed";
export interface XsiCallLog { type: XsiCallType; callLogId: string | null; phone: string | null; name: string | null; time: string | null }
/** GET /user/{id}/directories/CallLogs: <placed>, <received>, <missed> com <callLogsEntry>. PURA. */
export function parseXsiCallLogs(xml: string): XsiCallLog[] {
  const out: XsiCallLog[] = [];
  for (const type of ["placed", "received", "missed"] as const) {
    for (const list of xmlBlocks(xml, type)) {
      for (const e of xmlBlocks(list, "callLogsEntry")) {
        const cc = xmlText(e, "countryCode");
        const num = xmlText(e, "phoneNumber");
        out.push({ type, callLogId: xmlText(e, "callLogId"), phone: num ? (cc && !num.startsWith("+") && num.length >= 9 ? `+${cc}${num}` : num) : null, name: xmlText(e, "name"), time: xmlText(e, "time") });
      }
    }
  }
  return out;
}

/**
 * 40a.1: o que veio no corpo. O onenetws.vodafone.pt está atrás de uma
 * proteção anti-robôs (Imperva/Incapsula) que responde "200" com uma página
 * HTML a quem não é browser — isso não é o Xsi a responder. PURA.
 */
export type XsiBodyKind = "xml" | "shield" | "html" | "empty" | "other";
export function xsiBodyKind(body: unknown): XsiBodyKind {
  const s = String(body ?? "").trimStart();
  if (!s) return "empty";
  if (/_Incapsula_Resource|incapsula|imperva|cf-browser-verification|captcha/i.test(s.slice(0, 5000))) return "shield";
  if (/^(<!doctype\s+html|<html[\s>])/i.test(s)) return "html";
  if (/^<(\?xml|[A-Za-z][\w:.-]*)/.test(s)) return "xml";
  return "other";
}

/** Os últimos 9 dígitos (para cruzar números da One Net com as fichas). PURA. */
export function last9(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
}
