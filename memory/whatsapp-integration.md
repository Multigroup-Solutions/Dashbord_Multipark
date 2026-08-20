# WhatsApp Integration + External Availability Form

## Summary
Integração da WhatsApp Cloud API (Meta Graph API) na dashboard "Barnie" (dashboard-jorge) para: (1) seleção múltipla de extras com contactos, (2) envio em massa de templates WhatsApp, (3) inbox de respostas via webhook Meta, (4) API segura para uma app externa de formulário de disponibilidades. Plano aprovado pelo Jorge em 2026-07-09. Implementação faseada — cada fase é revista antes da seguinte. Este ficheiro tem o plano completo, os 5 ajustes do Jorge, e o changelog por fase.

## Related
- `sync-runners-topology.md` — topologia de execução (Railway `setInterval` vs Vercel/GitHub Actions cron). Relevante porque o webhook e o broadcast correm no processo Railway; o `runConcurrent` reutilizado vem do `multiparkBookingSync.ts`.
- `employee-city-derivation.md` — **2026-08-04**: a tabela de extras ganhou filtro
  por cidade (Lisboa/Porto/Faro, cidade DERIVADA, sem coluna nova). O alvo do
  broadcast ("a todos") passou a ser o conjunto visível JÁ FILTRADO — a Decisão 1
  mantém-se, mudou outra vez o conjunto visível. **2026-08-20**: junta-se-lhe a
  pesquisa livre por pessoa (nome/número), que compõe em AND com a cidade e é o
  3º filtro a definir o "a todos" do WhatsApp.
- `identity-by-email.md` — **2026-07-31, altera partes desta integração**: (1) `normalizePhoneE164` passou a tolerar texto livre (anotações, dois números, invisíveis) — os casos que marcavam números válidos como inválidos; (2) o "tem número válido?" passou a vir do SERVIDOR (`getWeekOverview.phoneE164`), a UI já não recalcula; (3) a tabela do `AvailabilitySection` mostra TODOS os extras ativos (o filtro `availableDays > 0` deixava a página vazia) + quem respondeu sem ter função "extra", e o `sendBroadcast` vai buscar esses à ficha para não os descartar em silêncio. A Decisão 1 ("a todos" = conjunto visível) mantém-se — mudou o conjunto visível.

## Terreno (mapa da investigação inicial)
- **"extras" = trabalhadores casuais** = `employees` com `position='extra'`. Contactos = `employees.email` + `employees.phone` (varchar 32, **texto livre, sem formato** — daí o `normalizePhoneE164`).
- **Disponibilidade já existe**: `server/extrasAvailability.ts` (`listActiveExtras` — só traz email, NÃO phone; `getMyWeek`/`setMyAvailability`; `getWeekOverview`; `getAvailabilityForDay`; `sendWeeklyAvailabilityRequest` = bulk-send SEQUENCIAL por email, molde do broadcast). Router tRPC `extrasAvailability` em `server/routers.ts:6117`. UI de multi-seleção já existente em `client/src/pages/ExtrasDiaPage.tsx` (`AvailabilitySection`, ~L1210-1365: `selectedIds: Set<number>`, checkbox "todos"+linha, "Enviar aos N selecionados").
- **Auth externa já existe**: tabela `api_keys` (X-API-Key). Dois routers Express: `server/externalApi.ts` (`/api/external`, sem scopes) e `server/mcpApi.ts` (`/api/v1`, COM scopes read/write/admin via `scopesFor`/`requireScope`). Router tRPC `apiKeys` (`routers.ts:3782`, super_admin). `mcpApi` só estava montado no `api-entry.ts` (Vercel), NÃO no `index.ts` (Railway) — corrigido na Fase 0.
- **Auth interna**: tRPC `protectedProcedure`/`adminProcedure` + `requireRole(role, minRole)` contra `ROLE_HIERARCHY` (`routers.ts:354`: super_admin7…user0). Sessão = cookie JWT HS256 (`_core/sdk.ts`).
- **Sem webhooks entrantes hoje** (nem Stripe nem Meta). Body parser `express.json({limit:50mb})` GLOBAL nos dois entrypoints → consome raw body → HMAC exige montar raw ANTES do json.
- **Concorrência**: `runConcurrent<T>(items, limit, fn, deadlineAt?)` em `server/jobs/multiparkBookingSync.ts:373` (worker-pool manual + budget de tempo). Sem fila persistente, sem rate-limiter.
- **Motor de BD: MySQL / InnoDB** (confirmado 2026-07-09 pelo coordenador: `drizzle.config.ts` dialect `mysql`, `drizzle-orm/mysql2` em `db.ts`, `mysql2` no package.json). A `0045_whatsapp_integration.sql` foi **revalidada** como sintaticamente correta para MySQL (`UNIQUE INDEX` nullable = múltiplos NULL permitidos, `ENUM`, `ON UPDATE CURRENT_TIMESTAMP`, `DATE`) — não precisa de alterações.
- **Migrações**: o journal do drizzle-kit está **congelado no idx 24**; os ficheiros 0025-0044 são SQL escritos à mão (CREATE TABLE / ALTER) que NÃO tocam o journal/meta. Runners one-shot em `server/migrations/migration_0044.ts` / `migration_0046.ts`. Convenção: tabela snake_case, colunas camelCase, `int autoincrement PK`, timestamps mode string.
- **Testes**: vitest, `server/**/*.test.ts`, sem supertest — usam `appRouter.createCaller(ctx)` ou funções puras. tsc exclui `**/*.test.ts`.

## Plano faseado (aprovado)
- **Fase 0 — Fundações** (FEITA): envs + health check; stub do webhook montável (GET verify + POST HMAC, responde 200 sem processar); montar `mcpApi` no Railway; `normalizePhoneE164`.
- **Fase 1 — Schema + cliente Graph API** (FEITA): 3 tabelas Drizzle + SQL 0045; `server/whatsapp.ts` (sendTemplateMessage/sendTextMessage); testes.
- **Fase 2 — UI seleção + broadcast** (FEITA): telefone na tabela + badge inválido; procedure `whatsapp.sendBroadcast` (modo teste + normal); Dialog shadcn com template configurável, teste 1-número, resumo válido/inválido e resultado por destinatário. Ver ajuste #1 e #5.
- **Fase 3 — Webhook processing + inbox** (FEITA): webhook process-then-ack (`whatsappInbound.ts`), routers inbox (`whatsappInbox.ts`: conversations/messages/markRead/reply com validação de janela server-side), página `WhatsAppInboxPage.tsx` com 3 estados de janela distintos. Ver ajustes #2 e #3.
- **Fase 4 — API app externa de disponibilidades** (FEITA): token JWT single-use por extra (`availabilityFormToken.ts`), endpoints `/api/v1/availability-form/{context,submit}` (`availabilityForm.ts` + `mcpApi.ts`), token injetado no botão URL do template no broadcast, migração 0047. Ver ajuste #4. **INTEGRAÇÃO COMPLETA.**

## Decisões semânticas FECHADAS (Jorge, 2026-07-09)
- **Decisão 1** — "a todos" no broadcast = **conjunto visível na tabela** (extras com disponibilidade), NÃO todos os ativos. FICA COMO ESTÁ; divergência intencional face ao email ("o que envio é o que vejo").
- **Decisão 2** — inválidos NÃO geram linha em `whatsapp_messages` (confirmado), MAS guarda-se em `whatsapp_broadcasts.invalidEmployeeIds` (TEXT/JSON nullable) a lista de employeeId que falharam por número inválido → para depois "mostrar extras com número inválido" e corrigir na origem. Implementado na Fase 3 (schema + 0045 emendada + persistência no broadcast).

## REGRA DE MIGRAÇÕES (Jorge, 2026-07-09) — VÁLIDA DAQUI PARA A FRENTE
- **Migrações já aplicadas nalgum sítio são IMUTÁVEIS.** Coluna/tabela nova = **migração numerada NOVA**, NUNCA emendar um ficheiro SQL existente in-place.
- A emenda in-place da `0045` (Fase 3, `invalidEmployeeIds`) só foi aceite porque foi VERIFICADO que a 0045 NUNCA foi aplicada a nenhuma BD (nenhum comando de migração corrido nas sessões; testes são funções puras sem BD; index.ts NÃO auto-migra no boot; `db:push` é manual; a 0045 está fora do journal do drizzle-kit). O ALTER avulso foi por isso desnecessário.
- **Fase 4 segue a regra à letra**: nova tabela → ficheiro NOVO. Numeração escolhida **0047** (`drizzle/0047_availability_form_tokens.sql`): 0046 evitado porque `server/migrations/migration_0046.ts` (runner one-shot `0046_multipark_report_extra_fields`) já ocupa semanticamente o "0046"; 0047 é inequívoco e livre em `drizzle/`.

## AJUSTES DO JORGE (2026-07-09) — aplicar em todas as fases
1. **Fase 2 em modo dev até haver número de produção Meta**: construir UI de seleção + `whatsapp.sendBroadcast` COMPLETAS, mas sem validar envio em escala (número de teste ≈250/24h, só destinos verificados). TEM de existir **"modo teste com 1 número"** para validação ponta-a-ponta (espelha o `testEmail` do `sendWeeklyAvailabilityRequest`).
2. **Webhook (Fase 3) = process-then-ack**: PROCESSAR e ESCREVER na BD ANTES de responder 200 à Meta. Decisão explícita (volume baixo, latência irrelevante; prefere o retry da Meta a perder mensagens em silêncio). NÃO responder-primeiro-processar-depois. Ponto de extensão já marcado em `whatsappWebhook.ts`.
3. **Inbox (Fase 3)**: o estado "template enviado, a aguardar 1ª resposta" tem de ser **visualmente distinto** de "janela aberta". Com template disparado mas sem resposta (`lastInboundAt` null/antigo = janela FECHADA), a UI **NÃO deixa escrever texto livre** e mostra claramente que se aguarda a 1ª resposta. Fonte da verdade da janela 24h = `whatsapp_conversations.lastInboundAt`.
4. **Token do formulário externo (Fase 4)**: invalidar após o **PRIMEIRO submit**, além da expiração de 14 dias (proteção contra reencaminhamento do link).
5. **Confirmados**: default **+351** na normalização; **nome de template configurável no dialog** (desenvolver com placeholder até os templates estarem APPROVED); **sem fila persistente** → `runConcurrent(4)` + **1 retry**, MAS deixar comentário no código do broadcast a assinalar que um restart do Railway a meio **perde os envios em curso**.

## Changelog

### 2026-08-20 — Seletor de templates na página de disponibilidade (+ `aviso_de_trabalho`, papéis por NOME, pré-visualização real)
**Type**: feature
**Scope**: `shared/whatsappTemplate.ts` (catálogo + helpers puros), `server/whatsappTemplateMeta.ts`
(`bodyText` na análise, `validateTemplateUsage` com papéis), `server/whatsappBroadcast.ts`
(papéis resolvidos no servidor + valores reordenados), `server/routers.ts`
(`whatsapp.templatePreview`), `client/src/pages/ExtrasDiaPage.tsx` (diálogo),
`server/whatsappTemplateCatalog.test.ts` (novo, 15 testes)
**What**:
- **CATÁLOGO `WHATSAPP_TEMPLATES`** em `shared/whatsappTemplate.ts` — cada entrada traz `id` interno,
  `name`/`language` aprovados na Meta, etiqueta+descrição para o seletor, o rótulo/placeholder do
  campo partilhado (`sharedParam.kind: "week" | "day"`) e os **papéis** dos parâmetros
  (`roles: {recipient, shared}`). Duas entradas: `disponibilidade` (`disponibilidade_extras`/pt_BR,
  `{{nome}}`+`{{semana}}`) e `aviso_trabalho` (**`aviso_de_trabalho`/pt_BR, `{{customer_name}}`+`{{day}}`**).
  Acrescentar um 3º template é editar só este array.
- **Papéis por NOME, não por posição** — `resolveBodyParamRoles(paramNames, paramCount, roles)` +
  `orderBodyValues` (puros, partilhados). O envio continua a produzir `[nome do extra, campo do
  diálogo]`, mas passa a REORDENAR para a ordem real dos parâmetros do template. Um template que
  escreva `{{day}}` antes de `{{customer_name}}` deixa de receber os dois trocados. Nome desconhecido,
  contagem diferente ou template fora do catálogo → **recurso posicional** = comportamento histórico.
  Os papéis são resolvidos NO SERVIDOR (`findWhatsAppTemplateByName(templateName, languageCode)`),
  nunca vindos do cliente.
- **`validateTemplateUsage`** deixou de exigir o campo do diálogo só quando `paramCount === 2`: agora
  exige-o sempre que ALGUM slot tenha o papel `shared` (cobre o template de 1 parâmetro que não é o nome).
- **Pré-visualização REAL** — `whatsapp.templatePreview` (query tRPC, backoffice+) devolve o
  `bodyText` aprovado na Meta (via `getTemplateMeta`, cache 5 min) e o cliente substitui com
  `previewTemplateBody` usando **os mesmos papéis do envio** → o preview não pode divergir do que a
  Meta recebe. Sem metadados (falta `WHATSAPP_WABA_ID`/permissão/rede) mostra o motivo em âmbar e o
  envio continua a funcionar. NÃO há cópia local do texto do template (era a única forma de garantir
  que não fica desatualizado).
- **Diálogo "Enviar WhatsApp"**: `Select` "Mensagem" (só as duas entradas do catálogo) + descrição,
  campo partilhado com rótulo/placeholder do template (**"Semana"** vs **"Dia"**), botões de
  preenchimento rápido com os 7 dias da semana (`overview.dayHeaders`, ex. "Sexta 22/08") quando o
  template pede um dia, e o bloco de pré-visualização. O valor escrito é guardado **por template**
  (`Record<templateId, string>`), por isso trocar de template não apaga o que já estava escrito.
**Why**: o Jorge aprovou na Meta um 2º template (`aviso_de_trabalho`) e precisa de escolher qual
enviar a partir da mesma tabela de extras.
**Notes / decisões / gotchas**:
- **`{{day}}` = texto livre com atalhos para os dias da semana selecionada na página** (rótulo
  "Sexta 22/08", exactamente o `dayHeaders[].label` que a tabela já usa). **Assunção**: o Jorge quer
  avisar de um dia concreto dessa semana; se for outra coisa (data ISO, "amanhã", hora incluída) o
  campo aceita texto livre à mesma — muda-se só o `sharedParam.placeholder`.
- O `weekStart` continua a ser enviado no broadcast (contexto + token do formulário) em AMBOS os
  templates; o `aviso_de_trabalho` não tem botão URL, e os metadados é que mandam nisso.
- O diálogo "Reiniciar com template" do inbox **não** ganhou seletor (continua com nome/língua à
  mão), mas escrever lá `aviso_de_trabalho` já apanha os papéis pelo catálogo.
- **Gates**: `tsc --noEmit` LIMPO, `vite build` OK. **+15 testes novos**; os 9 ficheiros
  WhatsApp/extras dão **140/140**. Suite total **321 passam / 328**, com as **mesmas 7 falhas
  pré-existentes de ambiente** (users.create sem DATABASE_URL, zello ×2, multipark ×3, auth.logout).
- Sem migração. Sem commits git (por instrução).
- ⚠️ **Passo na Meta**: o `aviso_de_trabalho` tem de estar APPROVED em **pt_BR** e o número do
  destinatário na allowed list enquanto a app estiver em modo de desenvolvimento (ver "PASSOS
  MANUAIS NA META"). O preview diz logo se o nome/língua/estado não batem certo.
- **Pós-rebase (mesmo dia, sobre `368c801`)** — o commit foi rebasado sobre um batch upstream de
  ~60 commits (redesign, Extras-Dia multi-cidade, `useTableSort`, coluna "Últ. trabalho" via
  `rh.lastWorkedMap`, e **`5be2c26` "templates de pedido (email + WhatsApp)"**). Conflitos só em
  `ExtrasDiaPage.tsx` (3 regiões), resolvidos mantendo AMBOS os lados. Reconciliação semântica:
  - **Sem colisão de contrato com `5be2c26`**: esse commit é do canal EMAIL
    (`shared/availabilityMessages.ts` + `sendRequest.message{kind,dia,turno,horas}`) e NÃO tocou em
    `shared/whatsappTemplate.ts` / `whatsappBroadcast.ts` / `whatsappTemplateMeta.ts`. O único ponto
    de contacto é o botão "Usar este texto no WhatsApp", que escrevia no `{{2}}` do (então único)
    template. Passou a chamar `applyMessageTextToWhatsApp`: **seleciona o template de
    disponibilidade E escreve no campo dele** — senão, com "Aviso de trabalho" escolhido, a frase do
    pedido ia parar ao campo "Dia".
  - **Ordenação**: as linhas passaram a vir de `availSort.sorted`, mas `useTableSort` só REORDENA
    (não filtra), por isso `shownExtras` continua a ser o conjunto certo para a seleção "todos os
    mostrados", o `hiddenSelectedCount`, os totais e o alvo do envio. A pesquisa é aplicada ANTES do
    `.map(lastWorked)` (o `lastWorked` é coluna, não filtro) e `matchesExtraQuery` continua a bater
    com a forma da linha (nome/`phone`/`phoneE164` inalterados).
  - **Colunas**: a tabela passou a ter 5 fixas (+ dias) → `colSpan` do estado vazio = `dayHeaders.length + 5`.
    ⚠️ **Bug upstream corrigido de passagem**: a linha de totais "Disponíveis" ficou com 4 células
    fixas quando a coluna "Últ. trabalho" foi adicionada, o que desalinhava os totais das colunas dos
    dias — faltava um `<td>` (1 linha).
  - Ambiente: o batch trouxe `leaflet`/`@types/leaflet` no `package.json` sem estarem instalados
    (tsc falhava em `ZelloLiveTab.tsx`); resolvido com `pnpm install --prefer-offline`.
  - **Gates pós-rebase**: `tsc --noEmit` LIMPO, `vite build` OK, 140/140 nos 9 ficheiros
    WhatsApp/extras, suite total **321/328** com as MESMAS 7 falhas pré-existentes de ambiente.

### 2026-08-19 (c) — Pesquisa de contactos no inbox WhatsApp
**Type**: feature
**Scope**: `shared/contactSearch.ts` (novo, puro), `server/contactSearch.test.ts` (novo, 7 testes), `client/src/pages/WhatsAppInboxPage.tsx` (caixa de pesquisa na coluna "Conversas")
**What**:
- `matchesContactQuery(query, {name, phone})`: sem acentos/maiúsculas no nome; número comparado só por dígitos (aceita "+351…", "00351…", "912 345"); várias palavras = TODAS têm de bater (cada uma no nome OU no número). Pesquisa vazia passa tudo. `normalizeSearchText` exportado para reutilizar.
- Inbox: input "Pesquisar nome ou número…" (ícone + botão limpar) por baixo do cabeçalho da lista; filtro LOCAL sobre `conversations.list` (já devolve `name` + `phoneE164`, cap 300, refetch 10s) — sem mudança de servidor. Estado vazio distingue "Sem resultados para “x”" de "Ainda sem conversas". Seleção atual mantém-se mesmo que saia do filtro.
**Why**: Jorge pediu forma de procurar contactos/pessoas na página WhatsApp.
**Notes**: só filtra conversas EXISTENTES — não lista extras sem conversa (iniciar conversa nova por template a partir da pesquisa fica como possível follow-up). Se as conversas passarem de 300, o cap do `listConversations` passa a esconder resultados → mover o filtro para o servidor nessa altura. `tsc` limpo; 7/7 testes novos.

### 2026-08-19 (b) — Dialog de broadcast limpo (só semana + teste + enviar)
**Type**: refactor
**Scope**: `client/src/pages/ExtrasDiaPage.tsx` (dialog WhatsApp + `submitBroadcast`), `client/src/pages/WhatsAppInboxPage.tsx` (só o banner)
**What**:
- Dialog "Enviar WhatsApp" passou a mostrar APENAS: descrição (N selecionados / todos · N sem número válido, só se >0), campo **Semana** (= `bodyParam2`, obrigatório — botões desativados até estar preenchido), **Número de teste** + "Enviar teste", e "Enviar a N extra(s)". O resultado por destinatário continua a aparecer só DEPOIS de enviar.
- Removidos: banner "Modo desenvolvimento" (número já é o de produção "Multipark", GREEN), campos "Nome do template" e "Língua" (agora fixos em `AVAILABILITY_TEMPLATE_NAME`/`DEFAULT_TEMPLATE_LANGUAGE`), explicação {{1}}/{{2}}, caixa "Alvos: X válidos / Y inválidos" e a **checkbox `includeFormLink`** — o cliente deixa de enviar `includeFormLink` (opcional no schema); o botão com link é decidido pelos metadados do template (`whatsappTemplateMeta.ts`) e, se a inspeção falhar, vai sem botão (comportamento conservador; a Meta rejeita botão injetado num template sem botão).
- Inbox: removido o mesmo banner "Modo desenvolvimento" do dialog "Reiniciar com template" (import `AlertTriangle` limpo). Template/língua editáveis nesse dialog ficaram como estavam.
**Why**: Jorge pediu o modal limpo, sem aviso de desenvolvimento nem checkbox — só o essencial.
**Notes**: `tsc --noEmit` limpo. Sem alteração de servidor nem de schema. Para testar OUTRO template deixa de haver UI aqui — mudar `shared/whatsappTemplate.ts` ou usar o dialog do inbox.

### 2026-08-19 — Diagnóstico: respostas dos extras NÃO chegam ao inbox (webhook nunca subscrito na Meta)
**Type**: review
**Scope**: nenhum ficheiro alterado — diagnóstico só de leitura (curl ao deploy + GETs à Graph API com o token do `.env`)
**What** (o que foi VERIFICADO, por ordem):
- Código do caminho inbound está completo e deployado: `GET /api/whatsapp/webhook` responde 403 a token errado e **200 + echo do challenge com o `WHATSAPP_VERIFY_TOKEN` do `.env` local** (⇒ o valor local == o valor no Vercel); `POST` sem assinatura → 401 em ~0.2s (raw body funciona na serverless). Vale em `https://dashbord-multipark.vercel.app` e em `https://dashboard.multipark.pt` (Cloudflare → mesmo deploy Vercel; o 403 "Forbidden" vem do Express, não da Cloudflare). `/api/health` confirma as 4 envs WHATSAPP_* + WABA no deploy.
- **Causa raiz — lado Meta, duas camadas vazias**: `GET /{APP_ID}/subscriptions` (app token `APP_ID|APP_SECRET`) → `{"data":[]}` = a app `dashboard.multipark.pt` (id 1642001116898221) **não tem callback URL nem campo `messages` subscrito**; `GET /{WABA_ID}/subscribed_apps` → `{"data":[]}` = a app **não está subscrita à WABA**. Sem as duas, a Meta nunca envia eventos ao nosso endpoint — o envio funciona (só precisa de token + phone_number_id), a receção não.
- Token é SYSTEM_USER, sem expiração, com `whatsapp_business_messaging` + `whatsapp_business_management` + `business_management` (chega para ambos os POSTs de subscrição). Número +351 911 955 252 "Multipark", CLOUD_API, GREEN, **sem** `webhook_configuration` ao nível do número (não há override a atrapalhar).
**Why**: Jorge reportou que tudo funciona menos "receber respostas na página WhatsApp". A secção "PASSOS MANUAIS NA META" já listava "webhook apontado a /api/whatsapp/webhook" como passo manual — nunca foi executado.
**Notes** (como resolver — NÃO executado, aguarda luz verde):
1. App-level (UI: Meta for Developers → app → WhatsApp → Configuration → Webhook → Edit: Callback URL `https://dashboard.multipark.pt/api/whatsapp/webhook`, Verify token = valor de `WHATSAPP_VERIFY_TOKEN` → Verify and save → Manage → subscrever `messages`). Equivalente API: `POST /{APP_ID}/subscriptions` `object=whatsapp_business_account&callback_url=…&verify_token=…&fields=messages` com `access_token=APP_ID|APP_SECRET` (a Meta faz o GET de verificação na hora).
2. WABA-level: `POST /{WABA_ID}/subscribed_apps` com Bearer `WHATSAPP_TOKEN` (UI raramente faz isto para WABAs fora do Embedded Signup). Confirmar com `GET /{WABA_ID}/subscribed_apps` → deve listar a app.
3. Teste: enviar um WhatsApp do telemóvel para +351 911 955 252 → em ≤10s aparece na `/whatsapp` (página faz `refetchInterval` 10s); logs Vercel mostram `[WhatsAppWebhook] processado: 1 inbound`. Se aparecer 500 nos logs → migração 0045 não está nessa BD (mas o broadcast 8 já escreveu em `whatsapp_broadcasts`, logo as tabelas existem).
- Passos 1+2 podem ser feitos por curl com os valores do `.env` local (token/secret verificados válidos); são ações que ALTERAM a config Meta ⇒ só com autorização explícita do Jorge.
- **2026-08-19 (mesmo dia) — Passo 2 EXECUTADO com autorização do Jorge**: `POST /{WABA_ID}/subscribed_apps` (Bearer system-user token) → `{"success":true}`; `GET` confirma a app `dashboard.multipark.pt` (1642001116898221) subscrita à WABA. **Passo 1 (callback URL + campo `messages` na UI da Meta) ficou a cargo do Jorge** — até o fazer, continua a não chegar nada; confirmar depois com `GET /{APP_ID}/subscriptions` (deve mostrar `callback_url` + `fields: [messages]`, `active: true`).

### 2026-08-04 (b) — Envio guiado pelos METADADOS do template (fim do erro 100 / parâmetros nomeados)
**Type**: fix + feature
**Scope**: `server/whatsappTemplateMeta.ts` (novo), `server/whatsappTemplateMeta.test.ts` (novo),
`server/whatsappBroadcast.ts`, `server/whatsapp.ts`, `server/whatsapp.test.ts`,
`server/_core/api-entry.ts`, `.env.example`, `client/src/pages/ExtrasDiaPage.tsx`
**Trigger**: 2º teste real — `+351963687459` (employeeId 374) falhou com
`(#100) Invalid parameter — Parameter name is missing or empty`. Causa: o
`disponibilidade_extras` (aprovado em **pt_BR**, ver commit `aadf91f`) foi criado no WhatsApp Manager
com parâmetros **NOMEADOS** (`{{nome}}`, `{{semana}}`) e a Cloud API exige `parameter_name` em cada
parâmetro do body; nós mandávamos posicionais. Pedido do Jorge: "que nunca mais falhe".
**What** — o envio deixou de ASSUMIR o formato e passou a LER o template:
1. **NOVO `server/whatsappTemplateMeta.ts`** — `GET /{wabaId}/message_templates?name=…`, **uma
   chamada por broadcast**, cache em memória 5 min por `wabaId|nome` (a resposta traz todas as
   línguas do mesmo nome). Núcleo 100% PURO e testado; o I/O **nunca lança**.
   - **WABA id**: env NOVA `WHATSAPP_WABA_ID` (determinística, preferida); sem ela, tenta
     `/debug_token` → `granular_scopes` (prefere `whatsapp_business_management`, senão
     `…_messaging`). **0 ou >1 ids = ambíguo → não adivinha**, desliga a inspeção e diz para definir
     a env. Resultado da resolução também cacheado 5 min (inclui as falhas, para não martelar).
2. **Payload adaptado ao template** — `analyzeTemplateEntry` extrai `parameter_format`
   (com inferência pelo texto do body quando a Meta não o declara), os **nomes dos parâmetros por
   ordem de aparição no texto do BODY** (`example.body_text_named_params` só como recurso), a
   contagem e a existência de **botão URL dinâmico** (+ o seu **índice real** dentro do bloco
   BUTTONS — antes assumíamos `index: "0"`, o que estaria errado com um botão de telefone à frente).
   `buildBodyComponent`: NAMED → `{type:"text", parameter_name, text}`; POSITIONAL → como antes;
   **0 parâmetros → nenhum componente de body** (regressão da batch anterior corrigida);
   1 parâmetro → só o nome; 2 → nome + "Semana/dia". O mapeamento continua semântico-por-posição.
3. **Validação PRÉ-ENVIO** (só quando há metadados) — falha ANTES de criar o broadcast e antes de
   gastar uma chamada: nome inexistente; língua inexistente → **lista as línguas que EXISTEM**
   ("está aprovado em: pt_BR" — é isto que mata o 132001 cego); estado ≠ APPROVED → diz o estado;
   >2 parâmetros → recusa e lista-os; 2 parâmetros com "Semana/dia" vazio → diz quais são; botão
   dinâmico sem semana escolhida → pede a semana.
4. **Metadados MANDAM sobre a checkbox `includeFormLink`** — o token do formulário passa a ser
   injetado se (e só se) o template tiver mesmo botão URL dinâmico. A checkbox fica como
   **fallback** para quando a inspeção não está disponível; texto de ajuda atualizado
   ("normalmente não é preciso mexer").
5. **Fallback gracioso** — inspeção indisponível (sem permissão `whatsapp_business_management`,
   rede, WABA ambíguo, sem token) → `console.warn` + envio com o comportamento anterior; se o envio
   falhar, o motivo é **anexado ao erro** (`withMetaHint`) e persistido em
   `whatsapp_messages.errorDetail` — a linha da BD e a UI contam a mesma história.
6. **Erro 100 mapeado** — detalhe com "parameter name" → explica os parâmetros nomeados e aponta
   para `WHATSAPP_WABA_ID`. Sem esse detalhe, mantém a mensagem genérica da Meta.
**Why**: o formato do template é decidido no WhatsApp Manager, fora do nosso controlo — só deixa de
falhar se o envio se adaptar ao que lá está em vez de assumir.
**Notes / decisões / gotchas**:
- **Ordem dos parâmetros vem do TEXTO do body**, não da lista de exemplo da Meta (é a ordem que o
  utilizador vê; a lista de exemplo pode vir incompleta — no template do Jorge só trazia `nome`).
- **Nome repetido no texto** (`{{nome}} … {{nome}}`) conta UMA vez — a Meta quer um valor por nome.
- A inspeção **não é obrigatória**: sem `WHATSAPP_WABA_ID` e com um token só de messaging, tudo
  continua a funcionar como antes (com a nota no erro). **Definir a env é o passo recomendado.**
- `/api/health` passou a expor `WHATSAPP_WABA_ID` (booleano de presença, padrão da casa).
- **Gates**: `tsc --noEmit` LIMPO. **+34 testes** (32 `whatsappTemplateMeta` + 2 do erro 100);
  os 7 ficheiros WhatsApp/extras dão **118/118**. Suite total **299 passam / 306**, com as **mesmas
  7 falhas pré-existentes de ambiente** (users.create sem DATABASE_URL, zello ×2, multipark ×3,
  auth.logout) — uma delas (zello auth, chamada de rede real) é intermitente e chegou a dar 8 num
  dos runs. Nada nos ficheiros tocados.
- Sem migração. **Sem commits git** (o Jorge revê e faz push).

### 2026-08-04 — Pós-teste real do Jorge: diagnóstico de erros Meta, template por defeito, {{1}} automático
**Type**: fix + feature
**Scope**: `shared/whatsappTemplate.ts` (novo), `server/whatsapp.ts`, `server/whatsappBroadcast.ts`,
`server/extrasAvailability.ts`, `server/routers.ts`, `client/src/pages/ExtrasDiaPage.tsx`,
`client/src/pages/WhatsAppInboxPage.tsx`, `server/whatsapp.test.ts`, `server/whatsappBroadcast.test.ts`
**Trigger**: primeiro envio real (broadcast 8, 2 destinatários) falhou nos dois:
`131030` (Jorge) e `132001` (Rafael). Diagnóstico: **nenhum dos dois é bug nosso**, mas a mensagem
de erro não dizia o que fazer nem QUAL template/língua tinham sido tentados.
**What**:
1. **Erros Meta auto-diagnosticáveis** — NOVA `describeMetaError(code, metaErr, ctx)` (PURA, exportada,
   6 testes) substitui o mapa cego `META_ERROR_HINTS`. `postMessage` passou a receber um
   `MetaErrorContext {to, templateName, languageCode, paramCount}` montado por `sendTemplateMessage`.
   - `131030` → diz o NÚMERO e manda adicioná-lo em *Meta for Developers → WhatsApp → API Setup → "To"*
     (ou passar a conta a produção). Antes: mensagem crua da Meta em inglês.
   - `132001` → diz o NOME do template e a LÍNGUA tentados + avisa que `pt_PT ≠ pt_BR ≠ pt`.
   - `132000` → diz quantos parâmetros foram enviados (era o suspeito nº 1 do botão URL).
   - Novos: 132005, 132012, 131009, 131031, 133010, 368. O `error_data.details` da Meta (onde ela
     explica mesmo o que falhou) passou a ser anexado — antes era deitado fora.
   - O resultado por destinatário na UI não mudou de forma (não regrediu); só o texto ficou útil.
2. **Template por defeito** — `shared/whatsappTemplate.ts` (novo, partilhado cliente+servidor):
   `AVAILABILITY_TEMPLATE_NAME = "disponibilidade_extras"`, `DEFAULT_TEMPLATE_LANGUAGE = "pt_PT"`,
   `UNKNOWN_RECIPIENT_NAME`, `sanitizeTemplateParam`, `firstNameOf`. Os dois dialogs (ExtrasDia e
   Inbox) abrem já preenchidos, continuam editáveis. O servidor usa a MESMA constante de língua
   (antes tinha um `DEFAULT_LANGUAGE` local — duas fontes de verdade).
3. **{{1}} automático por destinatário, {{2}} manual** — **CONTRATO MUDOU**: `templateParams: string[]`
   SAIU; entrou `bodyParam2: string | null`. NOVA `buildBodyParams(name, param2)` (PURA, 5 testes):
   `{{1}}` = PRIMEIRO nome do destinatário (mesmo critério do email "Olá João"), `{{2}}` = texto do
   dialog, igual para todos. Sem `{{2}}` envia-se só 1 parâmetro (template de 1 param não pode
   receber 2). Parâmetros são sanitizados (a Meta rejeita `\n`, tabs e 5+ espaços).
   - **Modo teste**: NOVA `findActiveEmployeeByPhoneE164` (match em memória — `employees.phone` é
     texto livre, não é comparável em SQL) dá o nome REAL ao `{{1}}` quando o número de teste é de um
     colaborador ativo (e a conversa do inbox nasce associada à ficha); senão `"Teste"`.
   - NOVA `dispatchOne` é agora o ÚNICO ponto de envio dos dois modos — o modo teste já não tem
     caminho próprio (era assim que um teste podia passar e o envio real falhar).
4. **Botão do formulário passou a OPT-IN** (`includeFormLink`, default **false**) — antes, com
   `weekStart` preenchido (que a página põe SEMPRE), o broadcast injetava um componente de botão URL
   em TODOS os envios. Num template SEM botão "Visit website" — que é o caso do `disponibilidade_extras`
   do Jorge — isso faz a Meta rejeitar o envio. Checkbox no dialog explica quando ligar. Ligado sem
   semana → erro claro; ligado num número sem ficha → falha explicada (não há employeeId para o token).
**Why**: depois de o Jorge aprovar o template e pôr os números na allowed list, não pode sobrar
nenhum obstáculo de código; e quando sobrar algum, a mensagem tem de identificar a causa sozinha.
**Notes / decisões / gotchas**:
- ⚠️ **Mudança de comportamento**: agora vai SEMPRE pelo menos 1 parâmetro de body ({{1}}). Um template
  com ZERO parâmetros passa a falhar com 132000 (mensagem já diz a contagem). Aceite — o requisito é o
  {{1}} automático. Solução definitiva seria ler os metadados do template (`GET /{waba}/message_templates`)
  e validar a contagem ANTES de enviar: **follow-up registado**.
- ⚠️ **`includeFormLink` default OFF desliga o fluxo da Fase 4** enquanto o template não tiver botão URL.
  É deliberado: o template que existe hoje não tem botão. Ligar a checkbox restaura a Fase 4 tal e qual.
- Os dois erros do broadcast 8 são de CONFIGURAÇÃO na Meta, não de código (ver "PASSOS MANUAIS NA META").
- **Gates**: `pnpm run check` (tsc) LIMPO exit 0. Testes **264 passam** (eram 243) — +21 novos
  (6 `describeMetaError`, 5 `buildBodyParams`, 10 de cidade). As **7 falhas continuam as MESMAS
  pré-existentes de ambiente** (users.create sem DATABASE_URL, zello ×2, multipark ×3, auth.logout).
- Sem migração. Sem commits git (por instrução).

### 2026-07-09 — Fase 0 + Fase 1
**Type**: feature
**Scope**: `.env.example`, `server/_core/api-entry.ts`, `server/_core/index.ts`, `server/whatsappWebhook.ts` (novo), `server/whatsapp.ts` (novo), `shared/phone.ts` (novo), `drizzle/schema.ts`, `drizzle/0045_whatsapp_integration.sql` (novo), `server/whatsapp.test.ts` (novo)
**What**:
- **Envs**: secção `WHATSAPP_*` no `.env.example` (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_API_VERSION` default v21.0). 4 booleanos de presença acrescentados ao `/api/health` (`api-entry.ts`, padrão existente sem expor valores).
- **Webhook stub** `server/whatsappWebhook.ts`: `createWhatsappWebhookRouter()` com GET verify (echo `hub.challenge` se `isValidWebhookVerification`) e POST com `express.raw({type:'application/json'})` próprio + `verifyMetaSignature` (HMAC-SHA256 do raw body, `crypto.timingSafeEqual`, 401 se inválida/ausente) → responde 200 sem processar (ponto de extensão Fase 3 marcado com a decisão process-then-ack). `verifyMetaSignature` e `isValidWebhookVerification` exportadas como funções puras testáveis.
- **Montagem**: webhook em `/api/whatsapp/webhook` ANTES do `express.json` global nos DOIS entrypoints (`index.ts` Railway + `api-entry.ts` Vercel). `createMcpApiRouter()` agora também montado em `/api/v1` no `index.ts` (antes só no Vercel) — sem conflito de paths (livre no Railway).
- **Normalização** `shared/phone.ts`: `normalizePhoneE164(raw): string|null` — `+...` mantém; `00...`→`+`; PT 9 dígitos→`+351`; `351`+9díg sem `+`→`+`; resto→null. Remove espaços/hífens/parêntesis/pontos. NÃO altera `employees.phone`.
- **Schema** `drizzle/schema.ts`: import `date` adicionado; 3 tabelas + 6 type aliases: `whatsapp_conversations` (phoneE164 unique, employeeId, lastInboundAt/lastMessageAt, unreadCount), `whatsapp_messages` (conversationId, direction in/out, waMessageId unique nullable=dedup+correlação status, type text/template, body, templateName, status pending/sent/delivered/read/failed, errorDetail, sentById, broadcastId, waTimestamp), `whatsapp_broadcasts` (templateName, note, createdById, weekStart date, total/sent/failedCount).
- **Cliente Graph API** `server/whatsapp.ts`: `sendTemplateMessage(toE164, templateName, languageCode, components?)` e `sendTextMessage(toE164, text)` → `{ok:true,waMessageId}|{ok:false,error,code?}`. POST `graph.facebook.com/{ver}/{phoneNumberId}/messages` Bearer. Mapa de erros Meta (131026/131047/132000/132001/130429/190). 1 retry com backoff só em 429/5xx/rede. Sem deps novas (fetch nativo).
- **Testes** `server/whatsapp.test.ts`: 16 casos — `normalizePhoneE164` (PT/+/00/lixo) + `verifyMetaSignature` (válida/errada/tamper/ausente/sem-secret/formato) + `isValidWebhookVerification` (token certo/errado/mode/sem-token).
**Why**: fundações reutilizáveis e o webhook já apontável na config Meta antes de haver processamento/UI.
**Notes / decisões / gotchas**:
- **Migração 0045 escrita À MÃO** (não `drizzle-kit generate`): o journal do drizzle-kit está congelado no idx 24 e o `schema.ts` está ~20 migrações manuais à frente → `generate` diffaria contra o snapshot 0024 obsoleto e emitiria um ficheiro gigante/errado (recriaria 0025-0044) + colisão de numeração. Seguido o padrão real da casa (SQL manual numerado, sem tocar journal/meta). **A migração NÃO foi executada contra nenhuma BD** — aplicar pelo runbook habitual antes do deploy.
- `whatsapp_broadcasts.weekStart` usa tipo `DATE` (pedido explícito), ao passo que `extras_availability.weekStart` é `varchar(10)` — pequena inconsistência aceite.
- **tsc**: LIMPO (`pnpm run check`, exit 0). **Testes novos**: 16/16 verdes.
- **Falha PRÉ-EXISTENTE não relacionada**: `server/auth.logout.test.ts` falha (`sameSite` recebido `"lax"` vs esperado `"none"`) — drift na config do cookie de logout, código NÃO tocado por este trabalho. Import do schema/router OK (o teste executou até à asserção). Flag para o Jorge; fora de escopo.
- **Env de dev**: o `node_modules` estava vazio (só `tsbuildinfo` stale) — corrido `pnpm install` (offline-preferred) para obter toolchain real. Build scripts ignorados (@tailwindcss/oxide, esbuild) — irrelevante para tsc/testes de servidor.
- **Sem commits git** (por instrução).

### 2026-07-09 — Fase 2 (seleção + envio em massa, MODO DESENVOLVIMENTO)
**Type**: feature
**Scope**: `server/extrasAvailability.ts`, `server/whatsappBroadcast.ts` (novo), `server/_core/concurrency.ts` (novo), `server/routers.ts`, `client/src/pages/ExtrasDiaPage.tsx`, `server/whatsappBroadcast.test.ts` (novo)
**What**:
- **`listActiveExtras`** agora devolve `phone` (novo campo em `ActiveExtra`); `OverviewExtra` + `getWeekOverview` também passam `phone` → chega ao cliente via `extrasAvailability.overview`.
- **`server/_core/concurrency.ts`**: `runConcurrent<T>(items, limit, fn, deadlineAt?)` extraído para módulo partilhado (réplica do que estava acoplado ao `multiparkBookingSync.ts` — o sync ficou intacto com a sua cópia).
- **`server/whatsappBroadcast.ts`**: `resolveRecipients(extras, employeeIds?)` (PURO, testável — subset + `normalizePhoneE164`) e `sendBroadcast(opts)` (orquestração). Falha CEDO se faltarem envs WHATSAPP_* ou BD. Modo teste (`testPhone`) envia só a 1 número, regista `whatsapp_broadcasts`+`whatsapp_messages` com note `[TESTE]`. Modo normal: cria 1 broadcast, por destinatário upsert de `whatsapp_conversations` (NUNCA toca `lastInboundAt` em outbound — mantém "aguarda 1ª resposta") + `whatsapp_messages` (out/template/sent|failed/waMessageId/errorDetail); inválidos/sem-número → falha SEM chamar API e SEM criar conversa/mensagem (não há phoneE164 chave). Envio via `runConcurrent(4)`. Devolve `{broadcastId,total,sent,failed,invalidPhone,recipients[]}`.
- **Router tRPC** `whatsapp.sendBroadcast` (`routers.ts`): `protectedProcedure`+`requireRole(...,"backoffice")`+`logActivity` (action `whatsapp_broadcast`), espelho de `extrasAvailability.sendRequest`. A mutation devolve o summary completo → SEM query separada (opção mais simples, pedido do ponto 3).
- **UI** `ExtrasDiaPage.tsx` `AvailabilitySection`: coluna Telefone com badge âmbar "sem número válido" (validação via `@shared/phone`); botão "WhatsApp aos selecionados / a todos" (verde) ao lado do email; **Dialog shadcn** com nome de template configurável (placeholder até APPROVED), língua (default pt_PT), parâmetros do body (separados por "|"), campo teste 1-número, resumo válidos/inválidos entre alvos, resultado por destinatário (enviado/falhou/inválido + erro), aviso de modo-dev (número de teste ≈250/24h, só verificados). Toasts sonner. Multi-seleção nativa existente mantida (não refatorizada).
**Why**: Fase 2 do plano — seleção + broadcast em modo dev, pronta para o Jorge validar ponta-a-ponta com o número de teste da Meta assim que existir.
**Notes / decisões / gotchas**:
- **Ajuste #5 (Jorge) aplicado**: comentário OBRIGATÓRIO no topo de `sendBroadcast` a assinalar que, sem fila persistente, um restart do Railway a meio de um broadcast PERDE os envios pendentes (decisão consciente; revisitar se a escala crescer). `runConcurrent(4)` + retry único (que já vive em `whatsapp.ts`).
- **Semântica "a todos" na UI**: sem seleção explícita, o alvo é o conjunto MOSTRADO (extras com disponibilidade), não todos os ativos — para bater certo com a tabela e o resumo válido/inválido (o backend aceita a lista concreta de ids). Difere do email ("a todos" = todos os ativos), intencionalmente.
- **invalidPhone** conta em `whatsapp_broadcasts.failedCount` (failedCount = falhas API + inválidos) mas é reportado à parte no summary. Inválidos NÃO geram linha em `whatsapp_messages` (análogo ao `noEmail`).
- **Testabilidade**: só `resolveRecipients` é unit-testada (pura). O loop de envio (`sendBroadcast`) precisa de BD+Graph reais → integração, não coberto por unit test (sem BD de teste). Motor confirmado **MySQL/InnoDB**; `0045` revalidada.
- **Gates**: `pnpm run check` (tsc) LIMPO exit 0. Testes: `whatsapp.test.ts` 16 + `whatsappBroadcast.test.ts` 5 = **21/21 verdes**. Falha pré-existente de `auth.logout.test.ts` persiste (não relacionada).
- **Sem commits git** (por instrução).

### 2026-07-09 — Fase 3 (Webhook + Inbox)
**Type**: feature
**Scope**: `drizzle/schema.ts` + `drizzle/0045_whatsapp_integration.sql` (Decisão 2: `invalidEmployeeIds`), `server/whatsappBroadcast.ts` (persistência), `server/whatsappWebhook.ts` (processamento), `server/whatsappInbound.ts` (novo), `server/whatsappInbox.ts` (novo), `server/routers.ts` (router inbox), `client/src/pages/WhatsAppInboxPage.tsx` (novo), `client/src/App.tsx` + `client/src/components/DashboardLayout.tsx` (rota+menu), `server/whatsappInbound.test.ts` + `server/whatsappInbox.test.ts` (novos)
**What**:
- **Decisão 2**: coluna `whatsapp_broadcasts.invalidEmployeeIds TEXT NULL` (schema + 0045 emendada). `sendBroadcast` persiste JSON dos employeeId com número inválido/ausente. **ALTER isolado** (caso a 0045 já tenha sido aplicada): `ALTER TABLE \`whatsapp_broadcasts\` ADD COLUMN \`invalidEmployeeIds\` TEXT NULL AFTER \`failedCount\`;`
- **Webhook** (`whatsappWebhook.ts` POST): valida HMAC → `JSON.parse` (malformado→400) → **process-then-ack** via `processInboundWebhook` (import dinâmico); sucesso→200, erro→500 (Meta faz retry). Log no erro.
- **`whatsappInbound.ts`** (parse PURO + orquestração): `parseWebhookPayload` (entry/changes/value/messages+statuses, defensivo), `parseMetaTimestamp` (epoch→UTC str), `messageBody` (texto ou marcador `[imagem]`/caption — **media NÃO descarregada nesta fase**, decisão registada), `metaFromToE164` (normalizePhoneE164 c/ fallback `+dígitos` p/ não-PT). Orquestração: dedup por `waMessageId` (no-op se existe), upsert conversa por phoneE164 (**set `lastInboundAt`+`lastMessageAt`, `unreadCount+1`**, associa employeeId por match de telefone via mapa normalizado), insere mensagem `in`/`text` (enum só tem text|template → media entra como text; status `delivered`=recebida). Statuses: correlação por `waMessageId` em mensagens `out`, atualiza status por rank (sent<delivered<read, failed sempre + errorDetail); desconhecida→no-op.
- **`whatsappInbox.ts`**: `deriveWindowState(lastInboundAt, now?)` PURO (awaiting_first_reply=null / open=<24h / expired), timestamps da BD tratadas como UTC. `listConversations` (join employees→nome ou número, preview da última msg via 1 query IN, windowState derivado), `getConversationThread` (thread cronológica limitada), `markConversationRead` (unread=0), `replyToConversation` (**valida janela NO SERVIDOR**: só envia se `open`, senão erro claro; `sendTextMessage` + insere out/text + atualiza lastMessageAt).
- **Router tRPC** (`whatsapp` estendido, tudo backoffice+): `conversations.list`, `messages.byConversation`, `markRead`, `reply` (+`logActivity` action `whatsapp_reply`).
- **`WhatsAppInboxPage.tsx`**: 2 colunas (lista c/ badge não-lidas + preview ordenado por lastMessageAt; thread c/ bolhas in/out, status ✓/✓✓/lido/falhou nas out, timestamps). Polling `refetchInterval` 10s; markRead ao abrir; responsivo via `useIsMobile` (lista OU thread no telemóvel). **3 estados de janela distintos** (ajuste #3): `awaiting_first_reply` (banner + composer OFF), `open` (countdown "fecha em Xh" + composer ON), `expired` (banner + composer OFF + botão "Enviar template" que reusa `sendBroadcast` com `testPhone`=número da conversa). Rota `/whatsapp` + item de menu em "Operações" (backoffice+, ícone MessageCircle).
**Why**: Fase 3 do plano — receber respostas e responder 1-a-1 dentro das regras da Meta.
**Notes / decisões / gotchas**:
- **Media não descarregada** (Fase 3): guardamos `[imagem]`/`[áudio]`/caption no body; download de media fica para depois (precisa de fetch autenticado à Graph + storage).
- **Status de mensagens inbound**: guardado como `delivered` (o enum não tem "received"); a UI só mostra status nas mensagens OUT. Não-regressão de status por rank.
- **Timezone**: writes são UTC wall-clock ('YYYY-MM-DD HH:MM:SS'); `deriveWindowState`/`fmtTime` reinterpretam como UTC (sufixo Z) para a matemática das 24h bater certo. Testado na fronteira.
- **Testabilidade**: parse do webhook + `deriveWindowState` + gate do reply são puros e testados. Escrita na BD (dedup real, upsert, reply IO) é integração, não coberta por unit test (sem BD de teste) — mas a lógica de decisão (dedup=existência, gate=deriveWindowState) está isolada e testada.
- **Gates**: `pnpm run check` (tsc) LIMPO exit 0. Testes: whatsapp 16 + whatsappBroadcast 5 + whatsappInbound 15 + whatsappInbox 9 = **45/45 verdes**. Falha pré-existente `auth.logout.test.ts` persiste (não relacionada).
- **Migração**: `0045` continua NÃO aplicada (tanto quanto se sabe); a emenda in-place é segura. ALTER isolado acima para o caso de já ter sido aplicada. Não colidir com `server/migrations/migration_0046.ts` (runner existente) — não criei ficheiro 0046.
- **Sem commits git** (por instrução).

### 2026-07-09 — Fase 4 (API app externa de disponibilidades) — FINAL
**Type**: feature
**Scope**: `drizzle/schema.ts` + `drizzle/0047_availability_form_tokens.sql` (novo), `server/availabilityFormToken.ts` (novo), `server/availabilityForm.ts` (novo), `server/whatsappBroadcast.ts` (token no template), `server/mcpApi.ts` (2 endpoints), `.env.example` + `server/_core/api-entry.ts` (envs), `server/availabilityForm.test.ts` (novo)
**What**:
- **Migração NOVA `0047`** (regra de imutabilidade): tabela `availability_form_tokens` (id, jti unique, employeeId, weekStart, expiresAt, usedAt nullable, createdAt). NÃO aplicada a nenhuma BD (deploy manual).
- **`availabilityFormToken.ts`** — token JWT HS256 via `jose`, secret DEDICADO `AVAILABILITY_FORM_TOKEN_SECRET` (≠ JWT_SECRET). Payload `{employeeId, weekStart}` + `jti` (nanoid) + exp 14 dias. Puros/testáveis: `signFormToken`, `verifyFormTokenSignature` (expired vs invalid via `ERR_JWT_EXPIRED`), `evaluateTokenRow` (ok/used/unknown), `extractAffectedRows`. I/O: `issueAvailabilityFormToken` (assina + persiste jti; devolve token+link), `verifyAvailabilityFormToken` (assinatura + estado jti, SEM consumir), `consumeAvailabilityFormToken` (**single-use atómico**: UPDATE ... WHERE usedAt IS NULL, true só se affectedRows===1).
- **`availabilityForm.ts`** — `submitDaysSchema` (zod, mirror do setMyWeek, weekStart vem do TOKEN não do body), `buildFormContext` (shape mínimo: firstName+semana, SEM email/telefone/id), `tokenErrorResponse` (expired→410 token_expired, used→410 token_already_used, invalid→401 token_invalid), `getFormContext` (valida SEM consumir), `submitForm` (valida→**consome**→`setMyAvailability`→logActivity `availability_form_submit` userId 0). **Reutiliza `getMyWeek`/`setMyAvailability` diretamente** — já keyed por employeeId, sem ctx de sessão; nenhuma extração precisou de ser feita.
- **Endpoints `mcpApi.ts`** (`/api/v1/availability-form/`): `GET /context?token=` (scope read, não consome), `POST /submit` {token, days} (scope write, consome). Ambos atrás de X-API-Key (`validateApiKey`) + `requireScope`. Erros com `code` distinguível para a app mostrar mensagem certa.
- **Token no broadcast** (`whatsappBroadcast.ts`): quando há `weekStart` e o destinatário é extra registado, emite token e injeta-o como parâmetro do **botão URL** do template (`buildComponents(params, buttonToken)` → `{type:"button",sub_type:"url",index:"0",parameters:[{type:"text",text:token}]}`). Falha a emitir token → destinatário marcado failed sem enviar. Modo teste NÃO gera token (sem employeeId).
- **Envs**: `AVAILABILITY_FORM_TOKEN_SECRET` (+ presença no /api/health), `AVAILABILITY_FORM_URL` (opcional) — documentadas no `.env.example`.
**Why**: fecha a integração — app externa recebe contexto (que extra/datas) e devolve a disponibilidade preenchida, em segurança.
**Notes / decisões / gotchas**:
- **Numeração 0047** (não 0046): `server/migrations/migration_0046.ts` já ocupa o "0046" semanticamente. Regra de imutabilidade seguida à letra.
- **Ordem consome→escreve** (ajuste #4): o consume atómico é a barreira de duplo-submit; o raro caso "consumiu mas setMyAvailability falhou" deixa a semana por gravar (recuperável reemitindo token) — aceite. GET /context NÃO consome (extra pode reabrir).
- **Token used bloqueia também o /context** (410 token_already_used) — a app distingue "expirado" de "já submetido" pelo `code`.
- **weekStart autoritativo do token**, não do body (o body só traz `days`) — a app externa é não-confiável.
- **Tokens expirados/nunca-usados** acumulam na tabela até expiry; limpeza é um cron futuro (não crítico, volume baixo).
- **Gates**: `pnpm run check` (tsc) LIMPO exit 0. Testes: whatsapp 16 + whatsappBroadcast 5 + whatsappInbound 15 + whatsappInbox 9 + **availabilityForm 18** = **63/63 verdes**. Falha pré-existente `auth.logout.test.ts` persiste (não relacionada).
- **Sem commits git** (por instrução).

## PASSOS MANUAIS NA META (o que o código NÃO pode resolver) — 2026-08-04
Os dois erros do broadcast 8 resolvem-se do lado da Meta, não no código:
- **`131030` "Recipient phone number not in allowed list"** — a app/WABA está em **modo de
  desenvolvimento**: só entrega a números explicitamente autorizados. Meta for Developers → a app →
  **WhatsApp → API Setup → campo "To" → Manage phone number list** → adicionar `+351935625800` (e
  qualquer outro número de teste; cada um confirma por SMS/chamada). Alternativa definitiva: concluir
  a verificação do negócio e usar um número de **produção** (aí entrega a qualquer número).
- **`132001` "Template inexistente ou ainda não aprovado"** — WhatsApp Manager → **Modelos de
  mensagem**: confirmar o nome EXATO `disponibilidade_extras` e o estado **APPROVED**. A língua
  default do código é **`pt_BR`** (é essa a tradução aprovada — confirmado 2026-08-04, commit
  `aadf91f`). Desde 2026-08-04(b), com a inspeção ativa, o erro passa a dizer **em que línguas o
  template EXISTE** ("está aprovado em: pt_BR").
- **Corpo do template**: 1 ou 2 parâmetros. Podem ser **posicionais** (`{{1}}`, `{{2}}`) ou
  **nomeados** (`{{nome}}`, `{{semana}}`) — desde 2026-08-04(b) o envio deteta o formato e adapta-se
  sozinho. Com 2 parâmetros, o campo "Semana/dia" tem de estar preenchido (validado antes de enviar).
- **Botão com link**: se o template tiver botão "Visit website" com URL dinâmico, o token pessoal é
  injetado automaticamente (basta ter a semana escolhida). A checkbox no diálogo só conta quando a
  inspeção do template não está disponível.
- **RECOMENDADO — definir `WHATSAPP_WABA_ID`** no Railway/Vercel com o id da conta WhatsApp Business
  (WhatsApp Manager → Definições da conta, ou Meta for Developers → WhatsApp → API Setup). É o que
  liga a inspeção automática de forma determinística. Sem ela o código tenta descobrir o id pelo
  token (`/debug_token`); se o token vir mais do que uma conta, a inspeção desliga-se e o envio segue
  às cegas (com a nota anexada a qualquer erro). O token precisa também da permissão
  **`whatsapp_business_management`** para poder LER templates.

## Como configurar o template no WhatsApp Manager (para o link do formulário)
1. Cria um template (categoria Utility/Marketing) com o texto do pedido de disponibilidade.
2. Adiciona um **botão "Visit website" com URL DINÂMICO**: URL = `{AVAILABILITY_FORM_URL}?token={{1}}` (o `{{1}}` TEM de ficar no fim). Ex.: `https://disponibilidade.multipark.pt?token={{1}}`.
3. Submete para aprovação. Quando APPROVED, mete o nome exato no dialog do broadcast (ExtrasDiaPage) e envia com um `weekStart` selecionado.
4. O backend injeta o token JWT single-use como valor de `{{1}}` (um por extra). A app externa lê `?token=` e chama `GET /api/v1/availability-form/context?token=` (X-API-Key + scope read) → mostra o formulário; no submit chama `POST /api/v1/availability-form/submit` (scope write). O token é consumido no 1º submit.
- Alternativa (sem botão URL): meter o link no corpo via um parâmetro de body — nesse caso configurar `{{N}}` no texto e passar o link completo como `templateParams`. O código atual usa o botão URL por defeito.

## RUNBOOK DE DEPLOY (migrações + envs por aplicar)
**Migrações (por ordem, NENHUMA aplicada ainda tanto quanto se sabe — todas manuais, fora do journal do drizzle-kit):**
- `drizzle/0045_whatsapp_integration.sql` — 3 tabelas WhatsApp (já inclui `whatsapp_broadcasts.invalidEmployeeIds`, emenda in-place da Fase 3 aceite por a 0045 nunca ter sido aplicada).
- `drizzle/0047_availability_form_tokens.sql` — tabela dos tokens do formulário.
- (Aplicar via o mecanismo manual da casa — `mysql < ficheiro` ou runbook equivalente; NÃO há auto-migração no boot.)

**Envs novas a definir no Railway/Vercel:**
- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (obrigatórias p/ envio+webhook), `WHATSAPP_API_VERSION` (opcional, default v21.0).
- `AVAILABILITY_FORM_TOKEN_SECRET` (obrigatória p/ Fase 4, ≥32 chars, distinta de JWT_SECRET), `AVAILABILITY_FORM_URL` (opcional).
- Config na Meta: webhook apontado a `POST/GET /api/whatsapp/webhook` com o `WHATSAPP_VERIFY_TOKEN`; criar templates APPROVED (incl. o do link, ver secção acima).
- Verificar tudo via `GET /api/health` (booleanos de presença).

## PENDENTES CONSOLIDADOS (pós-Fase 4)
- ~~**Validar a contagem de parâmetros ANTES de enviar**~~ — **FEITO em 2026-08-04(b)**
  (`server/whatsappTemplateMeta.ts`): lê o template, valida contagem/língua/estado e deteta o botão
  URL. Falta só definir `WHATSAPP_WABA_ID` em produção para ser determinístico.
- ~~**Template sem parâmetros deixou de ser suportado**~~ — **RESOLVIDO em 2026-08-04(b)**: com
  metadados, um template de 0 parâmetros já não leva componente de body.
- **Paginação dos templates** (2026-08-04b): o `GET …/message_templates?name=` pede `limit=50` e
  ignora `paging.next`. Com 50+ traduções do MESMO nome (irrealista) alguma escaparia.
- **Cache de 5 min**: alterar o template no WhatsApp Manager só é visto pelo envio até 5 min depois
  (por processo). Aceitável; se incomodar, expor um botão "recarregar template" que limpe a cache
  (`__clearTemplateMetaCache`).
- **UI "extras com número inválido"**: parcialmente resolvido em 2026-07-31 — a tabela distingue "sem número" de "número não reconhecido" e mostra o valor em bruto no tooltip (ver `identity-by-email.md`). Falta a correção em massa a partir de `whatsapp_broadcasts.invalidEmployeeIds`.
- **Número de produção Meta**: enquanto for número de teste, entrega só a ~250 destinos verificados/24h; broadcast em escala fica por validar (Fase 2 em modo dev).
- **Media no inbox** (Fase 3 adiado): mensagens não-texto guardam `[imagem]`/caption; falta download/preview (fetch autenticado à Graph + storage).
- **UI "extras com número inválido"**: `whatsapp_broadcasts.invalidEmployeeIds` já guarda os dados (Decisão 2); falta a UI para os corrigir de uma vez.
- **Migrações por aplicar**: 0045 + 0047 (ver runbook).
- **Cron de limpeza** de `availability_form_tokens` expirados (não crítico).
- **API keys em plaintext** e `UPDATE lastUsedAt` por request (dívida pré-existente do mcpApi/externalApi, não introduzida aqui).
