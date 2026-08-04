// server/campaignReportIngest.ts
// Ingestão de relatórios diários de campanhas (Google Ads / Supermetrics) em
// campaign_daily_stats. Duas portas de entrada, MESMO motor:
//   1) Email diário para campanhas@multipark.pt com CSV anexo (emailInboundSync)
//   2) Upload/colagem manual de CSV histórico na página Marketing (2024→)
// Match de campanha por nome normalizado; desconhecidas são AUTO-CRIADAS
// (platform google_ads, sem projeto) para nunca perder dados — o Jorge atribui
// o projeto depois na página Marketing.

import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { campaigns, campaignDailyStats } from "../drizzle/schema";

export type CampaignCsvRow = {
  date: string; // YYYY-MM-DD
  campaign: string;
  spend: number;
  impressions?: number | null;
  clicks?: number | null;
  conversions?: number | null;
  conversionValue?: number | null;
};

const HEADER_SYNONYMS: Record<keyof Omit<CampaignCsvRow, "date" | "campaign">, string[]> = {
  spend: ["cost", "custo", "spend", "gasto", "amount", "investimento"],
  impressions: ["impressions", "impressoes", "impr"],
  clicks: ["clicks", "cliques"],
  conversions: ["conversions", "conversoes", "conv"],
  conversionValue: ["conversion value", "conv value", "valor de conversao", "valor conv", "all conv value", "valor"],
};
const DATE_HEADERS = ["date", "data", "dia", "day"];
const CAMPAIGN_HEADERS = ["campaign", "campanha", "campaign name", "nome da campanha"];

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function normHeader(s: string): string {
  return stripAccents(s).toLowerCase().replace(/[."']/g, "").replace(/\s+/g, " ").trim();
}

function parseNum(s: string | undefined): number | null {
  if (s == null) return null;
  const t = String(s).trim().replace(/[€$%\s]/g, "");
  if (!t || t === "--" || t === "-") return null;
  // "1.234,56" (PT) vs "1,234.56"/"1234.56" (EN)
  const norm = /,\d{1,2}$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : null;
}

function parseDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/); // DD/MM/YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function detectDelimiter(line: string): string {
  const counts: Array<[string, number]> = [
    ["\t", (line.match(/\t/g) || []).length],
    [";", (line.match(/;/g) || []).length],
    [",", (line.match(/,/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

function splitLine(line: string, delim: string): string[] {
  // split simples com suporte a aspas
  const out: string[] = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === delim && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Parser tolerante: encontra a linha de cabeçalho (Date+Campaign), mapeia
 *  colunas por sinónimos PT/EN e devolve as linhas válidas. */
export function parseCampaignCsv(text: string): { rows: CampaignCsvRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { rows: [], errors: ["CSV vazio"] };

  // Encontra o cabeçalho (Supermetrics/Google Ads às vezes têm linhas de título antes)
  let headerIdx = -1, delim = ",", cols: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const d = detectDelimiter(lines[i]);
    const cs = splitLine(lines[i], d).map(normHeader);
    if (cs.some((c) => DATE_HEADERS.includes(c)) && cs.some((c) => CAMPAIGN_HEADERS.includes(c))) {
      headerIdx = i; delim = d; cols = cs;
      break;
    }
  }
  if (headerIdx === -1) return { rows: [], errors: ["Cabeçalho não encontrado — o CSV precisa das colunas Date/Data e Campaign/Campanha"] };

  const idxOf = (names: string[]) => cols.findIndex((c) => names.includes(c));
  const dateIdx = idxOf(DATE_HEADERS);
  const campIdx = idxOf(CAMPAIGN_HEADERS);
  const fieldIdx: Record<string, number> = {};
  for (const [field, syns] of Object.entries(HEADER_SYNONYMS)) {
    fieldIdx[field] = cols.findIndex((c) => syns.includes(c));
  }
  if (fieldIdx.spend === -1) errors.push("Coluna de custo (Cost/Custo/Spend) não encontrada — gasto ficará 0");

  const rows: CampaignCsvRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const parts = splitLine(lines[i], delim);
    const date = parseDate(parts[dateIdx]);
    const campaign = (parts[campIdx] ?? "").trim();
    if (!date || !campaign) continue; // linhas de totais/rodapé
    rows.push({
      date,
      campaign,
      spend: fieldIdx.spend >= 0 ? (parseNum(parts[fieldIdx.spend]) ?? 0) : 0,
      impressions: fieldIdx.impressions >= 0 ? parseNum(parts[fieldIdx.impressions]) : null,
      clicks: fieldIdx.clicks >= 0 ? parseNum(parts[fieldIdx.clicks]) : null,
      conversions: fieldIdx.conversions >= 0 ? parseNum(parts[fieldIdx.conversions]) : null,
      conversionValue: fieldIdx.conversionValue >= 0 ? parseNum(parts[fieldIdx.conversionValue]) : null,
    });
  }
  if (rows.length === 0) errors.push("Nenhuma linha de dados válida (data + campanha) encontrada");
  return { rows, errors };
}

function normCampaignName(s: string): string {
  return stripAccents(s).toLowerCase().replace(/[-_|·]/g, " ").replace(/\s+/g, " ").trim();
}

export type IngestResult = {
  imported: number;      // linhas dia×campanha gravadas
  daysCovered: number;
  campaignsMatched: number;
  campaignsCreated: string[]; // campanhas auto-criadas (para o Jorge atribuir projeto)
  totalSpend: number;
  errors: string[];
};

/** Grava as linhas em campaign_daily_stats. Idempotente: substitui o que já
 *  existir para o mesmo (campanha, dia) — reimportar não duplica. */
export async function ingestCampaignDaily(rows: CampaignCsvRow[], importedById: number): Promise<IngestResult> {
  const res: IngestResult = { imported: 0, daysCovered: 0, campaignsMatched: 0, campaignsCreated: [], totalSpend: 0, errors: [] };
  const db = await getDb();
  if (!db) { res.errors.push("BD indisponível"); return res; }
  if (rows.length === 0) return res;

  const all = await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns);
  const byNorm = new Map<string, number>();
  for (const c of all) byNorm.set(normCampaignName(c.name), c.id);

  // Resolve/auto-cria campanhas
  const idByCsvName = new Map<string, number>();
  const uniqueNames = Array.from(new Set(rows.map((r) => r.campaign)));
  for (const name of uniqueNames) {
    const norm = normCampaignName(name);
    let id = byNorm.get(norm);
    if (!id) {
      // match por conter/estar contido (ex.: "Airpark - Lisboa - PT" vs "Airpark Lisboa")
      for (const [n, cid] of byNorm) {
        if (n.includes(norm) || norm.includes(n)) { id = cid; break; }
      }
    }
    if (!id) {
      const ins = await db.insert(campaigns).values({
        name: name.slice(0, 256),
        platform: "google_ads",
        campaignStatus: "active",
        createdById: importedById,
        notes: "auto-criada pelo import de relatório de campanhas",
      } as any);
      id = Number((ins as any)[0]?.insertId ?? 0);
      if (id) { byNorm.set(norm, id); res.campaignsCreated.push(name); }
    } else {
      res.campaignsMatched++;
    }
    if (id) idByCsvName.set(name, id);
  }

  // Substitui por (campanha, dia): apaga o range afetado por campanha e insere
  const byCampaign = new Map<number, CampaignCsvRow[]>();
  for (const r of rows) {
    const id = idByCsvName.get(r.campaign);
    if (!id) continue;
    if (!byCampaign.has(id)) byCampaign.set(id, []);
    byCampaign.get(id)!.push(r);
  }

  const days = new Set<string>();
  for (const [campaignId, list] of byCampaign) {
    const dates = Array.from(new Set(list.map((r) => r.date)));
    // apaga os dias que vamos regravar (idempotência)
    for (let i = 0; i < dates.length; i += 200) {
      const chunk = dates.slice(i, i + 200);
      await db.delete(campaignDailyStats).where(and(
        eq(campaignDailyStats.campaignId, campaignId),
        sql`DATE(${campaignDailyStats.date}) IN (${sql.raw(chunk.map((d) => `'${d}'`).join(","))})`,
      ));
    }
    // agrega por dia (o CSV pode ter uma linha por rede/dispositivo)
    const byDay = new Map<string, CampaignCsvRow>();
    for (const r of list) {
      const ex = byDay.get(r.date);
      if (!ex) byDay.set(r.date, { ...r });
      else {
        ex.spend += r.spend;
        ex.impressions = (ex.impressions ?? 0) + (r.impressions ?? 0);
        ex.clicks = (ex.clicks ?? 0) + (r.clicks ?? 0);
        ex.conversions = (ex.conversions ?? 0) + (r.conversions ?? 0);
        ex.conversionValue = (ex.conversionValue ?? 0) + (r.conversionValue ?? 0);
      }
    }
    for (const [date, r] of byDay) {
      await db.insert(campaignDailyStats).values({
        campaignId,
        date: `${date} 00:00:00`,
        spend: String(Math.round(r.spend * 100) / 100),
        impressions: r.impressions != null ? Math.round(r.impressions) : 0,
        clicks: r.clicks != null ? Math.round(r.clicks) : 0,
        conversions: r.conversions != null ? Math.round(r.conversions) : 0,
        conversionValue: r.conversionValue != null ? String(Math.round(r.conversionValue * 100) / 100) : "0",
        importedById,
      } as any);
      res.imported++;
      res.totalSpend += r.spend;
      days.add(date);
    }
  }
  res.daysCovered = days.size;
  res.totalSpend = Math.round(res.totalSpend * 100) / 100;
  return res;
}
