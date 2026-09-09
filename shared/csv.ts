/**
 * CSV seguro (cliente e servidor): aspas em valores com separador, aspas ou
 * quebras de linha; prefixo contra injeção de fórmulas (= + - @ | tab) que o
 * Excel/Sheets executariam.
 */
export function csvCell(v: unknown, sep = ";"): string {
  if (v == null) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(sep) || s.includes('"') || s.includes("\n") || s.includes("\r")) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine(cells: unknown[], sep = ";"): string {
  return cells.map((c) => csvCell(c, sep)).join(sep);
}

export function toCsv(headers: string[], rows: unknown[][], sep = ";"): string {
  return [csvLine(headers, sep), ...rows.map((r) => csvLine(r, sep))].join("\n");
}
