/**
 * Lote 40a — Xsi da One Net (Jorge, 7 out 2026: "O XSI está ativo. Como é
 * que tenho que configurar agora?"). Configuração (servidor, utilizador,
 * palavra-passe CIFRADA) e "Testar": lê o perfil, o diretório da empresa e
 * os registos de chamadas, guarda o que o Xsi respondeu (sem segredos) e
 * cruza o diretório com as fichas do RH. Só leitura no Xsi; nada é escrito
 * nas chamadas nem se liga a ninguém (40b/40c).
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { fetchWithTimeout } from "./_core/fetchWithTimeout";
import {
  XSI_ACTIONS_PATH, last9, xsiBodyKind, normalizeXsiBase, normalizeXsiUserId, parseXsiCallLogs, parseXsiDirectory, parseXsiProfile,
  type XsiCallLog, type XsiDirectoryEntry,
} from "../shared/centralXsi";

const rowsOf = (res: unknown): any[] => {
  const r = Array.isArray(res) ? res[0] : (res as any)?.rows ?? res;
  return Array.isArray(r) ? r : [];
};
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const XSI_TIMEOUT_MS = 10_000;
const MAX_BODY = 400_000;

export interface XsiConfigView { baseUrl: string | null; userId: string | null; readUserId: string | null; hasPassword: boolean; updatedAt: string | null }

async function readRow(): Promise<any | null> {
  const db = await getDb();
  if (!db) return null;
  return rowsOf(await db.execute(sql`SELECT baseUrl, userId, readUserId, passwordEnc, updatedAt, lastTestAt, lastTestOk, lastTestJson FROM central_xsi_config WHERE id = 1 LIMIT 1`).catch(() => [[]]))[0] ?? null;
}

/** O que o ecrã pode ver: nunca a palavra-passe (só se está guardada). */
export async function xsiConfigView(): Promise<XsiConfigView & { lastTestAt: string | null; lastTestOk: boolean | null; lastTest: unknown }> {
  const r = await readRow();
  let lastTest: unknown = null;
  try { lastTest = r?.lastTestJson ? JSON.parse(String(r.lastTestJson)) : null; } catch { lastTest = null; }
  const iso = (v: unknown) => (v ? `${String(v).replace(" ", "T").slice(0, 19)}Z` : null);
  return {
    baseUrl: r?.baseUrl ? String(r.baseUrl) : null, userId: r?.userId ? String(r.userId) : null, readUserId: r?.readUserId ? String(r.readUserId) : null,
    hasPassword: !!r?.passwordEnc, updatedAt: iso(r?.updatedAt), lastTestAt: iso(r?.lastTestAt),
    lastTestOk: r?.lastTestOk == null ? null : Number(r.lastTestOk) === 1, lastTest,
  };
}

/** Guarda a configuração; palavra-passe vazia mantém a que está. Devolve o erro em português, se houver. */
export async function saveXsiConfig(input: { baseUrl: string; userId: string; readUserId?: string | null; password?: string | null }, byUserId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const baseUrl = normalizeXsiBase(input.baseUrl);
  if (!baseUrl) return { ok: false, error: "Servidor Xsi: tem de ser um endereço https (ex.: https://xsi.exemplo.pt), sem utilizador nem palavra-passe no endereço." };
  const userId = normalizeXsiUserId(input.userId);
  if (!userId) return { ok: false, error: "Utilizador: 3 a 120 caracteres, sem espaços (ex.: 351210000000@dominio)." };
  const readRaw = String(input.readUserId ?? "").trim();
  const readUserId = readRaw ? normalizeXsiUserId(readRaw) : null;
  if (readRaw && !readUserId) return { ok: false, error: "Utilizador a ler: 3 a 120 caracteres, sem espaços." };
  const db = await getDb();
  if (!db) return { ok: false, error: "Base de dados indisponível." };
  const pass = String(input.password ?? "");
  let passwordEnc: string | null = null;
  if (pass) {
    if (pass.length > 200) return { ok: false, error: "Palavra-passe demasiado comprida." };
    const { encryptSecret } = await import("./integrations/googleAds/crypto");
    passwordEnc = encryptSecret(pass);
  }
  const now = utc(Date.now());
  if (passwordEnc) {
    await db.execute(sql`INSERT INTO central_xsi_config (id, baseUrl, userId, readUserId, passwordEnc, updatedById, updatedAt)
        VALUES (1, ${baseUrl}, ${userId}, ${readUserId}, ${passwordEnc}, ${byUserId}, ${now})
        ON DUPLICATE KEY UPDATE baseUrl = VALUES(baseUrl), userId = VALUES(userId), readUserId = VALUES(readUserId), passwordEnc = VALUES(passwordEnc), updatedById = VALUES(updatedById), updatedAt = VALUES(updatedAt)`);
  } else {
    await db.execute(sql`INSERT INTO central_xsi_config (id, baseUrl, userId, readUserId, updatedById, updatedAt)
        VALUES (1, ${baseUrl}, ${userId}, ${readUserId}, ${byUserId}, ${now})
        ON DUPLICATE KEY UPDATE baseUrl = VALUES(baseUrl), userId = VALUES(userId), readUserId = VALUES(readUserId), updatedById = VALUES(updatedById), updatedAt = VALUES(updatedAt)`);
  }
  return { ok: true };
}

interface XsiCreds { baseUrl: string; userId: string; readUserId: string; password: string }
async function loadCreds(): Promise<XsiCreds | { error: string }> {
  const r = await readRow();
  if (!r?.baseUrl || !r?.userId) return { error: "Falta configurar o servidor e o utilizador do Xsi." };
  if (!r.passwordEnc) return { error: "Falta a palavra-passe do Xsi." };
  try {
    const { decryptSecret } = await import("./integrations/googleAds/crypto");
    const password = decryptSecret(String(r.passwordEnc));
    return { baseUrl: String(r.baseUrl), userId: String(r.userId), readUserId: String(r.readUserId || r.userId), password };
  } catch {
    return { error: "Não deu para abrir a palavra-passe guardada (a chave de cifra mudou?). Volta a escrevê-la e guarda." };
  }
}

/** Explicação em português para cada estado HTTP do Xsi. PURA. */
export function xsiStatusNote(status: number, error?: string | null): string {
  if (status === 0) return `não chegou ao servidor${error ? ` (${error})` : ""} — endereço errado, firewall, ou o IP da dashboard não está autorizado na Vodafone`;
  if (status === 401) return "utilizador ou palavra-passe errados (401)";
  if (status === 403) return "sem permissão (403) — o utilizador não pode ler isto, ou o IP da dashboard não está autorizado";
  if (status === 404) return "não existe (404) — utilizador ou serviço que este utilizador não tem";
  if (status >= 200 && status < 300) return `ok (${status})`;
  return `resposta ${status}`;
}

interface XsiResult { status: number; body: string; ms: number; error: string | null }

/** 40a.1: só conta como resposta do Xsi um 2xx com XML (a página do escudo anti-robôs também vem com 200). */
export function xsiResultOk(r: { status: number; body: string }): boolean {
  return r.status >= 200 && r.status < 300 && xsiBodyKind(r.body) === "xml";
}
/** Explicação do resultado, incluindo "200 mas página web" (escudo anti-robôs ou endereço que não é o Xsi). PURA. */
export function xsiResultNote(r: { status: number; body: string; error: string | null }): string {
  if (r.status >= 200 && r.status < 300) {
    const k = xsiBodyKind(r.body);
    if (k === "shield") return `barrado pela proteção anti-robôs da Vodafone (${r.status} com página de verificação) — a Vodafone tem de autorizar o servidor da dashboard`;
    if (k === "html") return `respondeu com uma página web (${r.status}), não com o Xsi — endereço errado ou caminho diferente`;
    if (k === "empty") return `resposta vazia (${r.status})`;
    if (k === "other") return `resposta que não é XML (${r.status})`;
  }
  return xsiStatusNote(r.status, r.error);
}

/** Um pedido ao Xsi com autenticação básica; fica no registo da central (sem a palavra-passe). */
async function xsiGet(c: XsiCreds, path: string, label: string): Promise<XsiResult> {
  const url = `${c.baseUrl}${XSI_ACTIONS_PATH}${path}`;
  const t0 = Date.now();
  let res: XsiResult;
  try {
    const r = await fetchWithTimeout(url, {
      method: "GET", redirect: "error", timeoutMs: XSI_TIMEOUT_MS,
      headers: { Authorization: `Basic ${Buffer.from(`${c.userId}:${c.password}`).toString("base64")}`, Accept: "application/xml" },
    });
    const text = (await r.text()).slice(0, MAX_BODY);
    res = { status: r.status, body: text, ms: Date.now() - t0, error: null };
  } catch (e: any) {
    res = { status: 0, body: "", ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 160) };
  }
  try {
    const db = await getDb();
    await db?.execute(sql`INSERT INTO central_requests (at, method, path, status, accountId, note, bodyJson)
        VALUES (${utc(Date.now())}, ${"XSI GET"}, ${`${XSI_ACTIONS_PATH}${path}`.slice(0, 255)}, ${res.status}, ${null},
                ${`Xsi · ${label} · ${xsiResultNote(res)} · ${res.ms} ms`.slice(0, 255)},
                ${JSON.stringify({ response: res.body.slice(0, 4000) || null, error: res.error })})`);
  } catch { /* o registo nunca trava o teste */ }
  return res;
}

export interface XsiDirectoryMatch extends XsiDirectoryEntry { employeeId: number | null; employeeName: string | null; dashboardUserId: number | null; matchedBy: "número" | "telemóvel" | null }

/** Diretório da One Net × fichas do RH ativas, pelos últimos 9 dígitos (número fixo ou telemóvel). */
async function matchDirectory(entries: XsiDirectoryEntry[]): Promise<XsiDirectoryMatch[]> {
  const db = await getDb();
  const emps = db ? rowsOf(await db.execute(sql`SELECT id, fullName, userId, phone, personalPhone FROM employees WHERE isActive = 1`).catch(() => [[]])) : [];
  const byTail = new Map<string, any>();
  for (const e of emps) for (const p of [e.phone, e.personalPhone]) { const k = last9(p); if (k && !byTail.has(k)) byTail.set(k, e); }
  return entries.map((d) => {
    const viaMobile = last9(d.mobile) ? byTail.get(last9(d.mobile)!) : null;
    const viaNumber = last9(d.number) ? byTail.get(last9(d.number)!) : null;
    const e = viaMobile ?? viaNumber ?? null;
    return {
      ...d, employeeId: e ? Number(e.id) : null, employeeName: e ? String(e.fullName) : null,
      dashboardUserId: e?.userId ? Number(e.userId) : null, matchedBy: viaMobile ? "telemóvel" : viaNumber ? "número" : null,
    };
  });
}

export interface XsiTestStep { step: string; status: number; ok: boolean; note: string; ms: number }
export interface XsiTestResult {
  ok: boolean; at: string; steps: XsiTestStep[]; error: string | null;
  profile: ReturnType<typeof parseXsiProfile> | null;
  directory: { total: number | null; count: number; matched: number; entries: XsiDirectoryMatch[] } | null;
  callLogs: { count: number; sample: XsiCallLog[] } | null;
  enhancedCallLogs: boolean | null;
}

/** "Testar": perfil → diretório da empresa, registos de chamadas e registos completos (com durações). */
export async function testXsi(): Promise<XsiTestResult> {
  const at = new Date().toISOString();
  const empty: XsiTestResult = { ok: false, at, steps: [], error: null, profile: null, directory: null, callLogs: null, enhancedCallLogs: null };
  const c = await loadCreds();
  if ("error" in c) return { ...empty, error: c.error };
  const u = `/user/${encodeURIComponent(c.readUserId)}`;
  const step = (name: string, r: XsiResult): XsiTestStep => ({ step: name, status: r.status, ok: xsiResultOk(r), note: xsiResultNote(r), ms: r.ms });
  const prof = await xsiGet(c, `${u}/profile`, "perfil");
  const steps = [step("Perfil do utilizador", prof)];
  if (!steps[0].ok) {
    // administrador sem "Utilizador a ler": o administrador não é um utilizador, o perfil dá 404
    const hint = prof.status === 404 && c.readUserId === c.userId ? " Se o acesso é de administrador, põe em \"Utilizador a ler\" o teu utilizador One Net e volta a testar." : "";
    return finish({ ...empty, steps, error: `O Xsi não aceitou: ${steps[0].note}.${hint}` });
  }
  const [dir0, logs, enh] = await Promise.all([
    xsiGet(c, `${u}/directories/Enterprise?start=1&results=1000`, "diretório da empresa"),
    xsiGet(c, `${u}/directories/CallLogs`, "registos de chamadas"),
    xsiGet(c, `${u}/directories/EnhancedCallLogs?callLogType=placed&start=1&results=5`, "registos completos"),
  ]);
  // alguns servidores recusam os parâmetros de paginação: tenta sem eles
  const dir = dir0.status === 400 ? await xsiGet(c, `${u}/directories/Enterprise`, "diretório da empresa (sem paginação)") : dir0;
  steps.push(step("Diretório da empresa", dir), step("Registos de chamadas", logs), step("Registos completos (com durações)", enh));
  const parsedDir = xsiResultOk(dir) ? parseXsiDirectory(dir.body) : null;
  const entries = parsedDir ? await matchDirectory(parsedDir.entries) : [];
  const parsedLogs = xsiResultOk(logs) ? parseXsiCallLogs(logs.body) : null;
  return finish({
    ok: true, at, steps, error: null, profile: parseXsiProfile(prof.body),
    directory: parsedDir ? { total: parsedDir.total, count: entries.length, matched: entries.filter((e) => e.employeeId != null).length, entries } : null,
    callLogs: parsedLogs ? { count: parsedLogs.length, sample: parsedLogs.slice(0, 10) } : null,
    enhancedCallLogs: xsiResultOk(enh) ? true : enh.status === 404 || enh.status === 403 ? false : null,
  });
}

async function finish(r: XsiTestResult): Promise<XsiTestResult> {
  try {
    const db = await getDb();
    const json = JSON.stringify(r);
    await db?.execute(sql`UPDATE central_xsi_config SET lastTestAt = ${utc(Date.now())}, lastTestOk = ${r.ok ? 1 : 0}, lastTestJson = ${json.length > 2_000_000 ? JSON.stringify({ ...r, directory: r.directory ? { ...r.directory, entries: r.directory.entries.slice(0, 500) } : null }) : json} WHERE id = 1`);
  } catch { /* o resultado volta na mesma ao ecrã */ }
  return r;
}
