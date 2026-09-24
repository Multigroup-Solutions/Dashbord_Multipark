/**
 * HTML dos emails → HTML seguro para mostrar (servidor, sanitize-html):
 *  - sem scripts, iframes, formulários, <style>/<link>, handlers on*;
 *  - estilos inline só com propriedades conhecidas e SEM url()/expression();
 *  - links abrem noutro separador (noopener noreferrer), só http/https/mailto/tel;
 *  - imagens REMOTAS bloqueadas por omissão (pixels de rastreio): ficam sem
 *    `src` até a pessoa carregar em "Mostrar imagens"; `cid:` (inline) só
 *    aparecem quando o servidor as resolve para data: URIs.
 * A UI mostra o resultado dentro de um iframe `sandbox` (sem scripts) —
 * duas camadas. PURA.
 */
import sanitizeHtml from "sanitize-html";

const SAFE_CSS = /^(?!.*(url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding)).*$/i;
const CSS_PROPS = [
  "color", "background-color", "font", "font-family", "font-size", "font-style", "font-weight", "line-height", "letter-spacing",
  "text-align", "text-decoration", "text-transform", "vertical-align", "white-space", "word-break", "direction",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-style", "border-width",
  "border-radius", "border-collapse", "border-spacing",
  "width", "max-width", "min-width", "height", "max-height", "min-height", "display", "float", "clear", "overflow", "list-style-type",
];
const ALLOWED_STYLES = { "*": Object.fromEntries(CSS_PROPS.map((p) => [p, [SAFE_CSS]])) };

export interface SanitizeOptions {
  /** Mostrar imagens remotas (http/https). */
  showImages?: boolean;
  /** cid → data: URI das imagens inline já resolvidas. */
  cidMap?: Record<string, string>;
}

export interface SanitizeResult { html: string; blockedImages: number; inlineImages: number }

export function sanitizeEmailHtml(dirty: string | null | undefined, opts: SanitizeOptions = {}): SanitizeResult {
  let blocked = 0;
  let inline = 0;
  const html = sanitizeHtml(String(dirty ?? ""), {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags, "img", "font", "center", "span", "div", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
      "colgroup", "col", "caption", "u", "s", "strike", "sub", "sup", "small", "big", "hr", "br",
    ],
    allowedAttributes: {
      "*": ["style", "align", "valign", "width", "height", "bgcolor", "dir", "title", "lang"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height", "data-blocked", "data-cid"],
      font: ["color", "face", "size"],
      table: ["border", "cellpadding", "cellspacing"],
      td: ["colspan", "rowspan", "nowrap"],
      th: ["colspan", "rowspan", "nowrap"],
      col: ["span"],
    },
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }),
      img: (tagName, attribs) => {
        const src = String(attribs.src ?? "").trim();
        const next: Record<string, string> = { ...attribs };
        if (/^cid:/i.test(src)) {
          const cid = src.slice(4).replace(/[<>]/g, "").trim();
          const data = opts.cidMap?.[cid];
          if (data) { next.src = data; inline++; }
          else { delete next.src; next["data-cid"] = cid; next["data-blocked"] = "1"; }
        } else if (/^https?:/i.test(src)) {
          if (!opts.showImages) { delete next.src; next["data-blocked"] = "1"; blocked++; }
        } else if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) {
          // imagem embebida: não pede nada à rede
        } else {
          delete next.src;
        }
        if (!next.alt) next.alt = next["data-blocked"] ? "[imagem bloqueada]" : "";
        return { tagName, attribs: next };
      },
    },
  });
  return { html, blockedImages: blocked, inlineImages: inline };
}

/** Versão guardada na BD: já sem scripts/handlers, mas com as imagens (a política aplica-se ao mostrar). PURA. */
export function sanitizeForStorage(dirty: string | null | undefined): string {
  return sanitizeEmailHtml(dirty, { showImages: true }).html.slice(0, 1_000_000);
}

/** Documento completo para o iframe sandbox (CSP sem scripts; imagens só se permitidas). PURA. */
export function wrapEmailDocument(body: string, opts: { showImages?: boolean } = {}): string {
  const img = opts.showImages ? "img-src https: http: data:;" : "img-src data:;";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img} style-src 'unsafe-inline'; font-src data:;"><base target="_blank"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.45;color:#111;margin:0;padding:12px;word-wrap:break-word}img{max-width:100%;height:auto}img[data-blocked]{display:inline-block;min-width:24px;min-height:16px;background:#eef2f7;border:1px dashed #b8c2d0}table{max-width:100%}blockquote{margin:0 0 0 .6em;padding-left:.6em;border-left:2px solid #d0d7e2;color:#555}</style></head><body>${body}</body></html>`;
}
