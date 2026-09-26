/**
 * DOCX → texto sem dependências novas: um .docx é um ZIP; lê-se o diretório
 * central, descomprime-se `word/document.xml` com o zlib do Node (deflate
 * "raw") e tiram-se os parágrafos (<w:p>) e o texto (<w:t>). Chega para
 * manuais (títulos, listas e tabelas viram linhas de texto).
 *
 * Usado quando o Drive não está configurado (com o Shared Drive, o ficheiro é
 * convertido em Google Doc e exportado em texto — melhor fidelidade).
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** Teto do XML descomprimido (proteção contra "zip bombs"). */
const MAX_XML_BYTES = 30 * 1024 * 1024;

/** Conteúdo (descomprimido) de uma entrada do ZIP, ou null. PURA. */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  if (zip.length < 22) return null;
  // Fim do diretório central: procura para trás (comentário até 64 KB).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== CEN_SIG) return null;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const entryName = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (entryName === name) {
      if (localOff + 30 > zip.length || zip.readUInt32LE(localOff) !== LOC_SIG) return null;
      const start = localOff + 30 + zip.readUInt16LE(localOff + 26) + zip.readUInt16LE(localOff + 28);
      const data = zip.subarray(start, start + compSize);
      if (size > MAX_XML_BYTES) return null;
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e] ?? "";
  });
}

/** XML do corpo de um documento Word → texto (um parágrafo por linha). PURA. */
export function wordXmlToText(xml: string): string {
  const out: string[] = [];
  for (const p of xml.split(/<\/w:p>/)) {
    const isHeading = /<w:pStyle w:val="(Heading|Ttulo|Titulo|Title)\d*"/i.test(p);
    const text = p
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>/g, "\n")
      .match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|\t|\n/g)
      ?.map((t) => (t === "\t" || t === "\n" ? t : decodeXml(t.replace(/<[^>]+>/g, ""))))
      .join("") ?? "";
    const line = text.replace(/[ \t]+$/g, "");
    if (!line.trim()) { out.push(""); continue; }
    out.push(isHeading ? `# ${line.trim()}` : line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** .docx → texto; null se não for um DOCX legível. PURA. */
export function docxToText(buf: Buffer): string | null {
  try {
    const xml = readZipEntry(buf, "word/document.xml");
    return xml ? wordXmlToText(xml.toString("utf8")) : null;
  } catch {
    return null;
  }
}
