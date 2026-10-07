/**
 * Mensagens WhatsApp aos motoristas extra — catálogo + helpers PUROS.
 *
 * O NOME e a LÍNGUA de cada template dependem da cidade e vêm SEMPRE do registo
 * `shared/driverTemplates.ts` (fonte única). Este catálogo só diz que mensagens
 * existem e como a UI as pede.
 *
 * Partilhado entre o cliente (seletor e pré-visualização em ExtrasDiaPage) e o
 * servidor (montagem dos componentes do template). Ter isto num só sítio evita o
 * clássico "a UI manda pt_PT e o servidor assume pt" — a divergência de língua é
 * uma das causas do erro 132001 da Meta.
 *
 * Contrato COMUM a todos os templates suportados (WhatsApp Manager):
 *   1º parâmetro = nome do destinatário → preenchido AUTOMATICAMENTE, por destinatário
 *   2º parâmetro = valor partilhado      → texto único, escrito no dialog, igual para todos
 *
 * "1º/2º" é semântico, não posicional: quando o template usa parâmetros NOMEADOS,
 * os papéis são resolvidos pelos nomes declarados no registo por cidade
 * (`shared/driverTemplates.ts`, ver `resolveBodyParamRoles`), para o nome do
 * extra não ir parar ao campo do dia só porque a Meta devolveu os parâmetros
 * por outra ordem.
 */
import {
  DEFAULT_PARAMS,
  driverTemplate,
  findDriverTemplateByName,
  type City,
  type DriverMessage,
  type DriverTemplateParams,
  type ResolvedDriverTemplate,
} from "./driverTemplates";

/**
 * Respostas rápidas do aviso de turno (`driver_shift_notice` em Lisboa; o do
 * Porto também, se tiver os mesmos botões). Chegam ao webhook como mensagem
 * de tipo `button` com `context.id` = wamid do aviso (é isso que liga a
 * resposta ao turno).
 */
export const SHIFT_NOTICE_CONFIRM_LABEL = "Confirmo";
export const SHIFT_NOTICE_DECLINE_LABEL = "Não posso";

function foldLabel(v: string): string {
  return v.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Botão do aviso de turno → resposta; null = não é um destes botões. PURA. */
export function shiftNoticeButtonAction(text: string | null | undefined): "confirmed" | "declined" | null {
  const v = foldLabel(String(text ?? ""));
  if (!v) return null;
  if (v === foldLabel(SHIFT_NOTICE_CONFIRM_LABEL)) return "confirmed";
  if (v === foldLabel(SHIFT_NOTICE_DECLINE_LABEL)) return "declined";
  return null;
}

/**
 * Nome usado no {{1}} SÓ no envio de TESTE explícito (número escrito à mão que
 * não bate com nenhuma ficha). Nunca num envio real.
 */
export const UNKNOWN_RECIPIENT_NAME = "Teste";

/** {{1}} de um envio REAL quando o destinatário não tem nome utilizável. */
export const NEUTRAL_RECIPIENT_NAME = "colega";

// ─── Catálogo de templates ──────────────────────────────────────────────────

/**
 * Nomes REAIS dos parâmetros do body no WhatsApp Manager, por papel.
 * Só se aplica a templates com parâmetros NOMEADOS; nos posicionais o papel é
 * dado pela ordem (1º = nome, 2º = valor partilhado).
 */
export type TemplateBodyRoles = DriverTemplateParams;

/** Como a UI deve pedir o valor partilhado (2º parâmetro). */
export interface SharedParamSpec {
  label: string;
  placeholder: string;
  /**
   * `week` → texto livre (ex.: "semana de 12 a 19 de agosto").
   * `day`  → texto livre COM preenchimento rápido pelos dias da semana visível
   *          na tabela (mesmo padrão dos botões "Esta semana"/"Próxima semana").
   */
  kind: "week" | "day";
}

export interface WhatsAppTemplateDef {
  /** Id interno estável (a UI guarda isto, não o nome da Meta). */
  id: string;
  /** Mensagem do registo por cidade (nome e língua: `templateForCity`). */
  message: DriverMessage;
  /** Etiqueta curta para o seletor. */
  label: string;
  /** O que a mensagem faz — mostrado por baixo do seletor. */
  description: string;
  /**
   * Campo único do diálogo ({{2}}). `null` = template SEM parâmetros de body
   * (nem nome, nem campo): o envio não manda componente `body` nenhum.
   */
  sharedParam: SharedParamSpec | null;
  /**
   * Mensagem de EQUIPA (automática, para extras): se a Meta a reter por limite
   * de marketing (131049) tem direito a UMA nova tentativa passadas 24 h
   * (server/whatsappFailurePolicy.ts). Recrutamento e envios à mão não.
   */
  teamRetry?: boolean;
}

/** O template (de qualquer cidade) é uma mensagem de equipa com direito a 1 nova tentativa após 131049? PURA. */
export function isTeamRetryTemplate(name: string | null | undefined): boolean {
  if (!name) return false;
  return findWhatsAppTemplateByName(name)?.def.teamRetry === true;
}

/** O template `name` é a mensagem `message` nalguma cidade do registo? PURA. */
export function isDriverMessageTemplate(name: string | null | undefined, message: DriverMessage): boolean {
  return !!name && findDriverTemplateByName(name)?.message === message;
}

/** Templates sem parâmetros de body não levam `components.body` (a Meta responde 132000 se levarem). */
export function templateHasBodyParams(def: Pick<WhatsAppTemplateDef, "message">): boolean {
  return DEFAULT_PARAMS[def.message] !== null;
}

/**
 * Mensagens que a dashboard pode enviar aos motoristas. Acrescentar uma
 * cidade não mexe aqui (é só uma entrada no registo); uma MENSAGEM nova é uma
 * entrada aqui + uma por cidade no registo. O envio lê os metadados reais
 * (server/whatsappTemplateMeta.ts) e adapta-se ao formato, contagem de
 * parâmetros e botão URL.
 */
export const WHATSAPP_TEMPLATES: readonly WhatsAppTemplateDef[] = [
  {
    id: "disponibilidade",
    message: "AVAILABILITY",
    label: "Pedido de disponibilidade",
    description: "Pede ao extra que indique a disponibilidade da semana.",
    sharedParam: {
      label: "Semana",
      placeholder: "ex: semana de 12 a 19 de agosto",
      kind: "week",
    },
    teamRetry: true,
  },
  {
    id: "aviso_trabalho",
    message: "WORK_NOTICE",
    label: "Aviso de trabalho",
    description: "Avisa o extra de que tem trabalho num dia concreto.",
    sharedParam: {
      label: "Dia",
      placeholder: "ex: Sexta 22/08",
      kind: "day",
    },
    teamRetry: true,
  },
  {
    id: "turno_confirmado",
    message: "CONFIRMED_SHIFT",
    label: "Turno confirmado",
    description: "Confirma o turno a quem aceitou o aviso de trabalho. Sai sozinho quando o extra aceita; aqui é para reenviar.",
    sharedParam: {
      label: "Turno",
      placeholder: "ex: Sexta 22/08",
      kind: "day",
    },
    teamRetry: true,
  },
  // Dois templates SEM parâmetros (Jorge, 2026-09-17): o texto é fixo na Meta,
  // por isso não há nome nem campo do diálogo a preencher.
  {
    id: "seja_motorista",
    message: "RECRUITMENT",
    label: "Seja motorista (recrutamento)",
    description: "Convida um contacto a tornar-se extra/motorista da Multipark. Sem campos a preencher.",
    sharedParam: null,
  },
  {
    id: "morada_regras",
    message: "ADDRESS_RULES",
    label: "Morada e regras",
    description: "Envia a morada e as regras a quem vem trabalhar. Sem campos a preencher.",
    sharedParam: null,
    teamRetry: true,
  },
] as const;

/** Template usado na página de leads de extras (contactos que ainda não são extras). */
export const LEAD_RECRUITMENT_TEMPLATE_ID = "seja_motorista";

/** Confirmação enviada quando o extra aceita o aviso de trabalho. */
export const CONFIRMED_SHIFT_TEMPLATE_ID = "turno_confirmado";

/** Template pré-selecionado no dialog (o fluxo original). */
export const DEFAULT_WHATSAPP_TEMPLATE_ID = "disponibilidade";

export function findWhatsAppTemplate(id: string): WhatsAppTemplateDef | undefined {
  return WHATSAPP_TEMPLATES.find((t) => t.id === id);
}

/** Nome, língua e parâmetros do template desta mensagem nesta cidade (do registo); null = a cidade não o tem. */
export function templateForCity(def: Pick<WhatsAppTemplateDef, "message">, city: City): ResolvedDriverTemplate | null {
  return driverTemplate(city, def.message);
}

/**
 * Mensagem + cidade a partir do NOME do template: é assim que o SERVIDOR
 * descobre a língua e os papéis sem confiar em nada que o cliente mande.
 * undefined para templates fora do registo (ex.: alertas operacionais).
 */
export function findWhatsAppTemplateByName(
  name: string,
): { def: WhatsAppTemplateDef; tpl: ResolvedDriverTemplate } | undefined {
  const tpl = findDriverTemplateByName(name);
  if (!tpl) return undefined;
  const def = WHATSAPP_TEMPLATES.find((t) => t.message === tpl.message);
  return def ? { def, tpl } : undefined;
}

// ─── Papéis dos parâmetros do body ──────────────────────────────────────────

export type BodyParamRole = "recipient" | "shared" | "unknown";

/**
 * Papel de CADA parâmetro do body, por ordem de aparição no texto do template. PURA.
 *
 * Preferência: mapear pelos NOMES declarados no catálogo (é o único mapeamento
 * que continua correto se o template trocar a ordem dos parâmetros). Só se aceita
 * o mapeamento por nome quando ele cobre TODOS os parâmetros — um nome
 * desconhecido significa que o template mudou, e aí a ordem é mais fiável do que
 * um palpite.
 *
 * Recurso: posicional — 1º = nome do destinatário, 2º = valor partilhado.
 */
export function resolveBodyParamRoles(
  paramNames: readonly string[] | null | undefined,
  paramCount: number,
  roles?: TemplateBodyRoles | null,
): BodyParamRole[] {
  const names = paramNames ?? [];
  if (roles && paramCount > 0 && names.length === paramCount) {
    const byName = names.map<BodyParamRole>((n) =>
      n === roles.recipient ? "recipient" : n === roles.shared ? "shared" : "unknown",
    );
    if (!byName.includes("unknown")) return byName;
  }
  return Array.from({ length: Math.max(0, paramCount) }, (_, i) =>
    i === 0 ? "recipient" : i === 1 ? "shared" : "unknown",
  );
}

/**
 * Valores do body pela ordem que o template espera. PURA.
 *
 * Os valores vazios no FIM são cortados: um template de 2 parâmetros com o campo
 * partilhado por preencher envia só 1 parâmetro, exactamente como antes deste
 * catálogo existir (a Meta rejeita parâmetros vazios com 132000).
 */
export function orderBodyValues(
  roleSlots: readonly BodyParamRole[],
  values: { recipient: string; shared?: string | null },
): string[] {
  const out = roleSlots.map((role) =>
    role === "recipient" ? values.recipient : role === "shared" ? (values.shared ?? "") : "",
  );
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Texto a mostrar no inbox para UMA mensagem. PURA.
 *
 * As mensagens de template enviadas ANTES de 2026-08-20 foram gravadas com
 * `body` NULL (só ficava o nome do template), por isso apareciam como uma bolha
 * vazia. Não há forma de as reconstruir — o texto aprovado na Meta pode ter
 * mudado e os valores por destinatário não ficaram guardados — logo diz-se isso
 * explicitamente em vez de fingir conteúdo. Os envios novos gravam o texto real.
 *
 * Devolve string vazia quando não há nada a dizer (a UI decide o placeholder).
 */
export function messageDisplayBody(msg: {
  body?: string | null;
  type?: string | null;
  templateName?: string | null;
}): string {
  const body = msg.body?.trim();
  if (body) return body;
  if (msg.type !== "template") return "";
  return msg.templateName
    ? `Mensagem de template “${msg.templateName}” (conteúdo não registado)`
    : "Mensagem de template (conteúdo não registado)";
}

/**
 * Texto do template com os parâmetros substituídos — para pré-visualizar o que
 * vai ser enviado. PURA.
 *
 * Usa os MESMOS papéis do envio (`resolveBodyParamRoles`), por isso a
 * pré-visualização não pode divergir do que a Meta recebe. Um parâmetro sem
 * valor fica com o placeholder original à vista (é o sinal de que falta
 * preencher). Nomes repetidos no texto partilham o mesmo valor.
 */
export function previewTemplateBody(
  bodyText: string,
  roleSlots: readonly BodyParamRole[],
  values: { recipient: string; shared?: string | null },
): string {
  const slotOf = new Map<string, number>();
  let nextSlot = 0;
  return bodyText.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (full, token: string) => {
    let slot = slotOf.get(token);
    if (slot === undefined) {
      slot = nextSlot++;
      slotOf.set(token, slot);
    }
    const role = roleSlots[slot];
    if (role === "recipient") return values.recipient || full;
    if (role === "shared") return values.shared?.trim() ? values.shared : full;
    return full;
  });
}

/** A Meta rejeita parâmetros muito longos; 512 é folgado para nome/semana. */
export const MAX_TEMPLATE_PARAM_LEN = 512;

/**
 * Limpa um valor para poder ir como parâmetro de template.
 *
 * A Meta REJEITA parâmetros com newlines, tabs ou 5+ espaços seguidos
 * (erro 132000/100). Colapsa tudo para um espaço simples e corta ao limite.
 */
export function sanitizeTemplateParam(raw: string, maxLen = MAX_TEMPLATE_PARAM_LEN): string {
  return raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maxLen);
}

/**
 * Primeiro nome de um nome completo — é assim que o email de disponibilidade
 * já trata os extras ("Olá João,"), por isso o WhatsApp usa o mesmo critério.
 * Devolve null quando não há nada aproveitável.
 */
export function firstNameOf(fullName: string | null | undefined): string | null {
  if (!fullName) return null;
  const clean = sanitizeTemplateParam(fullName, 64);
  if (!clean) return null;
  return clean.split(" ")[0] || null;
}
