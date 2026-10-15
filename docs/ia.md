# Inteligência artificial (IA)

Toda a IA da aplicação passa por um único módulo, `server/_core/ai/` (ver o
[README técnico](../server/_core/ai/README.md)). O fornecedor principal é o
**Google Gemini**, escolhido por ser o mais barato. Primeiro usamos a Gemini API
(Google AI Studio). Mais tarde passamos para o Vertex AI na UE, sem mudar código.

## 1. Configuração

### Google AI Studio (agora)

1. Em <https://aistudio.google.com/apikey>, cria uma chave num projeto com
   faturação ativa. O nível pago não usa os dados para treinar modelos.
2. No Vercel, define `GEMINI_API_KEY`.
3. Em Integrações → IA (Gemini), carrega em **Testar**. O teste faz uma chamada
   de poucos tokens.

### Vertex AI na UE (depois)

1. No Google Cloud, ativa a API Vertex AI e cria uma conta de serviço com o
   papel *Vertex AI User*. Gera uma chave JSON.
2. No Vercel, define:
   - `GOOGLE_GENAI_USE_VERTEXAI=true`
   - `GOOGLE_CLOUD_PROJECT=<id do projeto>`
   - `GOOGLE_CLOUD_LOCATION=europe-west1`. É a omissão; podes usar outra região
     da UE que tenha os modelos.
   - `GOOGLE_SERVICE_ACCOUNT_JSON=<o JSON, em texto ou base64>`
3. O Vertex ganha à `GEMINI_API_KEY`. Quando tudo funcionar, podes apagar a chave.
   - **Ficheiros pessoais inteiros** (documentos e CV do RH: `AI_HR_AUTOFILL` e
     `AI_HR_EMAIL_ATTACHMENTS`) **só correm em Vertex AI numa região da UE**
     (`europe-*`, menos `europe-west2` Londres e `europe-west6` Zurique; ou `eu`).
     Com o Google AI Studio (ou o fornecedor antigo) não correm, mesmo com o
     interruptor ligado. Regra em `shared/aiLimits.ts`, aplicada no `runAi` e
     no `aiFeatureAvailable`; as Definições → Automações dizem ao lado do
     interruptor onde está a IA hoje.
4. Confirma que os modelos escolhidos existem na região escolhida. Se não
   existirem, muda os `AI_MODEL_*`.

### Fornecedor antigo (compatibilidade)

`LLM_API_URL`, `LLM_API_KEY` e `LLM_MODEL` continuam a funcionar através do
adaptador "legacy". Ele usa a Anthropic quando o URL contém "anthropic" e, nos
outros casos, uma API compatível com a OpenAI. A escolha do fornecedor faz-se
por esta ordem:

- `AI_PROVIDER_<FUNCIONALIDADE>`, por exemplo `AI_PROVIDER_EXPENSE_OCR=legacy`;
- `AI_PROVIDER` (`gemini` ou `legacy`);
- automático: Gemini se estiver configurado, senão o antigo.

Um fornecedor pedido explicitamente mas sem configuração não cai para outro.
A funcionalidade fica "não configurada".

### Transcrição do rádio

A transcrição usa o Gemini, com o áudio como entrada (`AI_MODEL_STT`, por
omissão o modelo lite). O Whisper da OpenAI só entra quando `OPENAI_API_KEY`
está definida. Nesse caso é usado como recurso se o Gemini falhar, ou como
fornecedor principal se não houver Gemini. O Whisper fala sempre com
`api.openai.com`. Antes o pedido ia para o `LLM_API_URL`, o que falhava com a
Anthropic.

## 2. Modelos

Há três níveis de modelo. Cada um é escolhido por uma variável de ambiente.

| Nível | Env | Omissão (set 2026) | Uso |
|---|---|---|---|
| lite | `AI_MODEL_LITE` | `gemini-3.1-flash-lite` | **Todas as funcionalidades, por omissão.** É o mais barato. |
| fast | `AI_MODEL_FAST` | `gemini-3.8-flash` | Só onde o lite falha: faturas em PDF (várias páginas) e perguntas da formação. |
| smart | `AI_MODEL_SMART` | `gemini-3.1-pro-preview` | Só o **Multis do piloto** (`assistant_smart`, plano MPV F0b; pôr `AI_MODEL_SMART=gemini-4-argon`). Antes da 1.ª volta de ferramentas, um 404 ou um 429/quota (este depois de 2 novas tentativas, com 1 s e 3 s de espera) cai para o fast (`gemini-3.8-flash`). Depois da 1.ª volta não troca de modelo (o histórico já leva o conteúdo do smart): vai à chamada final. |

Regra do dono: usar o modelo mais barato sempre que possível. Para mudar o nível
de uma funcionalidade sem deploy:

- em Definições → Parâmetros → **Nível de modelo por funcionalidade de IA**, por
  exemplo `{"expense_ocr": "fast"}`;
- ou com a env `AI_TIER_<FUNCIONALIDADE>`, por exemplo `AI_TIER_EXPENSE_OCR=fast`.

A precedência é: Definições, depois env, depois o código.

Os Gemini 3.x correm com `thinkingLevel: low`, para gastar menos tokens de
raciocínio. A env `AI_THINKING_LEVEL` muda este valor (`off` usa o do modelo).

**Raciocínio por funcionalidade** (plano MPV, F0a): em Definições → Parâmetros →
**Raciocínio da IA por funcionalidade** (`ai.thinkingLevels`), por exemplo
`{"mail_routing": "minimal", "assistant": "low"}`. Níveis: `minimal`, `low`,
`medium`, `high` ou `default` (não manda o nível: fica o do modelo). Ordem:
Definições → o ponto de chamada (`runAi({ thinkingLevel })`) → env
`AI_THINKING_LEVEL` → `low`. Vazio = como até aqui. Só vale nos modelos que
aceitam o nível (Gemini 3.x). O raciocínio paga-se como saída e gasta do mesmo
teto (`maxTokens`): quem pede `scaleMaxTokensForThinking` (o Multis) sobe o teto
ao mínimo do nível (`maxTokensFor`: low 900, medium 4 096, high 8 192); o Multis
v1 passa assim de 700 para 900. Com o nível `default` (ou `AI_THINKING_LEVEL=off`) o nível efetivo é o do
modelo e o teto sobe ao maior (8 192), porque nos Gemini 3 o raciocínio do modelo costuma ser alto. Os
modelos Pro/smart podem recusar `minimal`: no nível smart o `minimal` é ignorado (fica a env, `low`).

**Function calling** (`runAi` com `tools`): todas as chamadas pedidas numa volta
recebem resposta (acima de 4 recebem "limite de chamadas nesta ronda"). No
máximo de voltas, ou quando o prazo deixa só a reserva (`finalReserveMs`,
omissão 8 s), faz-se uma chamada final **sem cache e sem ferramentas** ("responde
com o que tens"). Se a API recusar o histórico com ferramentas sem as declarar
(400), os resultados vão resumidos em texto (o `<` dos resultados vai como `\u003c`, para não fechar o
bloco); só quando o 400 fala de function/tool **e** o resumo resulta é que a instância passa a ir logo pelo
resumo — **por modelo, durante 1 h** (registo `final_summary` sempre que o resumo é usado). Se nem assim
houver texto, a pessoa recebe "Não consegui juntar tudo a tempo…" — nunca um erro depois de pagas as
voltas; no registo essa resposta conta como **erro** `final_fallback`. Depois de pelo menos uma volta,
**qualquer** erro (sem texto por `MAX_TOKENS`, 503 que já não cabe no prazo, 404/429 a meio) também leva
à chamada final. Com `schema` (não se combina com ferramentas hoje) não há texto de recurso: o erro é
`tool_rounds`. Teste manual contra a API real (não corre no CI):
`pnpm tsx scripts/check-final-call.ts`.

**Registo** (`ai_usage_log`, migração 0690): além do custo, `finishReason`,
`rounds`, `variant` (`v1` no Multis de hoje) e `forcedFinal`; o portão "só
Vertex AI na UE" do RH deixa uma linha `blocked` / `eu_only` (sem conteúdo) — também quando é
verificado antes do `runAi` (`aiFeatureAvailableLogged`: leitura dos documentos do RH e varrimento
dos anexos, este no máximo 1 linha por hora por instância). O **uso por dia** conta ainda os
recursos (`final_fallback`), as finais forçadas e as respostas cortadas por `MAX_TOKENS`.

Os modelos da Google mudam depressa. Confirma os modelos em
<https://ai.google.dev/gemini-api/docs/models> e na página de
[descontinuações](https://ai.google.dev/gemini-api/docs/deprecations).

## 3. Funcionalidades e interruptores

Os interruptores estão em Definições → Automações → *Inteligência artificial*.
Também existem como env (`on`/`off`). O valor escolhido na página sobrepõe-se ao
da env.

**Onde corre cada uma, página a página** (quando, quem vê, que dados, o que
faz sozinha): [`docs/ia-inventario.md`](ia-inventario.md).

| Interruptor | Funcionalidade (`feature`) | Nível |
|---|---|---|
| `AI_ENABLED` | todas (interruptor geral) | — |
| `AI_EXPENSE_OCR` | `expense_ocr`: leitura de faturas nas Despesas e dos talões nas Despesas do turno (Passagem de turno → `shiftHandover.readReceipt`, mesmo `extractInvoice`) | lite (imagem) / fast (PDF) |
| `AI_REVIEW_DRAFTS` | `review_reply`: rascunho de resposta às críticas Google (4 pontos de entrada) | lite |
| `AI_RADIO` | `radio_transcription` + `radio_summary` | lite |
| `AI_HANDOVER_SUMMARY` | `handover_summary`: 5 pontos da passagem de turno, **só ao entregar** (1.ª gravação) e no botão "Resumir agora"; as edições não chamam a IA (o resumo fica "desatualizado", `aiSummaryVersion` < `version`, migração 0600) | lite |
| `AI_WHATSAPP_ASSIST` | `whatsapp_summary` + `whatsapp_reply` | lite |
| `AI_QUIZ` | `quiz_generation`: perguntas a partir dos manuais e da base de conhecimento (texto com `redactPii`; o PDF anexo vai inteiro) | fast (manual) / lite (base) |
| `AI_HR_AUTOFILL` | `hr_autofill`: documentos do RH (só campos vazios; o IBAN só entra na hora para quem o pode mudar na hora — os outros ficam com pedido ao RH, D49) | lite. **Desligado por omissão.** **Só corre com Vertex AI na UE.** |
| `AI_HR_EMAIL_ATTACHMENTS` | `hr_email_attachments`: anexos dos emails do RH (CV, documentos) → candidato (só campos vazios) + resumo para quem entrevista | lite. **Desligado por omissão**. **Só corre com Vertex AI na UE.** Corre no varrimento de 15 em 15 min (2 anexos por vez), só emails dos últimos 14 dias, cada anexo uma vez (`rh_attachment_reads`). NIF/BI-CC/carta só o RH vê. |
| `AI_QUIZ_LIVE` | `quiz_live`: em cada jogo do Quiz, 10 perguntas novas a partir dos trechos da base de conhecimento (visibilidade de quem joga) e dos manuais publicados, com `redactPii`; evita as que a pessoa já teve. A resposta certa fica em `training_quiz_ai_questions` (0660) e a correção é no servidor. Falha/desligada → perguntas fixas | fast. **Ligado por omissão** (Jorge, 14 out 2026: só corre quando a pessoa carrega em **Jogar** e só grava as perguntas dessa tentativa). Limite: 5 jogos por pessoa por dia (a tentativa é reservada antes do pedido: cliques repetidos não passam o limite); 30 s, sem nova tentativa. Quem gere só vê as perguntas de documentos que pode ver |
| `AI_KB_FAQ` | `kb_faq`: FAQs a partir da base de conhecimento (só documentos visíveis para todos, nunca a ajuda da app), 1 pedido por documento com `redactPii`; até 3 FAQs publicadas e marcadas "IA" (`faqs.source`, `sourceKbDocId`, `aiKey`, 0660), sem repetir as que existem nem as arquivadas | lite. Corre em **Gerar agora** (Formação → FAQs, quem gere) e no trabalho semanal `kb-faq-weekly` (segunda a partir das 09:30), que tem o seu interruptor `KB_FAQ_WEEKLY` — **desligado por omissão** (escreve sozinho). "Gerar agora": 3/hora e 8/dia; uma corrida de cada vez |
| `AI_TRAINING_TUTOR` | `training_tutor`: tutor da Formação (chat nos manuais, vídeos, percursos e quiz). Também `training_search`: "Procurar formação" escolhe no catálogo (só títulos e resumos, `redactPii`; 6/min e 60/dia por pessoa); falha ou desligado → pesquisa por palavras | lite |
| `AI_COMPLAINT_TRIAGE` | `complaint_triage`: triagem das reclamações por email | lite |
| `AI_REVIEW_AUTO_DRAFTS` | `review_auto_draft`: rascunho automático para cada crítica nova | lite |
| `AI_WHATSAPP_TRIAGE` | `whatsapp_triage`: intenção e urgência das conversas | lite |
| `AI_LOST_FOUND_MATCH` | `lost_found_match`: correspondências perdido ↔ achado | lite |
| `AI_CRM_IDENTITY` | `crm_identity`: "é a mesma pessoa?" nas sugestões duvidosas de Rever fichas (só o 1.º nome e factos; junta sozinha só com ≥ 85 %) | lite. **Desligado por omissão.** |
| `AI_ASSISTANT` | `assistant`: assistente (chat) em todas as páginas | lite |
| `AI_ASSISTANT_SMART` | `assistant_smart`: o Multis das pessoas do piloto (com o interruptor `MPV` e `ai.assistantPilot`), com teto € próprio (`ai.assistantSmartBudget`); desligado por omissão | smart |
| `AI_ASSISTANT_MEMORY` | Memória do Multis (não chama a IA): "Lembra-te…" grava a nota da pessoa sem IA (até 30, 300 car.); notas da empresa só admin/super_admin (até 100); as ativas vão no contexto do turno (`<memoria>`, fora da cache). `assistant_memories` (0605); arquivar não apaga | — (sem IA). **Ligado por omissão** (Jorge, 8 out 2026). Desligado: não grava, não usa as notas e esconde a Memória. |
| `AI_OPS_BRIEFING` | `ops_briefing`: parágrafo do briefing diário por cidade | lite |
| `AI_WEEKLY_REPORTS` | `weekly_report`: texto dos relatórios de segunda (direção, marketing, operações, RH) | lite |
| `AI_ANOMALY_EXPLAIN` | `anomaly_explain`: uma linha por anomalia (1 chamada por corrida); condutores e extras veem o alerta sem a linha da IA | lite |
| `AI_AVAILABILITY_CLASSIFY` | `availability_classify`: respostas de disponibilidade pouco claras | lite |
| `AI_LEAD_SCORING` | `lead_summary` + `lead_first_contact`: resumo da pontuação e rascunho do 1.º contacto (a aprovar); os dois só para quem edita as Leads | lite |
| `AI_EVALUATION_EXPLAIN` | `evaluation_explain`: explicação da avaliação | lite |
| `AI_HANDOVER_REPEATS` | `handover_repeats`: pendentes repetidos e resumo semanal da passagem | lite |
| `AI_TASKS_FROM_TEXT` | `tasks_from_text`: tarefas a partir de texto (confirmadas antes de criar); team leader para cima | lite |
| `AI_MAIL_ROUTING` | `mail_routing`: a triagem dos emails (14 out 2026, `shared/mailTriage.ts`): UMA leitura por email recebido nas caixas partilhadas (nunca as pessoais; também as respostas) dá a categoria (`box`), o sim/não de haver uma queixa / um objeto em qualquer parte do email (`complaintMentioned`, `lostItemMentioned`) e as certezas de reclamação (`complaint`) e de objeto perdido (`lostItem`), pelo sentido — o pedido descreve cada categoria por uma frase, sem listas de palavras (teste). Conversa nova → caixa do tema; não percebeu (abaixo de `ai.commsRouting.minConfidence`, 0,7) → info; lixo fica. **Falhou → nada se mexe** e volta a ser lida (até 3×). Antes da IA, só regras óbvias: enviados/sistema/notificações de reserva, o que uma pessoa mexeu, reclamacoes@/perdidos@, envios em massa pelos cabeçalhos, avisos de avaliação pelo remetente, aviso de ocorrência da app pelo formulário, Livro de Reclamações pelo remetente. WhatsApp: as conversas NOVAS pela intenção da triagem (sem 2.ª chamada). Recrutamento em 1.º contacto → lead + candidatura. Uma linha por mensagem em `comms_ai_routing` (0595, 0655) | lite. **Ligado por omissão** (Jorge, 8 out 2026). Teto `ai.commsRouting.perRun` (10) por sincronização; o resto no `ai-comms`. Mensagem nova até 2500 car. + o citado/reencaminhado até 1200 como contexto, com `redactPii`; só o 1.º nome. O sim/não e as certezas de caso vêm primeiro e são obrigatórias no esquema (o modelo não os pode omitir); "mencionou" vale pelo menos "Por confirmar" (`caseScoresOf`) — um modelo pequeno vê a queixa de passagem mas dá-lhe pouca certeza. Um email só em HTML lê-se pelo HTML (não só o resumo do Gmail). Avaliação: Definições → Comunicação → "Testar a triagem" / `scripts/eval-mail-triage.ts` (três corpora: `server/fixtures/mailTriageCorpus.ts`, o de controlo `server/fixtures/mailTriageHoldout.ts` e o cego da auditoria `server/fixtures/mailTriageBlind.ts`; `--dump`/`--answers` para a avaliação sem chave). |
| `AI_MAIL_COMPLAINTS` | Lote 57 / 14 out 2026: sem funcionalidade própria — usa a leitura do `mail_routing`. Certeza de reclamação ≥ `ai.mailComplaints.createMinConfidence` (0,85) → a reclamação nasce pelo pipeline das reclamações (`server/complaintMailIntake.ts`, sem aviso de receção ao cliente) ou o email junta-se à aberta do mesmo cliente/conversa/reserva; ≥ `suggestMinConfidence` (0,5) → nasce **"Por confirmar (IA)"** (`complaints.aiUnconfirmed`). A conversa vai para a caixa Reclamações, por ler. Uma linha por conversa em `complaint_mail_intake` (0630, 0655) | **Ligado por omissão** (pedido do Jorge, 12 e 14 out 2026). Precisa de `AI_MAIL_ROUTING`. Nunca responde ao cliente. |
| `AI_MAIL_LOST_FOUND` | O mesmo para os perdidos (certeza `lostItem`; `lost_found_items.origin = 'ia'`, `aiUnconfirmed`) e a caixa Perdidos | **Desligado por omissão.** |
| `AI_MAIL_NOTICES` | Avisos de avaliação e elogios → caixa Críticas, lidos (nada no módulo); aviso de ocorrência da app → liga à ocorrência da Multipark (só leitura, `server/mailNotices.ts`), caixa Ocorrências, lido | **Desligado por omissão.** Sem IA nos avisos (regra). |
| `AI_MAIL_BACKFILL` | Varrimento dos emails dos últimos `ai.mailBackfill.days` (30) nas caixas partilhadas ainda sem caso, `perRun` (6) por corrida no trabalho `mail-backfill` | **Desligado por omissão.** Idempotente (`comms_ai_routing.sweptAt`/`category`); não baralha caixas de tema. |
| `AI_MAIL_PARTNER_CASES` | Ronda 2 (14 out 2026): uma reclamação ou um perdido que um parceiro (contacto das Parcerias: agência, hotel, comparador) manda em nome de um cliente abre o caso — sempre "Por confirmar (IA)"; o email do parceiro nunca fica como o do cliente nem junta casos (só pela conversa, matrícula ou reserva) | **Desligado por omissão** (antes: parceiros nunca abriam caso). |
| `AI_MAIL_ALIAS_FILTER` | reclamacoes@/perdidos@: só não abre o caso quando a IA diz lixo com ≥ 90 % e sem sinal de caso | **Desligado por omissão.** IA falhou → abre na mesma. |
| `AI_MAIL_DRAFT` | `mail_reply`: "Rascunho IA" na Comunicação (fica no editor) | lite |
| `AI_WEB_INSIGHT` | `web_insight`: resumo semanal do Web & SEO | lite |
| `AI_PAGESPEED_EXPLAIN` | `pagespeed_explain`: o que corrigir primeiro na PageSpeed | lite |
| `AI_GBP_POSTS` | `gbp_post_draft`: rascunho de publicações do Google Business | lite |
| `AI_KNOWLEDGE` | `knowledge_extract` + `knowledge_embed`: índice da base de conhecimento (PDFs sem Drive, embeddings); sincroniza sozinha quando há alterações nas pastas do Drive | lite / embed |

Quando uma funcionalidade está desligada, a UI mostra a mensagem "Esta
funcionalidade de IA está desligada." e não se faz nenhum pedido. Os botões
"IA" das páginas (WhatsApp, Formação) escondem-se.

### Comunicação com clientes (nada é enviado sem aprovação)

A classificação, as etiquetas e os rascunhos são automáticos. Tudo o que chega
ao cliente passa por uma pessoa.

- **Reclamações por email** (`server/complaintTriage.ts`). No fim do leitor de
  email e no cron `ai-comms`, cada reclamação nova recebe sugestões de tipo,
  prioridade, SLA (pela prioridade: urgente 12 h, alta 24 h, média 48 h,
  baixa 72 h), reserva (`caseOps.deriveBookingForCase`), duplicado (reclamação
  aberta do mesmo email, reserva ou matrícula nos últimos 60 dias) e um
  rascunho de resposta em PT-PT.
  - As sugestões ficam na tabela `ai_suggestions`, separadas dos campos
    humanos, com a confiança e o motivo.
  - Uma sugestão só se aplica sozinha com confiança ≥ 0,85 e com o campo
    vazio. O tipo está vazio quando é "Outro". A prioridade e o SLA estão
    vazios quando o caso foi criado pelo sistema e ninguém pegou nele. A
    reserva está vazia quando não há referência. O valor anterior fica
    guardado para "Desfazer".
  - O rascunho cita sempre a reserva. Um rascunho que fale em reembolsos,
    descontos, vouchers ou compensações é deitado fora. "Usar no email" abre
    a janela "Enviar email" e é uma pessoa que carrega em Enviar.
  - Na página das Reclamações, o cartão "Sugestões da IA" mostra cada
    sugestão com os botões Aceitar e Rejeitar (Manter e Desfazer para as que
    se aplicaram sozinhas).
- **Críticas Google** (`server/reviewAutoDraft.ts`). No fim do sync do Google
  Business Profile (em pausa; só manual), no email criticas@ e no cron `ai-comms`,
  cada crítica nova recebe um rascunho. O rascunho usa o prompt central
  `draftReviewReply` com o sentimento e o contexto da reclamação ou reserva
  ligada, que serve só para o tom e nunca é citado.
  - O rascunho fica com `aiResponseApproved = 0`. Os botões são "Aprovar e
    publicar" (com confirmação) e "Editar".
- **WhatsApp** (`server/whatsappTriage.ts`). A cada mensagem recebida, a
  conversa é classificada por intenção (reserva, alteração, cancelamento,
  perdido/achado, reclamação, recrutamento/extra, outro) e urgência.
  - Há debounce por conversa: no máximo uma triagem a cada 5 minutos. Uma
    rajada de mensagens fica agendada e é apanhada pela mensagem seguinte ou
    pelo cron.
  - A chamada corre depois de responder à Meta.
  - No inbox aparecem etiquetas e filtros ("Todas as intenções", "Urgentes").
  - As conversas urgentes entram no aviso de SLA com 1/3 do prazo (mínimo
    5 min).
  - A sugestão de resposta continua a ser pedida à mão e nunca é enviada
    sozinha.
- **Perdidos & Achados** (`server/lostFoundMatch.ts`). Um pré-filtro
  determinístico escolhe no máximo 5 candidatos do lado oposto: ±30 dias, mesmo
  parque, e pontos por matrícula, reserva e tipo. Depois, uma única chamada lite
  compara as descrições.
  - Aparece "Possíveis correspondências" nos dois casos, com pontuação e
    motivo.
  - "Confirmar" só deixa uma nota interna. Contactar o cliente é sempre
    humano.
  - Sem IA, ficam só as pontuações do pré-filtro.

Cron: `/api/cron/ai-comms`, agendado pelo `/api/cron/tick` a cada 15 min
(`server/cronSchedule.ts`; o `.github/workflows/ai-comms.yml` ficou só para
corridas manuais).
Cada passo tem um lote pequeno (3 a 8 casos) e um prazo abaixo dos 60 s. O
passo salta sem erro quando o interruptor está desligado, quando o orçamento
se esgotou ou quando não há fornecedor. Migração: 0123.
### Automações internas (set 2026)

Nenhuma é para clientes. **Os números vêm sempre do SQL/código; a IA só
escreve o texto.** Com o interruptor desligado ou o orçamento esgotado, a
automação continua com um texto fixo feito no código (e não faz pedidos).
Código em `server/aiOps/`, prompts em `server/_core/ai/prompts/ops.ts`,
tabelas na migração 0125.

- **Briefing diário por cidade** (`/api/cron/ops-briefing`, agendado pelo
  `/api/cron/tick` uma vez por dia a partir das 07:30 de Lisboa, idempotente): reservas do dia por hora e
  pico, extras escalados vs. necessários (previsão do Extras-Dia, só leitura),
  reclamações/ocorrências com prazo hoje, pendentes da passagem de turno (e os
  que se repetem), anomalias e alertas de marketing. Guardado em
  `ops_briefings`, mostrado no Dashboard e nas Tarefas e enviado por email aos
  team leaders/supervisores com acesso à cidade. Cada pessoa só vê as secções
  dos módulos a que tem acesso. Interruptor da automação: `OPS_BRIEFING`.
- **Anomalias** (`OPS_ANOMALIES`): z-score contra o mesmo dia da semana das
  últimas 8 semanas (reservas por parque e por canal, gasto e ROAS do
  marketing) e, nas despesas, valores fora do normal (mediana/MAD) e possíveis
  duplicados. Aparecem como "Alertas" em Operações, Despesas e Marketing.
  A linha da IA (`AI_ANOMALY_EXPLAIN`) faz-se uma vez por dia nesta corrida;
  condutores e extras veem o alerta, mas o servidor não lhes manda a linha da IA.
- **Relatórios semanais** (`WEEKLY_REPORTS`, segunda de manhã): direção,
  marketing, operações e RH, a quem tem o módulo com alcance nacional; resumo
  semanal da passagem de turno por cidade.
- **Respostas de disponibilidade** pouco claras: confiança ≥ 85% aplica-se
  sozinha; o resto fica numa tarefa para revisão humana.
- **Leads**: pontuação 0–100 com critérios explícitos (disponibilidade, cidade,
  experiência, anos de carta, rapidez de resposta), nunca atributos
  protegidos; o rascunho do 1.º contacto precisa de aprovação (o template
  `seja_motorista` continua como antes).
- **Avaliação**: explicação a partir das linhas das regras (nunca recalcula);
  o team leader pode escondê-la.
- **Tarefas a partir de texto**: a IA propõe, a pessoa confirma. Só team
  leader para cima (o servidor recusa a extras e condutores).
- **Passagem de turno**: o resumo da IA faz-se ao entregar a passagem e no
  botão "Resumir agora"; editar depois não chama a IA.

Custos: pedidos curtos, dados pessoais tapados (`redactPii`), teto de 12
chamadas por corrida do cron e cache por hash (leads, avaliação).

## 4. Custos e orçamento

- Cada chamada fica registada em `ai_usage_log` (migração 0111). O registo tem
  a funcionalidade, o nível, o fornecedor, o modelo, quem pediu, a entidade, os
  tokens, o custo estimado em €, a latência, o estado e o código de erro.
  **Nunca guarda o prompt, a resposta nem dados pessoais.**
- O custo é igual aos tokens multiplicados pelo preço do modelo, segundo a
  tabela em `server/_core/ai/pricing.ts`. Essa tabela tem os preços da Gemini
  API de set 2026 convertidos para €. Podes sobrepor os preços em Definições →
  Parâmetros → **Preços dos modelos de IA**, em JSON e em €, por exemplo
  `{"gemini-3.1-flash-lite": {"input": 0.22, "output": 1.29}}`.
  Nota: o Flash 3.6/3.7/3.8 tem um preço promocional até 31 dez 2026 (depois
  duplica). Atualiza os preços nessa altura. O **Argon** (`gemini-4-argon`) está com o preço
  introdutório até 30 nov 2026 ($2/M entrada, $10/M saída, $0,10/M em cache) — **rever em dezembro**
  (fonte secundária: $4/$20).
- **Gemini 4 Argon e cache**: segundo as docs da Google (out 2026), o Argon **não tem cache
  explícita** — só a implícita, para prefixos iguais de ≥ 4 096 tokens (o guia do modelo, mais
  recente, diz 6 144). O `getOrCreateContextCache` nem tenta criar cache para o Argon; o desconto
  da implícita aparece sozinho nos `cachedTokens`. Para a aproveitar, o prefixo estável (regras +
  índice + ferramentas) tem de passar os 6 144 tokens (a confirmar no F1 com
  `scripts/measure-help-tree.ts`). Fontes: <https://ai.google.dev/gemini-api/docs/caching>,
  <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon>.
- **Armazenamento da cache de contexto**: cada cache criada fica no registo com a funcionalidade
  que a criou e `entity = "context_cache_storage"` (conta para o teto dessa funcionalidade, sem
  pessoa). Custo estimado = tokens guardados × TTL × preço por hora (`pricing.ts`: Flash ≈ $1/M/h,
  Pro e Argon ≈ $4,50/M/h — o do Argon ainda não está publicado). Tokens: os da API
  (`usageMetadata.totalTokenCount`); sem eles, estimados (≈ 4 car./token, `errorCode`
  `tokens_estimated`). Modelo sem preço de armazenamento → só os tokens (custo 0). No cartão do
  custo estas linhas ficam à parte ("armazenamento da cache"): não contam nas chamadas, na latência
  nem no custo por pergunta, mas contam no gasto do mês.
- **2.ª cache do lite no piloto** (plano MPV F2, aceite): no piloto o Multis declara também `regras_em_vigor`, por isso quando desce para o lite (modo económico, ou o smart desligado) usa uma cache do lite à parte da do v1 (a chave inclui as ferramentas); só existe para quem está no piloto.
- **Teto próprio** (plano MPV §5.3): o `assistant_smart` (Multis do piloto) tem
  `ai.assistantSmartBudget` (`{"eurPerDay": 10, "eurPerMonth": 150, "eurPerUserPerDay": 3}`; os
  três têm de ser > 0 — não há "sem teto"; o dia é o **dia de Lisboa**, como no resto da app; o mês
  é o civil UTC, como o orçamento global), verificado **antes** do orçamento global. Cada turno
  **reserva à cabeça** na instância o custo **máximo estimado do turno**
  (`ownBudgetTurnEstimateEur`: por chamada, o teto de saída × preço de saída + a entrada estimada —
  sistema, histórico, pergunta e ferramentas, ≈ 4 car./token — × preço de entrada; × as chamadas
  possíveis, voltas de ferramentas + a final; nunca abaixo de 0,20 €. Ex.: Argon com raciocínio
  `default` (teto 8 192), 4 voltas e ~10 k tokens de entrada ≈ 0,44 €). A reserva faz-se mesmo antes
  do pedido, colada a um try/finally (se a preparação do pedido falhar, não fica nada reservado),
  liberta-se quando o custo real fica registado e **expira sozinha** ao fim de 2× o prazo do pedido
  (se a função morrer pelo limite da Vercel). A partir de 80 % de um teto o gasto lê-se sempre da BD
  (sem a cache de 60 s). **Limite do excesso**: cada instância só vê as suas reservas, por isso o
  teto pode passar, no máximo, ≈ (turnos em curso noutras instâncias × a estimativa de cada um) + o
  que um turno gastar acima da estimativa. Se não se conseguir medir o gasto (erro da BD), o piloto também desce para o lite
  (motivo "unknown"). Desligar o `AI_ASSISTANT` pára também o piloto. Ao chegar lá, o Multis
  responde com o `assistant` (lite) e a nota "modo económico" — não bloqueia nada. O gasto por pessoa
  lê-se pelo índice `(feature, userId, createdAt)` com cache de 60 s. As funcionalidades com teto
  próprio (`ownBudget` no catálogo) **não entram** na soma do orçamento global (`monthSpendEur`,
  cache do gasto e aviso do `assistant.status`); o cartão do custo continua a mostrá-las.
- **Orçamento mensal**: Definições → Parâmetros → *Orçamento mensal da IA (€)*.
  Sem valor na página, usa-se `AI_MONTHLY_BUDGET_EUR`; sem nenhum dos dois,
  30 €. 0 significa sem limite. O mês é o mês civil em UTC.
  - Aos 100% do orçamento, as funcionalidades não essenciais respondem "IA
    temporariamente indisponível." Os admins recebem um aviso na app, uma só vez
    por mês.
  - A leitura de faturas é essencial. Continua a funcionar até aos 150% do
    orçamento.
- O cartão **IA — custo do mês** (Definições → Estado) mostra o gasto, a barra
  do orçamento, os modelos em uso e, para cada funcionalidade, as chamadas, os
  erros, as chamadas bloqueadas, os tokens e o custo.

## 5. Dados pessoais

- Antes de irem para o fornecedor, os emails, telefones, IBAN, NIF e matrículas
  que aparecem em texto livre são trocados por marcadores (`[EMAIL_1]`,
  `[TELEFONE_1]`…). Isto aplica-se às críticas, ao rádio, à passagem de turno,
  ao WhatsApp, às reclamações, aos Perdidos & Achados e às perguntas ao assistente.
- Quando a resposta é privada (resumo do rádio, passagem de turno, sugestão de
  resposta no WhatsApp, assistente), os marcadores são repostos depois de a resposta
  chegar. Nas respostas públicas (críticas), os marcadores são retirados.
- Dos nomes, só se envia o primeiro.
- **Multis — um contexto de redação por turno** (plano MPV §3.7, F0b): o histórico, o conhecimento,
  a memória, a pergunta **e os resultados das ferramentas** passam pela mesma redação
  (`createRedactionContext`), com numeração contínua dos marcadores (o email da pergunta é o
  `[EMAIL_1]`, o de uma ferramenta o `[EMAIL_2]`), e a resposta é reposta uma só vez, no fim. Cada
  ferramenta declara os seus campos (`pii`): colaboradores → `[NOME_n]`, repostos com o nome
  completo (dois "João" não se confundem); clientes → só o 1.º nome; texto livre → emails,
  telefones, IBAN, NIF e matrículas tapados. Hoje: `extras_escala` (nomes), `casos_abertos` e
  `minhas_tarefas` (títulos). Sem contexto de redação, os colegas vão só pelo 1.º nome. O
  `<resumo>` das perguntas anteriores passa pela mesma redação.
- **Histórico sem nomes completos** (migração 0695): cada resposta guarda também
  `contentMasked` (os colegas ainda como `[NOME_n]`) e `maskedNames` (o mapa). No turno
  seguinte o histórico usa essa versão, com os marcadores renumerados no contexto novo — os nomes
  completos não voltam ao fornecedor. BD antes da 0695 → as ferramentas mandam só o 1.º nome.
- As imagens e PDFs (faturas, documentos do RH) vão tal como estão. Por isso o
  `AI_HR_AUTOFILL` e o `AI_HR_EMAIL_ATTACHMENTS` estão desligados por omissão
  e **só correm com Vertex AI numa região da UE** (ver secção 1): fora disso
  não correm, mesmo ligados. O rádio, as faturas e o resto não dependem disto.
- Os logs do servidor só têm metadados: funcionalidade, código de erro e modelo.

## 6. Erros

A UI recebe sempre mensagens genéricas em PT-PT: desligada, não configurada,
orçamento, demorou demasiado, muitos pedidos, não respondeu ou resposta
inválida. O detalhe do fornecedor nunca chega ao ecrã. Cada pedido tem um prazo
(abaixo dos 60 s do Vercel). Os erros 429, 5xx e as falhas de rede têm até 2
novas tentativas, com espera exponencial. Uma resposta fora do schema tem uma
nova tentativa.

## 7. Multis — assistente (chat da equipa)

Chama-se **o Multis** (Jorge, 3 out 2026) e apresenta-se com "Olá! Eu sou o Multis.
Em que posso ajudar?"; o ícone é o P da Multipark com uma
estrelinha de IA. Botão redondo no canto inferior direito de todas as páginas.
No telemóvel abre uma folha de baixo; no computador fica um **painel acoplado à
direita** (400 px) que encolhe o conteúdo, não bloqueia o resto do ecrã, não
fecha ao mudar de página e volta à mesma conversa (estado em `localStorage`:
`mp.multis.open`, `mp.multis.conversationId`). Tem:

- **"Como se usa"**: a ajuda está em `docs/ajuda/*.md`, um ficheiro curto por
  módulo. Depois de mudar um ficheiro, corre `pnpm tsx scripts/gen-ajuda.ts`
  (um teste avisa se te esqueceres). A escolha do ficheiro é feita por
  palavras-chave (sem IA) e, com a base de conhecimento ligada ao assistente
  (`useInAssistant`), também **pelo significado**: a MESMA consulta à base
  (um só vetor da pergunta, `helpTopK`) traz os trechos da ajuda (fonte
  "help"), que se juntam aos das palavras-chave — no máximo **3 páginas**, sem
  repetir (`combineHelpDocs`). Base desligada ou em baixo → só palavras-chave
  (1–2 páginas, como antes). De uma página longa vai a parte que interessa à
  pergunta (`excerptHelp`), não só o início; o bloco `<ajuda>` tem até 6000
  caracteres repartidos pelas páginas.
- **Memória** (Multis 2, interruptor `AI_ASSISTANT_MEMORY`): uma mensagem a
  começar por "Lembra-te" / "Memoriza" / "Não te esqueças" grava a nota da
  pessoa **sem chamar a IA** (`shared/assistantMemory.ts` →
  `parseRememberCommand`; uma pergunta, a acabar em "?", não conta). Até 30
  notas por pessoa e 100 da empresa (só admin/super_admin; ficam em
  `activity_logs`). As ativas vão no contexto do turno num bloco `<memoria>`
  (nunca no prompt estável, para não partir a cache); acima de ~3000
  caracteres as da empresa escolhem-se pelas palavras da pergunta. O prompt
  diz para as seguir como preferências, nunca para contornar permissões ou
  cidades. Arquivar marca `archivedAt` (nada se apaga).
- **👍/👎 e "Perguntas que falharam"** (`assistant_feedback`, 0605): cada
  pessoa avalia as respostas das suas conversas (mudar de ideias atualiza a
  mesma linha); depois de cada resposta o servidor marca sozinho (auto = 1)
  as que dizem que não sabe / não tem acesso / não encontrou nos manuais e as
  em que uma ferramenta devolveu erro (`detectUnanswered`). Guarda cópia da
  pergunta, da resposta (até 4000 car.), da página, das ferramentas e da
  ajuda usada (`ai_chat_messages.helpFiles`/`path`), porque as conversas se
  apagam aos 30 dias; esta tabela não tem purga. Lista em `/multis/falhas`
  (só admin/super_admin): período 7/30/90 dias, motivo, por tratar/tratadas,
  "Marcar como tratada" com nota e Desfazer.
- **Perguntas aos dados**, só de leitura, através de ferramentas: reservas
  (contagens por dia/cidade/parque), Extras-Dia (escalados e horas em falta),
  casos em aberto (reclamações, ocorrências, perdidos), WhatsApp por
  responder, a própria avaliação, as próprias tarefas e, só para quem tem
  acesso aos totais financeiros, o valor das reservas. Cada ferramenta chama
  o mesmo procedimento que a página usa, **como a própria pessoa**. Por isso
  aplicam-se as mesmas cidades, as mesmas permissões e os mesmos bloqueios.
  As ferramentas devolvem totais ou listas curtas (máximo 20 linhas), sem
  emails, telefones, matrículas nem nomes de clientes.
- **Histórico**: as conversas ficam guardadas 30 dias (`ai_chat_conversations`
  e `ai_chat_messages`, migração 0130) e são apagadas pelo daily-ops. Cada
  pessoa vê só as suas.
- **Registo**: cada chamada de ferramenta fica em `activity_logs`
  (`action = assistant_tool`), com o nome e os parâmetros. Os resultados não
  ficam registados.

Custos e limites:

- nível `lite`. O prompt estável (regras, índice da ajuda e ferramentas) fica
  na cache de contexto. Com a pergunta vão só os últimos 6 turnos e um resumo
  das perguntas anteriores (feito sem IA). A resposta tem no máximo 700 tokens;
- Definições → Parâmetros → **Limites do assistente (chat)**:
  `{"perMinute": 20, "perDay": 200, "maxInputChars": 1000}` por pessoa;
- conta para o orçamento mensal. Quando a IA está desligada, sem configuração
  ou acima do orçamento, o painel mostra uma mensagem simples e não faz
  pedidos.

**Piloto (plano MPV §5.2, F0b)**: com o interruptor `MPV` (desligado, só super admin) e a pessoa
em `ai.assistantPilot` (`{"userIds": [1, 12]}`), o `askAssistant` usa a funcionalidade
`assistant_smart` (nível smart, interruptor `AI_ASSISTANT_SMART`, desligado; limites
`ai.assistantSmartLimits`, omissão 10/min, 80/dia; chave do limitador `assistant_smart:user:N`;
teto de saída base 2 048); senão o `assistant` de sempre. Teto próprio atingido (antes ou durante o
pedido) ou gasto que não se consegue medir → `assistant` com `economy: true` e a nota "Modo
económico" no widget, com o motivo (teto da pessoa, do dia, do mês, ou "não consegui confirmar"). O
`assistant.status` devolve a funcionalidade **efetiva** da pessoa (`feature`, `tier`, `pilot`,
`economy`, `economyNote`) e os limites dela. As respostas guardam `variant` (`mpv` no piloto,
também no modo económico; `v1` fora dele) e `tier`.

**Conteúdo do MPV (plano MPV F3, só no piloto; o v1 fica igual)**: sistema com o índice da árvore
(`assistantMpvSystemPrompt(KNOWLEDGE_INDEX)`, igual para toda a gente) e as mesmas ferramentas
declaradas a todos (`declareAllTools`; as permitidas vão no `<contexto>`) → uma cache por modelo.
Por pergunta (`server/assistant/mpv.ts`): `<pagina_atual>` com o perfil da página
(`shared/multisProfiles.ts`) + a secção do separador aberto (ou a introdução da página) + até 2
secções da pesquisa lexical por secção, no máx. 5 000 car. `ajuda_abrir(id)` /
`ajuda_procurar(texto)` (`server/assistant/helpTools.ts`) no lugar do `abrir_ajuda`. Orçamento do
turno: 35 s com 8 s guardados para a chamada final (as voltas param aos 27 s); 4 voltas no Argon,
3 no lite; até 4 chamadas por volta. **Visibilidade da ajuda (decisão do Jorge, 15 out 2026)**: no
MPV, a página da ajuda de um módulo do mapa de acessos só aparece a quem pode ver esse módulo (nas
ferramentas e no bloco da pergunta); módulos fora do mapa (`multis`, `ia`) e a entrada ficam para
todos — o v1 não filtra. As secções sincronizam também na Base de conhecimento (fonte `help_sec`,
`help:<ficheiro>.md#<secção>`, só com o `MPV` ligado), fora de todas as consultas que não as pedem.

**Pesquisa pelo significado (plano MPV F5, só no piloto; o v1 fica igual)**: as secções `help_sec` ganham vetores (mesmo modelo `gemini-embedding-001`, `embedHelpSections` em lote, **quota própria** de 120 secções por corrida, depois do Drive — que mantém os seus 3; custo da 1.ª vez medido: 432 secções, 444 trechos, ≈ 133 mil tokens ≈ **0,02 €**). As 2 secções a mais do bloco da pergunta, o `ajuda_procurar` e os manuais do Multis do piloto usam candidatos = lexical/FULLTEXT top 40 ∪ **vizinhos por vetor top 20** (`server/knowledge/vectorIndex.ts`: vetores em memória por instância, normalizados; versão `vectors:version` em `kb_sync_state` lida no máx. a cada 60 s; teto 3 000 trechos nas secções e 6 000 nos manuais — as secções ocupam ≈ 1,4 MB; ≈ 0,7 ms por pergunta) e depois a pontuação de hoje (`server/assistant/helpSearch.ts`: 0,65 × cosseno + 0,35 × (0,7 × lexical + 0,3 × FULLTEXT); passa a lexical de hoje; quem entra só pelo vetor precisa de cosseno ≥ max(0,7; melhor − 0,08), também nos manuais do piloto, e os cossenos aceites/rejeitados ficam no registo, só números; o índice só lê os vetores do modelo atual e conta antes de carregar). Os vizinhos confirmam-se sempre na BD (`kbVisibilitySql` + `canSeeKbDoc`) e as secções passam pelo filtro por módulo (`canSeeHelpPage`). O vetor da pergunta calcula-se uma vez por pedido (`onceQueryEmbed`, partilhado com a base e a descida smart → lite; o texto do `ajuda_procurar` tem o seu). O bloco da página e a base correm em paralelo, depois do limite de pedidos (o vetor da pergunta passa pelo orçamento do `knowledge_embed`). Um documento só fica "com vetores" se não sobrar nenhum trecho sem vetor. Sem vetores, ou se a parte vetorial passar de 3 s, fica a lexical, sem erro.

**Contexto da página (plano MPV §3.1)**: as páginas com separadores ou registo chamam
`useMultisPage({ tab, entity })` (Extras-Dia, Atividade diária, Avaliação, Despesas, Parcerias,
Condutores e agentes, Críticas, Formação; a Ficha da reserva com `entity: booking`); o widget manda
`{ path, tab, entity }` no `status` e no `ask`. O servidor só aceita o `tab` da lista da página
(`shared/multisPage.ts`, com as mesmas constantes das páginas: `OPERATIONAL_TABS`, `CAIXA_TABS`,
`CONDUTORES_TABS`…) e o `entity` de um tipo conhecido (booking, employee, review, complaint,
expense, partner) com id inteiro > 0; o resto é ignorado (nunca dá erro). O caminho só entra no
`<contexto>` se tiver letras, dígitos, "_", "-" e "/". Vai para o `<contexto>` como "Separador
aberto: …" e "Registo aberto: tipo #id (nome)". Não dá acesso a nada.

**`abrir_ajuda`**: procura primeiro pelo **ficheiro** (`google-tempo-real`, `web-analytics.md`),
depois pelo módulo **só se for único**, depois pelo título; módulo com várias ajudas → devolve os
candidatos (ficheiro, título, resumo). O índice da ajuda mostra o ficheiro quando o módulo se
repete. Antes devolvia sempre a 1.ª ajuda do módulo (definicoes.md, marketing.md, integracoes.md…).

## 8. Preparação para o chat público (multipark.app)

O núcleo do chat (`server/_core/ai/chat/`) não depende da equipa: conversas,
ajuda por palavras-chave, registo de ferramentas e o turno com `runAi`. Um
chat público usa o mesmo núcleo com outras peças: a sua própria FAQ, só
ferramentas de FAQ, limites por IP (`ipKey`, guardado como hash) e o canal
`public`. Os passos estão no [README técnico](../server/_core/ai/README.md)
(secção "Chat público").

- `checkRateLimit(chave, { perMinute, perDay })` limita os pedidos por
  utilizador ou por IP. O estado vive na BD (`ai_rate_limits`), por isso
  funciona em serverless.
- `runAi({ cacheSystem: true, system: <contexto longo> })` usa a cache de
  contexto do Gemini. Os tokens lidos da cache custam cerca de 10% do preço
  normal. A cache é partilhada entre instâncias através de
  `ai_context_caches`.

## 8. Tutor da Formação

Um painel "Tutor da formação" aparece dentro das páginas da Formação: no
manual, no vídeo, em cada percurso de "A minha formação" e no quiz (antes e no
resultado). Não está no menu geral.

- **Só responde com o conteúdo dos manuais.** Os manuais do módulo são partidos
  pelos títulos e a pergunta é procurada por palavras-chave (sem embeddings,
  sem custo). Se nenhum trecho servir, responde logo "pergunta ao formador" (com
  o nome de quem criou o percurso, se houver) **sem chamar a IA**. Se a IA
  disser que a resposta não está no conteúdo, a resposta é a mesma. Nunca
  inventa regras. Os PDFs sem texto no campo "conteúdo" não entram na procura.
- O conteúdo do módulo vai no `system` com cache de contexto (`cacheSystem`,
  1 h) quando é grande; os trechos escolhidos, as últimas 4 trocas e a pergunta
  vão no `input`.
- Respostas até ~120 palavras (boas para ouvir; há um botão "Ouvir" com a voz
  do navegador) e um botão **Explicar melhor** (~250 palavras).
- Saudação com o progresso (módulos feitos, próximo passo, dias seguidos) e
  dicas antes do quiz: **sem IA**.
- Depois do quiz, "Explicar as respostas erradas": a citação do manual é
  escolhida no servidor (texto literal) e a IA só escreve a explicação curta.
  Com a IA desligada mostra a explicação do formador e o trecho.
- **Limites**: Definições → Parâmetros → *Tutor da formação: limite de
  perguntas* (`{"perMinute": 10, "perDay": 100}`), ou as env
  `AI_TRAINING_TUTOR_PER_MINUTE` / `AI_TRAINING_TUTOR_PER_DAY`. Perguntas até
  500 caracteres.
- **Dados pessoais**: a pergunta passa pelo `redactPii` antes da IA e antes de
  ser guardada. O histórico (tabela `training_tutor_messages`, migração 0138)
  fica 30 dias e cada formando só vê o seu.
- **Formadores** (quem gere a Formação): Formação → Acompanhamento → *Perguntas
  ao tutor* mostra o que se pergunta mais, por módulo, e quantas ficaram sem
  resposta. É um agregado anónimo (`training_tutor_questions`, sem utilizador).
- Interruptor desligado ou orçamento esgotado: o painel mostra uma mensagem
  simpática a sugerir o formador; nada falha.

## 9. Variáveis de ambiente

| Env | Para quê |
|---|---|
| `GEMINI_API_KEY` | Chave do Google AI Studio |
| `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_SERVICE_ACCOUNT_JSON` | Vertex AI na UE |
| `AI_PROVIDER`, `AI_PROVIDER_<FUNC>` | Escolha do fornecedor |
| `AI_MODEL_LITE`, `AI_MODEL_FAST`, `AI_MODEL_SMART`, `AI_MODEL_STT` | Modelos |
| `AI_MODEL_EMBED` | Modelo de embeddings da base de conhecimento (omissão `gemini-embedding-001`, 768 dimensões; interruptor `AI_KNOWLEDGE`; sem Gemini/IA a pesquisa usa só palavras-chave) |
| `AI_TIER_<FUNC>` | Nível por funcionalidade |
| `AI_THINKING_LEVEL` | Raciocínio dos Gemini 3.x |
| `AI_MONTHLY_BUDGET_EUR` | Orçamento (a página Definições ganha-lhe) |
| `AI_TRAINING_TUTOR_PER_MINUTE`, `AI_TRAINING_TUTOR_PER_DAY` | Limites do tutor da Formação (Definições ganha) |
| `AI_ENABLED` e todos os `AI_*` da tabela da secção 3 (`AI_EXPENSE_OCR` … `AI_KNOWLEDGE`) | Interruptores (a página Definições ganha) |
| `LLM_API_URL`, `LLM_API_KEY`, `LLM_MODEL` | Fornecedor antigo |
| `OPENAI_API_KEY` | Whisper (só se definida) |
