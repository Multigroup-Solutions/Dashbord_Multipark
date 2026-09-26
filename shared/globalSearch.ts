/**
 * Pesquisa global (Ctrl/Cmd+K) — regras PARTILHADAS servidor ↔ cliente:
 * grupos, leitura da pesquisa (código, matrícula, email, telefone), atalhos
 * de navegação (páginas/ações que a pessoa pode abrir), ordenação dos grupos
 * e pesquisas recentes. Tudo PURO.
 *
 * O servidor (server/globalSearch.ts) aplica, em CADA fonte, o mesmo acesso
 * (módulo + ação) e o mesmo âmbito de cidade da página correspondente.
 */
import { can, type Action, type ModuleId, type AccessOverrides } from "./access";

export const SEARCH_GROUPS = [
  "navegacao", "reservas", "contactos", "reclamacoes", "tarefas", "email", "whatsapp",
  "pessoas", "utilizadores", "parceiros", "conhecimento", "ajuda",
] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export const SEARCH_GROUP_LABELS: Record<SearchGroup, string> = {
  navegacao: "Páginas e ações",
  reservas: "Reservas",
  contactos: "Clientes e contactos",
  reclamacoes: "Reclamações",
  tarefas: "Tarefas",
  email: "Emails",
  whatsapp: "WhatsApp",
  pessoas: "Colaboradores",
  utilizadores: "Utilizadores",
  parceiros: "Parceiros",
  conhecimento: "Base de conhecimento",
  ajuda: "Ajuda",
};

/** Máximo de resultados por grupo na paleta. */
export const SEARCH_MAX_PER_GROUP = 5;
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 120;

export interface SearchItem {
  /** Chave estável (grupo:id). */
  key: string;
  group: SearchGroup;
  title: string;
  subtitle: string | null;
  /** Página interna a abrir (ou ligação https da Google para documentos do Drive). */
  href: string | null;
  /** Documento da base de conhecimento a abrir (ligação temporária pedida ao servidor). */
  kbDocId?: number;
  /** 0–100: correspondência exata > prefixo > contém. */
  score: number;
}

export interface SearchGroupResult {
  group: SearchGroup;
  label: string;
  items: SearchItem[];
  /** "Ver todos" — a página já filtrada pela pesquisa. */
  seeAllHref: string | null;
  /** A fonte não respondeu a tempo. */
  timedOut?: boolean;
}

// ─── Leitura da pesquisa ────────────────────────────────────────────────────

export interface ParsedSearch {
  raw: string;
  /** minúsculas, sem acentos, espaços simples */
  norm: string;
  /** LIKE "contém" escapado (minúsculas) */
  like: string;
  /** LIKE "começa por" escapado (tal como escrito, sem espaços nas pontas) */
  prefix: string;
  digits: string;
  isEmail: boolean;
  /** Matrícula PT (AA-00-00, 00AA00…) — normalizada sem hífens, maiúsculas. */
  plate: string | null;
  /** Parece um nº de reserva/código (letras+dígitos sem espaços, ≥ 4). */
  isCode: boolean;
  /** Parece um telefone (≥ 6 dígitos e quase só dígitos). */
  isPhone: boolean;
}

export function normalizeSearch(s: string): string {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const PLATE = /^(?:[A-Z]{2}\d{2}\d{2}|\d{2}[A-Z]{2}\d{2}|\d{2}\d{2}[A-Z]{2}|[A-Z]{2}\d{2}[A-Z]{2})$/;

export function parseSearch(input: string | null | undefined): ParsedSearch {
  const raw = String(input ?? "").trim().slice(0, SEARCH_MAX_CHARS);
  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D+/g, "").replace(/^00/, "");
  const compact = raw.toUpperCase().replace(/[\s-]+/g, "");
  return {
    raw,
    norm: normalizeSearch(raw),
    like: `%${escapeLike(lower)}%`,
    prefix: `${escapeLike(raw)}%`,
    digits,
    isEmail: /^[^\s@]+@[^\s@]+$/.test(raw),
    plate: PLATE.test(compact) ? compact : null,
    isCode: /^[A-Za-z0-9][A-Za-z0-9_-]{3,}$/.test(raw) && /\d/.test(raw),
    isPhone: digits.length >= 6 && raw.replace(/[\d\s+().-]/g, "").length === 0,
  };
}

/** "AA00BB" → "AA-00-BB" (formato com hífens). PURA. */
export function dashedPlate(plate: string): string {
  return plate.length === 6 ? `${plate.slice(0, 2)}-${plate.slice(2, 4)}-${plate.slice(4)}` : plate;
}

/**
 * Pontuação de um texto para a pesquisa: igual 100, começa por 70, uma
 * palavra começa por 50, contém 30, senão 0. PURA.
 */
export function matchScore(query: string, ...fields: Array<string | null | undefined>): number {
  const q = normalizeSearch(query);
  if (!q) return 0;
  let best = 0;
  for (const f of fields) {
    const t = normalizeSearch(f ?? "");
    if (!t) continue;
    if (t === q) return 100;
    if (t.startsWith(q)) best = Math.max(best, 70);
    else if (t.split(/[\s/@._-]+/).some((w) => w.startsWith(q))) best = Math.max(best, 50);
    else if (t.includes(q)) best = Math.max(best, 30);
  }
  return best;
}

// ─── Navegação (páginas e ações) ─────────────────────────────────────────────

export interface NavEntry {
  id: string;
  label: string;
  path: string;
  /** Visível se QUALQUER destes módulos tiver a ação (vazio = qualquer sessão). */
  modules: ModuleId[];
  action?: Action;
  keywords: string[];
  kind: "page" | "action";
}

export const NAV_ENTRIES: readonly NavEntry[] = [
  { id: "dashboard", label: "Dashboard", path: "/", modules: [], keywords: ["inicio", "home", "painel"], kind: "page" },
  { id: "operacoes", label: "Reservas & Operações", path: "/operacoes", modules: ["reservas_operacoes"], keywords: ["reservas", "operacoes", "recolhas", "entregas", "cancelados"], kind: "page" },
  { id: "reservas-hoje", label: "Reservas (lista)", path: "/operacoes?tab=reservas", modules: ["reservas_operacoes"], keywords: ["reservas", "lista de reservas"], kind: "page" },
  { id: "servicos", label: "Serviços", path: "/servicos", modules: ["servicos"], keywords: ["servicos", "lavagem", "extras"], kind: "page" },
  { id: "tarefas", label: "Tarefas", path: "/tarefas", modules: ["tarefas"], keywords: ["tarefas", "kanban", "checklist"], kind: "page" },
  { id: "nova-tarefa", label: "Nova tarefa", path: "/tarefas?new=1", modules: ["tarefas"], action: "edit", keywords: ["criar tarefa", "nova tarefa", "tarefa"], kind: "action" },
  { id: "extras-dia", label: "Extras Dia (escala de hoje)", path: "/extras-dia?dia=hoje", modules: ["extras_dia"], keywords: ["escala", "extras", "turnos", "hoje"], kind: "page" },
  { id: "escala-amanha", label: "Escala de amanhã", path: "/extras-dia?dia=amanha", modules: ["extras_dia"], keywords: ["escala de amanha", "amanha", "escala", "turnos amanha"], kind: "action" },
  { id: "passagem", label: "Passagem de Turno", path: "/passagem-turno", modules: ["passagem_turno"], keywords: ["passagem", "turno", "handover"], kind: "page" },
  { id: "disponibilidade", label: "Disponibilidade", path: "/disponibilidade", modules: ["disponibilidade", "disponibilidade_extras"], keywords: ["disponibilidade", "semana"], kind: "page" },
  { id: "whatsapp", label: "WhatsApp", path: "/whatsapp", modules: ["whatsapp"], keywords: ["whatsapp", "mensagens", "conversas"], kind: "page" },
  { id: "radio", label: "Rádio", path: "/radio", modules: ["radio"], keywords: ["radio", "zello"], kind: "page" },
  { id: "clientes", label: "Clientes", path: "/clientes", modules: ["clientes"], keywords: ["clientes", "crm"], kind: "page" },
  { id: "contactos", label: "Contactos", path: "/contactos", modules: ["contactos"], keywords: ["contactos", "telefone", "diretorio"], kind: "page" },
  { id: "reclamacoes", label: "Reclamações", path: "/reclamacoes", modules: ["reclamacoes"], keywords: ["reclamacoes", "queixas"], kind: "page" },
  { id: "nova-reclamacao", label: "Nova reclamação", path: "/reclamacoes?new=1", modules: ["reclamacoes"], action: "edit", keywords: ["nova reclamacao", "criar reclamacao", "reclamacao", "queixa"], kind: "action" },
  { id: "criticas", label: "Críticas Google", path: "/criticas", modules: ["criticas"], keywords: ["criticas", "reviews", "google"], kind: "page" },
  { id: "ocorrencias", label: "Ocorrências", path: "/ocorrencias", modules: ["ocorrencias"], keywords: ["ocorrencias", "danos", "incidentes"], kind: "page" },
  { id: "perdidos", label: "Perdidos e Achados", path: "/perdidos-achados", modules: ["perdidos"], keywords: ["perdidos", "achados", "objetos"], kind: "page" },
  { id: "comunicacao", label: "Caixas partilhadas (email)", path: "/comunicacao", modules: ["comunicacao"], keywords: ["email", "caixas", "comunicacao", "gmail"], kind: "page" },
  { id: "meu-email", label: "O meu email", path: "/comunicacao/meu-email", modules: ["ficha"], keywords: ["meu email", "gmail", "email"], kind: "page" },
  { id: "rh", label: "Recursos Humanos", path: "/rh", modules: ["rh", "ficha"], keywords: ["rh", "ficha", "recursos humanos", "ponto", "documentos"], kind: "page" },
  { id: "leads", label: "Leads de Extras", path: "/extras-leads", modules: ["leads_extras"], keywords: ["leads", "candidaturas", "recrutamento"], kind: "page" },
  { id: "formacao", label: "Formação", path: "/formacao", modules: ["formacao"], keywords: ["formacao", "manuais", "quiz", "tutor"], kind: "page" },
  { id: "conhecimento", label: "Base de conhecimento", path: "/formacao/conhecimento", modules: ["formacao"], action: "manage", keywords: ["base de conhecimento", "manuais", "procedimentos", "drive", "documentos"], kind: "page" },
  { id: "avaliacao", label: "Avaliação Individual", path: "/avaliacao", modules: ["avaliacao"], keywords: ["avaliacao", "pontuacao"], kind: "page" },
  { id: "despesas", label: "Despesas", path: "/despesas", modules: ["despesas"], keywords: ["despesas", "faturas", "recibos"], kind: "page" },
  { id: "parcerias", label: "Parcerias", path: "/parcerias", modules: ["parcerias"], keywords: ["parcerias", "parceiros", "agencias"], kind: "page" },
  { id: "faturacao", label: "Faturação", path: "/faturacao", modules: ["faturacao"], keywords: ["faturacao", "faturas"], kind: "page" },
  { id: "marketing", label: "Marketing", path: "/marketing", modules: ["marketing"], keywords: ["marketing", "anuncios", "google ads", "seo"], kind: "page" },
  { id: "dashboards", label: "Dashboards", path: "/dashboards", modules: ["dashboards"], keywords: ["dashboards", "graficos", "kpi"], kind: "page" },
  { id: "financeiro", label: "Financeiro", path: "/financeiro", modules: ["financeiro"], keywords: ["financeiro", "receita", "margem"], kind: "page" },
  { id: "utilizadores", label: "Utilizadores", path: "/utilizadores", modules: ["utilizadores"], keywords: ["utilizadores", "contas", "convites"], kind: "page" },
  { id: "permissoes", label: "Permissões", path: "/permissoes", modules: ["permissoes"], keywords: ["permissoes", "acessos"], kind: "page" },
  { id: "integracoes", label: "Integrações", path: "/integracoes", modules: ["integracoes"], keywords: ["integracoes", "google", "estado"], kind: "page" },
  { id: "definicoes", label: "Definições", path: "/definicoes", modules: ["definicoes"], keywords: ["definicoes", "configuracao", "automacoes", "ia"], kind: "page" },
  { id: "perfil", label: "O meu perfil", path: "/perfil", modules: [], keywords: ["perfil", "conta google", "foto"], kind: "page" },
];

type Subject = { role: string | null | undefined; accessOverrides?: AccessOverrides | null } | string | null | undefined;

/** Atalhos que a pessoa pode abrir e que batem na pesquisa (melhor primeiro). PURA. */
export function matchNavigation(query: string, user: Subject, max = SEARCH_MAX_PER_GROUP): SearchItem[] {
  const q = normalizeSearch(query);
  if (q.length < SEARCH_MIN_CHARS) return [];
  const out: SearchItem[] = [];
  for (const e of NAV_ENTRIES) {
    if (e.modules.length && !e.modules.some((m) => can(user as any, m, e.action ?? "view"))) continue;
    const score = Math.max(matchScore(q, e.label), ...e.keywords.map((k) => Math.max(0, matchScore(q, k) - 5)));
    if (score <= 0) continue;
    out.push({ key: `navegacao:${e.id}`, group: "navegacao", title: e.label, subtitle: e.kind === "action" ? "Ação" : "Página", href: e.path, score: score + (e.kind === "action" ? 1 : 0) });
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, max);
}

// ─── Ordenação e "ver todos" ─────────────────────────────────────────────────

/** Link "ver todos" de um grupo (a página com a pesquisa). PURA. */
export function seeAllHref(group: SearchGroup, query: string): string | null {
  const q = encodeURIComponent(String(query ?? "").trim());
  switch (group) {
    case "reservas": return `/operacoes?tab=reservas&q=${q}`;
    case "contactos": return `/contactos?q=${q}`;
    case "reclamacoes": return `/reclamacoes?q=${q}`;
    case "tarefas": return `/tarefas?q=${q}`;
    case "email": return `/comunicacao?q=${q}`;
    case "whatsapp": return `/whatsapp?q=${q}`;
    case "pessoas": return `/contactos?q=${q}&tab=pesquisa`;
    case "utilizadores": return `/utilizadores?q=${q}`;
    case "parceiros": return "/parcerias";
    case "conhecimento": return null;
    default: return null;
  }
}

/**
 * Grupos por ordem: primeiro os que têm uma correspondência exata (ex.: um nº
 * de reserva ou uma matrícula), depois pelo melhor resultado, e em empate pela
 * ordem fixa de SEARCH_GROUPS. Cada grupo ≤ max itens, melhor primeiro;
 * grupos vazios saem. PURA.
 */
export function rankGroups(groups: readonly SearchGroupResult[], max = SEARCH_MAX_PER_GROUP): SearchGroupResult[] {
  const order = (g: SearchGroup) => SEARCH_GROUPS.indexOf(g);
  return groups
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, max) }))
    .filter((g) => g.items.length > 0)
    .sort((a, b) => {
      const ea = a.items[0].score >= 100 ? 1 : 0;
      const eb = b.items[0].score >= 100 ? 1 : 0;
      if (ea !== eb) return eb - ea;
      // Navegação fica à frente quando é tão boa como o resto (atalhos rápidos).
      const sa = a.items[0].score + (a.group === "navegacao" ? 5 : 0);
      const sb = b.items[0].score + (b.group === "navegacao" ? 5 : 0);
      if (sa !== sb) return sb - sa;
      return order(a.group) - order(b.group);
    });
}

// ─── Pesquisas recentes (localStorage no cliente) ────────────────────────────

export const RECENT_SEARCHES_KEY = "mp.search.recent";
export const RECENT_SEARCHES_MAX = 8;

/** Junta uma pesquisa às recentes (sem repetidas, a mais recente primeiro). PURA. */
export function addRecentSearch(list: readonly string[], query: string, max = RECENT_SEARCHES_MAX): string[] {
  const q = String(query ?? "").trim().slice(0, SEARCH_MAX_CHARS);
  if (q.length < SEARCH_MIN_CHARS) return [...list].slice(0, max);
  const key = normalizeSearch(q);
  return [q, ...list.filter((x) => normalizeSearch(x) !== key)].slice(0, max);
}

export function parseRecentSearches(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length >= SEARCH_MIN_CHARS).slice(0, RECENT_SEARCHES_MAX) : [];
  } catch { return []; }
}
