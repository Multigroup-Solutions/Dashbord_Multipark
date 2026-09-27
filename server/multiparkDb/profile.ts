/**
 * Perfil da BD da Multipark — o que cada tabela/coluna guarda DE FACTO.
 * Corre na Vercel (DATABASE_URL_MULTIPARK). SÓ LÊ; não grava nada.
 *
 * Por tabela: n.º de linhas; por coluna: % preenchida, mín/máx (datas e
 * números), n.º de valores distintos; valores mais comuns SÓ de colunas de
 * categoria (enums, booleanos, textos com poucos valores repetidos) e nunca de
 * colunas com dados pessoais/segredos; chaves dos JSON; servidores dos URLs
 * (vídeos, assinaturas, anexos) e quantos vêm em base64.
 * À parte, catálogos de negócio (parques, parceiros com %, campanhas,
 * serviços, entregas, alocações, conexões, chaves de API, templates).
 *
 * Com orçamento de tempo: devolve `pendentes` quando não cabe tudo numa chamada
 * (o workflow chama de novo com ?tables=…).
 */
import { multiparkDbQuery } from "./client";

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Colunas cujos VALORES nunca saem (dados pessoais, texto livre, segredos). PURA. */
export function isSensitiveColumn(table: string, column: string): boolean {
  if (/(e)?mail|phone|firstname|lastname|fullname|nif|iban|bic|tax|address|plate|password|token|secret|hash|keyprefix|^ip$|lastusedip|ipwhitelist|useragent|requestedip|remarks|obs$|comment|content|body|message|subject|snippet|summary|draft|note|signature|^lat$|^lng$|birth|payload|quote|invoice|transactionid|paymentintent|chargeid|mitpaymentmethod|externalreference|idempotency|firebaseid|odooid|allocation$|^url$|originurl|video|attachment|logo|images|banner|certificate|terms|website|maplink|reference|clientname|sendername|authorname|username|agentname|drivername|byname|markedbyname|actordisplayname|actoremail|pendingemail|ownerEmail/i.test(column)) {
    // Excepções: nomes de catálogo (serviços, parques, campanhas…) não são pessoais.
    return !(column === "name" && CATALOG_NAME_TABLES.has(table));
  }
  if (column === "name" && !CATALOG_NAME_TABLES.has(table)) return true;
  if (column === "description" && !["ExtraService", "Campaign", "Allowance"].includes(table)) return true;
  if (column === "title" && !["Occurrence", "Procedures"].includes(table)) return true;
  return false;
}
const CATALOG_NAME_TABLES = new Set([
  "Park", "Partner", "Campaign", "ExtraService", "BookingExtraService", "CampaignExtraService", "DeliveryType",
  "CampaignDeliveryType", "Allocation", "Garage", "EmailTemplate", "ConnectionEndpoint", "ApiKey", "Allowance",
]);
const URLISH = /url|video|signature|attachment|logo|images|banner|certificate|terms|proof|maplink|website|invoice$/i;

interface Col { table: string; column: string; dataType: string; udt: string }

/** Tipo "lógico" de uma coluna para decidir o que medir. PURA. */
export function kindOf(c: Pick<Col, "dataType" | "udt">): "bool" | "num" | "time" | "text" | "enum" | "json" | "array" | "other" {
  const t = c.dataType.toLowerCase();
  if (t === "boolean") return "bool";
  if (/integer|numeric|double|real|bigint|smallint/.test(t)) return "num";
  if (/timestamp|date|time/.test(t)) return "time";
  if (t === "user-defined") return "enum";
  if (t === "jsonb" || t === "json") return "json";
  if (t === "array") return "array";
  if (/char|text/.test(t)) return "text";
  return "other";
}

const pct = (a: number, n: number) => (n ? Math.round((a / n) * 1000) / 10 : 0);

async function profileTable(table: string, cols: Col[]) {
  const T = q(table);
  // 1) Uma passagem: contagem, preenchimento, mín/máx, verdadeiros.
  const parts: string[] = ["count(*) AS n"];
  cols.forEach((c, i) => {
    const k = kindOf(c), C = q(c.column);
    parts.push(`count(${C}) AS f${i}`);
    if (k === "time" || k === "num") parts.push(`min(${C})::text AS mn${i}`, `max(${C})::text AS mx${i}`);
    if (k === "bool") parts.push(`count(*) FILTER (WHERE ${C}) AS t${i}`);
    if (k === "text") parts.push(`count(*) FILTER (WHERE ${C} = '') AS e${i}`);
  });
  const [base] = await multiparkDbQuery<any>(`SELECT ${parts.join(", ")} FROM ${T}`);
  const n = Number(base?.n ?? 0);
  const out: any = { linhas: n, colunas: {} as Record<string, any> };
  const distinctCols: number[] = [];
  cols.forEach((c, i) => {
    const k = kindOf(c), filled = Number(base[`f${i}`] ?? 0);
    const info: any = { tipo: c.udt || c.dataType, preenchida: pct(filled, n) };
    if (k === "time" || k === "num") { info.min = base[`mn${i}`] ?? null; info.max = base[`mx${i}`] ?? null; }
    if (k === "bool") info.verdadeiro = pct(Number(base[`t${i}`] ?? 0), n);
    if (k === "text" && Number(base[`e${i}`] ?? 0)) info.vazia = pct(Number(base[`e${i}`]), n);
    if (isSensitiveColumn(table, c.column)) info.valores = "(não mostrados: dados pessoais/texto livre)";
    out.colunas[c.column] = info;
    if ((k === "text" || k === "enum") && filled > 0) distinctCols.push(i);
  });
  if (!n) return out;

  // 2) Distintos (texto/enum) numa segunda passagem.
  if (distinctCols.length) {
    const d = await multiparkDbQuery<any>(`SELECT ${distinctCols.map((i) => `count(DISTINCT ${q(cols[i].column)}) AS d${i}`).join(", ")} FROM ${T}`);
    for (const i of distinctCols) out.colunas[cols[i].column].distintos = Number(d[0]?.[`d${i}`] ?? 0);
  }

  // 3) Valores de categoria, JSON, arrays e URLs.
  for (const c of cols) {
    const k = kindOf(c), C = q(c.column), info = out.colunas[c.column];
    if (!info.preenchida) continue;
    const sensitive = isSensitiveColumn(table, c.column);
    try {
      if (!sensitive && (k === "enum" || (k === "text" && info.distintos <= 40 && info.distintos * 3 <= n * info.preenchida / 100))) {
        const r = await multiparkDbQuery<any>(`SELECT ${C}::text AS v, count(*) AS c FROM ${T} WHERE ${C} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 40`);
        info.valores = Object.fromEntries(r.map((x) => [x.v === "" ? "(vazio)" : x.v, Number(x.c)]));
      } else if (!sensitive && k === "text" && ["BookingPricing.description", "BookingExtraService.name", "Occurrence.title", "Cancellation.cancellationType", "History.modifiedFields", "Billing.provider", "Billing.description"].includes(`${table}.${c.column}`)) {
        // Rótulos com muitas variantes: só os repetidos (≥ 5), nunca os únicos.
        const tok = c.column === "modifiedFields";
        const r = await multiparkDbQuery<any>(tok
          ? `SELECT btrim(t, ' "[]') AS v, count(*) AS c FROM (SELECT regexp_split_to_table(${C}, '[,;]') AS t FROM ${T} WHERE ${C} <> '') s GROUP BY 1 HAVING count(*) >= 5 ORDER BY 2 DESC LIMIT 80`
          : `SELECT ${C} AS v, count(*) AS c FROM ${T} WHERE ${C} IS NOT NULL GROUP BY 1 HAVING count(*) >= 5 ORDER BY 2 DESC LIMIT 60`);
        info.valoresRepetidos = Object.fromEntries(r.map((x) => [x.v === "" ? "(vazio)" : x.v, Number(x.c)]));
      }
      if (k === "json") {
        const r = await multiparkDbQuery<any>(`SELECT k, count(*) AS c FROM (SELECT jsonb_object_keys(${C}::jsonb) AS k FROM (SELECT ${C} FROM ${T} WHERE ${C} IS NOT NULL AND jsonb_typeof(${C}::jsonb) = 'object' LIMIT 20000) s0) s GROUP BY 1 ORDER BY 2 DESC LIMIT 80`);
        info.chavesJson = Object.fromEntries(r.map((x) => [x.k, Number(x.c)]));
        const t = await multiparkDbQuery<any>(`SELECT jsonb_typeof(${C}::jsonb) AS t, count(*) AS c FROM ${T} WHERE ${C} IS NOT NULL GROUP BY 1`);
        info.tiposJson = Object.fromEntries(t.map((x) => [x.t, Number(x.c)]));
      }
      if (k === "array" && !sensitive) {
        const r = await multiparkDbQuery<any>(`SELECT v::text AS v, count(*) AS c FROM (SELECT unnest(${C}) AS v FROM ${T}) s GROUP BY 1 ORDER BY 2 DESC LIMIT 40`);
        info.elementos = Object.fromEntries(r.map((x) => [x.v, Number(x.c)]));
      }
      if ((k === "text" || k === "array") && URLISH.test(c.column)) {
        const src = k === "array" ? `(SELECT unnest(${C}) AS u FROM ${T}) s` : `(SELECT ${C} AS u FROM ${T} WHERE ${C} IS NOT NULL) s`;
        const r = await multiparkDbQuery<any>(`SELECT CASE WHEN u ~ '^https?://' THEN substring(u from '^https?://([^/]+)')
            WHEN u LIKE 'data:%' THEN 'base64 (' || split_part(substring(u from 6), ';', 1) || ')'
            WHEN u = '' THEN '(vazio)' ELSE 'outro (' || length(u)::text || ' chars)' END AS h, count(*) AS c
          FROM ${src} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
        info.origens = Object.fromEntries(r.map((x) => [x.h, Number(x.c)]));
      }
    } catch (err: any) {
      info.erro = String(err?.message ?? err).slice(0, 160);
    }
  }
  return out;
}

/** Catálogos de negócio (tabelas pequenas, sem dados pessoais). */
async function catalogs() {
  const run = async (sqlText: string) => { try { return await multiparkDbQuery<any>(sqlText); } catch (e: any) { return [{ erro: String(e?.message ?? e).slice(0, 160) }]; } };
  return {
    parques: await run(`SELECT p."id", p."name", p."city", p."status"::text AS status, p."listingType"::text AS "listingType", p."types"::text[] AS types,
        p."totalSpots", p."backofficeViewType"::text AS "viewType", p."paymentMethods", p."paymentMethodsOnCheckout", p."occurrenceTypes", p."cancellationTypes",
        p."checkinRequireVideo", p."checkinRequireSignature", p."checkoutRequireSignature", p."checkinRequireVehicleKms", p."requireLocationForBookingActions",
        p."syncToFirebase", p."firebaseBrand", p."autoEmitInvoices", p."timezone",
        (SELECT count(*) FROM "Booking" b WHERE b."parkId" = p."id") AS reservas,
        (SELECT max(b."createdAt")::text FROM "Booking" b WHERE b."parkId" = p."id") AS "ultimaReserva"
      FROM "Park" p ORDER BY reservas DESC`),
    parceiros: await run(`SELECT pa."name", pk."name" AS parque, pa."partnerType"::text AS tipo, pa."feeType"::text AS "feeType", pa."feePercentage", pa."feeFixedValue", pa."isActive",
        (SELECT count(*) FROM "Booking" b WHERE b."partnerId" = pa."id") AS reservas
      FROM "Partner" pa LEFT JOIN "Park" pk ON pk."id" = pa."parkId" ORDER BY reservas DESC LIMIT 500`),
    campanhas: await run(`SELECT c."name", pk."name" AS parque, c."status"::text AS status, c."accessType"::text AS acesso, c."discountType"::text AS "discountType", c."discountValue",
        c."discountCode", c."bookingCount", c."revenue", c."currentUses", c."maxUses", c."startDate"::text AS inicio, c."endDate"::text AS fim
      FROM "Campaign" c LEFT JOIN "Park" pk ON pk."id" = c."parkId" ORDER BY c."bookingCount" DESC`),
    servicosExtra: await run(`SELECT s."name", pk."name" AS parque, s."price", s."vehiclePrices" FROM "ExtraService" s LEFT JOIN "Park" pk ON pk."id" = s."parkId" ORDER BY pk."name", s."sortOrder"`),
    taxasExtra: await run(`SELECT f."name"::text AS nome, pk."name" AS parque, f."price" FROM "ExtraFee" f LEFT JOIN "Park" pk ON pk."id" = f."parkId"`),
    entregas: await run(`SELECT d."name", pk."name" AS parque, d."price", d."callBeforeMinutes", d."checkoutAt" FROM "DeliveryType" d LEFT JOIN "Park" pk ON pk."id" = d."parkId" ORDER BY pk."name", d."sortOrder"`),
    precos: await run(`SELECT pk."name" AS parque, pr."parkingType"::text AS lugar, pr."vehicleType"::text AS veiculo, pr."pricingType"::text AS unidade, pr."price" FROM "Pricing" pr LEFT JOIN "Park" pk ON pk."id" = pr."parkId" ORDER BY 1, 2, 3, 4`),
    alocacoes: await run(`SELECT a."name", pk."name" AS parque, a."parkingType"::text AS lugar, a."prefix", a."minAllocation", a."maxAllocation" FROM "Allocation" a LEFT JOIN "Park" pk ON pk."id" = a."parkId" ORDER BY 2, 1`),
    garagens: await run(`SELECT g."name", pk."name" AS parque, g."parkingType"::text AS lugar, g."totalSpots", (SELECT count(*) FROM "Spot" s WHERE s."garageId" = g."id") AS lugares FROM "Garage" g LEFT JOIN "Park" pk ON pk."id" = g."parkId"`),
    conexoes: await run(`SELECT e."name", pk."name" AS parque, e."provider"::text AS provider, e."direction"::text AS direcao, e."eventType"::text AS evento, e."enabled",
        substring(e."url" from '^https?://([^/]+)') AS servidor,
        (SELECT count(*) FROM "ConnectionDelivery" d WHERE d."endpointId" = e."id") AS envios,
        (SELECT count(*) FROM "ConnectionDelivery" d WHERE d."endpointId" = e."id" AND d."status" = 'DEAD') AS falhados
      FROM "ConnectionEndpoint" e LEFT JOIN "Park" pk ON pk."id" = e."parkId" ORDER BY envios DESC`),
    chavesApi: await run(`SELECT k."name", pk."name" AS parque, pa."name" AS parceiro, k."status"::text AS status, k."rateLimit", k."requestCount", k."lastUsedAt"::text AS "ultimoUso", k."expiresAt"::text AS expira
      FROM "ApiKey" k LEFT JOIN "Park" pk ON pk."id" = k."parkId" LEFT JOIN "Partner" pa ON pa."id" = k."partnerId" ORDER BY k."requestCount" DESC`),
    templatesEmail: await run(`SELECT t."name", pk."name" AS parque, t."type"::text AS tipo, t."language", t."active", length(t."content") AS tamanho FROM "EmailTemplate" t LEFT JOIN "Park" pk ON pk."id" = t."parkId" ORDER BY 2, 3`),
    origens: await run(`SELECT b."origin"::text AS origem, substring(b."originUrl" from '^https?://([^/?#]+[^?#]*)') AS link, count(*) AS reservas, max(b."createdAt")::text AS ultima
      FROM "Booking" b GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 150`),
    agregadores: await run(`SELECT source::text AS fonte, reason::text AS motivo, status::text AS estado, count(*) AS n FROM "AggregatorQuarantineItem" GROUP BY 1, 2, 3`),
  };
}

export interface ProfileOptions { tables?: string[]; budgetMs?: number; withCatalogs?: boolean }

export async function runMultiparkDbProfile(opts: ProfileOptions = {}) {
  const t0 = Date.now();
  const budget = Math.max(5_000, Math.min(50_000, opts.budgetMs ?? 45_000));
  const rows = await multiparkDbQuery<any>(`SELECT table_name AS t, column_name AS c, data_type AS d, udt_name AS u
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY table_name, ordinal_position`);
  const byTable = new Map<string, Col[]>();
  for (const r of rows) {
    const list = byTable.get(r.t) ?? [];
    list.push({ table: r.t, column: r.c, dataType: r.d, udt: r.u });
    byTable.set(r.t, list);
  }
  const wanted = opts.tables?.length ? opts.tables.filter((t) => byTable.has(t)) : [...byTable.keys()];
  const tabelas: Record<string, any> = {};
  const pendentes: string[] = [];
  for (const t of wanted) {
    if (Date.now() - t0 > budget) { pendentes.push(t); continue; }
    try { tabelas[t] = await profileTable(t, byTable.get(t)!); }
    catch (err: any) { tabelas[t] = { erro: String(err?.message ?? err).slice(0, 200) }; }
  }
  const catalogos = opts.withCatalogs && Date.now() - t0 < budget ? await catalogs() : null;
  return { ok: true, ranAt: new Date().toISOString(), ms: Date.now() - t0, tabelas, pendentes, catalogos };
}
