/**
 * "Regras em vigor" geradas do código (plano MPV, §3.3, F2). Por módulo, as
 * frases em PT-PT que o Multis do piloto lê com a ferramenta
 * `regras_em_vigor(modulo)` (server/assistant/rulesTool.ts).
 *
 * Os NÚMEROS nunca se escrevem aqui: cada frase usa os marcadores
 * `{{regra:…}}` de shared/helpRuleValues.ts — a MESMA fonte da ajuda
 * (docs/ajuda/*.md). O gerador (scripts/gen-regras.ts) troca os marcadores
 * pelos valores e grava server/assistant/rulesDocs.generated.ts; um marcador
 * desconhecido dá erro, e um valor que vem de uma definição obriga a escrever
 * "por omissão" perto (a mesma regra da F1). Cada frase leva a origem
 * (`ficheiro:constante`): a dos marcadores que usa, mais `source` quando a
 * regra vem de uma função ou de uma lista sem marcador.
 *
 * Os valores VIVOS das definições/interruptores (o que está gravado hoje) não
 * estão aqui: vão pela lista branca de shared/rulesLiveWhitelist.ts.
 *
 * Mudar uma constante no código muda as frases no próximo
 * `pnpm tsx scripts/gen-ajuda.ts` (que também corre este gerador); o teste
 * falha enquanto o gerado não estiver em dia. PURO.
 */
import type { ModuleId } from "./access";
import { EVALUATION_RULES } from "./evaluationRules";
import { HELP_RULE_VALUES, HelpRuleMarkerError, renderRuleMarkers, ruleMarkersIn, type HelpRuleValue } from "./helpRuleValues";
import { PARTNER_CATEGORIES, PARTNER_TYPES, type PartnerChargeModel } from "./partnerTypes";

export const RULE_MODULE_IDS = ["avaliacao", "extras_dia", "tempos", "despesas", "parcerias", "casos", "criticas"] as const;
export type RuleModuleId = (typeof RULE_MODULE_IDS)[number];
export const isRuleModuleId = (v: unknown): v is RuleModuleId => typeof v === "string" && (RULE_MODULE_IDS as readonly string[]).includes(v);

/** Uma frase: texto com marcadores; `source` quando a regra não vem (só) dos marcadores. */
export interface RuleTemplate {
  text: string;
  source?: string;
}

export interface RuleModuleDef {
  id: RuleModuleId;
  label: string;
  /** Vê as regras quem tem `view` em QUALQUER destes módulos (shared/access.ts). */
  access: readonly ModuleId[];
  rules: readonly RuleTemplate[];
}

/** Modelos de cobrança das parcerias, em PT-PT (texto; os tipos e as descrições vêm de PARTNER_TYPES). */
const CHARGE_MODEL_TEXT: Record<PartnerChargeModel, string> = {
  commission_on_revenue: "comissão sobre a receita das reservas (receita × taxa de comissão)",
  small_commission: "comissão de afiliado (taxa normalmente baixa)",
  monthly_fee: "avença fixa por mês",
  yearly_fee: "avença em €/mês, como a mensal: cada fatura cobre o período escolhido (valor × meses desse período)",
  prepaid_with_discount: "o cliente paga logo, com o desconto já na reserva",
  monthly_invoice_discount: "fatura no fim do mês, com desconto",
  own_campaign: "campanha nossa (descontos, cashback ou prémios) — vai para o centro de custos",
  operational: "parceiro operacional — pagamos comissão operacional",
  manual: "sem modelo automático (lançamento manual)",
};

const m = (key: string) => `{{regra:${key}}}`;
/** Descrição do catálogo sem as notas técnicas (as frases com `campo`). */
const partnerDescription = (d: string) => d.split(/(?<=\.)\s+/).filter((f) => !f.includes("`")).join(" ").trim();

export const RULE_MODULES: readonly RuleModuleDef[] = [
  {
    id: "avaliacao",
    label: "Avaliação (pontos)",
    access: ["avaliacao"],
    rules: [
      ...EVALUATION_RULES.map((r) => ({ text: `Pontos por cada «${r.label}»: ${m(`evaluation.points.${r.key}`)}.` })),
      { text: `O 1.º movimento depois de uma recolha (levar o carro ao parque) vale ${m("evaluation.points.firstMoveAfterPickup")} e substitui os ${m("evaluation.points.movement")} desse movimento (não soma).` },
      { text: `Uma mudança de lugar na mesma garagem não é movimento: vale ${m("evaluation.points.spotChange")}.` },
      { text: `Atraso ao trabalho: entrada no ponto ${m("evaluation.lateArrivalFromMinutes")} min ou mais depois da hora da escala (Extras Dia) ou do horário fixo do RH; conta no máximo ${m("evaluation.maxLateArrivalsPerDay")} por dia.` },
      { text: `Os acidentes só contam a partir de ${m("evaluation.accidentsFromDay")} e só depois de um team leader (ou acima) confirmar o acidente e quem conduzia.` },
      { text: "Os totais podem ser negativos; os pontos por hora são uma vista à parte e não entram na pontuação.", source: "shared/evaluationRules.ts:scoreOf" },
      { text: `O recálculo de todos os dias refaz os últimos ${m("evaluation.recomputeWindowDays")} dias; os dias calculados com regras anteriores à versão ${m("evaluation.rulesVersion")} mostram o aviso «Recalcular».` },
      { text: `Excesso de velocidade: por omissão, acima de ${m("speed.limitKmh")} km/h com ${m("speed.tolerancePercent")} % de tolerância (Definições → Parâmetros → Limite de velocidade).` },
      { text: `Conta como excesso com pelo menos ${m("speed.minPoints")} pontos seguidos acima do limite (por omissão), ou um só ponto confirmado pela distância ao ponto vizinho (entre ${m("speed.positionMinGapS")} s e ${m("speed.positionMaxGapS")} s de intervalo).` },
      { text: `Pontos acima do limite a até ${m("speed.mergeGapS")} s uns dos outros são o mesmo excesso; os picos falsos do GPS (acima de ${m("speed.absurdKmh")} km/h, ou saltos isolados de mais de ${m("speed.maxJumpKmhPerS")} km/h por segundo) nunca contam.` },
      { text: `Um dia de GPS só conta acima do MAIOR entre o limite de hoje e o limite com que foi recolhido; os dias recolhidos antes de se guardar esse limite contam a ${m("speed.legacyThresholdKmh")} km/h.`, source: "shared/speedRules.ts:gpsDayThresholdOf" },
      { text: `Na Avaliação, o GPS do Zello dá no máximo ${m("evaluation.maxGpsSpeedingPerDay")} excesso (${m("evaluation.points.speeding")}) por pessoa e dia, pela máxima do dia acima do limite; esse dia nem conta se já houver um alerta ou uma penalização RH de velocidade no mesmo dia de calendário (00h–24h, Lisboa), nem se o dia já tiver excessos — nunca conta a dobrar. Os excessos um a um do GPS (guardados à parte, com os avisos de velocidade) não mudam os pontos.`, source: "server/evaluationCore.ts:computeEmployeeDays" },
    ],
  },
  {
    id: "extras_dia",
    label: "Extras Dia (pressão e escala)",
    access: ["extras_dia"],
    rules: [
      { text: `A Pressão mede desde ${m("extras.timesSince")} por omissão e a janela cresce todos os dias: nunca deita fora o que já mediu.` },
      { text: `Tempo por carro, por omissão: p${m("extras.timesPercentile.lisbon")} em Lisboa, p${m("extras.timesPercentile.porto")} no Porto e p${m("extras.timesPercentile.faro")} em Faro (valores possíveis: ${m("extras.cyclePercentiles")}).` },
      { text: `Um percentil de uma célula (dia da semana × hora) só conta com pelo menos ${m("extras.pressureMinSample")} medições.` },
      { text: `Condutor por carro: do início de um serviço ao início do serviço seguinte do mesmo condutor; um intervalo acima de ${m("extras.maxCycleMinutes")} min é pausa e não conta.` },
      { text: `Horas de ponta (o trânsito): ${m("extras.rushHours")}.` },
      { text: `Hora apertada: está nos ${m("extras.tightTopSharePct")} % de cima da carga (carros por hora) ou do tempo das entregas — o p75 do total (do pedido à assinatura) ou, com «Hora apertada pela Fila» ligado na cidade (${m("extras.tightUsesQueue")} por omissão), o p75 da Fila, mas só quando a Fila está medida em 60 % ou mais das entregas da cidade (abaixo disso fica o p75 do total).`, source: "shared/extrasPressure.ts:tightThresholds" },
      { text: `Com a escala pelos tempos medidos ligada na cidade, um escalão de equipa só usa o valor medido com pelo menos ${m("extras.crewMeasureMinSamples")} serviços medidos em horas cheias, e nunca acima da tabela de máximos.` },
      { text: `Proposta automática a partir das ${m("extras.autoProposeAt")} (por omissão), para ${m("extras.autoProposeDaysAhead")} dia(s) à frente por omissão; só faz a PRIMEIRA proposta de cada dia e cidade.` },
      { text: `Confirmar e avisar automaticamente: ${m("extras.autoConfirm")} por omissão, às ${m("extras.autoConfirmAt")} (por omissão): a proposta de amanhã que ninguém confirmou nem suspendeu é confirmada e os extras são avisados por WhatsApp e email.` },
      { text: "A mão humana manda: qualquer mudança nos condutores de um dia (pôr, tirar, mudar horas, preencher, confirmar, suspender…) marca o dia como «mexido à mão» e a proposta automática já não o muda; mexer só no TL não trava.", source: "shared/extrasSchedule.ts:autoProposeBlockedReason" },
      { text: `Turnos entre ${m("extras.minShiftHours")} h e ${m("extras.maxShiftHours")} h, no dia operacional que vai das ${m("extras.dayStartHour")} às ${m("extras.dayStartHour")} do dia seguinte.` },
      { text: `Ordem dos candidatos (soma ponderada): cobertura ${m("extras.rankWeights.coverage")} %, avaliação ${m("extras.rankWeights.eval")} %, custo ${m("extras.rankWeights.cost")} %, equidade ${m("extras.rankWeights.fairness")} % e fiabilidade ${m("extras.rankWeights.reliability")} %; empates por horas cobertas, custo e nome.` },
      { text: `Cada hora paga sem falta de gente pesa ${m("extras.idlePenalty")} contra o bloco: prefere dois turnos curtos a um longo com horas paradas.` },
      { text: `Recolha pelo meio de uma entrega (quando ligada na cidade): no mesmo terminal, entre ${m("extras.pairBeforeMin")} min antes e ${m("extras.pairAfterMin")} min depois da entrega, não conta como um carro a mais.` },
      { text: `Um aviso de escala que falha é tentado no máximo ${m("extras.maxNotifyAttempts")} vezes (por canal), cada nova tentativa ${m("extras.notifyRetryStepMin")} min × as tentativas já feitas depois da anterior (30, 60 e 90 min). Quem ficar por avisar (nenhum canal chegou: falhou em todas, número inválido, sem contacto ou STOP) gera um aviso ao TL, ao supervisor e ao back office, só com o interruptor «Extras-dia: avisos da escala» (${m("extras.scheduleAlertsFlag")} por omissão).`, source: "shared/extrasSchedule.ts:unnotifiedAfterRetries" },
      { text: `Dia mexido à mão na hora da confirmação: ${m("extras.manualEditAtConfirm")} por omissão (as outras opções: não confirmar e avisar — repete às ${m("extras.manualHoldRepeatAt")} se continuar por confirmar; com o interruptor «Extras-dia: avisos da escala» desligado ninguém seria avisado, por isso confirma na mesma —, ou só confirmar quando a última mudança à mão tiver mais de ${m("extras.manualEditSettleMin")} min; mexer depois das ~23:15 avisa, porque já não dá para confirmar sozinho).`, source: "shared/extrasSchedule.ts:autoConfirmDecision" },
      { text: `Lembretes ${m("extras.reminderLeadMin")} min antes da proposta e da confirmação (interruptor ${m("extras.remindersFlag")} por omissão); a quem e em que dias, por cidade, numa definição (por omissão TL e supervisor, todos os dias).`, source: "shared/extrasReminders.ts:remindersDue" },
      { text: `Depois da confirmação automática, uma escala que cubra menos de ${m("extras.coverageAlertPct")} % das horas×condutor previstas gera um aviso ao TL, ao supervisor e ao back office (só com o interruptor dos avisos da escala ligado).`, source: "shared/extrasSchedule.ts:scheduleCoverage" },
    ],
  },
  {
    id: "tempos",
    label: "Tempos de entrega e de recolha",
    access: ["extras_dia", "avaliacao_operacional", "condutores_agentes"],
    rules: [
      { text: `Entregas: Fila = do mais cedo entre a chamada do cliente e o pendente (com «contar desde a chamada» ${m("serviceTimes.useCalls")} por omissão; desligado, só o pendente) até o condutor pegar no carro; Trânsito = até chegar ao terminal (GPS); Cliente = até à assinatura; Nosso = Fila + Trânsito. A hora marcada na ficha não entra em nenhum tempo.`, source: "shared/serviceTimes.ts:deliveryTimes" },
      { text: `A meta do Nosso é ${m("serviceTimes.targetMinutes")} min por omissão (conta para a % na meta).` },
      { text: `A chamada conta se for até ${m("serviceTimes.callWindowBeforeMin")} min antes (ou ${m("serviceTimes.callWindowAfterMin")} min depois) do pendente; as chamadas só existem desde ${m("serviceTimes.callsSince")}.` },
      { text: `O mesmo telefone em ${m("serviceTimes.sharedPhoneMinBookings")} ou mais reservas com pedido no mesmo dia é uma agência ou um hotel: a chamada não conta.` },
      { text: `Dois inícios do mesmo agente a menos de ${m("serviceTimes.dispatchMinMinutes")} min = quem despacha, não quem conduz.` },
      { text: `Fora dos limites (não contam): Fila acima de ${m("serviceTimes.maxQueueMin")} min, Trânsito acima de ${m("serviceTimes.maxTransitMin")} min, Cliente acima de ${m("serviceTimes.maxCustomerMin")} min. «Sem medição» nunca é 0.` },
      { text: `Recolhas: atrasada só no T2, quando o condutor chega à zona T2 mais de ${m("serviceTimes.pickupT2TargetMinutes")} min (por omissão) depois do mais cedo entre a chamada do cliente e o «em recolha»; sem GPS fica sem medição, nunca «a tempo».`, source: "shared/serviceTimes.ts:pickupTimes" },
      { text: `Depois do check-in, por omissão: ${m("serviceTimes.garages.provisoria")} é a garagem provisória; ${m("serviceTimes.garages.parque")} já são um parque (pára de medir); ${m("serviceTimes.garages.final")} são o parque certo se o tipo de lugar bater (por omissão). Os movimentos contam até ${m("serviceTimes.pickupTrackMaxHours")} h depois do check-in.` },
      { text: `Os tempos que dependem do GPS só aparecem com o portão aberto e, por cidade e período, cobertura de pelo menos ${m("serviceTimes.gpsGate.minCoveragePct")} % e ${m("serviceTimes.gpsGate.minN")} medições (por omissão); com o portão fechado só o super admin os vê, «em calibração».` },
      { text: `Tempos por condutor: só informação (não dão pontos); com menos de ${m("serviceTimes.driverStatsMinN")} medições não se mostra número.` },
      { text: `Medição desde ${m("serviceTimes.since")} por omissão; com GPS desde ${m("serviceTimes.gpsSince")} por omissão.` },
    ],
  },
  {
    id: "despesas",
    label: "Despesas",
    access: ["despesas"],
    rules: [
      { text: `Lançar uma despesa já paga: só ${m("expenses.paidOnCreateRoles")}, escolhendo o método de pagamento; fica paga com a data de vencimento ou, sem ela, a data da despesa. Sem método fica pendente.`, source: "shared/expenseCreatePayment.ts:paymentOnCreate" },
      { text: "Para os outros papéis o método começa em «Cartão» e a despesa fica sempre pendente: o servidor nunca a marca paga por esta via.", source: "shared/expenseCreatePayment.ts:defaultCreatePaymentMethod" },
      { text: "Paga com data futura (vencimento depois de hoje) só com confirmação: o ecrã mostra um aviso âmbar.", source: "shared/expenseCreatePayment.ts:isFuturePaidAt" },
      { text: "Nota de crédito: documento próprio (n.º, data e PDF) ligado à fatura e gravado com valor negativo; os totais descontam no mês da data da nota e a fatura nunca é reescrita.", source: "shared/creditNotes.ts:creditNoteStoredAmount" },
      { text: `Estados da nota de crédito: ${m("creditNotes.states")}.` },
      { text: "Uma nota de crédito não passa do que falta creditar na fatura, nem vai para uma fatura cancelada, eliminada ou para outra nota de crédito.", source: "shared/creditNotes.ts:creditNoteError" },
    ],
  },
  {
    id: "parcerias",
    label: "Parcerias",
    access: ["parcerias"],
    rules: [
      ...PARTNER_TYPES.map((t) => ({ text: `«${t.label}»: ${partnerDescription(t.description)} Cobrança: ${CHARGE_MODEL_TEXT[t.chargeModel]}.`, source: "shared/partnerTypes.ts:PARTNER_TYPES" })),
      { text: `Categorias: ${PARTNER_CATEGORIES.map((c) => `«${c.label}» — ${c.description.replace(/\.$/, "")}`).join("; ")}.`, source: "shared/partnerTypes.ts:PARTNER_CATEGORIES" },
      { text: `Sem comissão de venda: ${m("partners.noCommissionTypes")} (o Pro tem desconto; a avença paga uma mensalidade).` },
      { text: "Avença (mensal ou anual): o valor é sempre €/mês e fatura-se valor × meses cobertos (cada mês conta os dias no intervalo ÷ os dias do mês); a anual só muda a periodicidade da fatura.", source: "shared/partnerRules.ts:partnerFeeForPeriod" },
      { text: "Os tipos que vêm da Multipark (Pros, avenças, agências, agregadores) ligam-se em «Ligar à Multipark» e o tipo e a taxa vêm de lá; só os nossos (hotel, empresa, outro…) ficam «por configurar» até um admin os gravar.", source: "shared/partnerRules.ts:isPartnerUnconfigured" },
    ],
  },
  {
    id: "casos",
    label: "Reclamações, ocorrências e perdidos",
    access: ["reclamacoes", "ocorrencias", "perdidos"],
    rules: [
      { text: `Prazo das ocorrências: ${m("cases.incidentSlaHours")} h por omissão (Definições → Prazos (SLA)).` },
      { text: `Perdidos: em atraso ao fim de ${m("cases.lostSlaDays")} dias por omissão, quando o caso não tem prazo próprio na Atribuição (âmbar a cerca de 3/7 do prazo).`, source: "shared/caseRules.ts:lostAgeTone" },
      { text: `Reclamações: o prazo corre só em ${m("cases.complaintSlaRunning")}; em «Aguarda Cliente» pára. Enviar um email ao cliente passa a «Aguarda Cliente»; a resposta do cliente volta a «Em Análise».`, source: "shared/caseRules.ts:complaintStatusAfterEmail" },
      { text: `A lista das Reclamações abre nos últimos ${m("cases.complaintListDays")} dias; as que estão abertas aparecem sempre.` },
      { text: `Cada foto de uma reclamação pode ter até ${m("cases.complaintPhotoMaxMb")} MB.` },
      { text: `Duplicado (email ↔ app Multipark): mesma matrícula, reserva que não contradiz e até ${m("cases.dedupeWindowHours")} h de diferença.` },
      { text: "Uma ocorrência só conta contra o condutor com o condutor indicado, o envolvimento confirmado (team leader ou acima) e não descartada nem convertida.", source: "shared/caseRules.ts:incidentCountsAgainstDriver" },
      { text: "«Devolvido» nos Perdidos obriga a dizer como e quando; «Outro» obriga a escrever como foi.", source: "shared/caseRules.ts:lostReturnedError" },
    ],
  },
  {
    id: "criticas",
    label: "Críticas Google",
    access: ["criticas"],
    rules: [
      { text: "«Respondida» quer dizer publicada: guardar um texto é só rascunho. Nas críticas da API publica o «Aprovar e publicar»; nas de email, quem respondeu no perfil Google carrega em «Já publiquei no Google».", source: "shared/reviewRules.ts:reviewUpdatePatch" },
      { text: `Converter numa reclamação abre-a com prazo de ${m("reviews.complaintSlaHours")} h e prioridade urgente (1★) ou alta (as outras).`, source: "shared/reviewRules.ts:reviewComplaintPriority" },
      { text: "Uma crítica convertida já não muda de estado aqui (trata-se na reclamação); a resposta pública continua a ser aqui.", source: "shared/reviewRules.ts:reviewUpdatePatch" },
      { text: `Rascunho automático (interruptor «IA: rascunho automático para cada crítica nova», ${m("reviews.autoDraftsFlag")} por omissão) só para críticas com até ${m("reviews.autoDraftMaxAgeDays")} dias: conta a data da crítica, sem ela a do email que a trouxe e, sem nenhuma, a data em que foi registada cá; sem data legível, não.`, source: "shared/reviewRules.ts:reviewAutoDraftEligible" },
      { text: `Respostas automáticas às 5★ (interruptor ${m("reviews.autoPublishFlag")} por omissão, só o super admin): só 5★ ligadas ao Google, recentes, sem reclamação nem resposta e sem links, contactos, insultos ou instruções no texto; a resposta (${m("reviews.replyMinChars")}–${m("reviews.replyMaxChars")} caracteres, sem números nem contactos, na língua da crítica) fica ${m("reviews.autoPublishDelayHours")} h à vista com «Cancelar» e só sai se a crítica, lida outra vez no Google, continuar com 5★, o texto da preparação e sem resposta (e só grava se continuar sem resposta cá); só se prepara com canal para publicar e com a IA dos rascunhos automáticos ligada; publica com o 1.º super admin; no máximo ${m("reviews.autoPublishMaxPerProfileDay")} por perfil em 24 h; pára ao fim de ${m("reviews.autoPublishMaxFailures")} falhas seguidas.`, source: "shared/reviewAutoPublish.ts:autoPublishEntryRefusal" },
      { text: "As críticas marcadas como «não é crítica» ou como repetidas nunca levam rascunho automático.", source: "server/reviewAutoDraft.ts:autoDraftReview" },
    ],
  },
];

export const RULE_MODULE_BY_ID: Readonly<Record<RuleModuleId, RuleModuleDef>> = Object.fromEntries(RULE_MODULES.map((r) => [r.id, r])) as Record<RuleModuleId, RuleModuleDef>;

/** As origens de uma frase: a própria (`source`) + as dos marcadores, sem repetir. PURA. */
export function ruleSources(t: RuleTemplate, values: Readonly<Record<string, HelpRuleValue>> = HELP_RULE_VALUES): string[] {
  const out = new Set<string>();
  if (t.source) out.add(t.source);
  for (const key of ruleMarkersIn(t.text)) {
    const hit = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;
    if (hit) out.add(hit.source);
  }
  return [...out];
}

/** Uma frase já com os valores, e de onde vêm. */
export interface RenderedRule {
  text: string;
  sources: readonly string[];
}
export interface RenderedRuleModule {
  label: string;
  rules: readonly RenderedRule[];
  /** O bloco que a ferramenta devolve ao modelo. */
  block: string;
}

/** Cabeçalho do bloco de um módulo. PURA. */
export function rulesBlockHeader(label: string): string {
  return `Regras em vigor — ${label} (valores do código; "por omissão" = o valor de uma definição que se pode mudar em Definições).`;
}

/**
 * Troca os marcadores de todas as frases (desconhecido, mal escrito ou valor
 * de definição sem "por omissão" por perto = HelpRuleMarkerError) e junta a
 * origem de cada uma. Falha também se uma frase ficar sem origem. PURA.
 */
export function renderRuleModules(
  modules: readonly RuleModuleDef[] = RULE_MODULES,
  values: Readonly<Record<string, HelpRuleValue>> = HELP_RULE_VALUES,
): Record<string, RenderedRuleModule> {
  const out: Record<string, RenderedRuleModule> = {};
  for (const mod of modules) {
    const rules = mod.rules.map((t, i) => {
      const where = `shared/rulesInForce.ts (${mod.id}, frase ${i + 1})`;
      const text = renderRuleMarkers(t.text, where, values);
      const sources = ruleSources(t, values);
      if (!sources.length) throw new HelpRuleMarkerError(`${where}: frase sem origem — usa um marcador {{regra:…}} ou indica \`source\` (ficheiro:constante).`);
      return { text, sources };
    });
    const block = [rulesBlockHeader(mod.label), ...rules.map((r) => `- ${r.text} [origem: ${r.sources.join("; ")}]`)].join("\n");
    out[mod.id] = { label: mod.label, rules, block };
  }
  return out;
}
