// GERADO por scripts/gen-regras.ts a partir de shared/rulesInForce.ts e shared/helpRuleValues.ts — não editar à mão.
// Regras em vigor por módulo (plano MPV §3.3): frases com os valores do código e a origem de cada uma.
import type { RenderedRuleModule, RuleModuleId } from "../../shared/rulesInForce";

export const RULES_DOCS: Readonly<Record<RuleModuleId, RenderedRuleModule>> = {
 "avaliacao": {
  "label": "Avaliação (pontos)",
  "rules": [
   {
    "text": "Pontos por cada «Movimento entre parques»: 2.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Pontos por cada «Mudança de lugar (mesma garagem)»: 1.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Pontos por cada «Recolha ou entrega»: 3.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Pontos por cada «1.º movimento após recolha (levar ao parque)»: 5.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Pontos por cada «Excesso de velocidade»: −10.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Pontos por cada «Atraso ao trabalho (≥ 5 min)»: −5.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Pontos por cada «Reclamação confirmada»: −20.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Pontos por cada «Acidente ou dano/risco»: −6000.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "O 1.º movimento depois de uma recolha (levar o carro ao parque) vale 5 e substitui os 2 desse movimento (não soma).",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Uma mudança de lugar na mesma garagem não é movimento: vale 1.",
    "sources": [
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   },
   {
    "text": "Atraso ao trabalho: entrada no ponto 5 min ou mais depois da hora da escala (Extras Dia) ou do horário fixo do RH; conta no máximo 1 por dia.",
    "sources": [
     "shared/evaluationRules.ts:LATE_ARRIVAL_FROM_MINUTES",
     "shared/evaluationRules.ts:MAX_LATE_ARRIVALS_PER_DAY"
    ]
   },
   {
    "text": "Os acidentes só contam a partir de 3 out 2026 e só depois de um team leader (ou acima) confirmar o acidente e quem conduzia.",
    "sources": [
     "shared/evaluationRules.ts:ACCIDENTS_FROM_DAY"
    ]
   },
   {
    "text": "Os totais podem ser negativos; os pontos por hora são uma vista à parte e não entram na pontuação.",
    "sources": [
     "shared/evaluationRules.ts:scoreOf"
    ]
   },
   {
    "text": "O recálculo de todos os dias refaz os últimos 31 dias; os dias calculados com regras anteriores à versão 3 mostram o aviso «Recalcular».",
    "sources": [
     "shared/evaluationRules.ts:RECOMPUTE_WINDOW_DAYS",
     "shared/evaluationRules.ts:EVALUATION_RULES_VERSION"
    ]
   },
   {
    "text": "Excesso de velocidade: por omissão, acima de 120 km/h com 0 % de tolerância (Definições → Parâmetros → Limite de velocidade).",
    "sources": [
     "shared/speedRules.ts:DEFAULT_SPEED_RULE"
    ]
   },
   {
    "text": "Conta como excesso com pelo menos 2 pontos seguidos acima do limite (por omissão), ou um só ponto confirmado pela distância ao ponto vizinho (entre 30 s e 300 s de intervalo).",
    "sources": [
     "shared/speedRules.ts:DEFAULT_SPEED_RULE",
     "shared/speedRules.ts:POSITION_MIN_GAP_S",
     "shared/speedRules.ts:POSITION_MAX_GAP_S"
    ]
   },
   {
    "text": "Pontos acima do limite a até 120 s uns dos outros são o mesmo excesso; os picos falsos do GPS (acima de 250 km/h, ou saltos isolados de mais de 15 km/h por segundo) nunca contam.",
    "sources": [
     "shared/speedRules.ts:EXCESS_MERGE_GAP_S",
     "shared/speedRules.ts:GPS_ABSURD_KMH",
     "shared/speedRules.ts:MAX_SPEED_JUMP_KMH_PER_S"
    ]
   },
   {
    "text": "Um dia de GPS só conta acima do MAIOR entre o limite de hoje e o limite com que foi recolhido; os dias recolhidos antes de se guardar esse limite contam a 132 km/h.",
    "sources": [
     "shared/speedRules.ts:gpsDayThresholdOf",
     "shared/speedRules.ts:LEGACY_COLLECTED_THRESHOLD_KMH"
    ]
   },
   {
    "text": "Na Avaliação, o GPS do Zello dá no máximo 1 excesso (−10) por pessoa e dia, pela máxima do dia acima do limite; esse dia nem conta se já houver um alerta ou uma penalização RH de velocidade no mesmo dia de calendário (00h–24h, Lisboa), nem se o dia já tiver excessos — nunca conta a dobrar. Os excessos um a um do GPS (guardados à parte, com os avisos de velocidade) não mudam os pontos.",
    "sources": [
     "server/evaluationCore.ts:computeEmployeeDays",
     "shared/evaluationRules.ts:MAX_GPS_SPEEDING_PER_DAY",
     "shared/evaluationRules.ts:EVALUATION_POINTS"
    ]
   }
  ],
  "block": "Regras em vigor — Avaliação (pontos) (valores do código; \"por omissão\" = o valor de uma definição que se pode mudar em Definições).\n- Pontos por cada «Movimento entre parques»: 2. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Pontos por cada «Mudança de lugar (mesma garagem)»: 1. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Pontos por cada «Recolha ou entrega»: 3. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Pontos por cada «1.º movimento após recolha (levar ao parque)»: 5. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Pontos por cada «Excesso de velocidade»: −10. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Pontos por cada «Atraso ao trabalho (≥ 5 min)»: −5. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Pontos por cada «Reclamação confirmada»: −20. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Pontos por cada «Acidente ou dano/risco»: −6000. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- O 1.º movimento depois de uma recolha (levar o carro ao parque) vale 5 e substitui os 2 desse movimento (não soma). [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Uma mudança de lugar na mesma garagem não é movimento: vale 1. [origem: shared/evaluationRules.ts:EVALUATION_POINTS]\n- Atraso ao trabalho: entrada no ponto 5 min ou mais depois da hora da escala (Extras Dia) ou do horário fixo do RH; conta no máximo 1 por dia. [origem: shared/evaluationRules.ts:LATE_ARRIVAL_FROM_MINUTES; shared/evaluationRules.ts:MAX_LATE_ARRIVALS_PER_DAY]\n- Os acidentes só contam a partir de 3 out 2026 e só depois de um team leader (ou acima) confirmar o acidente e quem conduzia. [origem: shared/evaluationRules.ts:ACCIDENTS_FROM_DAY]\n- Os totais podem ser negativos; os pontos por hora são uma vista à parte e não entram na pontuação. [origem: shared/evaluationRules.ts:scoreOf]\n- O recálculo de todos os dias refaz os últimos 31 dias; os dias calculados com regras anteriores à versão 3 mostram o aviso «Recalcular». [origem: shared/evaluationRules.ts:RECOMPUTE_WINDOW_DAYS; shared/evaluationRules.ts:EVALUATION_RULES_VERSION]\n- Excesso de velocidade: por omissão, acima de 120 km/h com 0 % de tolerância (Definições → Parâmetros → Limite de velocidade). [origem: shared/speedRules.ts:DEFAULT_SPEED_RULE]\n- Conta como excesso com pelo menos 2 pontos seguidos acima do limite (por omissão), ou um só ponto confirmado pela distância ao ponto vizinho (entre 30 s e 300 s de intervalo). [origem: shared/speedRules.ts:DEFAULT_SPEED_RULE; shared/speedRules.ts:POSITION_MIN_GAP_S; shared/speedRules.ts:POSITION_MAX_GAP_S]\n- Pontos acima do limite a até 120 s uns dos outros são o mesmo excesso; os picos falsos do GPS (acima de 250 km/h, ou saltos isolados de mais de 15 km/h por segundo) nunca contam. [origem: shared/speedRules.ts:EXCESS_MERGE_GAP_S; shared/speedRules.ts:GPS_ABSURD_KMH; shared/speedRules.ts:MAX_SPEED_JUMP_KMH_PER_S]\n- Um dia de GPS só conta acima do MAIOR entre o limite de hoje e o limite com que foi recolhido; os dias recolhidos antes de se guardar esse limite contam a 132 km/h. [origem: shared/speedRules.ts:gpsDayThresholdOf; shared/speedRules.ts:LEGACY_COLLECTED_THRESHOLD_KMH]\n- Na Avaliação, o GPS do Zello dá no máximo 1 excesso (−10) por pessoa e dia, pela máxima do dia acima do limite; esse dia nem conta se já houver um alerta ou uma penalização RH de velocidade no mesmo dia de calendário (00h–24h, Lisboa), nem se o dia já tiver excessos — nunca conta a dobrar. Os excessos um a um do GPS (guardados à parte, com os avisos de velocidade) não mudam os pontos. [origem: server/evaluationCore.ts:computeEmployeeDays; shared/evaluationRules.ts:MAX_GPS_SPEEDING_PER_DAY; shared/evaluationRules.ts:EVALUATION_POINTS]"
 },
 "extras_dia": {
  "label": "Extras Dia (pressão e escala)",
  "rules": [
   {
    "text": "A Pressão mede desde 3 abr 2026 por omissão e a janela cresce todos os dias: nunca deita fora o que já mediu.",
    "sources": [
     "shared/extrasPressure.ts:PRESSURE_SINCE_DEFAULT"
    ]
   },
   {
    "text": "Tempo por carro, por omissão: p75 em Lisboa, p60 no Porto e p60 em Faro (valores possíveis: 50, 60, 75, 85 e 90).",
    "sources": [
     "shared/appSettings.ts:DEFAULT_TIMES_PERCENTILE",
     "shared/extrasPressure.ts:CYCLE_PERCENTILES"
    ]
   },
   {
    "text": "Um percentil de uma célula (dia da semana × hora) só conta com pelo menos 5 medições.",
    "sources": [
     "shared/extrasPressure.ts:MIN_SAMPLE"
    ]
   },
   {
    "text": "Condutor por carro: do início de um serviço ao início do serviço seguinte do mesmo condutor; um intervalo acima de 120 min é pausa e não conta.",
    "sources": [
     "shared/extrasPressure.ts:MAX_CYCLE_MINUTES"
    ]
   },
   {
    "text": "Horas de ponta (o trânsito): 07h–10h e 17h–20h.",
    "sources": [
     "shared/extrasPressure.ts:RUSH_HOURS"
    ]
   },
   {
    "text": "Hora apertada: está nos 20 % de cima da carga (carros por hora) ou do tempo das entregas — o p75 do total (do pedido à assinatura) ou, com «Hora apertada pela Fila» ligado na cidade (desligado em todas as cidades por omissão), o p75 da Fila, mas só quando a Fila está medida em 60 % ou mais das entregas da cidade (abaixo disso fica o p75 do total).",
    "sources": [
     "shared/extrasPressure.ts:tightThresholds",
     "shared/extrasPressure.ts:TIGHT_TOP_SHARE",
     "shared/appSettings.ts:DEFAULT_TIGHT_USES_QUEUE"
    ]
   },
   {
    "text": "Com a escala pelos tempos medidos ligada na cidade, um escalão de equipa só usa o valor medido com pelo menos 30 serviços medidos em horas cheias, e nunca acima da tabela de máximos.",
    "sources": [
     "shared/extrasPressure.ts:CREW_MEASURE_MIN_SAMPLES"
    ]
   },
   {
    "text": "Proposta automática a partir das 11:00 (por omissão), para 1 dia(s) à frente por omissão; só faz a PRIMEIRA proposta de cada dia e cidade.",
    "sources": [
     "shared/appSettings.ts:SETTINGS[extras.autoProposeAt]",
     "shared/appSettings.ts:SETTINGS[extras.autoProposeDaysAhead]"
    ]
   },
   {
    "text": "Confirmar e avisar automaticamente: ligado por omissão, às 15:00 (por omissão): a proposta de amanhã que ninguém confirmou nem suspendeu é confirmada e os extras são avisados por WhatsApp e email.",
    "sources": [
     "shared/appSettings.ts:SETTINGS[extras.autoConfirm]",
     "shared/appSettings.ts:SETTINGS[extras.autoConfirmAt]"
    ]
   },
   {
    "text": "A mão humana manda: qualquer mudança nos condutores de um dia (pôr, tirar, mudar horas, preencher, confirmar, suspender…) marca o dia como «mexido à mão» e a proposta automática já não o muda; mexer só no TL não trava.",
    "sources": [
     "shared/extrasSchedule.ts:autoProposeBlockedReason"
    ]
   },
   {
    "text": "Turnos entre 3 h e 12 h, no dia operacional que vai das 03h às 03h do dia seguinte.",
    "sources": [
     "shared/extrasSchedule.ts:MIN_SHIFT_HOURS",
     "shared/extrasSchedule.ts:MAX_SHIFT_HOURS",
     "shared/extrasSchedule.ts:DAY_START_HOUR"
    ]
   },
   {
    "text": "Ordem dos candidatos (soma ponderada): cobertura 45 %, avaliação 20 %, custo 15 %, equidade 12 % e fiabilidade 8 %; empates por horas cobertas, custo e nome.",
    "sources": [
     "shared/extrasSchedule.ts:RANK_WEIGHTS"
    ]
   },
   {
    "text": "Cada hora paga sem falta de gente pesa 0,5 contra o bloco: prefere dois turnos curtos a um longo com horas paradas.",
    "sources": [
     "shared/extrasSchedule.ts:IDLE_PENALTY"
    ]
   },
   {
    "text": "Recolha pelo meio de uma entrega (quando ligada na cidade): no mesmo terminal, entre 10 min antes e 30 min depois da entrega, não conta como um carro a mais.",
    "sources": [
     "shared/extrasSchedule.ts:PICKUP_PAIR_BEFORE_MIN",
     "shared/extrasSchedule.ts:PICKUP_PAIR_AFTER_MIN"
    ]
   },
   {
    "text": "Um aviso de escala que falha é tentado no máximo 4 vezes (por canal), cada nova tentativa 30 min × as tentativas já feitas depois da anterior (30, 60 e 90 min). Quem ficar por avisar (nenhum canal chegou: falhou em todas, número inválido, sem contacto ou STOP) gera um aviso ao TL, ao supervisor e ao back office, só com o interruptor «Extras-dia: avisos da escala» (desligado por omissão).",
    "sources": [
     "shared/extrasSchedule.ts:unnotifiedAfterRetries",
     "shared/extrasSchedule.ts:MAX_NOTIFY_ATTEMPTS",
     "shared/extrasSchedule.ts:NOTIFY_RETRY_STEP_MIN",
     "shared/appSettings.ts:AUTOMATION_FLAGS[EXTRAS_SCHEDULE_ALERTS]"
    ]
   },
   {
    "text": "Dia mexido à mão na hora da confirmação: «Confirma na mesma (como até aqui)» por omissão (as outras opções: não confirmar e avisar — repete às 18:00 se continuar por confirmar —, ou só confirmar quando a última mudança à mão tiver mais de 30 min; mexer depois das ~23:15 avisa, porque já não dá para confirmar sozinho).",
    "sources": [
     "shared/extrasSchedule.ts:autoConfirmDecision",
     "shared/extrasSchedule.ts:MANUAL_EDIT_AT_CONFIRM_DEFAULT",
     "shared/extrasSchedule.ts:MANUAL_HOLD_REPEAT_AT_MIN",
     "shared/extrasSchedule.ts:MANUAL_EDIT_SETTLE_MIN"
    ]
   },
   {
    "text": "Lembretes 30 min antes da proposta e da confirmação (interruptor desligado por omissão); a quem e em que dias, por cidade, numa definição (por omissão TL e supervisor, todos os dias).",
    "sources": [
     "shared/extrasReminders.ts:remindersDue",
     "shared/extrasReminders.ts:REMINDER_LEAD_MIN",
     "shared/appSettings.ts:AUTOMATION_FLAGS[EXTRAS_REMINDERS]"
    ]
   },
   {
    "text": "Depois da confirmação automática, uma escala que cubra menos de 80 % das horas×condutor previstas gera um aviso ao TL, ao supervisor e ao back office (só com o interruptor dos avisos da escala ligado).",
    "sources": [
     "shared/extrasSchedule.ts:scheduleCoverage",
     "shared/extrasSchedule.ts:COVERAGE_ALERT_MIN"
    ]
   }
  ],
  "block": "Regras em vigor — Extras Dia (pressão e escala) (valores do código; \"por omissão\" = o valor de uma definição que se pode mudar em Definições).\n- A Pressão mede desde 3 abr 2026 por omissão e a janela cresce todos os dias: nunca deita fora o que já mediu. [origem: shared/extrasPressure.ts:PRESSURE_SINCE_DEFAULT]\n- Tempo por carro, por omissão: p75 em Lisboa, p60 no Porto e p60 em Faro (valores possíveis: 50, 60, 75, 85 e 90). [origem: shared/appSettings.ts:DEFAULT_TIMES_PERCENTILE; shared/extrasPressure.ts:CYCLE_PERCENTILES]\n- Um percentil de uma célula (dia da semana × hora) só conta com pelo menos 5 medições. [origem: shared/extrasPressure.ts:MIN_SAMPLE]\n- Condutor por carro: do início de um serviço ao início do serviço seguinte do mesmo condutor; um intervalo acima de 120 min é pausa e não conta. [origem: shared/extrasPressure.ts:MAX_CYCLE_MINUTES]\n- Horas de ponta (o trânsito): 07h–10h e 17h–20h. [origem: shared/extrasPressure.ts:RUSH_HOURS]\n- Hora apertada: está nos 20 % de cima da carga (carros por hora) ou do tempo das entregas — o p75 do total (do pedido à assinatura) ou, com «Hora apertada pela Fila» ligado na cidade (desligado em todas as cidades por omissão), o p75 da Fila, mas só quando a Fila está medida em 60 % ou mais das entregas da cidade (abaixo disso fica o p75 do total). [origem: shared/extrasPressure.ts:tightThresholds; shared/extrasPressure.ts:TIGHT_TOP_SHARE; shared/appSettings.ts:DEFAULT_TIGHT_USES_QUEUE]\n- Com a escala pelos tempos medidos ligada na cidade, um escalão de equipa só usa o valor medido com pelo menos 30 serviços medidos em horas cheias, e nunca acima da tabela de máximos. [origem: shared/extrasPressure.ts:CREW_MEASURE_MIN_SAMPLES]\n- Proposta automática a partir das 11:00 (por omissão), para 1 dia(s) à frente por omissão; só faz a PRIMEIRA proposta de cada dia e cidade. [origem: shared/appSettings.ts:SETTINGS[extras.autoProposeAt]; shared/appSettings.ts:SETTINGS[extras.autoProposeDaysAhead]]\n- Confirmar e avisar automaticamente: ligado por omissão, às 15:00 (por omissão): a proposta de amanhã que ninguém confirmou nem suspendeu é confirmada e os extras são avisados por WhatsApp e email. [origem: shared/appSettings.ts:SETTINGS[extras.autoConfirm]; shared/appSettings.ts:SETTINGS[extras.autoConfirmAt]]\n- A mão humana manda: qualquer mudança nos condutores de um dia (pôr, tirar, mudar horas, preencher, confirmar, suspender…) marca o dia como «mexido à mão» e a proposta automática já não o muda; mexer só no TL não trava. [origem: shared/extrasSchedule.ts:autoProposeBlockedReason]\n- Turnos entre 3 h e 12 h, no dia operacional que vai das 03h às 03h do dia seguinte. [origem: shared/extrasSchedule.ts:MIN_SHIFT_HOURS; shared/extrasSchedule.ts:MAX_SHIFT_HOURS; shared/extrasSchedule.ts:DAY_START_HOUR]\n- Ordem dos candidatos (soma ponderada): cobertura 45 %, avaliação 20 %, custo 15 %, equidade 12 % e fiabilidade 8 %; empates por horas cobertas, custo e nome. [origem: shared/extrasSchedule.ts:RANK_WEIGHTS]\n- Cada hora paga sem falta de gente pesa 0,5 contra o bloco: prefere dois turnos curtos a um longo com horas paradas. [origem: shared/extrasSchedule.ts:IDLE_PENALTY]\n- Recolha pelo meio de uma entrega (quando ligada na cidade): no mesmo terminal, entre 10 min antes e 30 min depois da entrega, não conta como um carro a mais. [origem: shared/extrasSchedule.ts:PICKUP_PAIR_BEFORE_MIN; shared/extrasSchedule.ts:PICKUP_PAIR_AFTER_MIN]\n- Um aviso de escala que falha é tentado no máximo 4 vezes (por canal), cada nova tentativa 30 min × as tentativas já feitas depois da anterior (30, 60 e 90 min). Quem ficar por avisar (nenhum canal chegou: falhou em todas, número inválido, sem contacto ou STOP) gera um aviso ao TL, ao supervisor e ao back office, só com o interruptor «Extras-dia: avisos da escala» (desligado por omissão). [origem: shared/extrasSchedule.ts:unnotifiedAfterRetries; shared/extrasSchedule.ts:MAX_NOTIFY_ATTEMPTS; shared/extrasSchedule.ts:NOTIFY_RETRY_STEP_MIN; shared/appSettings.ts:AUTOMATION_FLAGS[EXTRAS_SCHEDULE_ALERTS]]\n- Dia mexido à mão na hora da confirmação: «Confirma na mesma (como até aqui)» por omissão (as outras opções: não confirmar e avisar — repete às 18:00 se continuar por confirmar —, ou só confirmar quando a última mudança à mão tiver mais de 30 min; mexer depois das ~23:15 avisa, porque já não dá para confirmar sozinho). [origem: shared/extrasSchedule.ts:autoConfirmDecision; shared/extrasSchedule.ts:MANUAL_EDIT_AT_CONFIRM_DEFAULT; shared/extrasSchedule.ts:MANUAL_HOLD_REPEAT_AT_MIN; shared/extrasSchedule.ts:MANUAL_EDIT_SETTLE_MIN]\n- Lembretes 30 min antes da proposta e da confirmação (interruptor desligado por omissão); a quem e em que dias, por cidade, numa definição (por omissão TL e supervisor, todos os dias). [origem: shared/extrasReminders.ts:remindersDue; shared/extrasReminders.ts:REMINDER_LEAD_MIN; shared/appSettings.ts:AUTOMATION_FLAGS[EXTRAS_REMINDERS]]\n- Depois da confirmação automática, uma escala que cubra menos de 80 % das horas×condutor previstas gera um aviso ao TL, ao supervisor e ao back office (só com o interruptor dos avisos da escala ligado). [origem: shared/extrasSchedule.ts:scheduleCoverage; shared/extrasSchedule.ts:COVERAGE_ALERT_MIN]"
 },
 "tempos": {
  "label": "Tempos de entrega e de recolha",
  "rules": [
   {
    "text": "Entregas: Fila = do mais cedo entre a chamada do cliente e o pendente (com «contar desde a chamada» ligado por omissão; desligado, só o pendente) até o condutor pegar no carro; Trânsito = até chegar ao terminal (GPS); Cliente = até à assinatura; Nosso = Fila + Trânsito. A hora marcada na ficha não entra em nenhum tempo.",
    "sources": [
     "shared/serviceTimes.ts:deliveryTimes",
     "shared/appSettings.ts:SETTINGS[serviceTimes.useCalls]"
    ]
   },
   {
    "text": "A meta do Nosso é 15 min por omissão (conta para a % na meta).",
    "sources": [
     "shared/serviceTimes.ts:DEFAULT_SERVICE_TARGET_MINUTES"
    ]
   },
   {
    "text": "A chamada conta se for até 60 min antes (ou 5 min depois) do pendente; as chamadas só existem desde 6 out 2026.",
    "sources": [
     "shared/serviceTimes.ts:CALL_WINDOW_BEFORE_MIN",
     "shared/serviceTimes.ts:CALL_WINDOW_AFTER_MIN",
     "shared/serviceTimes.ts:SERVICE_CALLS_SINCE"
    ]
   },
   {
    "text": "O mesmo telefone em 3 ou mais reservas com pedido no mesmo dia é uma agência ou um hotel: a chamada não conta.",
    "sources": [
     "shared/serviceTimes.ts:SHARED_PHONE_MIN_BOOKINGS"
    ]
   },
   {
    "text": "Dois inícios do mesmo agente a menos de 8 min = quem despacha, não quem conduz.",
    "sources": [
     "shared/serviceTimes.ts:DISPATCH_MIN_MINUTES"
    ]
   },
   {
    "text": "Fora dos limites (não contam): Fila acima de 240 min, Trânsito acima de 120 min, Cliente acima de 240 min. «Sem medição» nunca é 0.",
    "sources": [
     "shared/serviceTimes.ts:MAX_QUEUE_MIN",
     "shared/serviceTimes.ts:MAX_TRANSIT_MIN",
     "shared/serviceTimes.ts:MAX_CUSTOMER_MIN"
    ]
   },
   {
    "text": "Recolhas: atrasada só no T2, quando o condutor chega à zona T2 mais de 15 min (por omissão) depois do mais cedo entre a chamada do cliente e o «em recolha»; sem GPS fica sem medição, nunca «a tempo».",
    "sources": [
     "shared/serviceTimes.ts:pickupTimes",
     "shared/serviceTimes.ts:DEFAULT_PICKUP_T2_TARGET_MINUTES"
    ]
   },
   {
    "text": "Depois do check-in, por omissão: P2 é a garagem provisória; CENTRAL e CENTRAL COBERTO já são um parque (pára de medir); PD, PD FORA e COBERTO são o parque certo se o tipo de lugar bater (por omissão). Os movimentos contam até 48 h depois do check-in.",
    "sources": [
     "shared/serviceTimes.ts:DEFAULT_GARAGE_ROLES",
     "shared/serviceTimes.ts:PICKUP_TRACK_MAX_HOURS"
    ]
   },
   {
    "text": "Os tempos que dependem do GPS só aparecem com o portão aberto e, por cidade e período, cobertura de pelo menos 60 % e 20 medições (por omissão); com o portão fechado só o super admin os vê, «em calibração».",
    "sources": [
     "shared/serviceTimes.ts:DEFAULT_GPS_GATE"
    ]
   },
   {
    "text": "Tempos por condutor: só informação (não dão pontos); com menos de 10 medições não se mostra número.",
    "sources": [
     "shared/serviceTimes.ts:DRIVER_STATS_MIN_N"
    ]
   },
   {
    "text": "Medição desde 3 abr 2026 por omissão; com GPS desde 15 set 2026 por omissão.",
    "sources": [
     "shared/serviceTimes.ts:SERVICE_TIMES_SINCE_DEFAULT",
     "shared/serviceTimes.ts:SERVICE_TIMES_GPS_SINCE_DEFAULT"
    ]
   }
  ],
  "block": "Regras em vigor — Tempos de entrega e de recolha (valores do código; \"por omissão\" = o valor de uma definição que se pode mudar em Definições).\n- Entregas: Fila = do mais cedo entre a chamada do cliente e o pendente (com «contar desde a chamada» ligado por omissão; desligado, só o pendente) até o condutor pegar no carro; Trânsito = até chegar ao terminal (GPS); Cliente = até à assinatura; Nosso = Fila + Trânsito. A hora marcada na ficha não entra em nenhum tempo. [origem: shared/serviceTimes.ts:deliveryTimes; shared/appSettings.ts:SETTINGS[serviceTimes.useCalls]]\n- A meta do Nosso é 15 min por omissão (conta para a % na meta). [origem: shared/serviceTimes.ts:DEFAULT_SERVICE_TARGET_MINUTES]\n- A chamada conta se for até 60 min antes (ou 5 min depois) do pendente; as chamadas só existem desde 6 out 2026. [origem: shared/serviceTimes.ts:CALL_WINDOW_BEFORE_MIN; shared/serviceTimes.ts:CALL_WINDOW_AFTER_MIN; shared/serviceTimes.ts:SERVICE_CALLS_SINCE]\n- O mesmo telefone em 3 ou mais reservas com pedido no mesmo dia é uma agência ou um hotel: a chamada não conta. [origem: shared/serviceTimes.ts:SHARED_PHONE_MIN_BOOKINGS]\n- Dois inícios do mesmo agente a menos de 8 min = quem despacha, não quem conduz. [origem: shared/serviceTimes.ts:DISPATCH_MIN_MINUTES]\n- Fora dos limites (não contam): Fila acima de 240 min, Trânsito acima de 120 min, Cliente acima de 240 min. «Sem medição» nunca é 0. [origem: shared/serviceTimes.ts:MAX_QUEUE_MIN; shared/serviceTimes.ts:MAX_TRANSIT_MIN; shared/serviceTimes.ts:MAX_CUSTOMER_MIN]\n- Recolhas: atrasada só no T2, quando o condutor chega à zona T2 mais de 15 min (por omissão) depois do mais cedo entre a chamada do cliente e o «em recolha»; sem GPS fica sem medição, nunca «a tempo». [origem: shared/serviceTimes.ts:pickupTimes; shared/serviceTimes.ts:DEFAULT_PICKUP_T2_TARGET_MINUTES]\n- Depois do check-in, por omissão: P2 é a garagem provisória; CENTRAL e CENTRAL COBERTO já são um parque (pára de medir); PD, PD FORA e COBERTO são o parque certo se o tipo de lugar bater (por omissão). Os movimentos contam até 48 h depois do check-in. [origem: shared/serviceTimes.ts:DEFAULT_GARAGE_ROLES; shared/serviceTimes.ts:PICKUP_TRACK_MAX_HOURS]\n- Os tempos que dependem do GPS só aparecem com o portão aberto e, por cidade e período, cobertura de pelo menos 60 % e 20 medições (por omissão); com o portão fechado só o super admin os vê, «em calibração». [origem: shared/serviceTimes.ts:DEFAULT_GPS_GATE]\n- Tempos por condutor: só informação (não dão pontos); com menos de 10 medições não se mostra número. [origem: shared/serviceTimes.ts:DRIVER_STATS_MIN_N]\n- Medição desde 3 abr 2026 por omissão; com GPS desde 15 set 2026 por omissão. [origem: shared/serviceTimes.ts:SERVICE_TIMES_SINCE_DEFAULT; shared/serviceTimes.ts:SERVICE_TIMES_GPS_SINCE_DEFAULT]"
 },
 "despesas": {
  "label": "Despesas",
  "rules": [
   {
    "text": "Lançar uma despesa já paga: só Admin e Super Admin, escolhendo o método de pagamento; fica paga com a data de vencimento ou, sem ela, a data da despesa. Sem método fica pendente.",
    "sources": [
     "shared/expenseCreatePayment.ts:paymentOnCreate",
     "shared/expenseCreatePayment.ts:PAID_ON_CREATE_ROLES"
    ]
   },
   {
    "text": "Para os outros papéis o método começa em «Cartão» e a despesa fica sempre pendente: o servidor nunca a marca paga por esta via.",
    "sources": [
     "shared/expenseCreatePayment.ts:defaultCreatePaymentMethod"
    ]
   },
   {
    "text": "Paga com data futura (vencimento depois de hoje) só com confirmação: o ecrã mostra um aviso âmbar.",
    "sources": [
     "shared/expenseCreatePayment.ts:isFuturePaidAt"
    ]
   },
   {
    "text": "Nota de crédito: documento próprio (n.º, data e PDF) ligado à fatura e gravado com valor negativo; os totais descontam no mês da data da nota e a fatura nunca é reescrita.",
    "sources": [
     "shared/creditNotes.ts:creditNoteStoredAmount"
    ]
   },
   {
    "text": "Estados da nota de crédito: «Por receber» (o fornecedor ainda vai devolver o dinheiro), «Recebida» (o dinheiro já voltou) e «Abatida» (descontada noutra fatura do mesmo fornecedor).",
    "sources": [
     "shared/creditNotes.ts:CREDIT_NOTE_STATE_LABELS"
    ]
   },
   {
    "text": "Uma nota de crédito não passa do que falta creditar na fatura, nem vai para uma fatura cancelada, eliminada ou para outra nota de crédito.",
    "sources": [
     "shared/creditNotes.ts:creditNoteError"
    ]
   }
  ],
  "block": "Regras em vigor — Despesas (valores do código; \"por omissão\" = o valor de uma definição que se pode mudar em Definições).\n- Lançar uma despesa já paga: só Admin e Super Admin, escolhendo o método de pagamento; fica paga com a data de vencimento ou, sem ela, a data da despesa. Sem método fica pendente. [origem: shared/expenseCreatePayment.ts:paymentOnCreate; shared/expenseCreatePayment.ts:PAID_ON_CREATE_ROLES]\n- Para os outros papéis o método começa em «Cartão» e a despesa fica sempre pendente: o servidor nunca a marca paga por esta via. [origem: shared/expenseCreatePayment.ts:defaultCreatePaymentMethod]\n- Paga com data futura (vencimento depois de hoje) só com confirmação: o ecrã mostra um aviso âmbar. [origem: shared/expenseCreatePayment.ts:isFuturePaidAt]\n- Nota de crédito: documento próprio (n.º, data e PDF) ligado à fatura e gravado com valor negativo; os totais descontam no mês da data da nota e a fatura nunca é reescrita. [origem: shared/creditNotes.ts:creditNoteStoredAmount]\n- Estados da nota de crédito: «Por receber» (o fornecedor ainda vai devolver o dinheiro), «Recebida» (o dinheiro já voltou) e «Abatida» (descontada noutra fatura do mesmo fornecedor). [origem: shared/creditNotes.ts:CREDIT_NOTE_STATE_LABELS]\n- Uma nota de crédito não passa do que falta creditar na fatura, nem vai para uma fatura cancelada, eliminada ou para outra nota de crédito. [origem: shared/creditNotes.ts:creditNoteError]"
 },
 "parcerias": {
  "label": "Parcerias",
  "rules": [
   {
    "text": "«Agregador»: Sites de venda (ex: Looking4Parking, Parkos). Recebem comissão sobre a reserva. Cobrança: comissão sobre a receita das reservas (receita × taxa de comissão).",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Agência de viagem»: Agências que vendem o estacionamento como parte de um pacote. Cobrança: comissão sobre a receita das reservas (receita × taxa de comissão).",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Avença mensal»: Valor fixo cobrado todos os meses. Cobrança: avença fixa por mês.",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Avença anual»: Valor fixo em €/mês, como a mensal; muda só a fatura, que cobre os meses do período escolhido (valor × meses). Cobrança: avença em €/mês, como a mensal: cada fatura cobre o período escolhido (valor × meses desse período).",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Cliente Pro (Airpark)»: Empresas Pro — actualmente só na marca Airpark. Faturam no fim do mês com desconto. Cobrança: fatura no fim do mês, com desconto.",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Hotel»: Parceria com hotéis. Comissão sobre a reserva trazida. Cobrança: comissão sobre a receita das reservas (receita × taxa de comissão).",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Companhia aérea»: Parceria com companhias aéreas. Comissão sobre a reserva. Cobrança: comissão sobre a receita das reservas (receita × taxa de comissão).",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Afiliado»: Comissão pequena. Cliente do afiliado tem desconto já reflectido na fatura. Cobrança: comissão de afiliado (taxa normalmente baixa).",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Enterprise / Corporate»: Cliente corporate. Paga logo no acto. Desconto já vem na reserva. Cobrança: o cliente paga logo, com o desconto já na reserva.",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Campanha própria»: Promoções nossas com descontos, cashback ou prémios — vão para o centro de custos. Cobrança: campanha nossa (descontos, cashback ou prémios) — vai para o centro de custos.",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Operacional»: Parceiro que gere operações (ex: Top Parking para marcas do Porto). Pagamos comissão operacional. Cobrança: parceiro operacional — pagamos comissão operacional.",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "«Outro»: Casos não cobertos pelos tipos acima. Cobrança: sem modelo automático (lançamento manual).",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_TYPES"
    ]
   },
   {
    "text": "Categorias: «Prós» — Empresas com plano Pro (faturação mensal com desconto); «Agências de viagens» — Agências que vendem o estacionamento em pacote; «Empresas parceiras» — ACP, corporates, hotéis, companhias aéreas, avenças e afiliados; «Agregadores» — Sites de venda (Parkos, Parclick, Parkvia, …) à comissão; «Operacional / Campanhas» — Parceiros operacionais e campanhas próprias — custo, não venda.",
    "sources": [
     "shared/partnerTypes.ts:PARTNER_CATEGORIES"
    ]
   },
   {
    "text": "Sem comissão de venda: Cliente Pro (Airpark), Avença mensal e Avença anual (o Pro tem desconto; a avença paga uma mensalidade).",
    "sources": [
     "shared/partnerRules.ts:NO_COMMISSION_TYPES"
    ]
   },
   {
    "text": "Avença (mensal ou anual): o valor é sempre €/mês e fatura-se valor × meses cobertos (cada mês conta os dias no intervalo ÷ os dias do mês); a anual só muda a periodicidade da fatura.",
    "sources": [
     "shared/partnerRules.ts:partnerFeeForPeriod"
    ]
   },
   {
    "text": "Os tipos que vêm da Multipark (Pros, avenças, agências, agregadores) ligam-se em «Ligar à Multipark» e o tipo e a taxa vêm de lá; só os nossos (hotel, empresa, outro…) ficam «por configurar» até um admin os gravar.",
    "sources": [
     "shared/partnerRules.ts:isPartnerUnconfigured"
    ]
   }
  ],
  "block": "Regras em vigor — Parcerias (valores do código; \"por omissão\" = o valor de uma definição que se pode mudar em Definições).\n- «Agregador»: Sites de venda (ex: Looking4Parking, Parkos). Recebem comissão sobre a reserva. Cobrança: comissão sobre a receita das reservas (receita × taxa de comissão). [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Agência de viagem»: Agências que vendem o estacionamento como parte de um pacote. Cobrança: comissão sobre a receita das reservas (receita × taxa de comissão). [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Avença mensal»: Valor fixo cobrado todos os meses. Cobrança: avença fixa por mês. [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Avença anual»: Valor fixo em €/mês, como a mensal; muda só a fatura, que cobre os meses do período escolhido (valor × meses). Cobrança: avença em €/mês, como a mensal: cada fatura cobre o período escolhido (valor × meses desse período). [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Cliente Pro (Airpark)»: Empresas Pro — actualmente só na marca Airpark. Faturam no fim do mês com desconto. Cobrança: fatura no fim do mês, com desconto. [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Hotel»: Parceria com hotéis. Comissão sobre a reserva trazida. Cobrança: comissão sobre a receita das reservas (receita × taxa de comissão). [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Companhia aérea»: Parceria com companhias aéreas. Comissão sobre a reserva. Cobrança: comissão sobre a receita das reservas (receita × taxa de comissão). [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Afiliado»: Comissão pequena. Cliente do afiliado tem desconto já reflectido na fatura. Cobrança: comissão de afiliado (taxa normalmente baixa). [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Enterprise / Corporate»: Cliente corporate. Paga logo no acto. Desconto já vem na reserva. Cobrança: o cliente paga logo, com o desconto já na reserva. [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Campanha própria»: Promoções nossas com descontos, cashback ou prémios — vão para o centro de custos. Cobrança: campanha nossa (descontos, cashback ou prémios) — vai para o centro de custos. [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Operacional»: Parceiro que gere operações (ex: Top Parking para marcas do Porto). Pagamos comissão operacional. Cobrança: parceiro operacional — pagamos comissão operacional. [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- «Outro»: Casos não cobertos pelos tipos acima. Cobrança: sem modelo automático (lançamento manual). [origem: shared/partnerTypes.ts:PARTNER_TYPES]\n- Categorias: «Prós» — Empresas com plano Pro (faturação mensal com desconto); «Agências de viagens» — Agências que vendem o estacionamento em pacote; «Empresas parceiras» — ACP, corporates, hotéis, companhias aéreas, avenças e afiliados; «Agregadores» — Sites de venda (Parkos, Parclick, Parkvia, …) à comissão; «Operacional / Campanhas» — Parceiros operacionais e campanhas próprias — custo, não venda. [origem: shared/partnerTypes.ts:PARTNER_CATEGORIES]\n- Sem comissão de venda: Cliente Pro (Airpark), Avença mensal e Avença anual (o Pro tem desconto; a avença paga uma mensalidade). [origem: shared/partnerRules.ts:NO_COMMISSION_TYPES]\n- Avença (mensal ou anual): o valor é sempre €/mês e fatura-se valor × meses cobertos (cada mês conta os dias no intervalo ÷ os dias do mês); a anual só muda a periodicidade da fatura. [origem: shared/partnerRules.ts:partnerFeeForPeriod]\n- Os tipos que vêm da Multipark (Pros, avenças, agências, agregadores) ligam-se em «Ligar à Multipark» e o tipo e a taxa vêm de lá; só os nossos (hotel, empresa, outro…) ficam «por configurar» até um admin os gravar. [origem: shared/partnerRules.ts:isPartnerUnconfigured]"
 },
 "casos": {
  "label": "Reclamações, ocorrências e perdidos",
  "rules": [
   {
    "text": "Prazo das ocorrências: 48 h por omissão (Definições → Prazos (SLA)).",
    "sources": [
     "shared/caseRules.ts:DEFAULT_INCIDENT_SLA_HOURS"
    ]
   },
   {
    "text": "Perdidos: em atraso ao fim de 7 dias por omissão, quando o caso não tem prazo próprio na Atribuição (âmbar a cerca de 3/7 do prazo).",
    "sources": [
     "shared/caseRules.ts:lostAgeTone",
     "shared/caseRules.ts:DEFAULT_LOST_SLA_DAYS"
    ]
   },
   {
    "text": "Reclamações: o prazo corre só em «Novo» e «Em Análise»; em «Aguarda Cliente» pára. Enviar um email ao cliente passa a «Aguarda Cliente»; a resposta do cliente volta a «Em Análise».",
    "sources": [
     "shared/caseRules.ts:complaintStatusAfterEmail",
     "shared/caseRules.ts:COMPLAINT_SLA_RUNNING"
    ]
   },
   {
    "text": "A lista das Reclamações abre nos últimos 90 dias; as que estão abertas aparecem sempre.",
    "sources": [
     "shared/caseRules.ts:COMPLAINT_LIST_DEFAULT_DAYS"
    ]
   },
   {
    "text": "Cada foto de uma reclamação pode ter até 4 MB.",
    "sources": [
     "shared/caseRules.ts:COMPLAINT_PHOTO_MAX_BYTES"
    ]
   },
   {
    "text": "Duplicado (email ↔ app Multipark): mesma matrícula, reserva que não contradiz e até 2 h de diferença.",
    "sources": [
     "shared/caseRules.ts:DEDUPE_WINDOW_MS"
    ]
   },
   {
    "text": "Uma ocorrência só conta contra o condutor com o condutor indicado, o envolvimento confirmado (team leader ou acima) e não descartada nem convertida.",
    "sources": [
     "shared/caseRules.ts:incidentCountsAgainstDriver"
    ]
   },
   {
    "text": "«Devolvido» nos Perdidos obriga a dizer como e quando; «Outro» obriga a escrever como foi.",
    "sources": [
     "shared/caseRules.ts:lostReturnedError"
    ]
   }
  ],
  "block": "Regras em vigor — Reclamações, ocorrências e perdidos (valores do código; \"por omissão\" = o valor de uma definição que se pode mudar em Definições).\n- Prazo das ocorrências: 48 h por omissão (Definições → Prazos (SLA)). [origem: shared/caseRules.ts:DEFAULT_INCIDENT_SLA_HOURS]\n- Perdidos: em atraso ao fim de 7 dias por omissão, quando o caso não tem prazo próprio na Atribuição (âmbar a cerca de 3/7 do prazo). [origem: shared/caseRules.ts:lostAgeTone; shared/caseRules.ts:DEFAULT_LOST_SLA_DAYS]\n- Reclamações: o prazo corre só em «Novo» e «Em Análise»; em «Aguarda Cliente» pára. Enviar um email ao cliente passa a «Aguarda Cliente»; a resposta do cliente volta a «Em Análise». [origem: shared/caseRules.ts:complaintStatusAfterEmail; shared/caseRules.ts:COMPLAINT_SLA_RUNNING]\n- A lista das Reclamações abre nos últimos 90 dias; as que estão abertas aparecem sempre. [origem: shared/caseRules.ts:COMPLAINT_LIST_DEFAULT_DAYS]\n- Cada foto de uma reclamação pode ter até 4 MB. [origem: shared/caseRules.ts:COMPLAINT_PHOTO_MAX_BYTES]\n- Duplicado (email ↔ app Multipark): mesma matrícula, reserva que não contradiz e até 2 h de diferença. [origem: shared/caseRules.ts:DEDUPE_WINDOW_MS]\n- Uma ocorrência só conta contra o condutor com o condutor indicado, o envolvimento confirmado (team leader ou acima) e não descartada nem convertida. [origem: shared/caseRules.ts:incidentCountsAgainstDriver]\n- «Devolvido» nos Perdidos obriga a dizer como e quando; «Outro» obriga a escrever como foi. [origem: shared/caseRules.ts:lostReturnedError]"
 },
 "criticas": {
  "label": "Críticas Google",
  "rules": [
   {
    "text": "«Respondida» quer dizer publicada: guardar um texto é só rascunho. Nas críticas da API publica o «Aprovar e publicar»; nas de email, quem respondeu no perfil Google carrega em «Já publiquei no Google».",
    "sources": [
     "shared/reviewRules.ts:reviewUpdatePatch"
    ]
   },
   {
    "text": "Converter numa reclamação abre-a com prazo de 24 h e prioridade urgente (1★) ou alta (as outras).",
    "sources": [
     "shared/reviewRules.ts:reviewComplaintPriority",
     "shared/reviewRules.ts:REVIEW_COMPLAINT_SLA_HOURS"
    ]
   },
   {
    "text": "Uma crítica convertida já não muda de estado aqui (trata-se na reclamação); a resposta pública continua a ser aqui.",
    "sources": [
     "shared/reviewRules.ts:reviewUpdatePatch"
    ]
   },
   {
    "text": "Rascunho automático (interruptor «IA: rascunho automático para cada crítica nova», ligado por omissão) só para críticas com até 14 dias: conta a data da crítica, sem ela a do email que a trouxe e, sem nenhuma, a data em que foi registada cá; sem data legível, não.",
    "sources": [
     "shared/reviewRules.ts:reviewAutoDraftEligible",
     "shared/appSettings.ts:AUTOMATION_FLAGS[AI_REVIEW_AUTO_DRAFTS]",
     "shared/reviewRules.ts:REVIEW_AUTO_DRAFT_MAX_AGE_DAYS"
    ]
   },
   {
    "text": "Respostas automáticas às 5★ (interruptor desligado por omissão, só o super admin): só 5★ ligadas ao Google, recentes, sem reclamação nem resposta e sem links, contactos, insultos ou instruções no texto; a resposta (40–400 caracteres, sem números nem contactos, na língua da crítica) fica 6 h à vista com «Cancelar» e só sai se a crítica, lida outra vez no Google, continuar com 5★, o texto da preparação e sem resposta (e só grava se continuar sem resposta cá); só se prepara com canal para publicar e com a IA dos rascunhos automáticos ligada; publica com o 1.º super admin; no máximo 20 por perfil em 24 h; pára ao fim de 3 falhas seguidas.",
    "sources": [
     "shared/reviewAutoPublish.ts:autoPublishEntryRefusal",
     "shared/appSettings.ts:AUTOMATION_FLAGS[REVIEW_AUTO_PUBLISH_5STAR]",
     "shared/reviewAutoPublish.ts:REPLY_MIN_CHARS",
     "shared/reviewAutoPublish.ts:REPLY_MAX_CHARS",
     "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_DELAY_HOURS",
     "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY",
     "shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_MAX_CONSECUTIVE_FAILURES"
    ]
   },
   {
    "text": "As críticas marcadas como «não é crítica» ou como repetidas nunca levam rascunho automático.",
    "sources": [
     "server/reviewAutoDraft.ts:autoDraftReview"
    ]
   }
  ],
  "block": "Regras em vigor — Críticas Google (valores do código; \"por omissão\" = o valor de uma definição que se pode mudar em Definições).\n- «Respondida» quer dizer publicada: guardar um texto é só rascunho. Nas críticas da API publica o «Aprovar e publicar»; nas de email, quem respondeu no perfil Google carrega em «Já publiquei no Google». [origem: shared/reviewRules.ts:reviewUpdatePatch]\n- Converter numa reclamação abre-a com prazo de 24 h e prioridade urgente (1★) ou alta (as outras). [origem: shared/reviewRules.ts:reviewComplaintPriority; shared/reviewRules.ts:REVIEW_COMPLAINT_SLA_HOURS]\n- Uma crítica convertida já não muda de estado aqui (trata-se na reclamação); a resposta pública continua a ser aqui. [origem: shared/reviewRules.ts:reviewUpdatePatch]\n- Rascunho automático (interruptor «IA: rascunho automático para cada crítica nova», ligado por omissão) só para críticas com até 14 dias: conta a data da crítica, sem ela a do email que a trouxe e, sem nenhuma, a data em que foi registada cá; sem data legível, não. [origem: shared/reviewRules.ts:reviewAutoDraftEligible; shared/appSettings.ts:AUTOMATION_FLAGS[AI_REVIEW_AUTO_DRAFTS]; shared/reviewRules.ts:REVIEW_AUTO_DRAFT_MAX_AGE_DAYS]\n- Respostas automáticas às 5★ (interruptor desligado por omissão, só o super admin): só 5★ ligadas ao Google, recentes, sem reclamação nem resposta e sem links, contactos, insultos ou instruções no texto; a resposta (40–400 caracteres, sem números nem contactos, na língua da crítica) fica 6 h à vista com «Cancelar» e só sai se a crítica, lida outra vez no Google, continuar com 5★, o texto da preparação e sem resposta (e só grava se continuar sem resposta cá); só se prepara com canal para publicar e com a IA dos rascunhos automáticos ligada; publica com o 1.º super admin; no máximo 20 por perfil em 24 h; pára ao fim de 3 falhas seguidas. [origem: shared/reviewAutoPublish.ts:autoPublishEntryRefusal; shared/appSettings.ts:AUTOMATION_FLAGS[REVIEW_AUTO_PUBLISH_5STAR]; shared/reviewAutoPublish.ts:REPLY_MIN_CHARS; shared/reviewAutoPublish.ts:REPLY_MAX_CHARS; shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_DELAY_HOURS; shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_MAX_PER_PROFILE_DAY; shared/reviewAutoPublish.ts:REVIEW_AUTO_PUBLISH_MAX_CONSECUTIVE_FAILURES]\n- As críticas marcadas como «não é crítica» ou como repetidas nunca levam rascunho automático. [origem: server/reviewAutoDraft.ts:autoDraftReview]"
 }
};
