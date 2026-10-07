/**
 * Lote 39a — Central Vodafone pela consola (Jorge, 6 out 2026: "avança com o
 * Sugar"). A One Net Attendant Console só regista chamadas em CRM conhecidos;
 * a dashboard responde como um Sugar CRM (API REST v10 e a antiga v4_1) e
 * guarda cada chamada em nome de quem a atendeu ou fez. Regras PURAS.
 */

export const CENTRAL_SUGAR_FLAG = "CENTRAL_SUGAR";
/** Onde a porta vive (o "Server URL" a pôr na consola é a origem + isto). */
export const CENTRAL_SUGAR_BASE_PATH = "/api/central/sugar";

export interface CentralCall {
  direction: "in" | "out";
  /** false = não atendida ("Not Held"). */
  held: boolean;
  startedAtMs: number;
  durationS: number | null;
  phone: string | null;
  subject: string | null;
  description: string | null;
}

/** Utilizador da consola: minúsculas, letras/números/._- , 3 a 60. PURA. */
export function normalizeCentralUsername(raw: string): string | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return /^[a-z0-9._-]{3,60}$/.test(v) ? v : null;
}

/** v4_1: name_value_list em lista [{name, value}] ou objeto {campo: {name, value}} → objeto simples. PURA. */
export function flattenNameValueList(nvl: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(nvl)) {
    for (const it of nvl) if (it && typeof it === "object" && "name" in (it as any)) out[String((it as any).name)] = (it as any).value;
    return out;
  }
  if (nvl && typeof nvl === "object") {
    for (const [k, v] of Object.entries(nvl as Record<string, unknown>)) {
      out[k] = v && typeof v === "object" && "value" in (v as any) ? (v as any).value : v;
    }
  }
  return out;
}

const str = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
};

/** "2026-10-06T22:10:00+01:00" ou "2026-10-06 21:10:00" (v4: UTC). Sem data válida → null. PURA. */
export function parseSugarDate(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(s);
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(hasZone ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** O primeiro número de telefone que aparecer (9+ dígitos). PURA. */
export function extractPhone(...texts: Array<unknown>): string | null {
  for (const t of texts) {
    const m = String(t ?? "").match(/\+?\d[\d\s().-]{7,}\d/);
    if (m) {
      const digits = m[0].replace(/[^\d+]/g, "");
      if (digits.replace(/\D/g, "").length >= 9) return digits.slice(0, 32);
    }
  }
  return null;
}

/**
 * Uma chamada do Sugar (módulo Calls) → a nossa chamada. `now` só entra quando
 * a consola não manda a hora. Direção pelo campo `direction` ou, sem ele,
 * pelo texto ("recebida"/"inbound" vs "efetuada"/"outbound"); sem nada → "in".
 * PURA.
 */
export function parseSugarCall(fields: Record<string, unknown>, now: number): CentralCall {
  const f = Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const subject = str(f.name);
  const description = str(f.description);
  const dirRaw = String(f.direction ?? "").toLowerCase();
  const text = `${subject ?? ""} ${description ?? ""}`.toLowerCase();
  const direction: "in" | "out" = /^out|sa[ií]da|outbound/.test(dirRaw) ? "out"
    : /^in|entrada|inbound/.test(dirRaw) ? "in"
    : /outbound|efetuada|efectuada|realizada|sa[ií]da/.test(text) ? "out" : "in";
  const status = String(f.status ?? "").toLowerCase();
  const held = !/not\s*held|missed|perdida|n[aã]o atendida/.test(`${status} ${text}`);
  const h = Number(f.duration_hours ?? 0) || 0;
  const m = Number(f.duration_minutes ?? 0) || 0;
  const secs = Number(f.duration_seconds ?? f.duration ?? NaN);
  // 39e: a consola manda só minutos ("duration_minutes": "0" = menos de 1 min); 0 é duração, não "sem dado"
  const hasMinutes = [f.duration_hours, f.duration_minutes].some((v) => v != null && String(v).trim() !== "" && Number.isFinite(Number(v)));
  const durationS = Number.isFinite(secs) && secs > 0 ? Math.round(secs) : h || m || hasMinutes ? h * 3600 + m * 60 : null;
  const startedAtMs = parseSugarDate(f.date_start) ?? parseSugarDate(f.date_entered) ?? now;
  const phone = extractPhone(f.phone, f.phone_number, f.phone_work, f.phone_mobile, f.number, subject, description);
  return {
    direction, held, startedAtMs, durationS: durationS != null ? Math.min(durationS, 24 * 3600) : null,
    phone, subject: subject ? subject.slice(0, 255) : null, description: description ? description.slice(0, 4000) : null,
  };
}

/** Tira segredos (password, tokens, client_secret…) antes de guardar o pedido; corta a 4000. PURA. */
export function redactForLog(body: unknown): string | null {
  if (body == null || (typeof body === "object" && !Object.keys(body as object).length)) return null;
  const SECRET = /pass|secret|token|auth|session|cookie/i;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6) return "…";
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET.test(k) ? "***" : walk(x, depth + 1)]));
    }
    if (typeof v === "string") {
      // rest_data da v4_1 vem como texto JSON: abre-o para tirar a password lá de dentro
      if (/^\s*[{[]/.test(v)) { try { return walk(JSON.parse(v), depth + 1); } catch { /* texto */ } }
      return v.length > 500 ? `${v.slice(0, 500)}…` : v;
    }
    return v;
  };
  const s = JSON.stringify(walk(body, 0));
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
}

// ─── 39d: quem está a ligar (pesquisa da consola) ───────────────────────────

/**
 * O telefone que a consola procura: `q: "*+351913225918*"` (POST
 * /Contacts/filter) ou dentro do `filter` (GET ?filter[0][phone_work]=…). PURA.
 */
export function sugarSearchPhone(input: unknown): string | null {
  if (input == null) return null;
  return extractPhone(typeof input === "string" ? input : JSON.stringify(input));
}

/** Contactos que a dashboard dá à consola: ficha do CRM, contacto do CRM, ficha do RH ou só o número. */
export type CentralContactKind = "crm" | "ct" | "emp" | "tel";
/** "crm-123" → { kind: "crm", id: "123" }; "tel-351913225918" → número. Inválido → null. PURA. */
export function parseContactRef(raw: unknown): { kind: CentralContactKind; id: string } | null {
  const m = /^(crm|ct|emp|tel)-(\d{1,20})$/.exec(String(raw ?? "").trim());
  return m ? { kind: m[1] as CentralContactKind, id: m[2] } : null;
}

/** A que contacto a consola ligou a chamada (parent_id, contact_id ou a lista contacts). PURA. */
export function callContactRef(fields: Record<string, unknown>): string | null {
  const f = Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const contacts = Array.isArray(f.contacts) ? f.contacts : Array.isArray((f.contacts as any)?.add) ? (f.contacts as any).add : [];
  for (const c of [f.parent_id, f.contact_id, ...contacts.map((x: any) => (x && typeof x === "object" ? x.id : x))]) {
    if (parseContactRef(c)) return String(c).trim();
  }
  return null;
}

/** Para onde a página do "Sugar" manda quem abre um contacto na consola (#Contacts/crm-123). PURA. */
export function contactRedirect(hash: string): string {
  const m = /^#?\/?(?:Contacts|Leads|Accounts)\/((?:crm|ct|emp|tel)-\d+)/.exec(String(hash ?? ""));
  const ref = m ? parseContactRef(m[1]) : null;
  if (!ref) return "/";
  if (ref.kind === "crm") return `/clientes/${ref.id}`;
  if (ref.kind === "emp") return "/rh";
  if (ref.kind === "tel") return `/clientes?q=${encodeURIComponent(`+${ref.id}`)}`;
  return "/clientes";
}

// ─── 39e: o número da chamada ───────────────────────────────────────────────

/** A nota que fica no registo de cada pesquisa da consola (e de onde se tira o número da chamada). PURA. */
export function searchNote(phone: string, ref: string, name: string): string {
  return `pesquisa ${phone} → ${ref} ${name}`;
}

/**
 * O POST /Calls da consola só traz o contacto (`contact_id: "emp-1"`), sem o
 * número: o número é o da última pesquisa desta conta que deu esse contacto.
 * Lê o número de uma nota de `searchNote`; outra nota → null. PURA.
 */
export function phoneFromSearchNote(note: unknown, ref: string): string | null {
  const s = String(note ?? "");
  const head = "pesquisa ";
  const mid = ` → ${ref} `;
  if (!s.startsWith(head) || !parseContactRef(ref)) return null;
  const i = s.indexOf(mid, head.length);
  return i > head.length ? extractPhone(s.slice(head.length, i)) : null;
}
