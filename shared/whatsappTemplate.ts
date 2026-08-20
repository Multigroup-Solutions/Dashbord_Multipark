/**
 * Templates WhatsApp usados na página de disponibilidade — catálogo + helpers PUROS.
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
 * os papéis são resolvidos pelos nomes declarados em `roles` (ver
 * `resolveBodyParamRoles`), para o nome do extra não ir parar ao campo do dia só
 * porque a Meta devolveu os parâmetros por outra ordem.
 */

/** Nome EXATO do template aprovado no WhatsApp Manager. */
export const AVAILABILITY_TEMPLATE_NAME = "disponibilidade_extras";

/**
 * Código de língua Meta. `pt_PT` (português europeu) ≠ `pt_BR` ≠ `pt` — a Meta
 * trata-os como traduções DISTINTAS e devolve 132001 se o template não estiver
 * aprovado exatamente nesta. O template `disponibilidade_extras` está aprovado
 * em `pt_BR` no WhatsApp Manager (confirmado 2026-08-04).
 */
export const DEFAULT_TEMPLATE_LANGUAGE = "pt_BR";

/** Nome usado no parâmetro do nome quando o destinatário não é um colaborador conhecido. */
export const UNKNOWN_RECIPIENT_NAME = "Teste";

// ─── Catálogo de templates ──────────────────────────────────────────────────

/**
 * Nomes REAIS dos parâmetros do body no WhatsApp Manager, por papel.
 * Só se aplica a templates com parâmetros NOMEADOS; nos posicionais o papel é
 * dado pela ordem (1º = nome, 2º = valor partilhado).
 */
export interface TemplateBodyRoles {
  /** Parâmetro que recebe o NOME do destinatário. */
  recipient: string;
  /** Parâmetro que recebe o valor único escrito no dialog. */
  shared: string;
}

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
  /** Nome EXATO aprovado no WhatsApp Manager. */
  name: string;
  /** Código de língua Meta da tradução aprovada. */
  language: string;
  /** Etiqueta curta para o seletor. */
  label: string;
  /** O que a mensagem faz — mostrado por baixo do seletor. */
  description: string;
  sharedParam: SharedParamSpec;
  roles: TemplateBodyRoles;
}

/**
 * Templates que a página de disponibilidade pode enviar.
 *
 * Acrescentar aqui um template APROVADO na Meta é tudo o que é preciso: o envio
 * lê os metadados reais (server/whatsappTemplateMeta.ts) e adapta-se ao formato,
 * contagem de parâmetros e botão URL. Só os PAPÉIS dos parâmetros é que a Meta
 * não sabe — é o que este catálogo declara.
 */
export const WHATSAPP_TEMPLATES: readonly WhatsAppTemplateDef[] = [
  {
    id: "disponibilidade",
    name: AVAILABILITY_TEMPLATE_NAME,
    language: DEFAULT_TEMPLATE_LANGUAGE,
    label: "Pedido de disponibilidade",
    description: "Pede ao extra que indique a disponibilidade da semana.",
    sharedParam: {
      label: "Semana",
      placeholder: "ex: semana de 12 a 19 de agosto",
      kind: "week",
    },
    roles: { recipient: "nome", shared: "semana" },
  },
  {
    id: "aviso_trabalho",
    name: "aviso_de_trabalho",
    language: "pt_BR",
    label: "Aviso de trabalho",
    description: "Avisa o extra de que tem trabalho num dia concreto.",
    sharedParam: {
      label: "Dia",
      placeholder: "ex: Sexta 22/08",
      kind: "day",
    },
    roles: { recipient: "customer_name", shared: "day" },
  },
] as const;

/** Template pré-selecionado no dialog (o fluxo original). */
export const DEFAULT_WHATSAPP_TEMPLATE_ID = "disponibilidade";

export function findWhatsAppTemplate(id: string): WhatsAppTemplateDef | undefined {
  return WHATSAPP_TEMPLATES.find((t) => t.id === id);
}

/**
 * Definição a partir do nome+língua que vieram no pedido — é assim que o
 * SERVIDOR descobre os papéis sem confiar em nada que o cliente mande.
 * A língua é opcional: um template com o mesmo nome noutra tradução mantém os
 * mesmos parâmetros.
 */
export function findWhatsAppTemplateByName(
  name: string,
  language?: string | null,
): WhatsAppTemplateDef | undefined {
  const sameName = WHATSAPP_TEMPLATES.filter((t) => t.name === name);
  if (!sameName.length) return undefined;
  if (!language) return sameName[0];
  const lang = language.toLowerCase();
  return sameName.find((t) => t.language.toLowerCase() === lang) ?? sameName[0];
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
