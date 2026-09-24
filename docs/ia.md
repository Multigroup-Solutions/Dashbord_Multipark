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
| smart | `AI_MODEL_SMART` | `gemini-3.1-pro-preview` | Não é usado por omissão. Se o modelo deixar de existir (404), cai para o fast. |

Regra do dono: usar o modelo mais barato sempre que possível. Para mudar o nível
de uma funcionalidade sem deploy:

- em Definições → Parâmetros → **Nível de modelo por funcionalidade de IA**, por
  exemplo `{"expense_ocr": "fast"}`;
- ou com a env `AI_TIER_<FUNCIONALIDADE>`, por exemplo `AI_TIER_EXPENSE_OCR=fast`.

A precedência é: Definições, depois env, depois o código.

Os Gemini 3.x correm com `thinkingLevel: low`, para gastar menos tokens de
raciocínio. A env `AI_THINKING_LEVEL` muda este valor (`off` usa o do modelo).

Os modelos da Google mudam depressa. Confirma os modelos em
<https://ai.google.dev/gemini-api/docs/models> e na página de
[descontinuações](https://ai.google.dev/gemini-api/docs/deprecations).

## 3. Funcionalidades e interruptores

Os interruptores estão em Definições → Automações → *Inteligência artificial*.
Também existem como env (`on`/`off`). O valor escolhido na página sobrepõe-se ao
da env.

| Interruptor | Funcionalidade (`feature`) | Nível |
|---|---|---|
| `AI_ENABLED` | todas (interruptor geral) | — |
| `AI_EXPENSE_OCR` | `expense_ocr`: leitura de faturas nas Despesas | lite (imagem) / fast (PDF) |
| `AI_REVIEW_DRAFTS` | `review_reply`: rascunho de resposta às críticas Google (4 pontos de entrada) | lite |
| `AI_RADIO` | `radio_transcription` + `radio_summary` | lite |
| `AI_HANDOVER_SUMMARY` | `handover_summary`: 5 pontos da passagem de turno | lite |
| `AI_WHATSAPP_ASSIST` | `whatsapp_summary` + `whatsapp_reply` | lite |
| `AI_QUIZ` | `quiz_generation`: perguntas a partir dos manuais | fast |
| `AI_HR_AUTOFILL` | `hr_autofill`: documentos do RH | lite. **Desligado por omissão** até decisão sobre o RGPD. |
| `AI_TRAINING_TUTOR` | `training_tutor`: tutor da Formação (chat nos manuais, vídeos, percursos e quiz) | lite |
| `AI_COMPLAINT_TRIAGE` | `complaint_triage`: triagem das reclamações por email | lite |
| `AI_REVIEW_AUTO_DRAFTS` | `review_auto_draft`: rascunho automático para cada crítica nova | lite |
| `AI_WHATSAPP_TRIAGE` | `whatsapp_triage`: intenção e urgência das conversas | lite |
| `AI_LOST_FOUND_MATCH` | `lost_found_match`: correspondências perdido ↔ achado | lite |

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
  Business Profile (a cada 10 min), no email criticas@ e no cron `ai-comms`,
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

Cron: `/api/cron/ai-comms` (`.github/workflows/ai-comms.yml`, a cada 15 min).
Cada passo tem um lote pequeno (3 a 8 casos) e um prazo abaixo dos 60 s. O
passo salta sem erro quando o interruptor está desligado, quando o orçamento
se esgotou ou quando não há fornecedor. Migração: 0123.

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
  duplica). Atualiza os preços nessa altura.
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
  ao WhatsApp, às reclamações e aos Perdidos & Achados.
- Quando a resposta é privada (resumo do rádio, passagem de turno, sugestão de
  resposta no WhatsApp), os marcadores são repostos depois de a resposta
  chegar. Nas respostas públicas (críticas), os marcadores são retirados.
- Dos nomes, só se envia o primeiro.
- As imagens e PDFs (faturas, documentos do RH) vão tal como estão. Por isso o
  `AI_HR_AUTOFILL` está desligado por omissão.
- Os logs do servidor só têm metadados: funcionalidade, código de erro e modelo.

## 6. Erros

A UI recebe sempre mensagens genéricas em PT-PT: desligada, não configurada,
orçamento, demorou demasiado, muitos pedidos, não respondeu ou resposta
inválida. O detalhe do fornecedor nunca chega ao ecrã. Cada pedido tem um prazo
(abaixo dos 60 s do Vercel). Os erros 429, 5xx e as falhas de rede têm até 2
novas tentativas, com espera exponencial. Uma resposta fora do schema tem uma
nova tentativa.

## 7. Preparação para o chat público (multipark.app)

Os blocos já existem, mas ainda não há interface:

- `checkRateLimit(chave, { perMinute, perDay })` limita os pedidos por
  utilizador ou por IP. O IP é guardado como hash. O estado vive na BD
  (`ai_rate_limits`), por isso funciona em serverless.
- `runAi({ cacheSystem: true, system: <contexto longo> })` usa a cache de
  contexto do Gemini. O prefixo estável é guardado uma vez e os tokens lidos da
  cache custam cerca de 10% do preço normal. A cache é partilhada entre
  instâncias através de `ai_context_caches`.

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
| `AI_TIER_<FUNC>` | Nível por funcionalidade |
| `AI_THINKING_LEVEL` | Raciocínio dos Gemini 3.x |
| `AI_MONTHLY_BUDGET_EUR` | Orçamento (a página Definições ganha-lhe) |
| `AI_TRAINING_TUTOR_PER_MINUTE`, `AI_TRAINING_TUTOR_PER_DAY` | Limites do tutor da Formação (Definições ganha) |
| `AI_ENABLED`, `AI_EXPENSE_OCR`, `AI_REVIEW_DRAFTS`, `AI_RADIO`, `AI_HANDOVER_SUMMARY`, `AI_WHATSAPP_ASSIST`, `AI_QUIZ`, `AI_HR_AUTOFILL`, `AI_COMPLAINT_TRIAGE`, `AI_REVIEW_AUTO_DRAFTS`, `AI_WHATSAPP_TRIAGE`, `AI_LOST_FOUND_MATCH` | Interruptores |
| `LLM_API_URL`, `LLM_API_KEY`, `LLM_MODEL` | Fornecedor antigo |
| `OPENAI_API_KEY` | Whisper (só se definida) |
