/**
 * Modo do ponto de cada pessoa (plano 63, passo 1). Tudo PURO: o servidor
 * (server/pontoModes.ts) e o cartão da ficha (RH → ficha → Horário) usam as
 * mesmas regras.
 *
 *  - Sem modo (NULL) = as regras de hoje. É a omissão de toda a gente.
 *  - 1 `fixed` (horário fixo), 2 `exempt` (isenção), 3 `always_on` (sempre em
 *    serviço). Neste passo o modo só fica marcado, com histórico, avisos lidos,
 *    alertas e o rasto das picagens: **nenhuma regra muda** (horas, ordenado,
 *    atrasos e faltas ficam iguais). As regras de cada modo entram nos passos
 *    seguintes, cada uma com o seu interruptor.
 *  - Histórico (`employee_ponto_modes`): cada mudança é uma linha "a partir de
 *    AAAA-MM-DD" (dia operacional). Uma mudança posterior com uma data igual ou
 *    anterior SUBSTITUI as que começavam nesse dia ou depois (ficam no
 *    histórico, marcadas "substituída"; nada se apaga). O ordenado e a Avaliação
 *    leem o histórico (`pontoModeOn`), nunca a cópia em `employees.pontoMode`.
 */
import { z } from "zod";

export const PONTO_MODOS_FLAG = "PONTO_MODOS";

export const PONTO_MODES = ["fixed", "exempt", "always_on"] as const;
export type PontoMode = (typeof PONTO_MODES)[number];

export function isPontoMode(v: unknown): v is PontoMode {
  return typeof v === "string" && (PONTO_MODES as readonly string[]).includes(v);
}
/** Valor da BD → modo (o que não for um modo conhecido conta como "sem modo"). */
export function normalizePontoMode(v: unknown): PontoMode | null {
  return isPontoMode(v) ? v : null;
}

export const PONTO_MODE_NUMBER: Record<PontoMode, 1 | 2 | 3> = { fixed: 1, exempt: 2, always_on: 3 };
export const PONTO_MODE_LABEL: Record<PontoMode, string> = {
  fixed: "Horário fixo",
  exempt: "Isenção",
  always_on: "Sempre em serviço",
};
export const NO_PONTO_MODE_LABEL = "Sem modo — regras de hoje";

/** Para quem é cada modo (uma linha, no cartão da ficha). */
export const PONTO_MODE_HINT: Record<PontoMode, string> = {
  fixed: "Back office e front office: selfie, foto de perfil validada e zona de trabalho.",
  exempt: "Isenção de horário: pica onde quiser; só o fim de semana se paga à parte, depois de validado.",
  always_on: "Reformados: as entradas e saídas ficam registadas sozinhas (Zello e movimentos), com a foto de perfil.",
};

/** "1 · Horário fixo" / "Sem modo — regras de hoje". */
export function pontoModeLabel(mode: PontoMode | null | undefined): string {
  return mode ? `${PONTO_MODE_NUMBER[mode]} · ${PONTO_MODE_LABEL[mode]}` : NO_PONTO_MODE_LABEL;
}

/** Os modos que mexem em horas já picadas: pôr ou tirar só a partir de hoje. */
const FORWARD_ONLY: ReadonlySet<PontoMode> = new Set<PontoMode>(["exempt", "always_on"]);
export function isForwardOnlyMode(mode: PontoMode | null | undefined): boolean {
  return !!mode && FORWARD_ONLY.has(mode);
}

/** Recuo máximo de uma mudança para trás (além dos meses fechados). */
export const PONTO_MODE_MAX_BACK_DAYS = 366;
export const PONTO_MODE_NOTE_MIN = 3;

// ─── Histórico ──────────────────────────────────────────────────────────────

export interface PontoModeEntry {
  id: number;
  mode: PontoMode | string | null;
  /** dia operacional "AAAA-MM-DD" a partir do qual vale */
  effectiveFrom: string;
  note?: string | null;
  setById?: number | null;
  /** UTC "AAAA-MM-DD HH:MM:SS" */
  setAt?: string | null;
}

const isoDay = (v: string) => String(v ?? "").slice(0, 10);

/**
 * O histórico por ordem de gravação, com `superseded`: uma linha fica
 * substituída quando uma linha gravada DEPOIS começa no mesmo dia ou antes.
 */
export function pontoModeTimeline<T extends PontoModeEntry>(history: readonly T[]): Array<T & { superseded: boolean }> {
  const byId = [...history].sort((a, b) => a.id - b.id);
  const superseded = new Map<number, boolean>();
  let minNewer: string | null = null;
  for (let i = byId.length - 1; i >= 0; i--) {
    const from = isoDay(byId[i].effectiveFrom);
    superseded.set(byId[i].id, minNewer != null && minNewer <= from);
    if (minNewer == null || from < minNewer) minNewer = from;
  }
  return byId.map((e) => ({ ...e, superseded: superseded.get(e.id) === true }));
}

/** O modo num dia operacional ("AAAA-MM-DD"), pelo histórico. Sem linha que valha → sem modo. */
export function pontoModeOn(day: string, history: readonly PontoModeEntry[]): PontoMode | null {
  let best: { from: string; id: number; mode: PontoMode | null } | null = null;
  for (const e of pontoModeTimeline(history)) {
    if (e.superseded) continue;
    const from = isoDay(e.effectiveFrom);
    if (from > day) continue;
    if (!best || from > best.from || (from === best.from && e.id > best.id)) best = { from, id: e.id, mode: normalizePontoMode(e.mode) };
  }
  return best ? best.mode : null;
}

// ─── Guardas da mudança ─────────────────────────────────────────────────────

export interface PontoModeChangeInput {
  actorRole: string;
  employee: {
    position?: string | null;
    contractType?: string | null;
    zelloUsername?: string | null;
    hasMultiparkAgent: boolean;
    isActive?: boolean | number | null;
  };
  history: readonly PontoModeEntry[];
  /** o modo novo (null = voltar a "sem modo") */
  mode: PontoMode | null;
  effectiveFrom: string;
  /** dia operacional de hoje */
  today: string;
  /** meses com o ordenado fechado ("AAAA-MM") */
  closedMonths: ReadonlySet<string>;
  hasOpenCheckIn: boolean;
  note: string;
}

export interface PontoModeChangeCheck {
  error: string | null;
  warnings: string[];
  /** dias (de `effectiveFrom` a hoje) cujo modo muda */
  changedDays: string[];
}

/** Extra = posto ou contrato "extra" (a mesma regra do terminal e das finanças). */
export function isExtraLike(e: { position?: string | null; contractType?: string | null }): boolean {
  return e.position === "extra" || e.contractType === "extra";
}

const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** "2026-09" → "setembro de 2026". */
export function monthKeyLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return MONTHS_PT[m - 1] ? `${MONTHS_PT[m - 1]} de ${y}` : key;
}
/** "2026-10-05" → "05/10/2026". */
export function fmtIsoDayPt(day: string): string {
  const [y, m, d] = isoDay(day).split("-");
  return y && m && d ? `${d}/${m}/${y}` : day;
}

export function isIsoDayString(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function addDaysIso(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function daysFromTo(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length <= PONTO_MODE_MAX_BACK_DAYS + 1; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

/**
 * O dia mais antigo que a mudança pode ter: hoje para a isenção e o "sempre em
 * serviço" (pôr ou tirar); senão o 1.º dia do mês aberto mais antigo seguido
 * até hoje (sem nenhum mês fechado pelo meio), no máximo 366 dias para trás.
 * O servidor confirma sempre (`pontoModeChangeCheck`). PURA.
 */
export function pontoModeEarliestFrom(o: { mode: PontoMode | null; currentMode: PontoMode | null; today: string; closedMonths: ReadonlySet<string>; history?: readonly PontoModeEntry[] }): string {
  if (isForwardOnlyMode(o.mode) || isForwardOnlyMode(o.currentMode)) return o.today;
  const limit = addDaysIso(o.today, -PONTO_MODE_MAX_BACK_DAYS);
  let first = o.today;
  let monthStart = `${o.today.slice(0, 7)}-01`;
  while (true) {
    if (o.closedMonths.has(monthStart.slice(0, 7))) break;
    first = monthStart < limit ? limit : monthStart;
    if (monthStart <= limit) break;
    monthStart = `${addDaysIso(monthStart, -1).slice(0, 7)}-01`;
  }
  // nunca por cima de dias que estiveram em isenção ou "sempre em serviço" (também só para a frente)
  if (o.history?.length) {
    for (let d = addDaysIso(o.today, -1); d >= first; d = addDaysIso(d, -1)) {
      if (isForwardOnlyMode(pontoModeOn(d, o.history))) return addDaysIso(d, 1);
    }
  }
  return first;
}

/**
 * Avisos sobre o modo de HOJE da ficha (o cartão mostra-os ao RH e ao super
 * admin): um extra só pode estar em "Sempre em serviço" — se o posto ou o
 * contrato passou a extra depois de pôr o modo 1 ou 2, avisa para o tirar; um
 * extra em "Sempre em serviço" não recebe pelas horas automáticas. PURA.
 */
export function pontoModeStateWarnings(mode: PontoMode | null, employee: { position?: string | null; contractType?: string | null }): string[] {
  const out: string[] = [];
  if (!mode) return out;
  if (isExtraLike(employee) && (mode === "fixed" || mode === "exempt")) {
    out.push(`É extra e está em "${pontoModeLabel(mode)}": os modos 1 e 2 são só para funcionários. Muda para "Sem modo" (ou "Sempre em serviço").`);
  }
  if (isExtraLike(employee) && mode === "always_on") out.push("É extra: as horas automáticas não pagam (ficam a 0 € na folha e no custo dos extras).");
  return out;
}

/**
 * Pode gravar-se esta mudança? Erro (recusa) ou avisos (deixa gravar). PURA.
 *  - só o super admin;
 *  - a data: um dia válido, nunca no futuro, no máximo 366 dias para trás;
 *  - tem de mudar alguma coisa;
 *  - os extras não têm modo 1 nem 2 (o 3 aceita-os, com o aviso de que as horas
 *    automáticas não pagam);
 *  - isenção e "sempre em serviço" (pôr ou tirar) só a partir de hoje;
 *  - nunca num mês com o ordenado fechado;
 *  - "sempre em serviço" sem entrada do ponto aberta; sem Zello ou sem agente
 *    da Multipark só avisa;
 *  - o motivo é obrigatório.
 */
export function pontoModeChangeCheck(i: PontoModeChangeInput): PontoModeChangeCheck {
  const warnings: string[] = [];
  const fail = (error: string, changedDays: string[] = []): PontoModeChangeCheck => ({ error, warnings, changedDays });
  if (i.actorRole !== "super_admin") return fail("Só o super admin muda o modo do ponto.");
  if (i.mode != null && !isPontoMode(i.mode)) return fail("Modo do ponto desconhecido.");
  if (!isIsoDayString(i.effectiveFrom)) return fail("Escolhe o dia a partir do qual vale (AAAA-MM-DD).");
  if (i.effectiveFrom > i.today) return fail("O modo vale a partir de hoje ou de um dia que já passou: não há datas no futuro.");
  if (i.effectiveFrom < addDaysIso(i.today, -PONTO_MODE_MAX_BACK_DAYS)) return fail("Esse dia é demasiado antigo (no máximo um ano para trás).");

  const extra = isExtraLike(i.employee);
  if (extra && (i.mode === "fixed" || i.mode === "exempt")) {
    return fail("Os extras não têm horário fixo nem isenção: os modos 1 e 2 são só para funcionários. Um extra só pode ficar em \"Sempre em serviço\".");
  }

  const nextId = i.history.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  const after: PontoModeEntry[] = [...i.history, { id: nextId, mode: i.mode, effectiveFrom: i.effectiveFrom }];
  const days = daysFromTo(i.effectiveFrom, i.today);
  const changedDays = days.filter((d) => pontoModeOn(d, i.history) !== pontoModeOn(d, after));
  if (!changedDays.length) return fail(`Nada muda: a ficha já está em "${pontoModeLabel(i.mode)}" nesses dias.`);

  const touchesForwardOnly = changedDays.some((d) => isForwardOnlyMode(pontoModeOn(d, i.history)) || isForwardOnlyMode(pontoModeOn(d, after)));
  if (touchesForwardOnly && i.effectiveFrom < i.today) {
    return fail("A isenção e o \"Sempre em serviço\" (pôr ou tirar) só valem a partir de hoje: para trás mudavam horas já picadas.", changedDays);
  }

  const closed = Array.from(new Set(changedDays.map((d) => d.slice(0, 7)))).filter((m) => i.closedMonths.has(m)).sort();
  if (closed.length) {
    return fail(`O ordenado de ${closed.map(monthKeyLabel).join(", ")} já está fechado: o modo não muda nesses dias. Escolhe um dia a seguir.`, changedDays);
  }

  if (i.mode === "always_on" && i.hasOpenCheckIn) {
    return fail("Tem uma entrada do ponto aberta: faz a saída antes de passar a \"Sempre em serviço\".", changedDays);
  }
  if (String(i.note ?? "").trim().length < PONTO_MODE_NOTE_MIN) return fail("Escreve o motivo da mudança.", changedDays);

  if (i.mode === "always_on") {
    if (!String(i.employee.zelloUsername ?? "").trim()) warnings.push("Sem conta Zello na ficha: as horas automáticas só vão contar com os movimentos da Multipark.");
    if (!i.employee.hasMultiparkAgent) warnings.push("Sem agente da Multipark ligado à ficha: os movimentos não vão contar.");
    if (extra) warnings.push("É extra: as horas automáticas não pagam (ficam a 0 € na folha e no custo dos extras).");
  }
  if (i.employee.isActive != null && Number(i.employee.isActive) === 0) warnings.push("A ficha está inativa.");
  if (i.effectiveFrom < i.today) warnings.push(`Vale para trás desde ${fmtIsoDayPt(i.effectiveFrom)}: as picagens já feitas nesses dias guardam o modo que tinham.`);
  return { error: null, warnings, changedDays };
}

/** Só o erro (ou null). PURA. */
export function pontoModeChangeError(i: PontoModeChangeInput): string | null {
  return pontoModeChangeCheck(i).error;
}

// ─── Avisos escritos ("Li") ─────────────────────────────────────────────────
// Textos do plano 63 §13. Cada versão é um texto fixo: mudar o texto = versão
// nova (`_v2`), e quem leu a anterior volta a ver o aviso.

export const PONTO_NOTICES = {
  fixed_v1: {
    mode: "fixed",
    title: "Horário fixo",
    text: "Ao picar o ponto guardamos uma fotografia tua e a localização do telemóvel nesse momento, para registar a assiduidade. A localização da entrada é comparada com a zona de trabalho (parques e aeroportos). Todas as semanas, cerca de duas das tuas fotografias de entrada, escolhidas à sorte, são comparadas por uma pessoa com a tua foto de perfil. As horas que contam são as do ponto. As fotografias apagam-se 6 meses depois de o mês do ordenado fechar.",
  },
  exempt_v1: {
    mode: "exempt",
    title: "Isenção",
    text: "Picas quando e onde quiseres, com fotografia e localização. As horas de fim de semana pagam-se à parte, depois de validadas.",
  },
  always_on_v1: {
    mode: "always_on",
    title: "Sempre em serviço",
    text: "As tuas horas contam quando o Zello está ligado e estás perto do parque, e quando mexes em carros na Multipark. Com o Zello desligado não há localização e só contam os movimentos. As tuas entradas e saídas ficam registadas sozinhas, com a tua foto de perfil.",
  },
  extra_zone_v1: {
    mode: null,
    title: "Zona de trabalho (extras)",
    text: "A localização da tua entrada no ponto é comparada com a zona de trabalho (parques e aeroportos). Uma entrada feita fora da zona fica por validar e só é paga depois de validada.",
  },
  hours_model_v1: {
    mode: null,
    title: "Horas contadas ao mês (40 h por semana)",
    text: "As tuas horas contam-se ao mês: o total do ponto, menos 1 h de almoço nos dias de mais de 6 h, contra 40 h por semana (8 h por dia útil, sem feriados, férias e baixas). O que passar paga-se como horas a mais. Um dia mais curto compensa-se com um mais longo no mesmo mês. Se não concordares, diz-nos por escrito em 14 dias.",
  },
} as const satisfies Record<string, { mode: PontoMode | null; title: string; text: string }>;

export type PontoNoticeKey = keyof typeof PONTO_NOTICES;
export const PONTO_NOTICE_KEYS = Object.keys(PONTO_NOTICES) as PontoNoticeKey[];
export function isPontoNoticeKey(v: unknown): v is PontoNoticeKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PONTO_NOTICES, v);
}

/** O aviso que cada modo pede (versão em vigor). */
export function noticeForMode(mode: PontoMode | null | undefined): PontoNoticeKey | null {
  if (mode === "fixed") return "fixed_v1";
  if (mode === "exempt") return "exempt_v1";
  if (mode === "always_on") return "always_on_v1";
  return null;
}

export const PONTO_ACK_CHANNELS = ["app", "paper"] as const;
export type PontoAckChannel = (typeof PONTO_ACK_CHANNELS)[number];

export interface PontoAckLike { notice: string; channel: string; ackAt: string; ackByUserId?: number | null }
/** A leitura mais recente deste aviso (ou null). PURA. */
export function latestAck<T extends PontoAckLike>(acks: readonly T[], notice: PontoNoticeKey): T | null {
  let best: T | null = null;
  for (const a of acks) if (a.notice === notice && (!best || String(a.ackAt) > String(best.ackAt))) best = a;
  return best;
}

// ─── Alertas do ponto ───────────────────────────────────────────────────────

export const PONTO_ALERT_KINDS = [
  "outside_zone", "no_gps", "imprecise",
  "face_no_match", "face_uncertain", "face_no_face",
  "profile_photo_unvalidated", "long_shift", "exempt_weekend", "auto_day_warning",
] as const;
export type PontoAlertKind = (typeof PONTO_ALERT_KINDS)[number];
export function isPontoAlertKind(v: unknown): v is PontoAlertKind {
  return typeof v === "string" && (PONTO_ALERT_KINDS as readonly string[]).includes(v);
}

export const PONTO_ALERT_LABEL: Record<PontoAlertKind, string> = {
  outside_zone: "Fora da zona",
  no_gps: "Sem GPS",
  imprecise: "GPS impreciso",
  face_no_match: "A cara não bate",
  face_uncertain: "Cara duvidosa",
  face_no_face: "Sem cara na foto",
  profile_photo_unvalidated: "Foto de perfil por validar",
  long_shift: "Turno longo",
  exempt_weekend: "Isenção: fim de semana",
  auto_day_warning: "Dia automático com avisos",
};

/** A zona, as caras e o fim de semana da isenção: só o super admin vê. */
export const PONTO_ALERT_SUPER_ONLY: ReadonlySet<PontoAlertKind> = new Set<PontoAlertKind>([
  "outside_zone", "no_gps", "imprecise", "face_no_match", "face_uncertain", "face_no_face", "exempt_weekend",
]);

export const PONTO_ALERT_STATUSES = ["open", "seen", "justified", "confirmed"] as const;
export type PontoAlertStatus = (typeof PONTO_ALERT_STATUSES)[number];
export const PONTO_ALERT_STATUS_LABEL: Record<PontoAlertStatus, string> = {
  open: "Por ver",
  seen: "Visto",
  justified: "Justificado",
  confirmed: "Confirmado",
};

/**
 * Quem vê (e revê) um alerta do ponto. Ninguém na própria ficha; a zona, as
 * caras e o fim de semana da isenção só o super admin; os outros, o super
 * admin e quem gere a ficha (o RH da cidade). PURA.
 */
export function pontoAlertVisible(kind: string, viewer: { role: string; isOwn: boolean; canManage: boolean }): boolean {
  if (viewer.isOwn) return false;
  if (!isPontoAlertKind(kind)) return viewer.role === "super_admin";
  if (PONTO_ALERT_SUPER_ONLY.has(kind)) return viewer.role === "super_admin";
  return viewer.role === "super_admin" || viewer.canManage;
}

/**
 * Chave de um alerta, ÚNICA com a ficha (`UNIQUE (employeeId, dedupeKey)`):
 * o mesmo alerta (tipo, dia e registo) nunca se cria duas vezes. Não leva o id
 * da ficha: ao juntar fichas, a linha muda de `employeeId` e a chave continua
 * certa. PURA.
 */
export function pontoAlertDedupeKey(o: { kind: PontoAlertKind; day: string; timeRecordId?: number | null; faceCheckId?: number | null; autoDayId?: number | null }): string {
  const ref = o.timeRecordId ? `r${o.timeRecordId}` : o.faceCheckId ? `f${o.faceCheckId}` : o.autoDayId ? `a${o.autoDayId}` : "-";
  return `${o.kind}:${isoDay(o.day)}:${ref}`.slice(0, 120);
}

// ─── Rasto das picagens ─────────────────────────────────────────────────────
// Só informação: nenhuma conta de horas, de ordenado, de atrasos ou de faltas
// lê estas colunas (há teste).

export const PHOTO_SOURCES = ["camera", "file"] as const;
export type PhotoSource = (typeof PHOTO_SOURCES)[number];

export interface PontoTrailInput {
  /** a selfie veio da câmara ou de "Escolher foto" (ficheiro/galeria) */
  photoSource?: PhotoSource | string | null;
  /** idade do ficheiro escolhido (segundos), só como pista */
  photoFileAgeS?: number | null;
  /** imprecisão do GPS (metros) */
  gpsAccuracyM?: number | null;
}

/**
 * O rasto na entrada e na saída do ponto (`rh.timeRecords.checkIn/checkOut`).
 * Tolerante: um rasto estranho (texto onde vai um número, NaN, infinito…) fica
 * VAZIO em vez de recusar a picagem — o ponto nunca falha por causa do rasto.
 * Os valores são depois limpos em `pontoTrailColumns`.
 */
export const pontoTrailInputSchema = z.object({
  photoSource: z.string().max(16).nullable().optional(),
  photoFileAgeS: z.number().nullable().optional(),
  gpsAccuracyM: z.number().nullable().optional(),
}).optional().catch(undefined);

export interface PontoTrailColumns {
  pontoMode: PontoMode | null;
  photoSource: PhotoSource | null;
  photoFileAgeS: number | null;
  gpsAccuracyM: number | null;
  createdByUserId: number | null;
}

const TEN_YEARS_S = 10 * 366 * 86_400;
const intIn = (v: unknown, min: number, max: number): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/**
 * As colunas do rasto de uma picagem: o modo do dia, de onde veio a selfie (só
 * com selfie), a idade do ficheiro (só quando veio de um ficheiro), a
 * imprecisão do GPS e a conta que picou. Valores fora do normal são cortados
 * aos limites; o que não for número fica vazio. PURA.
 */
export function pontoTrailColumns(o: { input?: PontoTrailInput | null; hasPhoto: boolean; actorUserId: number | null; mode: PontoMode | null }): PontoTrailColumns {
  const raw = o.input?.photoSource;
  const source: PhotoSource | null = o.hasPhoto && typeof raw === "string" && (PHOTO_SOURCES as readonly string[]).includes(raw) ? (raw as PhotoSource) : null;
  return {
    pontoMode: o.mode ?? null,
    photoSource: source,
    photoFileAgeS: source === "file" ? intIn(o.input?.photoFileAgeS, 0, TEN_YEARS_S) : null,
    gpsAccuracyM: intIn(o.input?.gpsAccuracyM, 0, 1_000_000),
    createdByUserId: o.actorUserId != null && Number.isInteger(o.actorUserId) && o.actorUserId > 0 ? o.actorUserId : null,
  };
}

// ─── Juntar fichas ──────────────────────────────────────────────────────────

/**
 * Aviso da pré-visualização de "Juntar fichas" quando as duas têm modo do
 * ponto: o histórico das duas passa para a ficha que fica (nada se apaga) e o
 * modo confirma-se depois de juntar. Null = nada a dizer. PURA.
 */
export function pontoModeMergeWarning(o: { keepHistory: readonly PontoModeEntry[]; dropHistory: readonly PontoModeEntry[]; today: string }): string | null {
  if (!o.keepHistory.length && !o.dropHistory.length) return null;
  const keepMode = pontoModeOn(o.today, o.keepHistory);
  const dropMode = pontoModeOn(o.today, o.dropHistory);
  if (keepMode !== dropMode) {
    // os ids das linhas são da mesma tabela: o histórico junto lê-se como um só
    const merged = pontoModeOn(o.today, [...o.keepHistory, ...o.dropHistory]);
    return `Modo do ponto diferente: a ficha que fica tem "${pontoModeLabel(keepMode)}" e a que sai tinha "${pontoModeLabel(dropMode)}". O histórico das duas passa para a que fica, que fica em "${pontoModeLabel(merged)}"; confirma o modo em RH → ficha → Horário depois de juntar.`;
  }
  if (o.keepHistory.length && o.dropHistory.length) {
    return "As duas fichas têm histórico do modo do ponto: passa tudo para a que fica; confirma o modo em RH → ficha → Horário depois de juntar.";
  }
  return null;
}
