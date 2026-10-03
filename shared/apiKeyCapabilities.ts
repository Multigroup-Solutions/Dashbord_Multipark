/**
 * Capacidades das API keys (P3 lote 20a, decisão do Jorge: "por capacidade").
 *
 * Cada chave diz o que pode fazer; o servidor confere a capacidade em cada
 * rota da /api/v1 e da /api/external. Partilhado com o ecrã "API Keys" para os
 * nomes e a leitura das chaves antigas serem os mesmos dos dois lados.
 *
 * Chaves antigas (permissions read/write/admin/device ou vazio) continuam a
 * fazer exatamente o que faziam — são lidas como o conjunto de capacidades
 * equivalente. Ao gravar no ecrã, a chave passa a ter só as que ficarem
 * marcadas.
 */

export const API_KEY_CAPABILITIES = [
  "site:intake",
  "reports:ops",
  "reports:cash",
  "reports:marketing",
  "pii",
  "complaints:write",
  "device",
  "admin",
] as const;
export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

export const API_KEY_CAPABILITY_INFO: Record<ApiKeyCapability, { label: string; description: string }> = {
  "site:intake": {
    label: "Formulários do site",
    description: "Candidaturas \"Be a Driver\", disponibilidades dos extras e o formulário de disponibilidades.",
  },
  "reports:ops": {
    label: "Relatórios de operação",
    description: "Parques, projetos, viaturas, condutores, estatísticas de reservas e de reclamações, resumo.",
  },
  "reports:cash": {
    label: "Caixa e parceiros",
    description: "Contagens e correções de caixa, passagens de turno, faturação e fecho de parceiros.",
  },
  "reports:marketing": {
    label: "Marketing",
    description: "Campanhas, gasto em anúncios, ROAS, Google Analytics e Search Console.",
  },
  pii: {
    label: "Dados pessoais",
    description: "Reservas com os dados do cliente, reclamações, críticas e a lista de colaboradores.",
  },
  "complaints:write": {
    label: "Reclamações e críticas (escrever)",
    description: "Criar e atualizar reclamações, mensagens e críticas.",
  },
  device: {
    label: "Dispositivo (GPS / rádio)",
    description: "Só a /api/external: viaturas, colaboradores, alertas de velocidade, movimentos e rádio.",
  },
  admin: {
    label: "Administração (tudo)",
    description: "Tudo o que está acima, mais arquivar reclamações, criar projetos e as rotas /admin. Só para manutenção.",
  },
};

/** O que uma chave "read" antiga fazia: ler tudo. */
const LEGACY_READ: ApiKeyCapability[] = ["reports:ops", "reports:cash", "reports:marketing", "pii"];
/** "write" antiga: ler tudo + escrever (site, reclamações) + rotas de dispositivo da /api/external. */
const LEGACY_WRITE: ApiKeyCapability[] = [...LEGACY_READ, "site:intake", "complaints:write", "device"];

const isCapability = (v: string): v is ApiKeyCapability => (API_KEY_CAPABILITIES as readonly string[]).includes(v);

/** Lê o campo `permissions` (JSON ou lista separada por vírgulas/espaços). */
export function permissionTokens(permissions: string | null | undefined): string[] {
  const raw = String(permissions ?? "").trim();
  if (!raw) return [];
  let parts: string[];
  try {
    const parsed = JSON.parse(raw);
    parts = Array.isArray(parsed) ? parsed.map(String) : String(parsed).split(/[,\s]+/);
  } catch {
    parts = raw.split(/[,\s]+/);
  }
  return Array.from(new Set(parts.map((p) => p.trim().toLowerCase()).filter(Boolean)));
}

/** Chave antiga = sem permissions ou com read/write/full/"*" (o que o ecrã novo nunca grava). */
export function isLegacyPermissions(permissions: string | null | undefined): boolean {
  const t = permissionTokens(permissions);
  return t.length === 0 || t.some((x) => x === "read" || x === "write" || x === "full" || x === "*");
}

/**
 * Capacidades efetivas. `admin` (ou "*"/"full") = todas. Sem permissions =
 * dispositivo (legado). Valores desconhecidos são ignorados.
 */
export function capabilitiesFor(permissions: string | null | undefined): Set<ApiKeyCapability> {
  const tokens = permissionTokens(permissions);
  const out = new Set<ApiKeyCapability>();
  if (tokens.length === 0) { out.add("device"); return out; }
  for (const t of tokens) {
    if (t === "admin" || t === "*" || t === "full") API_KEY_CAPABILITIES.forEach((c) => out.add(c));
    else if (t === "write") LEGACY_WRITE.forEach((c) => out.add(c));
    else if (t === "read") LEGACY_READ.forEach((c) => out.add(c));
    else if (isCapability(t)) out.add(t);
  }
  return out;
}

/** Valida e normaliza a lista que o ecrã grava (ordem fixa, sem repetidos). */
export function normalizeCapabilities(list: readonly string[]): ApiKeyCapability[] {
  const set = new Set(list.map((x) => String(x).trim().toLowerCase()).filter(isCapability));
  if (set.has("admin")) return ["admin"];
  return API_KEY_CAPABILITIES.filter((c) => set.has(c));
}

/** Texto curto para listas e logs: "Marketing, Dados pessoais". */
export function capabilitiesLabel(caps: Iterable<ApiKeyCapability>): string {
  const s = new Set(caps);
  if (s.has("admin")) return API_KEY_CAPABILITY_INFO.admin.label;
  const names = API_KEY_CAPABILITIES.filter((c) => s.has(c)).map((c) => API_KEY_CAPABILITY_INFO[c].label);
  return names.length ? names.join(", ") : "nenhuma";
}
