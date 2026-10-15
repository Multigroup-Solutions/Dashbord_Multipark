/**
 * LISTA BRANCA dos valores VIVOS que a ferramenta `regras_em_vigor(modulo)`
 * do Multis pode mostrar (plano MPV, §3.3, F2). É uma lista branca, NÃO uma
 * lista negra: o que não está aqui nunca sai, mesmo que exista nas Definições.
 *
 * Porquê: as Definições e os interruptores só se leem hoje nas Definições,
 * que são só de admin (server/settingsRouter.ts: `values.list` e
 * `flags.list` são `adminOnly`). O Multis não pode abrir essa porta. Por isso
 * cada entrada diz QUEM já vê o valor hoje:
 *   - `visibleTo: "admin"` → só admin e super admin (como nas Definições);
 *   - `visibleTo: { module, seenIn }` → também quem tem `view` nesse módulo,
 *     porque um ecrã/procedimento desse módulo JÁ o mostra hoje (`seenIn`
 *     diz qual). Sem esta prova, a entrada fica "admin".
 *
 * NUNCA entra aqui (os testes em server/assistant/rulesTool.test.ts e o
 * filtro `liveEntryForbiddenReason` em execução verificam):
 *   - nada de `ai.*` nem interruptores de IA (grupo "ia", AI_*, MPV);
 *   - integrações (Google, Gmail, Windsor/GBP, Central, Stripe/Viva/
 *     InvoiceExpress, WhatsApp chamadas…) e os grupos emails/marketing/
 *     notificações;
 *   - chaves, segredos, tokens, palavras-passe, preços, valores em euros e
 *     taxas financeiras (grupo financeiro);
 *   - nada `superAdminOnly` (definições em SUPER_ADMIN_SETTING_KEYS e
 *     interruptores com `superAdminOnly`) — por isso os parâmetros dos tempos
 *     (serviceTimes.*) não estão: só o super admin os muda.
 *
 * Para acrescentar: a chave tem de existir no registo (SETTINGS ou
 * AUTOMATION_FLAGS — há teste), o módulo tem de ser um dos de
 * shared/rulesInForce.ts, e o `visibleTo` com módulo leva a prova em `seenIn`.
 */
import type { ModuleId } from "./access";
import type { RuleModuleId } from "./rulesInForce";

export interface LiveValueEntry {
  kind: "setting" | "flag";
  /** Chave da definição (SETTINGS) ou nome do interruptor (AUTOMATION_FLAGS). */
  key: string;
  visibleTo: "admin" | { module: ModuleId; seenIn: string };
  /**
   * Valor por cidade ({ lisbon, porto, faro }): só saem as cidades da pessoa
   * (como a Pressão, que só devolve as cidades do âmbito de quem pergunta).
   */
  perCity?: true;
}

export const RULES_LIVE_WHITELIST: Readonly<Record<RuleModuleId, readonly LiveValueEntry[]>> = {
  avaliacao: [
    // Só admin: o Histórico diário (operational.driverHistory) mostra o LIMIAR em uso (limite × tolerância), não a
    // regra inteira (pontos seguidos) — a regra completa só se vê nas Definições.
    { kind: "setting", key: "gps.speedRule", visibleTo: "admin" },
    { kind: "flag", key: "GPS_SPEED_ALERTS", visibleTo: "admin" },
  ],
  extras_dia: [
    // A página do Extras Dia mostra "Proposta automática às … · confirmação e avisos automáticos às …" (extrasDia.schedule → settings).
    { kind: "setting", key: "extras.autoProposeAt", visibleTo: { module: "extras_dia", seenIn: "extrasDia.schedule (settings.autoProposeAt)" } },
    { kind: "setting", key: "extras.autoProposeDaysAhead", visibleTo: { module: "extras_dia", seenIn: "extrasDia.schedule (settings.daysAhead)" } },
    { kind: "setting", key: "extras.autoConfirm", visibleTo: { module: "extras_dia", seenIn: "extrasDia.schedule (settings.autoConfirm)" } },
    { kind: "setting", key: "extras.autoConfirmAt", visibleTo: { module: "extras_dia", seenIn: "extrasDia.schedule (settings.autoConfirmAt)" } },
    // A Pressão devolve, por cidade, o percentil, as faixas da tabela e se usa os tempos medidos; a janela começa em extras.timesSince.
    { kind: "setting", key: "extras.timesPercentile", visibleTo: { module: "extras_dia", seenIn: "extrasDia.pressure (cities[].percentile)" }, perCity: true },
    { kind: "setting", key: "extras.useMeasuredTimes", visibleTo: { module: "extras_dia", seenIn: "extrasDia.pressure (cities[].useMeasured)" }, perCity: true },
    { kind: "setting", key: "extras.crewRules", visibleTo: { module: "extras_dia", seenIn: "extrasDia.pressure (cities[].bands)" }, perCity: true },
    { kind: "setting", key: "extras.timesSince", visibleTo: { module: "extras_dia", seenIn: "extrasDia.pressure (windowStart)" } },
    { kind: "setting", key: "extras.tightUsesQueue", visibleTo: { module: "extras_dia", seenIn: "extrasDia.pressure (times.cities[].tightUsesQueue)" }, perCity: true },
    { kind: "setting", key: "extras.pairPickups", visibleTo: "admin", perCity: true },
    { kind: "flag", key: "EXTRAS_AUTOMATION", visibleTo: "admin" },
    { kind: "flag", key: "TRAINING_BLOCKS_ESCALA", visibleTo: "admin" },
  ],
  // Os parâmetros dos tempos (serviceTimes.*) e o trabalho SERVICE_TIMES são só do super admin → nenhum valor vivo.
  tempos: [],
  // As regras das despesas são do código (papéis), sem definições.
  despesas: [],
  parcerias: [
    { kind: "flag", key: "PARTNER_CLOSE_ALERTS", visibleTo: "admin" },
  ],
  casos: [
    // O quadro dos Perdidos pede o prazo para as cores do "Parado há N dias" (lostFound.slaDays).
    { kind: "setting", key: "sla.lostFoundDays", visibleTo: { module: "perdidos", seenIn: "lostFound.slaDays / lostFound.getById (slaDays)" } },
    { kind: "setting", key: "sla.incidentHours", visibleTo: "admin" },
    { kind: "flag", key: "CASE_REMINDERS", visibleTo: "admin" },
    { kind: "flag", key: "COMPLAINT_AUTO_ACK", visibleTo: "admin" },
  ],
  // Os interruptores das críticas são de IA ou de integrações (Windsor/GBP) → nenhum valor vivo.
  criticas: [],
};

/** Prefixos/nomes de interruptores que nunca saem (IA, integrações, MPV). */
const FORBIDDEN_FLAG_RE = /^(AI_|MPV$|GBP_|CENTRAL_|CASH_|MAIL_|GOOGLE_|WHATSAPP_CALLS$|INTEGRATION_|ENTRAR_COM_CODIGO$|ACCOUNT_LINK_)/;
/** Grupos de definições que nunca saem (IA, integrações, notificações, financeiro). */
export const FORBIDDEN_SETTING_GROUPS: readonly string[] = ["ia", "emails", "marketing", "notificacoes", "financeiro"];
/** Palavras que denunciam chaves, segredos ou preços. */
const FORBIDDEN_WORD_RE = /key|secret|token|password|senha|price|pre[cç]o|eur\b|budget|apikey|webhook/i;

/**
 * Motivo para uma entrada NUNCA sair (ou null). Usa só o que se lhe passa
 * (registo e marcas), para ser PURA e igual no teste e em execução.
 */
export function liveEntryForbiddenReason(e: LiveValueEntry, reg: {
  settingGroup?: string | null; settingSuperAdminOnly?: boolean; flagGroup?: string | null; flagSuperAdminOnly?: boolean; exists: boolean;
}): string | null {
  if (!reg.exists) return "não existe no registo";
  if (e.key.startsWith("ai.")) return "ai.*";
  if (FORBIDDEN_WORD_RE.test(e.key)) return "chave/segredo/preço";
  if (e.kind === "setting") {
    if (reg.settingSuperAdminOnly) return "superAdminOnly";
    if (reg.settingGroup && FORBIDDEN_SETTING_GROUPS.includes(reg.settingGroup)) return `grupo ${reg.settingGroup}`;
  } else {
    if (reg.flagSuperAdminOnly) return "superAdminOnly";
    if (reg.flagGroup === "ia") return "interruptor de IA";
    if (FORBIDDEN_FLAG_RE.test(e.key)) return "IA ou integração";
  }
  return null;
}
