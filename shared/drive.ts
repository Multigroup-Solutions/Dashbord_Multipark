/**
 * Google Drive / Docs / Sheets — regras PURAS (servidor + cliente, sem BD,
 * sem rede, sem relógio implícito). Pedido do dono (set 2026).
 *
 * Âmbitos (mínimos — ver docs/ajuda/drive.md):
 *  - por pessoa (OAuth, autorização incremental "drive"): SÓ
 *    `drive.file` — a app só vê os ficheiros que ela própria criou ou que a
 *    pessoa abriu com a app (Google Picker). Chega para "Guardar no Drive",
 *    "Exportar para Sheets" (a folha é criada pela app; a API Sheets aceita
 *    drive.file) e para gerar documentos na pasta "Multipark" da pessoa
 *    (a API Docs aceita drive.file nos ficheiros da app);
 *  - conta de serviço com delegação (DWD), a impersonar a conta dona do
 *    Shared Drive "Multipark": `drive` + `documents` (pastas, cópias de
 *    modelos, espelho de documentos, relatórios ao vivo). A API Sheets
 *    aceita `drive` — não é preciso `spreadsheets`.
 *
 * Aqui: ligações (id a partir de um link), nomes/pastas seguros, estrutura
 * do Shared Drive, catálogo de marcadores {{…}} dos modelos e o pedido
 * `replaceAllText`, divisão de linhas para a API Sheets e leitura de uma
 * folha como CSV para as importações existentes.
 */
import { z } from "zod";
import type { Action, ModuleId } from "./access";

// ─── Âmbitos ────────────────────────────────────────────────────────────────

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** Conta de serviço (delegação) — Shared Drive, modelos, espelho, relatórios. */
export const DWD_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
] as const;

// ─── Tipos de ficheiro ──────────────────────────────────────────────────────

export const GOOGLE_MIME = {
  folder: "application/vnd.google-apps.folder",
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export type DriveFileKind = "folder" | "doc" | "sheet" | "slides" | "pdf" | "image" | "video" | "other";

/** Tipo (para o ícone) a partir do mimeType. PURA. */
export function driveFileKind(mimeType: string | null | undefined): DriveFileKind {
  const m = String(mimeType ?? "").toLowerCase();
  if (m === GOOGLE_MIME.folder) return "folder";
  if (m === GOOGLE_MIME.doc || m.includes("wordprocessingml") || m === "application/msword") return "doc";
  if (m === GOOGLE_MIME.sheet || m.includes("spreadsheetml") || m === "text/csv") return "sheet";
  if (m === GOOGLE_MIME.slides || m.includes("presentationml")) return "slides";
  if (m === GOOGLE_MIME.pdf) return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return "other";
}

// ─── Ligações a partir de um link ───────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * Id do ficheiro a partir de um link do Drive/Docs/Sheets/Slides (ou do id
 * cru). Só aceita domínios da Google. null se não for reconhecível. PURA.
 */
export function parseDriveFileId(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (ID_RE.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!(host === "drive.google.com" || host === "docs.google.com")) return null;
  const m = u.pathname.match(/\/(?:file|document|spreadsheets|presentation|forms|drawings)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,200})/)
    ?? u.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,200})/);
  if (m) return m[1];
  const q = u.searchParams.get("id");
  return q && ID_RE.test(q) ? q : null;
}

/** Link de visualização quando a Google não o devolveu (sem acesso por drive.file). PURA. */
export function fallbackViewLink(fileId: string, mimeType?: string | null): string {
  const id = encodeURIComponent(fileId);
  switch (driveFileKind(mimeType)) {
    case "doc": return mimeType === GOOGLE_MIME.doc ? `https://docs.google.com/document/d/${id}/edit` : `https://drive.google.com/file/d/${id}/view`;
    case "sheet": return mimeType === GOOGLE_MIME.sheet ? `https://docs.google.com/spreadsheets/d/${id}/edit` : `https://drive.google.com/file/d/${id}/view`;
    case "slides": return mimeType === GOOGLE_MIME.slides ? `https://docs.google.com/presentation/d/${id}/edit` : `https://drive.google.com/file/d/${id}/view`;
    case "folder": return `https://drive.google.com/drive/folders/${id}`;
    default: return `https://drive.google.com/file/d/${id}/view`;
  }
}

/** Só links https da Google chegam à UI (nunca javascript:, nunca outro domínio). PURA. */
export function safeGoogleLink(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    return h === "google.com" || h.endsWith(".google.com") ? u.toString() : null;
  } catch { return null; }
}

// ─── Nomes e pastas ─────────────────────────────────────────────────────────

/**
 * Nome seguro para ficheiro/pasta do Drive: sem barras, sem caracteres de
 * controlo, espaços normalizados, máx. `max` caracteres; nunca vazio, "." ou
 * "..". PURA.
 */
export function sanitizeDriveName(raw: string | null | undefined, max = 120, fallback = "Sem nome"): string {
  let s = String(raw ?? "").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max).trim();
  if (!s || s === "." || s === "..") return fallback;
  return s;
}

/** Nome da pasta de cada pessoa ("O meu Drive" → "Multipark"). */
export const USER_DRIVE_FOLDER = "Multipark";
export const DEFAULT_SHARED_DRIVE_NAME = "Multipark";

export type SharedFolderTarget =
  | { kind: "client"; name: string | null; email: string }
  | { kind: "complaint"; id: number; createdAt: string | null }
  | { kind: "employee"; city: string | null; name: string; id: number }
  | { kind: "partner"; name: string; id: number }
  | { kind: "reports" };

/**
 * Caminho (pastas) no Shared Drive, criado a pedido:
 *   Clientes/<nome>, Reclamações/<ano>/<id>, RH/<cidade>/<trabalhador>,
 *   Parcerias/<nome>, Relatórios. PURA.
 */
export function sharedFolderPath(t: SharedFolderTarget): string[] {
  switch (t.kind) {
    case "client": {
      const label = t.name?.trim() ? `${t.name.trim()} (${t.email})` : t.email;
      return ["Clientes", sanitizeDriveName(label, 100)];
    }
    case "complaint": {
      const year = /^\d{4}/.test(String(t.createdAt ?? "")) ? String(t.createdAt).slice(0, 4) : "Sem data";
      return ["Reclamações", year, String(Math.trunc(t.id))];
    }
    case "employee":
      return ["RH", sanitizeDriveName(t.city, 60, "Sem cidade"), sanitizeDriveName(`${t.name} (#${Math.trunc(t.id)})`, 100)];
    case "partner":
      return ["Parcerias", sanitizeDriveName(t.name, 100)];
    case "reports":
      return ["Relatórios"];
  }
}

/** Chave do caminho para a cache de pastas (sem maiúsculas/acentos a separar o mesmo). PURA. */
export function folderPathKey(segments: readonly string[]): string {
  return segments.map((s) => sanitizeDriveName(s)).join("/").slice(0, 500);
}

/** Literal para `q` da API Drive (aspas e barras escapadas). PURA. */
export function driveQueryLiteral(s: string): string {
  return `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// ─── Registos a que se pode ligar um ficheiro ───────────────────────────────

export const DRIVE_ENTITY_TYPES = ["client", "complaint", "mail_thread", "employee", "task", "partner"] as const;
export type DriveEntityType = (typeof DRIVE_ENTITY_TYPES)[number];
export const DRIVE_ENTITY_LABELS: Record<DriveEntityType, string> = {
  client: "Cliente", complaint: "Reclamação", mail_thread: "Conversa de email", employee: "Colaborador (RH)", task: "Tarefa", partner: "Parceria",
};

/** Id do registo normalizado (email de cliente em minúsculas; ids numéricos). PURA. */
export function normalizeDriveEntityId(type: DriveEntityType, raw: string | number): string | null {
  const s = String(raw ?? "").trim();
  if (type === "client") {
    const e = s.toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 320 ? e : null;
  }
  return /^\d{1,10}$/.test(s) && Number(s) > 0 ? String(Number(s)) : null;
}

export const driveLinkInputSchema = z.object({
  entityType: z.enum(DRIVE_ENTITY_TYPES),
  entityId: z.string().trim().min(1).max(320),
});

// ─── Configuração (Definições → Comunicação → Google Drive) ─────────────────

export const LIVE_REPORT_KEYS = ["financeiro", "faturacao", "extras_metricas", "avaliacoes"] as const;
export type LiveReportKey = (typeof LIVE_REPORT_KEYS)[number];

export const driveConfigSchema = z.object({
  /** Shared Drive da empresa (conta de serviço com delegação). */
  sharedEnabled: z.boolean().default(false),
  /** Conta do Workspace membro (gestor) do Shared Drive, impersonada pela conta de serviço. */
  ownerEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email("Email inválido.")]).default(""),
  sharedDriveName: z.string().trim().min(1).max(100).default(DEFAULT_SHARED_DRIVE_NAME),
  /** Shared Drive só para RH (membros restritos). Vazio = pasta "RH" no Shared Drive principal. */
  rhDriveName: z.string().trim().max(100).default(""),
  /** Copiar os documentos do RH para RH/<cidade>/<trabalhador>. */
  mirrorRhDocuments: z.boolean().default(false),
  /** Copiar as provas (fotos/ficheiros) das reclamações para Reclamações/<ano>/<id>. */
  mirrorComplaintEvidence: z.boolean().default(false),
  /** Relatórios ao vivo: folha fixa no Shared Drive, atualizada 1×/dia pelo cron. */
  liveReports: z.object({
    enabled: z.boolean().default(false),
    reports: z.array(z.enum(LIVE_REPORT_KEYS)).max(LIVE_REPORT_KEYS.length).default(["financeiro"]),
    /** Hora (Lisboa) a partir da qual corre a atualização do dia. */
    hour: z.number().int().min(0).max(23).default(6),
  }).default({ enabled: false, reports: ["financeiro"], hour: 6 }),
  /** Conta (super admin) cujas permissões os relatórios ao vivo usam — gravada ao guardar. */
  liveRunAsUserId: z.number().int().positive().nullable().default(null),
}).superRefine((v, ctx) => {
  if (v.sharedEnabled && !v.ownerEmail) ctx.addIssue({ code: "custom", message: "Indica a conta do Workspace membro do Shared Drive." });
  if ((v.mirrorRhDocuments || v.mirrorComplaintEvidence || v.liveReports.enabled) && !v.sharedEnabled) {
    ctx.addIssue({ code: "custom", message: "O espelho e os relatórios ao vivo precisam do Shared Drive ligado." });
  }
});
export type DriveConfig = z.output<typeof driveConfigSchema>;
export const DEFAULT_DRIVE_CONFIG: DriveConfig = driveConfigSchema.parse({});

export function parseDriveConfig(raw: unknown): DriveConfig {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = {}; } }
  const r = driveConfigSchema.safeParse(v && typeof v === "object" ? v : {});
  return r.success ? r.data : DEFAULT_DRIVE_CONFIG;
}

// ─── Modelos de documentos (Google Docs com {{marcadores}}) ─────────────────

export const DOC_TEMPLATE_TYPES = ["contrato_trabalho", "declaracao", "resposta_reclamacao", "proposta_comercial", "proposta_parceria"] as const;
export type DocTemplateType = (typeof DOC_TEMPLATE_TYPES)[number];
export const DOC_TEMPLATE_LABELS: Record<DocTemplateType, string> = {
  contrato_trabalho: "Contrato de trabalho",
  declaracao: "Declaração",
  resposta_reclamacao: "Resposta a reclamação",
  proposta_comercial: "Proposta comercial",
  proposta_parceria: "Proposta de parceria",
};
/** Registos onde cada tipo de modelo pode ser gerado. */
export const DOC_TEMPLATE_ENTITIES: Record<DocTemplateType, readonly DriveEntityType[]> = {
  contrato_trabalho: ["employee"],
  declaracao: ["employee", "client"],
  resposta_reclamacao: ["complaint"],
  proposta_comercial: ["client", "partner"],
  proposta_parceria: ["partner"],
};
export type GenerateEntityType = "employee" | "complaint" | "client" | "partner";
export const GENERATE_ENTITY_TYPES: readonly GenerateEntityType[] = ["employee", "complaint", "client", "partner"];

export function templateTypesFor(entity: DriveEntityType): DocTemplateType[] {
  return DOC_TEMPLATE_TYPES.filter((t) => DOC_TEMPLATE_ENTITIES[t].includes(entity));
}

export const docTemplateInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  templateType: z.enum(DOC_TEMPLATE_TYPES),
  link: z.string().trim().min(10).max(500),
  description: z.string().trim().max(500).optional().nullable(),
});

/** Marcadores comuns a todos os modelos. */
const COMMON_PLACEHOLDERS: Array<{ key: string; label: string }> = [
  { key: "data_hoje", label: "Data de hoje (DD/MM/AAAA)" },
  { key: "data_hoje_extenso", label: "Data de hoje por extenso (25 de setembro de 2026)" },
  { key: "utilizador_nome", label: "Nome de quem gera" },
  { key: "utilizador_email", label: "Email de quem gera" },
];

/** Catálogo de marcadores por tipo de registo (o que o modelo pode usar). */
export const PLACEHOLDER_CATALOG: Record<GenerateEntityType, Array<{ key: string; label: string; sensitive?: "salary" }>> = {
  employee: [
    { key: "nome", label: "Nome completo" },
    { key: "nif", label: "NIF" },
    { key: "morada", label: "Morada" },
    { key: "nacionalidade", label: "Nacionalidade" },
    { key: "data_nascimento", label: "Data de nascimento" },
    { key: "email", label: "Email de trabalho" },
    { key: "telefone", label: "Telefone" },
    { key: "cargo", label: "Função" },
    { key: "cidade", label: "Cidade / centro de custos" },
    { key: "tipo_contrato", label: "Tipo de contrato" },
    { key: "inicio_contrato", label: "Início do contrato" },
    { key: "fim_contrato", label: "Fim do contrato" },
    { key: "salario_mensal", label: "Ordenado mensal (só quem vê os ordenados)", sensitive: "salary" },
    { key: "subsidio_alimentacao", label: "Subsídio de alimentação/dia (só quem vê os ordenados)", sensitive: "salary" },
  ],
  complaint: [
    { key: "reclamacao_id", label: "N.º da reclamação" },
    { key: "reclamacao_titulo", label: "Título" },
    { key: "reclamacao_descricao", label: "Descrição" },
    { key: "reclamacao_data", label: "Data da reclamação" },
    { key: "reclamacao_estado", label: "Estado" },
    { key: "cliente_nome", label: "Nome do cliente" },
    { key: "cliente_email", label: "Email do cliente" },
    { key: "cliente_telefone", label: "Telefone do cliente" },
    { key: "reserva", label: "Referência da reserva" },
    { key: "matricula", label: "Matrícula" },
    { key: "cidade", label: "Cidade" },
  ],
  client: [
    { key: "cliente_nome", label: "Nome do cliente" },
    { key: "cliente_email", label: "Email do cliente" },
    { key: "cliente_telefone", label: "Telefone do cliente" },
    { key: "reservas", label: "N.º de reservas" },
    { key: "primeira_reserva", label: "Primeira entrada" },
    { key: "ultima_reserva", label: "Última entrada" },
  ],
  partner: [
    { key: "parceiro_nome", label: "Nome do parceiro" },
    { key: "parceiro_nif", label: "NIF do parceiro" },
    { key: "contacto_nome", label: "Pessoa de contacto" },
    { key: "contacto_email", label: "Email de contacto" },
    { key: "contacto_telefone", label: "Telefone de contacto" },
    { key: "comissao", label: "Comissão (%)" },
    { key: "mensalidade", label: "Mensalidade (€)" },
  ],
};

export function placeholdersFor(entity: GenerateEntityType): Array<{ key: string; label: string; sensitive?: "salary" }> {
  return [...COMMON_PLACEHOLDERS, ...PLACEHOLDER_CATALOG[entity]];
}

/** Marcadores {{chave}} presentes num texto (únicos, pela ordem). PURA. */
export function extractPlaceholders(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/\{\{\s*([a-z0-9_]{1,60})\s*\}\}/gi)) {
    const k = m[1].toLowerCase();
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const POSITION_PT: Record<string, string> = {
  director: "Diretor(a)", supervisor: "Supervisor(a)", team_leader: "Team Leader", backoffice: "Backoffice", frontoffice: "Frontoffice",
  senior_driver: "Condutor(a) sénior", driver: "Condutor(a)", extra: "Extra",
};
const CONTRACT_PT: Record<string, string> = { permanent: "Sem termo", fixed_term: "A termo certo", extra: "Extra (prestação pontual)" };
const COMPLAINT_STATUS_PT: Record<string, string> = {
  new: "Nova", analyzing: "Em análise", waiting_client: "À espera do cliente", resolved: "Resolvida", closed: "Fechada", converted: "Convertida",
};

/** "2026-09-25…" → "25/09/2026" (vazio se inválida). PURA. */
export function ptDate(raw: string | null | undefined): string {
  const m = String(raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
/** "2026-09-25" → "25 de setembro de 2026". PURA. */
export function ptDateLong(isoDay: string): string {
  const m = isoDay.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} de ${MONTHS_PT[Number(m[2]) - 1]} de ${m[1]}` : "";
}
const money = (v: unknown) => {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? "" : n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const txt = (v: unknown) => (v == null ? "" : String(v).trim());

export interface PlaceholderContext {
  /** Dia de hoje (Lisboa, AAAA-MM-DD). */
  today: string;
  user: { name: string | null; email: string | null };
  /** Quem gera vê os ordenados (rh_salarios)? Sem isto, os valores ficam vazios. */
  canSeeSalary: boolean;
  /** Nome da cidade/centro do registo (já resolvido). */
  cityName?: string | null;
}

/**
 * Valores dos marcadores para um registo. Só as chaves do catálogo; os
 * sensíveis (ordenado) ficam vazios para quem não os vê. PURA.
 */
export function buildPlaceholderValues(entity: GenerateEntityType, rec: Record<string, any>, c: PlaceholderContext): Record<string, string> {
  const v: Record<string, string> = {
    data_hoje: ptDate(c.today),
    data_hoje_extenso: ptDateLong(c.today),
    utilizador_nome: txt(c.user.name),
    utilizador_email: txt(c.user.email),
  };
  if (entity === "employee") {
    Object.assign(v, {
      nome: txt(rec.fullName), nif: txt(rec.nif), morada: txt(rec.address), nacionalidade: txt(rec.nationality),
      data_nascimento: ptDate(rec.birthDate), email: txt(rec.email), telefone: txt(rec.phone),
      cargo: POSITION_PT[String(rec.position ?? "")] ?? txt(rec.position), cidade: txt(c.cityName),
      tipo_contrato: CONTRACT_PT[String(rec.contractType ?? "")] ?? txt(rec.contractType),
      inicio_contrato: ptDate(rec.contractStart), fim_contrato: ptDate(rec.contractEnd),
      salario_mensal: c.canSeeSalary ? money(rec.monthlySalary) : "",
      subsidio_alimentacao: c.canSeeSalary ? money(rec.mealAllowancePerDay) : "",
    });
  } else if (entity === "complaint") {
    Object.assign(v, {
      reclamacao_id: txt(rec.id), reclamacao_titulo: txt(rec.title), reclamacao_descricao: txt(rec.description),
      reclamacao_data: ptDate(rec.createdAt), reclamacao_estado: COMPLAINT_STATUS_PT[String(rec.complaintStatus ?? "")] ?? txt(rec.complaintStatus),
      cliente_nome: txt(rec.clientName), cliente_email: txt(rec.clientEmail), cliente_telefone: txt(rec.clientPhone),
      reserva: txt(rec.reservationRef), matricula: txt(rec.vehiclePlate).toUpperCase(), cidade: txt(c.cityName),
    });
  } else if (entity === "client") {
    Object.assign(v, {
      cliente_nome: txt(rec.name), cliente_email: txt(rec.email), cliente_telefone: txt(rec.phone),
      reservas: rec.bookings != null ? String(rec.bookings) : "", primeira_reserva: ptDate(rec.firstCheckIn), ultima_reserva: ptDate(rec.lastCheckIn),
    });
  } else {
    Object.assign(v, {
      parceiro_nome: txt(rec.name), parceiro_nif: txt(rec.partnerNif), contacto_nome: txt(rec.contactName),
      contacto_email: txt(rec.contactEmail), contacto_telefone: txt(rec.contactPhone),
      comissao: rec.commissionRate != null ? String(rec.commissionRate) : "", mensalidade: money(rec.monthlyFee),
    });
  }
  return v;
}

/**
 * Pedidos `replaceAllText` da API Docs (um por marcador; aceita "{{ chave }}"
 * com espaços). Valores longos são cortados (limite prático da API). PURA.
 */
export function replaceAllTextRequests(values: Record<string, string>, opts: { variants?: boolean } = {}): Array<{ replaceAllText: { containsText: { text: string; matchCase: boolean }; replaceText: string } }> {
  const out: Array<{ replaceAllText: { containsText: { text: string; matchCase: boolean }; replaceText: string } }> = [];
  for (const [k, raw] of Object.entries(values)) {
    const value = String(raw ?? "").replace(/\r\n?/g, "\n").slice(0, 10_000);
    const forms = opts.variants === false ? [`{{${k}}}`] : [`{{${k}}}`, `{{ ${k} }}`];
    for (const text of forms) out.push({ replaceAllText: { containsText: { text, matchCase: false }, replaceText: value } });
  }
  return out;
}

/** Nome do documento gerado ("Contrato de trabalho — Ana Silva — 2026-09-25"). PURA. */
export function generatedDocName(type: DocTemplateType, label: string, today: string): string {
  return sanitizeDriveName(`${DOC_TEMPLATE_LABELS[type]} — ${label} — ${today}`, 150);
}

// ─── Sheets: escrita em blocos e leitura como CSV ───────────────────────────

export type SheetCell = string | number | boolean | null;
export interface SheetTab { name: string; rows: SheetCell[][] }

/** Letra(s) da coluna (1 → A, 27 → AA). PURA. */
export function columnLetter(n: number): string {
  let s = "";
  let x = Math.max(1, Math.trunc(n));
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

/** Título de separador válido e único (máx. 100, sem []:*?/\). PURA. */
export function sanitizeSheetTitle(raw: string, used: Set<string> = new Set()): string {
  let base = String(raw ?? "").replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Folha";
  if (base.startsWith("'")) base = base.slice(1) || "Folha";
  let t = base;
  for (let i = 2; used.has(t.toLowerCase()); i++) t = `${base} (${i})`;
  used.add(t.toLowerCase());
  return t;
}

/** Referência A1 com o nome da folha entre plicas. PURA. */
export function a1Range(sheet: string, startRow: number, colCount: number, rowCount: number): string {
  const end = startRow + Math.max(1, rowCount) - 1;
  return `'${sheet.replace(/'/g, "''")}'!A${startRow}:${columnLetter(Math.max(1, colCount))}${end}`;
}

/** Célula para a API (RAW: nada é interpretado como fórmula). PURA. */
export function sheetValue(c: SheetCell | undefined): string | number | boolean {
  if (c == null) return "";
  if (typeof c === "number") return Number.isFinite(c) ? c : "";
  if (typeof c === "boolean") return c;
  return String(c).slice(0, 50_000);
}

export const SHEETS_MAX_CELLS_PER_REQUEST = 40_000;
export const SHEETS_MAX_ROWS_PER_CHUNK = 2_000;

/**
 * Divide as linhas de cada separador em blocos (≤ maxCells células e
 * ≤ maxRows linhas por pedido) com o intervalo A1 de cada bloco. PURA.
 */
export function chunkSheetWrites(
  tabs: readonly SheetTab[],
  o: { maxCells?: number; maxRows?: number } = {},
): Array<Array<{ range: string; values: Array<Array<string | number | boolean>> }>> {
  const maxCells = o.maxCells ?? SHEETS_MAX_CELLS_PER_REQUEST;
  const maxRows = o.maxRows ?? SHEETS_MAX_ROWS_PER_CHUNK;
  const requests: Array<Array<{ range: string; values: Array<Array<string | number | boolean>> }>> = [];
  let cur: Array<{ range: string; values: Array<Array<string | number | boolean>> }> = [];
  let curCells = 0;
  const flush = () => { if (cur.length) requests.push(cur); cur = []; curCells = 0; };
  for (const tab of tabs) {
    const width = Math.max(1, ...tab.rows.map((r) => r.length));
    const rowsPerChunk = Math.max(1, Math.min(maxRows, Math.floor(maxCells / width)));
    for (let start = 0; start < tab.rows.length; start += rowsPerChunk) {
      const slice = tab.rows.slice(start, start + rowsPerChunk).map((r) => Array.from({ length: width }, (_, i) => sheetValue(r[i])));
      const cells = slice.length * width;
      if (curCells + cells > maxCells) flush();
      cur.push({ range: a1Range(tab.name, start + 1, width, slice.length), values: slice });
      curCells += cells;
    }
  }
  flush();
  return requests;
}

/**
 * Valores lidos de uma folha → CSV com vírgulas (o formato das importações
 * existentes: linha a linha, aspas nos valores com vírgula/aspas). As
 * quebras de linha dentro das células viram espaço (os importadores leem
 * por linha); linhas vazias no fim saem. PURA.
 */
export function sheetValuesToCsv(values: ReadonlyArray<ReadonlyArray<unknown>> | null | undefined): string {
  const rows = (values ?? []).map((r) => (r ?? []).map((c) => (c == null ? "" : String(c).replace(/\r\n|\r|\n/g, " ").trim())));
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_, i) => {
    const c = r[i] ?? "";
    return /[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
  }).join(",")).join("\n");
}

export const SHEET_IMPORT_PURPOSES = ["extras", "financial_history"] as const;
export type SheetImportPurpose = (typeof SHEET_IMPORT_PURPOSES)[number];

// ─── Exportar para Sheets (relatórios) ──────────────────────────────────────

export const SHEET_EXPORT_REPORTS = ["financeiro", "faturacao", "extras_metricas", "clientes", "avaliacoes"] as const;
export type SheetExportReport = (typeof SHEET_EXPORT_REPORTS)[number];
export const SHEET_EXPORT_LABELS: Record<SheetExportReport, string> = {
  financeiro: "Financeiro",
  faturacao: "Faturação",
  extras_metricas: "Métricas dos extras",
  clientes: "Clientes",
  avaliacoes: "Avaliação individual (ranking)",
};

/**
 * Permissão para exportar cada relatório (além da do procedimento de
 * origem): a ação "exportar" do módulo, onde a matriz a tem; Extras-dia não
 * tem "exportar" → gerir (admin+).
 */
export const SHEET_EXPORT_GATES: Record<SheetExportReport, { module: ModuleId; action: Action }> = {
  financeiro: { module: "financeiro", action: "export" },
  faturacao: { module: "faturacao", action: "export" },
  extras_metricas: { module: "extras_dia", action: "manage" },
  clientes: { module: "clientes", action: "export" },
  avaliacoes: { module: "avaliacao", action: "export" },
};

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const sheetExportInputSchema = z.discriminatedUnion("report", [
  z.object({ report: z.literal("financeiro"), from: isoDay, to: isoDay, projectId: z.number().optional() }),
  z.object({ report: z.literal("faturacao"), from: isoDay, to: isoDay, projectId: z.number().optional(), granularity: z.enum(["day", "week", "month", "year"]).optional() }),
  z.object({ report: z.literal("extras_metricas"), days: z.number().int().min(7).max(180).optional() }),
  z.object({
    report: z.literal("clientes"),
    search: z.string().max(200).nullable().optional(),
    segment: z.enum(["all", "new", "recurring", "vip", "at_risk", "partner", "shared"]).nullable().optional(),
    projectId: z.number().optional(),
  }),
  z.object({ report: z.literal("avaliacoes"), from: isoDay, to: isoDay }),
]);
export type SheetExportInput = z.infer<typeof sheetExportInputSchema>;

/** Nome da folha exportada ("Faturação 2026-09-01 a 2026-09-25 (exportado 2026-09-25)"). PURA. */
export function exportSpreadsheetName(input: SheetExportInput, today: string): string {
  const label = SHEET_EXPORT_LABELS[input.report];
  const period = "from" in input && "to" in input ? ` ${input.from} a ${input.to}` : "";
  return sanitizeDriveName(`${label}${period} (exportado ${today})`, 150);
}
