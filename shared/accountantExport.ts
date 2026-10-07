/**
 * P3 lote 30b — Export para a contabilista (Jorge, 6 out 2026): "export
 * mensal só com as faturas e as datas, a pedido do utilizador".
 *
 * Um ZIP por mês, gerado quando alguém carrega no botão (nada é enviado
 * sozinho): os ficheiros das faturas do mês (data da fatura no mês, sem as
 * canceladas nem eliminadas) com nomes que se leem — data, fornecedor, nº do
 * documento, valor — e uma folha com as datas. O ZIP monta-se no browser, um
 * ficheiro de cada vez (as funções da Vercel não devolvem respostas grandes).
 *
 * PURO: igual no cliente e no servidor; o ZIP é "store" (sem compressão — os
 * PDFs e as fotos já vêm comprimidos), com nomes em UTF-8.
 */

/** Ficheiro maior do que isto não cabe numa resposta da Vercel (base64 +33 %): fica de fora com aviso. */
export const ACCOUNTANT_FILE_MAX_BYTES = 3_000_000;

/** "2026-09" → primeiro e último dia. PURA. */
export function monthDays(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Mês inválido (AAAA-MM).");
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

/** Mês anterior ao dia dado ("2026-10-06" → "2026-09"). PURA. */
export const previousMonthOf = (day: string): string => {
  const [y, m] = day.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};

const slug = (s: string | null | undefined, max: number) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

const EXT_BY_TYPE: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/gif": "gif", "application/xml": "xml", "text/xml": "xml" };

/** Extensão pela key/URL (sem query) ou pelo tipo; "bin" se não der. PURA. */
export function fileExtOf(keyOrUrl: string | null | undefined, contentType?: string | null): string {
  const path = String(keyOrUrl ?? "").split(/[?#]/)[0];
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(path);
  if (m) return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  return EXT_BY_TYPE[String(contentType ?? "").split(";")[0].trim().toLowerCase()] ?? "bin";
}

export interface AccountantExpense {
  id: number;
  expenseDate: string | null;
  paidAt: string | null;
  supplier: string | null;
  supplierNif: string | null;
  documentNumber: string | null;
  description: string | null;
  amount: number;
  fileKey: string | null;
  fileUrl: string | null;
  /** Nota de crédito (valor negativo) — vai com "NC_" no nome e "Nota de crédito" na folha. */
  creditNote?: boolean;
}

/** "2026-09-03_Google-Ireland-Limited_FT-2026-123_1100.00EUR_#7.pdf". PURA. */
export function accountantFileName(e: AccountantExpense): string {
  const day = String(e.expenseDate ?? "").slice(0, 10) || "sem-data";
  const who = slug(e.supplier, 40) || slug(e.description, 40) || "sem-fornecedor";
  const doc = slug(e.documentNumber, 30);
  return `${e.creditNote ? "NC_" : ""}${day}_${who}${doc ? `_${doc}` : ""}_${e.amount.toFixed(2)}EUR_#${e.id}.${fileExtOf(e.fileKey || e.fileUrl)}`;
}

const dmy = (s: string | null | undefined) => (s ? String(s).slice(0, 10).split("-").reverse().join("/") : "");

/**
 * Que ficheiros entram no ZIP e as linhas da folha (só as datas e o que
 * identifica a fatura). As despesas sem ficheiro ficam numa lista à parte. PURA.
 */
export function buildAccountantExport(rows: readonly AccountantExpense[]) {
  const sorted = [...rows].sort((a, b) => String(a.expenseDate ?? "").localeCompare(String(b.expenseDate ?? "")) || a.id - b.id);
  const withFile = sorted.filter((e) => e.fileKey || e.fileUrl);
  const files = withFile.map((e) => ({ id: e.id, name: `faturas/${accountantFileName(e)}` }));
  const sheet = withFile.map((e, i) => ({
    "Data da fatura": dmy(e.expenseDate),
    "Data de pagamento": dmy(e.paidAt),
    "Fornecedor": e.supplier ?? "",
    "NIF": e.supplierNif ?? "",
    "Nº documento": e.documentNumber ?? "",
    "Valor (€)": Math.round(e.amount * 100) / 100,
    "Ficheiro": files[i].name,
    "Tipo": e.creditNote ? "Nota de crédito" : "Fatura",
  }));
  const missing = sorted.filter((e) => !(e.fileKey || e.fileUrl)).map((e) => ({
    "Data": dmy(e.expenseDate),
    "Fornecedor": e.supplier ?? e.description ?? "",
    "Nº documento": e.documentNumber ?? "",
    "Valor (€)": Math.round(e.amount * 100) / 100,
    "ID": e.id,
    "Tipo": e.creditNote ? "Nota de crédito" : "Fatura",
  }));
  return { files, sheet, missing, total: Math.round(withFile.reduce((s, e) => s + e.amount, 0) * 100) / 100 };
}

// ─── ZIP (store, UTF-8) ─────────────────────────────────────────────────────

let CRC_TABLE: Uint32Array | null = null;
/** CRC-32 (IEEE) — o do ZIP. PURA. */
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Hora/data MS-DOS (a do ZIP) — em relógio de Lisboa não interessa: o ZIP não tem fuso. PURA. */
function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Junta os ficheiros num ZIP sem compressão (nomes em UTF-8). PURA. */
export function buildZip(files: ReadonlyArray<{ name: string; data: Uint8Array }>, when: Date = new Date()): Uint8Array {
  if (files.length > 65_000) throw new Error("Demasiados ficheiros para um ZIP.");
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(when);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.name)) throw new Error(`Nome repetido no ZIP: ${f.name}`);
    seen.add(f.name);
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, f.data);
    centrals.push(ch);
    offset += lh.length + size;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  const out = new Uint8Array(offset + cdSize + end.length);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, p); p += part.length; }
  return out;
}
