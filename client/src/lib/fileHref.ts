/**
 * URL abrível de um ficheiro do storage. `url` antiga pode ser RELATIVA
 * ("/uploads/...") — o Vercel não serve esse caminho (o rewrite manda tudo o
 * que não é /api para o index.html) e o ficheiro "não abre". Nesses casos
 * resolve-se pela key através do endpoint /api/file/<key>, que redireciona
 * para o storage (ou serve do disco no modo local).
 */
export function fileHref(
  url?: string | null,
  key?: string | null,
): string | null {
  if (url && /^https?:\/\//.test(url)) return url;
  if (key) return `/api/file/${encodeURI(key)}`;
  return url || null;
}
