/**
 * Migra o número 911 938 482 (bot Multis) para a WABA 910790285411664
 * (a mesma do 911 955 252), para partilhar cartão, templates `booking_*` e token.
 *
 * Passos (Meta, "migrate phone number between WABAs"):
 *   precheck      GET do número + números da WABA destino + apps subscritas
 *   start         POST /{WABA}/phone_numbers  cc, phone_number, migrate_phone_number=true  → NOVO_PHONE_ID
 *   request-code  POST /{NOVO_PHONE_ID}/request_code  code_method=SMS, language=pt_PT
 *   verify        POST /{NOVO_PHONE_ID}/verify_code   code=<SMS>
 *   register      POST /{NOVO_PHONE_ID}/register      messaging_product=whatsapp, pin=<WA_BOT_2FA_PIN>
 *   postcheck     números da WABA (os dois CONNECTED) + templates booking_* APPROVED
 *   all           tudo em sequência, interativo (pede o código SMS e, se faltar, o PIN)
 *
 * Uso:
 *   npx tsx scripts/wa-migrate-number.ts precheck
 *   npx tsx scripts/wa-migrate-number.ts start
 *   npx tsx scripts/wa-migrate-number.ts request-code --phone-id <NOVO_PHONE_ID>
 *   npx tsx scripts/wa-migrate-number.ts verify --phone-id <NOVO_PHONE_ID> [--code 123456]
 *   npx tsx scripts/wa-migrate-number.ts register --phone-id <NOVO_PHONE_ID>
 *   npx tsx scripts/wa-migrate-number.ts postcheck
 *   npx tsx scripts/wa-migrate-number.ts all
 *
 * Regras: o token e o PIN NUNCA são impressos; antes de cada POST corre um GET
 * de verificação; qualquer erro da Meta pára o script e mostra code / subcode /
 * message completos (exit 1). Sem contornos.
 *
 * Env (.env da dashboard): WHATSAPP_TOKEN (ou WA_TOKEN), WHATSAPP_API_VERSION
 * (default v25.0), WA_BOT_2FA_PIN (pedido no terminal se faltar).
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const DEST_WABA = "910790285411664";
const SOURCE_PHONE_ID = "1398713853332371";
const DASHBOARD_PHONE_ID = "1257688664090269";
const CC = "351";
const LOCAL_NUMBER = "911938482";
const BOOKING_TEMPLATES = [
  "booking_confirmation",
  "booking_confirmation_partner",
  "booking_payment_link",
  "booking_checkin",
  "booking_checkout",
  "booking_evaluation",
  "booking_evaluation_google",
  "booking_flight_info_request",
  "booking_invoice",
  "booking_extra_services",
  "booking_cancellation",
  "booking_credit_note",
  "booking_new_message",
] as const;
const LANGUAGES = ["pt_PT", "en", "es"] as const;

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1").trim();
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && v.trim()) out[k] = v.trim();
  return out;
}

const env = loadEnv();
const TOKEN = env.WA_TOKEN || env.WHATSAPP_TOKEN || "";
const VERSION = env.WHATSAPP_API_VERSION || "v25.0";
if (!TOKEN) {
  console.error("Falta WHATSAPP_TOKEN / WA_TOKEN no .env.");
  process.exit(1);
}

/** Paragem já explicada no terminal (exit 1, sem stack). */
class Stop extends Error {}

class MetaError extends Error {
  constructor(readonly step: string, readonly http: number, readonly body: unknown) {
    super(step);
  }
}

async function graph(step: string, method: "GET" | "POST", pathAndQuery: string, body?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://graph.facebook.com/${VERSION}/${pathAndQuery}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json && typeof json === "object" && "error" in json)) throw new MetaError(step, res.status, json);
  return json;
}

function printMetaError(error: MetaError): void {
  const e = (error.body as any)?.error ?? {};
  console.error(`\n✖ PASSO FALHOU: ${error.step} (HTTP ${error.http})`);
  console.error(`  code:     ${e.code ?? "-"}`);
  console.error(`  subcode:  ${e.error_subcode ?? "-"}`);
  console.error(`  type:     ${e.type ?? "-"}`);
  console.error(`  message:  ${e.message ?? "-"}`);
  if (e.error_user_title) console.error(`  title:    ${e.error_user_title}`);
  if (e.error_user_msg) console.error(`  user_msg: ${e.error_user_msg}`);
  if (e.error_data) console.error(`  data:     ${JSON.stringify(e.error_data)}`);
  console.error(`  trace:    ${e.fbtrace_id ?? "-"}`);
  console.error("  Script parado. Nada foi contornado.");
}

const NUMBER_FIELDS = "display_phone_number,verified_name,name_status,status,code_verification_status,platform_type";

async function showNumber(label: string, phoneId: string): Promise<any> {
  const n = await graph(`GET número ${phoneId}`, "GET", `${phoneId}?fields=${NUMBER_FIELDS}`);
  console.log(
    `  ${label}: ${n.display_phone_number} · ${n.verified_name} · name_status=${n.name_status} · status=${n.status} · ` +
      `verificação=${n.code_verification_status} · ${n.platform_type}`,
  );
  return n;
}

async function showWabaNumbers(): Promise<Array<{ id: string; display_phone_number: string; status: string; quality_rating?: string }>> {
  const r = await graph(`GET ${DEST_WABA}/phone_numbers`, "GET", `${DEST_WABA}/phone_numbers?fields=id,display_phone_number,status,quality_rating&limit=100`);
  const list = r.data ?? [];
  console.log(`  WABA ${DEST_WABA} tem ${list.length} número(s):`);
  for (const p of list) console.log(`    - ${p.id} ${p.display_phone_number} ${p.status}${p.quality_rating ? ` (${p.quality_rating})` : ""}`);
  return list;
}

/** O 911 938 482 já na WABA destino (id novo), ou null. */
async function findInDest(): Promise<{ id: string; status: string } | null> {
  const list = await showWabaNumbers();
  const hit = list.find((p) => p.display_phone_number.replace(/\D/g, "").endsWith(LOCAL_NUMBER));
  return hit ? { id: hit.id, status: hit.status } : null;
}

async function precheck(): Promise<string | null> {
  console.log("\n▶ 1. Pré-verificação");
  const already = await findInDest();
  const n = await showNumber(already ? "número (já na WABA destino)" : "número a migrar", already?.id ?? SOURCE_PHONE_ID);
  if (already) console.log(`  ℹ o ${LOCAL_NUMBER} JÁ está na WABA destino com o id ${already.id} — o passo start é dispensado`);
  const subs = await graph(`GET ${DEST_WABA}/subscribed_apps`, "GET", `${DEST_WABA}/subscribed_apps`);
  const apps = (subs.data ?? []).map((s: any) => `${s.whatsapp_business_api_data?.name} (${s.whatsapp_business_api_data?.id})`);
  console.log(`  apps subscritas na WABA destino: ${apps.join(", ") || "NENHUMA"}`);
  const problems: string[] = [];
  if (n.name_status !== "APPROVED") problems.push(`name_status = ${n.name_status} (tem de ser APPROVED)`);
  if (!apps.length) problems.push("nenhuma app subscrita na WABA destino");
  if (problems.length) {
    console.error(`\n✖ Pré-verificação falhou:\n  - ${problems.join("\n  - ")}\n  Script parado.`);
    throw new Stop();
  }
  console.log("  ✔ pré-verificação OK");
  return already?.id ?? null;
}

async function start(): Promise<string> {
  console.log("\n▶ 2. Iniciar migração");
  await showNumber("antes", SOURCE_PHONE_ID);
  await showWabaNumbers();
  const r = await graph("POST phone_numbers (migrate)", "POST", `${DEST_WABA}/phone_numbers`, {
    cc: CC,
    phone_number: LOCAL_NUMBER,
    migrate_phone_number: true,
  });
  const id = String(r.id ?? "");
  if (!id) {
    console.error(`✖ A Meta não devolveu id: ${JSON.stringify(r)}`);
    throw new Stop();
  }
  console.log(`  ✔ migração iniciada · NOVO_PHONE_ID = ${id}${id === SOURCE_PHONE_ID ? " (igual ao anterior)" : " (DIFERENTE do anterior)"}`);
  return id;
}

async function requestCode(phoneId: string): Promise<void> {
  console.log("\n▶ 3. Pedir código por SMS");
  await showNumber("estado", phoneId);
  const r = await graph("POST request_code", "POST", `${phoneId}/request_code`, { code_method: "SMS", language: "pt_PT" });
  console.log(`  ✔ código pedido (${JSON.stringify(r)}) — verifica o SMS no 911 938 482`);
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error(`✖ Sem terminal interativo para: ${question.trim()} — passa o valor por argumento.`);
    throw new Stop();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function verify(phoneId: string, code?: string): Promise<void> {
  console.log("\n▶ 5. Verificar código");
  await showNumber("estado", phoneId);
  const value = (code ?? (await ask("  Código SMS recebido: "))).replace(/\D/g, "");
  if (!value) {
    console.error("✖ Código vazio. Script parado.");
    throw new Stop();
  }
  const r = await graph("POST verify_code", "POST", `${phoneId}/verify_code`, { code: value });
  console.log(`  ✔ código aceite (${JSON.stringify(r)})`);
}

async function register(phoneId: string): Promise<void> {
  console.log("\n▶ 6. Registar na Cloud API");
  await showNumber("estado", phoneId);
  let pin = (env.WA_BOT_2FA_PIN ?? "").replace(/\D/g, "");
  if (!pin) pin = (await ask("  WA_BOT_2FA_PIN não está no .env — PIN de 6 dígitos (não é guardado nem mostrado): ")).replace(/\D/g, "");
  if (pin.length !== 6) {
    console.error("✖ O PIN tem de ter 6 dígitos. Script parado.");
    throw new Stop();
  }
  const r = await graph("POST register", "POST", `${phoneId}/register`, { messaging_product: "whatsapp", pin });
  console.log(`  ✔ registado (${JSON.stringify(r)}) — verificação em dois passos ligada com o PIN do .env`);
}

async function postcheck(newPhoneId?: string): Promise<void> {
  console.log("\n▶ 7. Pós-verificação");
  const list = await showWabaNumbers();
  const want = [DASHBOARD_PHONE_ID, ...(newPhoneId ? [newPhoneId] : [])];
  const bot = list.find((p) => p.display_phone_number.replace(/\D/g, "").endsWith(LOCAL_NUMBER));
  const missing = want.filter((id) => !list.some((p) => p.id === id && p.status === "CONNECTED"));
  if (!bot || bot.status !== "CONNECTED") missing.push(`${LOCAL_NUMBER} (CONNECTED)`);
  const t = await graph("GET message_templates", "GET", `${DEST_WABA}/message_templates?fields=name,language,status&limit=250`);
  const templates: Array<{ name: string; language: string; status: string }> = t.data ?? [];
  const notOk: string[] = [];
  for (const name of BOOKING_TEMPLATES)
    for (const lang of LANGUAGES) {
      const row = templates.find((x) => x.name === name && x.language === lang);
      if (!row || row.status !== "APPROVED") notOk.push(`${name}:${lang}=${row?.status ?? "AUSENTE"}`);
    }
  console.log(`  templates booking_*: ${BOOKING_TEMPLATES.length * LANGUAGES.length - notOk.length}/${BOOKING_TEMPLATES.length * LANGUAGES.length} APPROVED`);
  if (bot) console.log(`  NOVO_PHONE_ID do 911 938 482 nesta WABA: ${bot.id}`);
  if (missing.length || notOk.length) {
    if (missing.length) console.error(`  ✖ números em falta / não CONNECTED: ${missing.join(", ")}`);
    if (notOk.length) console.error(`  ✖ templates não aprovados: ${notOk.join(", ")}`);
    throw new Stop();
  }
  console.log("  ✔ pós-verificação OK");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function needPhoneId(): string {
  const id = arg("phone-id");
  if (!id) {
    console.error("✖ Falta --phone-id <NOVO_PHONE_ID> (devolvido pelo passo start).");
    throw new Stop();
  }
  return id;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  console.log(`Graph API ${VERSION} · WABA destino ${DEST_WABA}`);
  switch (cmd) {
    case "precheck":
      await precheck();
      return;
    case "start":
      await start();
      return;
    case "request-code":
      return requestCode(needPhoneId());
    case "verify":
      return verify(needPhoneId(), arg("code"));
    case "register":
      return register(needPhoneId());
    case "postcheck":
      return postcheck(arg("phone-id"));
    case "all": {
      const existing = await precheck();
      const id = existing ?? (await start());
      const state = await graph("GET estado", "GET", `${id}?fields=code_verification_status`);
      if (state.code_verification_status !== "VERIFIED") {
        await requestCode(id);
        console.log("\n▶ 4. À espera do código SMS");
        await verify(id);
      } else {
        console.log("\n▶ 3–5. Código já VERIFIED — SMS dispensado");
      }
      await register(id);
      await postcheck(id);
      console.log(`\n✔ Migração concluída · NOVO_PHONE_ID = ${id}`);
      return;
    }
    default:
      console.error("Uso: precheck | start | request-code --phone-id X | verify --phone-id X [--code N] | register --phone-id X | postcheck [--phone-id X] | all");
      throw new Stop();
  }
}

main().catch((error) => {
  if (error instanceof Stop) {
    // mensagem já impressa
  } else if (error instanceof MetaError) printMetaError(error);
  else console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
