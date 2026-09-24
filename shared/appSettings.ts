/**
 * Definições da aplicação (página /definicoes) — regras PURAS, partilhadas
 * entre servidor (validação ao gravar) e cliente (validação no formulário).
 *
 *  - SETTINGS: definições editáveis (chave → schema zod + valor por omissão);
 *  - AUTOMATION_FLAGS: interruptores das automações que podem ser sobrepostos
 *    na BD (o resto das env vars NUNCA é sobreposto — ex.: INPROCESS_SCHEDULERS);
 *  - CRON_JOBS: os /api/cron/* agendados pelo GitHub Actions e o intervalo
 *    esperado de cada um (para detetar crons parados);
 *  - NOTIFICATION_KINDS: tipos de notificação na app que cada pessoa pode
 *    silenciar no seu Perfil.
 */
import { z } from "zod";
import { AI_FEATURE_IDS, AI_TIERS } from "./aiFeatures";

// ─── Taxas com data de efeito (IVA / TSU) ───────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const rateEntrySchema = z.object({
  /** Fração (0.23 = 23%). */
  rate: z.number({ error: "Taxa inválida." }).min(0, "A taxa não pode ser negativa.").max(1, "A taxa é uma fração (ex.: 0,23)."),
  /** Primeiro dia (Lisboa, AAAA-MM-DD) em que a taxa se aplica. */
  from: z.string().regex(ISO_DAY, "Data inválida (AAAA-MM-DD)."),
});
export type RateEntry = z.infer<typeof rateEntrySchema>;

export const rateScheduleSchema = z
  .array(rateEntrySchema)
  .min(1, "Indica pelo menos uma taxa.")
  .max(20, "No máximo 20 taxas.")
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const e of list) {
      if (seen.has(e.from)) ctx.addIssue({ code: "custom", message: `Data de efeito repetida: ${e.from}.` });
      seen.add(e.from);
    }
  })
  .transform((list) => [...list].sort((a, b) => a.from.localeCompare(b.from)));

/** Taxa em vigor num dia (a última com `from` <= dia); `null` se nenhuma. PURA. */
export function effectiveRate(list: readonly RateEntry[] | null | undefined, day: string): number | null {
  let best: RateEntry | null = null;
  for (const e of list ?? []) {
    if (e.from <= day && (!best || e.from > best.from)) best = e;
  }
  return best ? best.rate : null;
}

// ─── Registo das definições editáveis ───────────────────────────────────────

const emailSchema = z.string().trim().toLowerCase().email("Email inválido.").max(320);

export const emailListSchema = z
  .array(emailSchema)
  .max(20, "No máximo 20 emails.")
  .transform((list) => Array.from(new Set(list)));

/** Preço (EUR por 1M tokens) de um modelo de IA — sobreposição da tabela do código. */
export const aiModelPriceSchema = z.object({
  input: z.number({ error: "Preço de entrada inválido." }).min(0).max(1000),
  output: z.number({ error: "Preço de saída inválido." }).min(0).max(1000),
  cached: z.number().min(0).max(1000).optional(),
  audioInput: z.number().min(0).max(1000).optional(),
});
export const aiPriceOverridesSchema = z
  .record(z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/, "Nome de modelo inválido."), aiModelPriceSchema)
  .refine((r) => Object.keys(r).length <= 40, "No máximo 40 modelos.");
export type AiPriceOverrides = z.infer<typeof aiPriceOverridesSchema>;

/** Nível de modelo por funcionalidade de IA (só ids e níveis conhecidos). */
export const aiFeatureTiersSchema = z.record(
  z.string().refine((k) => (AI_FEATURE_IDS as readonly string[]).includes(k), "Funcionalidade de IA desconhecida."),
  z.enum(AI_TIERS as unknown as ["lite", "fast", "smart"], { error: "Nível inválido (lite, fast ou smart)." }),
);

export type SettingGroup = "financeiro" | "sla" | "emails" | "disponibilidade" | "ia" | "extras";

// ─── Extras-dia (escala automática) ─────────────────────────────────────────

/** Cidades do Extras-dia (mesmos ids do servidor: server/extrasDia.ts). */
export const EXTRAS_CITY_IDS = ["lisbon", "porto", "faro"] as const;
export type ExtrasCityId = (typeof EXTRAS_CITY_IDS)[number];

const carsPerHourValue = z
  .number({ error: "Indica um número de carros por hora." })
  .min(0.5, "Mínimo 0,5 carros/hora.")
  .max(20, "Máximo 20 carros/hora.");

/** Carros/hora que UM condutor despacha, por cidade (Lisboa 2, Porto 3, Faro 3). */
export const carsPerHourMapSchema = z.object({
  lisbon: carsPerHourValue,
  porto: carsPerHourValue,
  faro: carsPerHourValue,
}, { error: "Indica os carros/hora de Lisboa, Porto e Faro." });
export type CarsPerHourMap = z.infer<typeof carsPerHourMapSchema>;
export const DEFAULT_CARS_PER_HOUR: CarsPerHourMap = { lisbon: 2, porto: 3, faro: 3 };

/** Ponto de encontro por cidade (vai no aviso de escala); vazio = não se indica. */
export const meetingPointMapSchema = z.object({
  lisbon: z.string().trim().max(200, "Máximo 200 caracteres."),
  porto: z.string().trim().max(200, "Máximo 200 caracteres."),
  faro: z.string().trim().max(200, "Máximo 200 caracteres."),
});

/** Hora "HH:MM" (Lisboa). */
export const hhmmSchema = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida (HH:MM, ex.: 14:00).");

/** "14:30" → 870 (minutos desde a meia-noite). PURA. */
export function hhmmToMinutes(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}
/** Limites do tutor da formação (pedidos por pessoa). */
export const trainingTutorLimitsSchema = z.object({
  perMinute: z.number({ error: "Indica um número por minuto." }).int("Número inteiro.").min(1, "Mínimo 1 por minuto.").max(120, "Máximo 120 por minuto."),
  perDay: z.number({ error: "Indica um número por dia." }).int("Número inteiro.").min(1, "Mínimo 1 por dia.").max(5000, "Máximo 5000 por dia."),
});

/** Limites do assistente (chat): pedidos por pessoa e tamanho da pergunta. */
export const aiAssistantLimitsSchema = z.object({
  perMinute: z.number({ error: "perMinute tem de ser um número." }).int().min(1, "perMinute: mínimo 1.").max(120, "perMinute: máximo 120."),
  perDay: z.number({ error: "perDay tem de ser um número." }).int().min(1, "perDay: mínimo 1.").max(5000, "perDay: máximo 5000."),
  maxInputChars: z.number({ error: "maxInputChars tem de ser um número." }).int().min(100, "maxInputChars: mínimo 100.").max(4000, "maxInputChars: máximo 4000.").optional(),
}).strict();
export type AiAssistantLimits = z.infer<typeof aiAssistantLimitsSchema>;
export const AI_ASSISTANT_DEFAULT_LIMITS = { perMinute: 20, perDay: 200, maxInputChars: 1000 } as const;


export interface SettingDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  schema: S;
  defaultValue: z.input<S>;
  /** Onde o valor é usado; "store" = só guardado/mostrado (ainda não ligado ao código). */
  wiring: "live" | "store";
}

function def<S extends z.ZodTypeAny>(d: SettingDef<S>): SettingDef<S> {
  return d;
}

export const SETTINGS = {
  "finance.vat": def({
    key: "finance.vat",
    group: "financeiro",
    label: "IVA",
    description: "Taxa de IVA por data de efeito. Usada nos cálculos de Finanças (receita e despesas sem IVA) e de Marketing (ROAS s/ IVA) a partir da data de efeito; antes da primeira data usa-se 23%.",
    schema: rateScheduleSchema,
    defaultValue: [{ rate: 0.23, from: "2011-01-01" }],
    wiring: "live",
  }),
  "finance.tsu": def({
    key: "finance.tsu",
    group: "financeiro",
    label: "TSU (entidade patronal)",
    description: "Taxa Social Única a cargo da empresa, por data de efeito. Usada nos custos de pessoal em Finanças a partir da data de efeito; antes da primeira data usa-se 23,75%.",
    schema: rateScheduleSchema,
    defaultValue: [{ rate: 0.2375, from: "2011-01-01" }],
    wiring: "live",
  }),
  "sla.incidentHours": def({
    key: "sla.incidentHours",
    group: "sla",
    label: "Prazo das ocorrências (horas)",
    description: "Prazo de resolução dado a cada ocorrência nova. Sobrepõe-se a INCIDENT_SLA_HOURS.",
    schema: z.number({ error: "Indica um número de horas." }).int("Número inteiro de horas.").min(1, "Mínimo 1 hora.").max(720, "Máximo 720 horas (30 dias)."),
    defaultValue: 48,
    wiring: "live",
  }),
  "sla.lostFoundDays": def({
    key: "sla.lostFoundDays",
    group: "sla",
    label: "Prazo dos perdidos e achados (dias)",
    description: "Referência do prazo dos perdidos e achados. Por agora só fica registado.",
    schema: z.number({ error: "Indica um número de dias." }).int("Número inteiro de dias.").min(1, "Mínimo 1 dia.").max(90, "Máximo 90 dias."),
    defaultValue: 7,
    wiring: "store",
  }),
  "sync.webhookStaleHours": def({
    key: "sync.webhookStaleHours",
    group: "sla",
    label: "Alerta sem notificações Multipark (horas)",
    description: "Se não chegar nenhum webhook da Multipark durante este número de horas, em horário de operação (07h–23h, Lisboa), os admins recebem um aviso na app (uma vez, e outra quando voltarem).",
    schema: z.number({ error: "Indica um número de horas." }).int("Número inteiro de horas.").min(1, "Mínimo 1 hora.").max(48, "Máximo 48 horas."),
    defaultValue: 3,
    wiring: "live",
  }),
  "emails.handoverCc": def({
    key: "emails.handoverCc",
    group: "emails",
    label: "Cópia do email da passagem de turno",
    description: "Emails em CC na passagem de turno (além dos team leaders). Vazio = usa HANDOVER_EMAIL_CC.",
    schema: emailListSchema,
    defaultValue: [],
    wiring: "live",
  }),
  "availability.assigneeEmail": def({
    key: "availability.assigneeEmail",
    group: "disponibilidade",
    label: "Responsável pelas disponibilidades a confirmar",
    description: "Email da pessoa a quem são atribuídas as tarefas \"Disponibilidade a confirmar\". Vazio = usa AVAILABILITY_TASK_ASSIGNEE_EMAIL.",
    schema: z.union([z.literal(""), emailSchema]),
    defaultValue: "",
    wiring: "live",
  }),
  "ai.monthlyBudgetEur": def({
    key: "ai.monthlyBudgetEur",
    group: "ia",
    label: "Orçamento mensal da IA (€)",
    description: "Teto de gasto estimado da IA por mês civil (UTC). Ao chegar a 100%, as funcionalidades não essenciais respondem \"IA temporariamente indisponível\" e os admins recebem um aviso (uma vez por mês); as essenciais (leitura de faturas) param aos 150%. 0 = sem limite. Vazio = usa AI_MONTHLY_BUDGET_EUR (ou 30 €).",
    schema: z.number({ error: "Indica um valor em euros." }).min(0, "Não pode ser negativo.").max(100_000, "Máximo 100 000 €."),
    defaultValue: 30,
    wiring: "live",
  }),
  "ai.featureTiers": def({
    key: "ai.featureTiers",
    group: "ia",
    label: "Nível de modelo por funcionalidade de IA",
    description: "Sobrepõe o nível (lite = o mais barato, fast, smart) de cada funcionalidade. JSON: {\"expense_ocr\": \"fast\"}. Funcionalidades: " + AI_FEATURE_IDS.join(", ") + ". Vazio = omissão do código (quase tudo lite).",
    schema: aiFeatureTiersSchema,
    defaultValue: {},
    wiring: "live",
  }),
  "ai.assistantLimits": def({
    key: "ai.assistantLimits",
    group: "ia",
    label: "Limites do assistente (chat)",
    description: "Pedidos por pessoa ao assistente e tamanho máximo da pergunta. JSON: {\"perMinute\": 20, \"perDay\": 200, \"maxInputChars\": 1000}. Acima do limite, a pessoa vê \"Muitos pedidos\" e o tempo de espera.",
    schema: aiAssistantLimitsSchema,
    defaultValue: { ...AI_ASSISTANT_DEFAULT_LIMITS },
    wiring: "live",
  }),
  "ai.priceOverridesEur": def({
    key: "ai.priceOverridesEur",
    group: "ia",
    label: "Preços dos modelos de IA (€ por 1M tokens)",
    description: "Sobrepõe a tabela de preços do código (server/_core/ai/pricing.ts) para calcular o custo registado. JSON: {\"<modelo>\": {\"input\": 0.22, \"output\": 1.3, \"cached\": 0.02}}. Vazio = tabela do código.",
    schema: aiPriceOverridesSchema,
    defaultValue: {},
    wiring: "live",
  }),
  "extras.carsPerHourPerDriver": def({
    key: "extras.carsPerHourPerDriver",
    group: "extras",
    label: "Carros por hora por condutor",
    description: "Quantos carros (recolhas + entregas, pesados por tipo de entrega) um condutor despacha por hora, por cidade. Define quantos condutores a previsão do Extras-dia pede em cada hora e a proposta automática de escala.",
    schema: carsPerHourMapSchema,
    defaultValue: DEFAULT_CARS_PER_HOUR,
    wiring: "live",
  }),
  "extras.autoProposeAt": def({
    key: "extras.autoProposeAt",
    group: "extras",
    label: "Hora da proposta automática de escala",
    description: "A partir desta hora (Lisboa) o sistema propõe a escala dos próximos dias com os extras disponíveis (uma vez por dia e cidade; não substitui uma escala já proposta ou confirmada).",
    schema: hhmmSchema,
    defaultValue: "14:00",
    wiring: "live",
  }),
  "extras.autoProposeDaysAhead": def({
    key: "extras.autoProposeDaysAhead",
    group: "extras",
    label: "Dias propostos com antecedência",
    description: "Quantos dias à frente a proposta automática cobre (1 = só amanhã).",
    schema: z.number({ error: "Indica um número de dias." }).int("Número inteiro de dias.").min(1, "Mínimo 1 dia.").max(7, "Máximo 7 dias."),
    defaultValue: 1,
    wiring: "live",
  }),
  "extras.autoConfirm": def({
    key: "extras.autoConfirm",
    group: "extras",
    label: "Confirmar e avisar automaticamente",
    description: "Se ligado, a proposta de amanhã que ninguém confirmou nem suspendeu é confirmada à hora indicada abaixo e os extras são avisados por WhatsApp e email.",
    schema: z.boolean({ error: "Ligado ou desligado." }),
    defaultValue: true,
    wiring: "live",
  }),
  "extras.autoConfirmAt": def({
    key: "extras.autoConfirmAt",
    group: "extras",
    label: "Hora da confirmação automática",
    description: "Hora (Lisboa) a partir da qual a proposta de amanhã é confirmada e enviada automaticamente (se não estiver suspensa).",
    schema: hhmmSchema,
    defaultValue: "18:00",
    wiring: "live",
  }),
  "extras.meetingPoints": def({
    key: "extras.meetingPoints",
    group: "extras",
    label: "Ponto de encontro (aviso de escala)",
    description: "Texto curto com o ponto de encontro de cada cidade, incluído no WhatsApp e no email de escala. Vazio = não se indica.",
    schema: meetingPointMapSchema,
    defaultValue: { lisbon: "", porto: "", faro: "" },
    wiring: "live",
  }),
  "ai.trainingTutorLimits": def({
    key: "ai.trainingTutorLimits",
    group: "ia",
    label: "Tutor da formação: limite de perguntas",
    description: "Perguntas ao tutor da formação por pessoa, por minuto e por dia. JSON: {\"perMinute\": 10, \"perDay\": 100}. Vazio = usa AI_TRAINING_TUTOR_PER_MINUTE / AI_TRAINING_TUTOR_PER_DAY (ou 10 e 100).",
    schema: trainingTutorLimitsSchema,
    defaultValue: { perMinute: 10, perDay: 100 },
    wiring: "live",
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]["schema"]>;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key);
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Valida (e normaliza) o valor de uma definição. PURA. */
export function validateSetting<K extends SettingKey>(key: K, value: unknown): ValidationResult<SettingValue<K>>;
export function validateSetting(key: string, value: unknown): ValidationResult<unknown>;
export function validateSetting(key: string, value: unknown): ValidationResult<unknown> {
  if (isFlagSettingKey(key)) {
    return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "O interruptor só aceita ligado/desligado." };
  }
  if (!isSettingKey(key)) return { ok: false, error: `Definição desconhecida: ${key}` };
  const r = SETTINGS[key].schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => i.message).join(" ") || "Valor inválido." };
}

// ─── Interruptores das automações ───────────────────────────────────────────

export interface AutomationFlag {
  name: string;
  label: string;
  description: string;
  /** Valor sem env nem sobreposição (omissão: ligado). */
  defaultEnabled?: boolean;
  /** Secção na página (omissão: automações gerais). */
  group?: "ia";
}

export const AUTOMATION_FLAGS: readonly AutomationFlag[] = [
  { name: "EXTRAS_AUTOMATION", label: "Automação dos extras", description: "Pedido de disponibilidade à quinta, lembrete ao sábado, aviso de escala e alerta de cobertura (cron horário)." },
  { name: "LEAD_REMINDERS", label: "Lembretes das leads de extras", description: "Lembretes automáticos às leads que ainda não responderam." },
  { name: "LEAD_AUTO_REPLY", label: "Resposta automática às leads", description: "Envia o link da candidatura às leads novas." },
  { name: "TASKS_AUTOMATION", label: "Automação das tarefas", description: "Checklists do dia e avisos de atraso/conclusão." },
  { name: "CASE_REMINDERS", label: "Lembretes de SLA dos casos", description: "Avisa quando ocorrências/perdidos passam do prazo." },
  { name: "COMPLAINT_AUTO_ACK", label: "Aviso de receção das reclamações", description: "Responde automaticamente ao cliente quando chega uma reclamação por email." },
  { name: "HANDOVER_EMAIL", label: "Email da passagem de turno", description: "Envia a passagem de turno por email aos team leaders." },
  { name: "HANDOVER_REMINDERS", label: "Lembretes da passagem de turno", description: "Lembra quem ainda não entregou/confirmou a passagem." },
  { name: "TRAINING_REMINDERS", label: "Lembretes da formação", description: "Avisa quem tem formação por concluir." },
  { name: "TRAINING_BLOCKS_ESCALA", label: "Formação bloqueia a escala", description: "Quem tem formação obrigatória em atraso não entra na escala." },
  { name: "OPS_BRIEFING", label: "Briefing diário por cidade", description: "Às 07:30 (Lisboa): reservas do dia, extras, SLA, pendentes e alertas por email aos team leaders/supervisores da cidade e no Dashboard." },
  { name: "WEEKLY_REPORTS", label: "Relatórios semanais", description: "À segunda de manhã: direção, marketing, operações e RH por email a quem tem acesso nacional ao módulo; resumo semanal da passagem de turno." },
  { name: "OPS_ANOMALIES", label: "Deteção de anomalias", description: "Todos os dias: reservas por parque/canal, despesas (valores fora do normal e duplicados) e gasto/ROAS do marketing." },
  // ── IA (server/_core/ai) — AI_ENABLED desliga tudo de uma vez ──
  { name: "AI_ENABLED", label: "IA (interruptor geral)", description: "Desligado = nenhuma funcionalidade de IA faz pedidos ao fornecedor.", group: "ia" },
  { name: "AI_EXPENSE_OCR", label: "IA: leitura de faturas", description: "Extrai fornecedor, valor, datas e NIF das faturas carregadas nas Despesas.", group: "ia" },
  { name: "AI_REVIEW_DRAFTS", label: "IA: rascunhos de resposta às críticas", description: "Prepara a resposta às críticas Google (nunca publica sozinha).", group: "ia" },
  { name: "AI_RADIO", label: "IA: transcrição e resumo do rádio", description: "Transcreve as mensagens de rádio e resume-as em 1–2 frases.", group: "ia" },
  { name: "AI_HANDOVER_SUMMARY", label: "IA: resumo da passagem de turno", description: "5 pontos para o team leader do turno seguinte.", group: "ia" },
  { name: "AI_WHATSAPP_ASSIST", label: "IA: assistente do WhatsApp", description: "Resumo da conversa e sugestão de resposta (vai para a caixa de texto, nunca é enviada sozinha).", group: "ia" },
  { name: "AI_QUIZ", label: "IA: perguntas da formação", description: "Gera rascunhos de perguntas a partir dos manuais.", group: "ia" },
  { name: "AI_TRAINING_TUTOR", label: "IA: tutor da formação", description: "Chat nas páginas da Formação: responde só com o conteúdo dos manuais, motiva e explica as respostas erradas do quiz.", group: "ia" },
  { name: "AI_COMPLAINT_TRIAGE", label: "IA: triagem das reclamações por email", description: "Sugere tipo, prioridade, SLA, reserva e duplicados e prepara um rascunho de resposta (nunca é enviado sozinho). Só aplica sozinha com confiança alta e campo vazio.", group: "ia" },
  { name: "AI_REVIEW_AUTO_DRAFTS", label: "IA: rascunho automático para cada crítica nova", description: "Prepara a resposta às críticas Google novas (fica por aprovar; nunca publica sozinha).", group: "ia" },
  { name: "AI_WHATSAPP_TRIAGE", label: "IA: intenção e urgência no WhatsApp", description: "Etiqueta as conversas (reserva, cancelamento, reclamação…) e marca as urgentes (entram no aviso de SLA). No máximo 1× a cada poucos minutos por conversa; nunca responde sozinha.", group: "ia" },
  { name: "AI_LOST_FOUND_MATCH", label: "IA: correspondências nos Perdidos & Achados", description: "Compara as descrições dos perdidos com os objetos encontrados (depois de um filtro por data, matrícula/reserva e parque). Contactar o cliente é sempre humano.", group: "ia" },
  { name: "AI_ASSISTANT", label: "IA: assistente (chat)", description: "Botão de ajuda em todas as páginas: explica como se usa a app e responde a perguntas sobre os dados que a pessoa já pode ver (só leitura).", group: "ia" },
  { name: "AI_HR_AUTOFILL", label: "IA: preenchimento a partir de documentos do RH", description: "Lê CC, título de residência, carta, IBAN e morada para preencher campos vazios da ficha. Desligado por omissão até decisão RGPD.", defaultEnabled: false, group: "ia" },
  { name: "AI_OPS_BRIEFING", label: "IA: texto do briefing diário", description: "Escreve o parágrafo do briefing das 07:30 por cidade (os números vêm sempre do sistema).", group: "ia" },
  { name: "AI_WEEKLY_REPORTS", label: "IA: texto dos relatórios semanais", description: "Narrativa curta dos relatórios de segunda-feira (direção, marketing, operações, RH).", group: "ia" },
  { name: "AI_ANOMALY_EXPLAIN", label: "IA: explicação das anomalias", description: "Uma linha por anomalia detetada (reservas, despesas, marketing). A deteção é estatística, sem IA.", group: "ia" },
  { name: "AI_AVAILABILITY_CLASSIFY", label: "IA: respostas de disponibilidade pouco claras", description: "Classifica as respostas que o sistema não percebeu. Confiança alta aplica-se sozinha; o resto vai para revisão humana.", group: "ia" },
  { name: "AI_LEAD_SCORING", label: "IA: resumo e 1.º contacto das leads", description: "Resumo de uma linha da pontuação (calculada no sistema) e rascunho do 1.º contacto, que precisa de aprovação.", group: "ia" },
  { name: "AI_EVALUATION_EXPLAIN", label: "IA: explicação da avaliação", description: "Explica em PT-PT a pontuação a partir das linhas das regras (nunca recalcula).", group: "ia" },
  { name: "AI_HANDOVER_REPEATS", label: "IA: pendentes repetidos da passagem de turno", description: "Redige os pendentes que se repetem entre turnos e o resumo semanal por cidade.", group: "ia" },
  { name: "AI_TASKS_FROM_TEXT", label: "IA: tarefas a partir de texto", description: "Propõe tarefas a partir de notas coladas; nada é criado sem confirmação.", group: "ia" },
];

/** Omissão de um interruptor do catálogo (desconhecido → ligado). PURA. */
export function automationFlagDefault(name: string): boolean {
  return AUTOMATION_FLAGS.find((f) => f.name === name)?.defaultEnabled ?? true;
}

export const FLAG_SETTING_PREFIX = "flag.";
const FLAG_NAMES = new Set(AUTOMATION_FLAGS.map((f) => f.name));

export function isAutomationFlag(name: string): boolean {
  return FLAG_NAMES.has(name);
}
export function flagSettingKey(name: string): string {
  return `${FLAG_SETTING_PREFIX}${name}`;
}
export function isFlagSettingKey(key: string): boolean {
  return key.startsWith(FLAG_SETTING_PREFIX) && isAutomationFlag(key.slice(FLAG_SETTING_PREFIX.length));
}

// ─── Crons (GitHub Actions → /api/cron/*) ───────────────────────────────────

export interface CronJob {
  name: string;
  label: string;
  /** Intervalo esperado entre corridas (min); `null` = sem agenda fixa. */
  intervalMinutes: number | null;
  workflow: string;
}

export const CRON_JOBS: readonly CronJob[] = [
  { name: "multipark-deliveries", label: "Fila do webhook Multipark", intervalMinutes: 5, workflow: "multipark-deliveries.yml" },
  { name: "google-business", label: "Críticas Google (Business Profile)", intervalMinutes: 10, workflow: "google-business-reviews.yml" },
  { name: "multipark-sync", label: "Sincronização de reservas (recente)", intervalMinutes: 60, workflow: "multipark-cron.yml" },
  { name: "extras-auto", label: "Automação dos extras", intervalMinutes: 60, workflow: "multipark-cron.yml" },
  // Corre de 30 em 30 min entre as 08h e as 23h (Lisboa); 300 min para a
  // pausa da noite (~8h30) não aparecer como "parado".
  { name: "extras-schedule", label: "Escala automática dos extras (propor/confirmar/avisar)", intervalMinutes: 300, workflow: "multipark-cron.yml" },
  { name: "identity-sweep", label: "Ligações funcionário ↔ utilizador", intervalMinutes: 60, workflow: "multipark-cron.yml" },
  { name: "email-inbound", label: "Emails recebidos (IMAP)", intervalMinutes: 60, workflow: "multipark-cron.yml" },
  { name: "multipark-future", label: "Sincronização de reservas (futuras)", intervalMinutes: 120, workflow: "multipark-cron.yml" },
  { name: "daily-ops", label: "Manutenção diária + recolha GPS", intervalMinutes: 1440, workflow: "multipark-cron.yml" },
  { name: "evaluation-recompute", label: "Avaliação (recálculo das 4 semanas)", intervalMinutes: 1440, workflow: "multipark-cron.yml" },
  { name: "google-ads", label: "Google Ads", intervalMinutes: 1440, workflow: "multipark-cron.yml" },
  { name: "meta-ads", label: "Meta Ads", intervalMinutes: 1440, workflow: "multipark-cron.yml" },
  { name: "ops-briefing", label: "Briefing diário, anomalias e relatórios semanais", intervalMinutes: 1440, workflow: "multipark-cron.yml" },
];

const CRON_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** "/multipark-sync" ou "/api/cron/multipark-sync" → "multipark-sync"; `null` se inválido. PURA. */
export function cronNameFromPath(path: string): string | null {
  const seg = String(path ?? "").replace(/^\/api\/cron/, "").replace(/^\/+/, "").split(/[/?#]/)[0] ?? "";
  return CRON_NAME.test(seg) ? seg : null;
}

/** O GitHub Actions atrasa os crons (às vezes muito): nunca menos de 30 min de folga. */
export const CRON_MIN_STALE_MINUTES = 30;

/** Limite (min) sem corridas a partir do qual o cron é "parado": 2× o intervalo. */
export function staleThresholdMinutes(intervalMinutes: number): number {
  return Math.max(2 * intervalMinutes, CRON_MIN_STALE_MINUTES);
}

export type CronHealth = "ok" | "failed" | "stale" | "never" | "running" | "unscheduled";

export interface CronRunLite {
  startedAt: number;          // epoch ms
  finishedAt: number | null;  // null = ainda a correr (ou morreu sem responder)
  ok: boolean | null;
}

/**
 * Estado de um cron a partir da última corrida. PURA.
 *  - never: nunca correu (desde que há registo);
 *  - stale: sem corridas há mais de 2× o intervalo esperado;
 *  - failed: a última terminada falhou (ou ficou sem resposta > 15 min);
 *  - running: começou há pouco e ainda não respondeu.
 */
export function cronHealth(last: CronRunLite | null, intervalMinutes: number | null, now: number): CronHealth {
  if (!last) return intervalMinutes == null ? "unscheduled" : "never";
  if (intervalMinutes != null && now - last.startedAt > staleThresholdMinutes(intervalMinutes) * 60_000) return "stale";
  if (last.finishedAt == null) return now - last.startedAt > 15 * 60_000 ? "failed" : "running";
  return last.ok ? "ok" : "failed";
}

/**
 * Resultado de uma resposta de cron. PURA.
 *  - falha: HTTP não-2xx, `ok:false`, `status:"failed"`, `stepErrors[]` ou
 *    `errors[]` não vazios (estes últimos só sem `ok:true` explícito);
 *  - mensagem de erro: `error` → `reason` → `errors[]`/`stepErrors[]`;
 *  - sucesso com nota: `skipped` (+ `reason`) ou `warnings[]` não vazios ficam
 *    em `note` (a corrida é verde, mas não fica em silêncio).
 * `errors[]` com `ok:true` explícito são erros de itens individuais (ex.: um
 * email que falhou e se repete) → vão para a nota, não tornam a corrida
 * vermelha; sem `ok` explícito contam como falha.
 */
export function cronOutcome(httpStatus: number, body: unknown): { ok: boolean; error: string | null; note?: string | null } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const httpOk = httpStatus >= 200 && httpStatus < 300;
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x != null && x !== "").map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : []);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const steps = strList(b?.stepErrors);
  const errors = strList(b?.errors);
  const warnings = strList(b?.warnings);
  const reason = str(b?.reason);
  const bodyFailed = !!b && (b.ok === false || b.status === "failed");
  const errorsFail = errors.length > 0 && b?.ok !== true;
  const ok = httpOk && !bodyFailed && steps.length === 0 && !errorsFail;
  if (ok) {
    const parts: string[] = [];
    const skipped = b?.skipped != null && b.skipped !== false ? (typeof b.skipped === "string" ? b.skipped : "sim") : b?.status === "skipped" ? "sim" : null;
    if (skipped) parts.push(`saltado: ${skipped}${reason ? ` — ${reason}` : ""}`);
    else if (reason) parts.push(reason);
    if (errors.length) parts.push(`${errors.length} erro(s) de itens: ${errors.slice(0, 3).join(" | ")}`);
    if (warnings.length) parts.push(`${warnings.length} aviso(s): ${warnings.slice(0, 3).join(" | ")}`);
    return parts.length ? { ok: true, error: null, note: parts.join(" · ").slice(0, 1000) } : { ok: true, error: null };
  }
  // daily-ops: a recolha correu, mas passos de manutenção falharam → falha.
  const msg = str(b?.error) ?? (steps.length ? steps.join(" | ") : null) ?? reason ?? (errors.length ? errors.join(" | ") : null)
    ?? `HTTP ${httpStatus}${bodyFailed ? " (ok:false)" : ""}`;
  return { ok: false, error: msg.slice(0, 1000) };
}

// ─── Preferências de notificação (por pessoa) ───────────────────────────────

export interface NotificationKind {
  kind: string;
  label: string;
  description: string;
  /** Obrigatória: não se pode silenciar (pede ação/confirmação). */
  required?: boolean;
}

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  { kind: "task", label: "Tarefas", description: "Tarefas atribuídas, atrasadas ou concluídas." },
  { kind: "handover", label: "Passagem de turno", description: "Passagens entregues e lembretes (pede \"Recebi\").", required: true },
  { kind: "extras", label: "Extras e escala", description: "Falta de condutores, disponibilidades, avisos da escala." },
  { kind: "complaint", label: "Reclamações", description: "Reclamações novas." },
  { kind: "case_sla", label: "Casos em atraso", description: "Ocorrências e perdidos fora do prazo." },
  { kind: "driver_application", label: "Candidaturas", description: "Candidaturas novas \"Be a Driver\"." },
  { kind: "training", label: "Formação", description: "Formação por concluir e promoções." },
];

export const notificationPrefsSchema = z.object({
  muted: z.array(z.string().max(32)).max(50).default([]),
});
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

/** Normaliza as preferências guardadas (JSON cru ou objeto) — nunca lança. PURA. */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  const r = notificationPrefsSchema.safeParse(v ?? {});
  if (!r.success) return { muted: [] };
  const allowed = new Set(NOTIFICATION_KINDS.filter((k) => !k.required).map((k) => k.kind));
  return { muted: Array.from(new Set(r.data.muted.filter((k) => allowed.has(k)))) };
}

/** A pessoa quer receber notificações deste tipo? (obrigatórias e tipos desconhecidos → sim). PURA. */
export function wantsNotification(prefs: NotificationPrefs, kind: string | null | undefined): boolean {
  const k = String(kind ?? "info");
  const def = NOTIFICATION_KINDS.find((x) => x.kind === k);
  if (!def || def.required) return true;
  return !prefs.muted.includes(k);
}
