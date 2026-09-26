/**
 * Base de conhecimento (pedido do dono, set 2026) — regras PARTILHADAS
 * servidor ↔ cliente: configuração (pastas do Shared Drive), visibilidade de
 * cada documento (todos / papéis / cidades), estados e rótulos.
 *
 * Fontes: (a) pastas do Shared Drive "Multipark" sincronizadas pela conta de
 * serviço com delegação; (b) ficheiros carregados na app (PDF, DOCX, TXT/MD);
 * (c) a ajuda da app (docs/ajuda, já no bundle).
 *
 * Visibilidade: um documento sem papéis nem cidades é de TODOS; com papéis,
 * só quem tem um desses papéis; com cidades, só quem tem acesso a uma dessas
 * cidades (quem vê todas as cidades vê tudo). A recuperação filtra SEMPRE por
 * isto antes de qualquer trecho ir para um prompt.
 */
import { z } from "zod";
import { ROLES, type Role } from "./access";

export const KB_SOURCES = ["drive", "upload", "help"] as const;
export type KbSource = (typeof KB_SOURCES)[number];
export const KB_SOURCE_LABELS: Record<KbSource, string> = { drive: "Google Drive", upload: "Carregado", help: "Ajuda da app" };

export const KB_STATUSES = ["pending", "processing", "synced", "error", "skipped"] as const;
export type KbStatus = (typeof KB_STATUSES)[number];
export const KB_STATUS_LABELS: Record<KbStatus, string> = {
  pending: "Por processar",
  processing: "A processar",
  synced: "Sincronizado",
  error: "Erro",
  skipped: "Ignorado",
};

export const KB_CITIES = ["Lisboa", "Porto", "Faro"] as const;
export type KbCity = (typeof KB_CITIES)[number];

/** Máximo de um ficheiro carregado (o tRPC leva base64; o Vercel corta ~4,5 MB). */
export const KB_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** Tipos aceites no carregamento manual. */
export const KB_UPLOAD_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
} as const;
export const KB_UPLOAD_ACCEPT = ".pdf,.docx,.txt,.md";

export const kbVisibilitySchema = z.object({
  /** Papéis que veem (vazio = todos os papéis). */
  roles: z.array(z.enum(ROLES)).max(ROLES.length).default([]),
  /** Cidades (vazio = todas). */
  cities: z.array(z.enum(KB_CITIES)).max(KB_CITIES.length).default([]),
});
export type KbVisibility = z.infer<typeof kbVisibilitySchema>;
export const KB_VISIBILITY_ALL: KbVisibility = { roles: [], cities: [] };

export const kbFolderSchema = z.object({
  /** Caminho a partir da raiz do Shared Drive, ex.: "Formação" ou "Procedimentos/Porto". */
  path: z.string().trim().min(1, "Indica a pasta.").max(200).regex(/^[^\\]+$/, "Usa / para separar pastas."),
  visibility: kbVisibilitySchema.default(KB_VISIBILITY_ALL),
});
export type KbFolder = z.infer<typeof kbFolderSchema>;

export const knowledgeConfigSchema = z.object({
  /** Sincronizar as pastas do Shared Drive (cron knowledge-sync). */
  driveEnabled: z.boolean().default(false),
  folders: z.array(kbFolderSchema).max(20).default([{ path: "Formação", visibility: KB_VISIBILITY_ALL }, { path: "Procedimentos", visibility: KB_VISIBILITY_ALL }]),
  /** Índice por embeddings (se a IA estiver ligada); desligado = só palavras-chave. */
  embeddings: z.boolean().default(true),
  /** O assistente e o tutor usam a base de conhecimento. */
  useInAssistant: z.boolean().default(true),
  useInTutor: z.boolean().default(true),
});
export type KnowledgeConfig = z.infer<typeof knowledgeConfigSchema>;
export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = knowledgeConfigSchema.parse({});
export const KNOWLEDGE_SETTING_KEY = "knowledge.config" as const;

export function parseKnowledgeConfig(raw: unknown): KnowledgeConfig {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = {}; } }
  const r = knowledgeConfigSchema.safeParse(v && typeof v === "object" ? v : {});
  return r.success ? r.data : DEFAULT_KNOWLEDGE_CONFIG;
}

/** Lista guardada na BD (JSON) → valores válidos. PURA. */
export function parseVisibility(rolesRaw: unknown, citiesRaw: unknown): KbVisibility {
  const list = (raw: unknown): string[] => {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw !== "string" || !raw.trim()) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  };
  return {
    roles: list(rolesRaw).filter((r): r is Role => (ROLES as readonly string[]).includes(r)),
    cities: list(citiesRaw).filter((c): c is KbCity => (KB_CITIES as readonly string[]).includes(c)),
  };
}

/** Quem pede (papel + cidades a que tem acesso). */
export interface KbViewer {
  role: string;
  /** true = vê todas as cidades. */
  allCities: boolean;
  cityNames: readonly string[];
}

const normCity = (s: string) => {
  const k = s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return k === "lisbon" ? "lisboa" : k === "oporto" ? "porto" : k;
};

/** Esta pessoa pode ver este documento? PURA (a mesma regra do SQL em kbVisibilitySql). */
export function canSeeKbDoc(v: KbVisibility, viewer: KbViewer): boolean {
  if (v.roles.length && !v.roles.includes(viewer.role as Role)) return false;
  if (v.cities.length && !viewer.allCities) {
    const mine = new Set(viewer.cityNames.map(normCity));
    if (!v.cities.some((c) => mine.has(normCity(c)))) return false;
  }
  return true;
}

/** Texto curto da visibilidade (lista e pré-visualização). PURA. */
export function visibilityLabel(v: KbVisibility, roleLabels: Record<string, string> = {}): string {
  if (!v.roles.length && !v.cities.length) return "Todos";
  const parts: string[] = [];
  if (v.roles.length) parts.push(v.roles.map((r) => roleLabels[r] ?? r).join(", "));
  if (v.cities.length) parts.push(v.cities.join(", "));
  return parts.join(" · ");
}

/** Ligação segura para abrir a fonte de uma citação (só Google Drive/Docs ou caminhos internos). PURA. */
export function safeCitationHref(href: string | null | undefined): string | null {
  const h = String(href ?? "").trim();
  if (!h) return null;
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  try {
    const u = new URL(h);
    return u.protocol === "https:" && /(^|\.)google\.com$/.test(u.hostname) ? u.toString() : null;
  } catch { return null; }
}

export interface KbCitation {
  /** Etiqueta usada no texto da resposta ([K1], [K2]…). */
  tag: string;
  docId: number;
  title: string;
  section: string | null;
  href: string | null;
}

/**
 * "Fontes:" no fim de uma resposta — só as citações que a resposta usou
 * ([K1]…, as etiquetas que o prompt pede). Sem etiquetas (a resposta não
 * veio dos manuais, ex.: "não encontrei") → a resposta tal e qual. PURA.
 */
export function appendCitations(answer: string, citations: readonly KbCitation[]): { text: string; used: KbCitation[] } {
  const text = String(answer ?? "").trim();
  if (!citations.length) return { text, used: [] };
  const tagged = citations.filter((c) => text.includes(`[${c.tag}]`));
  const used = tagged.filter(
    (c, i, arr) => arr.findIndex((x) => x.docId === c.docId && x.section === c.section) === i,
  );
  if (!used.length) return { text, used: [] };
  const lines = used.map((c) => {
    const label = c.section && c.section !== c.title ? `${c.title} — ${c.section}` : c.title;
    const href = safeCitationHref(c.href);
    return `- [${c.tag}] ${href ? `[${label}](${href})` : label}`;
  });
  return { text: `${text}\n\nFontes:\n${lines.join("\n")}`, used };
}
