# Auditoria — PDAs, Zello e Atividade do Dia

*27 set 2026 · análise de código (só leitura, sem dados de produção) sobre `origin/main`.*

Âmbito: registo/emparelhamento de PDAs (`/pda/registar`, QR, `pda_checkins`), ligação aparelho↔pessoa,
login/logout, integração Zello (API, recolha GPS diária, velocidades, alertas), Atividade do Dia
(`/operacional`), Avaliação → separador "Dia" (movimentos ao vivo da BD Multipark), ligação
agente Multipark↔colaborador, ponto e exclusões de administradores.

Contexto do teste do dono (hoje): registou o próprio telemóvel como PDA lendo o QR com o próprio
telemóvel, conduziu, fez login/logout, tirou a conta partilhada do Gil — e **nenhuma velocidade
dele ficou registada/assinalada** e **nenhum dos seus movimentos Multipark do dia foi contado**.

---

## Resumo (para quem não vai ler tudo)

| # | Causa | Efeito no teste | Certeza |
|---|---|---|---|
| B1 | SQL cru usa a coluna `checkinStatus`, mas a coluna real é `checkin_status` (9 sítios em `server/db.ts`) | O login no PDA **nunca** cria a ligação aparelho→pessoa; o logout nunca a fecha; o mapa ao vivo não resolve ninguém | Alta (o ORM e o SQL cru contradizem-se — um dos dois falha sempre; os ecrãs do ORM funcionam) |
| B2 | Desde o PR #141 (hoje, `e8eab2e`) `multipark_booking_history` deixou de ser alimentada, mas `/operacional` ainda conta as ações a partir dela | **Zero** movimentos de hoje na Atividade do Dia, para toda a gente | Certa |
| B3 | Não há monitorização de velocidade ao vivo: `speedMonitoring.checkNow`, `gpsAlerts.checkNow` e `speedAlerts.create` não têm quem os chame (nem UI nem cron) | Nenhum excesso é gravado nem avisado durante o dia | Certa |
| B4 | O GPS só é recolhido às 23:15–23:55 (provisório) e em D-2 (final) | Durante o dia não há km/velocidades na Atividade | Certa (por desenho) |
| B5 | Utilizadores **admin no Zello** são excluídos da recolha GPS, dos alertas "GPS desligado" e da lista "por ligar" | Se a conta Zello do dono é admin, o GPS dele nunca é recolhido | Certa no código; confirmar a flag da conta dele |
| B6 | A Avaliação → "Dia" só mostra quem está na **escala** (extras-dia) | O dono (fora da escala) não aparece, com ou sem movimentos | Certa |
| B7 | O motor da avaliação só conta velocidade a partir de `speed_alerts` (que ninguém cria) | Velocidade nunca pesa na avaliação | Certa |
| B8 | O emparelhamento é "ao contrário": o QR colado no PDA regista **o browser que o lê** como sendo esse PDA; a pessoa é quem estiver com sessão aberta nesse browser | Qualquer pessoa com sessão (até uma conta partilhada) "fica" com o PDA; um condutor pode registar o próprio telemóvel como PDA X e roubar o registo ao PDA verdadeiro | Certa |
| B9 | O catálogo de agentes e as ligações automáticas (id do agente pelo nome, "Agentes por ligar", varrimento de identidade) leem o histórico local congelado | Agentes novos deixam de ser ligados/propostos; `agentIdForName` devolve `null` | Certa |

---

## (a) Como funciona hoje — passo a passo

### a.1 Modelo de dados

- `pdas` (`drizzle/schema.ts:1575-1597`): `name`, `zelloUsername` (o utilizador Zello instalado no aparelho,
  migração 0058), `deviceToken` (token guardado no `localStorage` do browser do aparelho), `qrCode`
  (segredo fixo do QR, migração 0079), `status`.
- `pda_checkins` (`drizzle/schema.ts:1558-1573`): `pdaId`, `employeeId`, `zelloUsername`, `checkinAt`,
  `checkoutAt`, **`checkinStatus` → coluna SQL `checkin_status`** (`mysqlEnum("checkin_status", …)`,
  criada em `drizzle/0021_lovely_madame_masque.sql:55`). É, na prática, a tabela "aparelho X com pessoa Y
  de…até".
- `employees.zelloUsername` (ligação fixa Zello→pessoa, para telemóveis pessoais) e
  `employees.multiparkAgentName` / `multiparkAgentUserId` (ligação agente Multipark→pessoa) + agentes extra
  (`employee_agents`, `server/employeeAliases.ts`).
- `daily_driver_history` (1 linha por utilizador Zello e dia) + `driver_day_shares` (a linha partida por
  quem tinha o PDA em cada minuto).
- `speed_violations` (por `zelloUsername`, sem pessoa), `speed_alerts` (por `employeeId`), `gps_alerts`.
- `time_records` (ponto), com o resumo Zello do turno no check-out (`zelloKm`, `zelloMaxSpeed`, …).

### a.2 Registo do aparelho (QR "colado no PDA")

1. Chefia abre `/operacional` → PDAs → botão QR (`client/src/pages/OperationalPage.tsx:912-916`) →
   `operational.pdas.qrLink` gera (uma vez) o segredo `pdas.qrCode` e devolve
   `/pda/registar?pda=ID&c=CÓDIGO` (`server/routers.ts:4395-4401`, `server/db.ts:5984-5994`). Imprime-se e
   cola-se no aparelho. O código **nunca expira nem roda**.
2. Quem **lê o QR com o browser de um aparelho** abre `PdaRegisterPage`
   (`client/src/pages/PdaRegisterPage.tsx:16-43`). Sem sessão, guarda o QR e manda para o login
   (`:34-38`); com sessão chama `operational.pdas.registerByQr` (`:41`).
3. `registerByQr` (`server/routers.ts:4404-4413`) exige `pdas:edit` **com `allowOwn: true`** — e `extra` e
   `condutor` têm `pdas: own:ve` (`shared/access.ts:164-168`). Ou seja, **qualquer condutor/extra** pode
   registar o aparelho que tem na mão como sendo o PDA do QR (o comentário diz "Só chefias", o código não).
4. `setPdaDeviceToken` gera um token novo e **substitui** o anterior (`server/db.ts:6014-6019`): o
   aparelho que tinha o registo perde-o sem aviso. O token vai para o `localStorage` do browser
   (`client/src/lib/pdaDevice.ts:12-14`) — noutro browser, em modo privado ou limpando dados, perde-se.
5. Alternativa "sem QR": escolher o PDA numa lista no próprio browser (`OperationalPage.tsx:763-779`,
   `operational.pdas.registerDevice` em `server/routers.ts:4385-4392`).

### a.3 Ligação aparelho→pessoa (login, ponto, manual)

- **No login**: `DashboardLayout` monta `PdaDeviceBinder` (`client/src/components/DashboardLayout.tsx:540`).
  Se o browser tem token e ainda não reclamou para este utilizador nesta sessão, chama
  `operational.pdas.claimOnLogin` (`client/src/components/PdaDeviceBinder.tsx:23-36`). Em erro limpa a marca
  e **não mostra nada** (`:34`). No servidor, `claimOnLogin` resolve a ficha do utilizador e chama
  `attachPdaByDeviceToken` (`server/routers.ts:4416-4426`), que fecha o check-in de quem lá estava, fecha os
  check-ins da pessoa noutros PDAs e cria um `pda_checkins` novo (`server/db.ts:5941-5970`).
- **No ponto (check-in)**: `HRPage` envia `pdaDeviceToken` do `localStorage`
  (`client/src/pages/HRPage.tsx:767`) e o servidor chama o mesmo `attachPdaByDeviceToken` dentro de um
  `try/catch` que só faz `console.warn` (`server/routers.ts:3357-3371`).
- **No logout**: `useAuth.logout` chama `releaseOnLogout` antes de sair (`client/src/_core/hooks/useAuth.ts:31-35`)
  → `releasePdaByDeviceToken` (`server/db.ts:5973-5981`). Erros são engolidos.
- **No ponto (check-out)**: `closePdaCheckinsForEmployee` (`server/routers.ts:3473-3480`,
  `server/db.ts:6005-6011`), também com `try/catch` silencioso.
- **Manual (recurso)**: diálogo "Check-in manual" com foto obrigatória (`server/routers.ts:4511-4542`) — é o
  único caminho que usa o ORM (`createPdaCheckin`) e por isso funciona.
- **Perfil**: `operational.pdas.mine` mostra "PDA: X desde…" (`server/routers.ts:4367-4381`; usa
  `checkin_status`, correto).

Nota: não há expiração da ligação (só termina no logout, no check-out do ponto ou quando outra pessoa
entra); uma conta partilhada com sessão aberta no aparelho fica "dona" do PDA indefinidamente.

### a.4 Zello → GPS, km, velocidades

- API (`server/zello.ts`): `getZelloUsers` (`:132-147`, com a flag `admin` do Zello), `getZelloLocations`
  (`:162-185`, posição atual com `lastReport`), `getZelloUserHistory` (`:187-201`, GeoJSON em km/h).
- **Ao vivo** (`client/src/components/ZelloLiveTab.tsx`): mapa com `locations` a cada 30 s e `mappings`
  (`getZelloLiveMappings`, `server/db.ts:990-1011`). Aviso de velocidade **só visual, no browser de quem
  tiver o separador aberto**, com limite fixo `SPEED_ALERT_KMH = 130` (`:15`, `:31`, `:74`). Nada é gravado.
- **Recolha diária** (`server/jobs/dailyDriverCollection.ts`): passagem provisória do dia de hoje às
  23:15–23:55 (`server/cronSchedule.ts:55`, `:83`) e final em D-2 às ~04:30 (`server/cronJobs.ts:296-314`).
  Para cada utilizador Zello **não admin** (`:357`): métricas do dia (`processGeoJsonHistory`), excessos
  (`countSpeedViolations`), GeoJSON no S3, `employeeId` = quem teve o PDA mais tempo
  (`resolveZelloHoldersForDay`, `server/db.ts:5740-5761`), e partes por pessoa
  (`pdaIntervalsForDay` + `splitByHolder`, `server/db.ts:5707-5727`, `server/zelloGps.ts:112-160`).
  Os excessos ficam só como contagem na linha/partes — **não** criam `speed_violations` nem `speed_alerts`.
- **Check-out do ponto**: resumo Zello do turno (`summarizeZelloShift`) com o utilizador Zello resolvido
  por `resolveZelloUsernameForShift` (PDA do turno, senão Zello fixo da ficha) (`server/routers.ts:3434-3447`,
  `server/db.ts:968-984`). É o único momento em que há km/velocidade "do próprio dia" antes da recolha.
- **Velocidade "oficial"**: `speedMonitoring.checkNow` (`server/routers.ts:4252-4289`) e
  `gpsAlerts.checkNow` (`:4581-4629`, que também salta admins em `:4586`) existem mas **ninguém os chama**
  (sem botão, sem cron). `speedAlerts.create` (`:4040-4069`) idem.

### a.5 Atividade do Dia (`/operacional`, separador "Atividade do Dia")

`OperationalPage.tsx:96` → `multipark.dayActivity` (`server/routers.ts:7013-7029`) → `getActivityRange`
(`server/dayActivity.ts:98-358`):

1. Escala extras-dia do intervalo (custo e janelas de turno) (`:138-183`).
2. **Ações nas reservas: lidas de `multipark_booking_history` (cópia local)** (`:186-213`), atribuídas com
   `buildIdentityResolver` (id do agente > agente extra > nome do agente na ficha > ignorado > parceiro)
   (`server/activityHelpers.ts:32-63`).
3. GPS: partes (`driver_day_shares`) + linhas do dia (`daily_driver_history`) (`:227-299`).
4. Ponto: horas + km provisórios do check-out para dias ainda sem recolha (`:302-323`).
5. PDAs usados (`:326-335`).

Gaveta de uma pessoa (`getPersonDay`, `:362-419`): ações também de `multipark_booking_history` (`:430-441`).

### a.6 Avaliação → "Dia"

`client/src/components/evaluation/DayEvaluationTab.tsx:74-77` → `multipark.dayEvaluation`
(`server/routers.ts:6844-6852`) → `evaluateDay` (`server/multiparkEvaluation.ts:117-...`):

- Parte da **escala do dia**; sem escala devolve vazio (`:118-121`). Só as linhas da escala viram cartões.
- Métricas do motor (`recomputeRange` → `server/evaluationEngine.ts:95-190`): movimentos **ao vivo** da BD
  Multipark (`getEngineLiveInputs`, `server/multiparkDb/movements.ts:223`), ponto, incidentes, e velocidade
  **só de `speed_alerts`** (`server/evaluationEngine.ts:133`, `server/evaluationCore.ts:469-487`).
- Lista de movimentos do cartão: `agentHistorySummary` por ids do agente ou, sem ids, pelo nome em
  `"Agent"` (`server/routers.ts:6878-6899`); dia **operacional** 03h→03h de Lisboa
  (`server/multiparkDb/movements.ts:56-63`, `shared/lisbonDay.ts:162-194`).
- Editar o nome do agente no cartão chama `setMultiparkAgentMapping` só com o **nome**
  (`DayEvaluationTab.tsx:296-302`; `server/routers.ts:6855-6872`): não mexe no `multiparkAgentUserId`, não
  garante unicidade e não fica no log.

### a.7 Ligação agente Multipark ↔ colaborador

- Manual: `mapAgentToEmployee` (`server/routers.ts:6903-6934`) — procura o id do agente com `agentIdForName`,
  que lê `multipark_booking_history` (`server/identityLink.ts:101-109`).
- Automática: `runIdentitySweep` (hora a hora) — completa ids e liga por email/nome a partir de
  `multipark_booking_history` (`server/identityLink.ts:~170-173`, `:191-194`).
- "Agentes por ligar" (RH): `unlinkedAgents` agrega `multipark_booking_history` (`server/routers.ts:7076-7125`).
- Ponto: no check-in só há um **aviso** se faltar `multiparkAgentName` (o id nem é verificado)
  (`server/routers.ts:3323-3327`).
- `multipark_agents` (catálogo, migração 0205) já não é alimentado nem lido.

---

## (b) Bugs e lacunas que explicam o teste

### B1 — Nome de coluna errado no SQL cru dos PDAs (a ligação login→PDA nunca acontece)

Evidência:
- Coluna real: `checkin_status` (`drizzle/0021_lovely_madame_masque.sql:55`; `drizzle/schema.ts:1570`
  `mysqlEnum("checkin_status", …)`). Nenhuma migração a renomeia.
- SQL cru com `checkinStatus` (MySQL não converte camelCase → snake_case): `server/db.ts:1001`, `:5951`,
  `:5956`, `:5960`, `:5977`, `:5979`, `:6008-6009`, `:6027`. Os ecrãs que usam o ORM
  (`getActiveCheckins`, `server/db.ts:6052`) e o SQL cru que usa `checkin_status`
  (`server/routers.ts:4377`, `server/shiftHandoverDraft.ts:329`) estão certos — por isso "Em uso" e o
  check-in manual funcionam, e o resto não.
- Os testes não apanham: `server/operational.test.ts` usa a BD simulada.

Efeito em cadeia:
- `attachPdaByDeviceToken` rebenta na 2.ª query → `claimOnLogin` falha; o `PdaDeviceBinder` engole o erro
  (`PdaDeviceBinder.tsx:34`) e **não aparece nenhum aviso**. Também o ponto→PDA no check-in
  (`routers.ts:3368-3370`, só `console.warn`).
- `releasePdaByDeviceToken` e `closePdaCheckinsForEmployee` falham em silêncio → check-ins manuais nunca
  fecham por logout/ponto.
- `getZelloLiveMappings` rebenta → o mapa ao vivo não resolve Zello→pessoa; `getPdaByDeviceToken` rebenta
  → o cartão "Este aparelho" não mostra o PDA.
- Sem `pda_checkins`, `pdaIntervalsForDay`/`resolveZelloHoldersForDay` não têm intervalos → o GPS do
  aparelho do dono fica sem pessoa ("— sem login no PDA") ou com o Zello fixo da ficha, se existir.

**Explica**: "fiz login/logout e nada ficou ligado a mim".

### B2 — A Atividade do Dia conta ações de uma tabela que deixou de ser alimentada

Evidência: o PR #141 (`e8eab2e`, hoje 16:17) retirou a cópia do histórico
(`server/jobs/multiparkBookingSync.ts:1-10`: "multipark_booking_history fica só com o que já lá estava";
`server/cronJobs.ts:45-47`). `getActivityRange` continua a ler `multipark_booking_history`
(`server/dayActivity.ts:186-190`) e a gaveta também (`:430-441`). A Avaliação passou para leitura ao vivo,
a Atividade do Dia não.

**Explica**: "nenhum dos meus movimentos do dia foi contado" em `/operacional` — nem os de ninguém a partir
de hoje. Afeta também `agentIdForName`, `unlinkedAgents`, o varrimento de identidade (B9), e tudo o que
ainda lê essa tabela (`server/db.ts:2912`, `:6281-6577`, `complaintsExtended.ts:75`, `complaintDossier.ts:354`,
`shiftHandoverDraft.ts`).

### B3 — Nenhuma velocidade é gravada ou avisada durante o dia

- `speedMonitoring.checkNow` e `gpsAlerts.checkNow` não têm chamadores (procurado em `client/src` e no
  agendador `server/cronSchedule.ts` / `server/cronScheduler.ts`). `speedAlerts.create` também não.
- O aviso do mapa ao vivo é só cor/etiqueta no browser (`ZelloLiveTab.tsx:31`, `:74`), com 130 km/h fixos
  (o limite configurado em Definições é ignorado aqui), e só se alguém estiver a olhar.
- Mesmo quando `checkNow` corresse, grava por `zelloUsername` sem pessoa (`routers.ts:4264-4275`) e avisa
  "quem vê todas" as cidades.

**Explica**: "em nenhum momento a minha velocidade foi registada/assinalada".

### B4 — GPS só existe depois das 23:15 (e o definitivo em D-2)

`passForDay`/`collectDailyDriverData` (`dailyDriverCollection.ts:316-320`, `:342-349`); a Atividade marca o
dia como `gpsMissingDays` e só usa os km do check-out do ponto (`dayActivity.ts:302-323`). Se o dono não
fez check-out do ponto, não há nada; se fez, o resumo usa o Zello resolvido por `pda_checkins` (B1) ou o
fixo da ficha.

### B5 — Contas admin do Zello são excluídas

- Recolha: `users.filter(u => !u.admin)` (`dailyDriverCollection.ts:357`, e o esperado em `:557`).
- Alertas GPS: `if (user.admin) continue` (`routers.ts:4586`).
- Mapa ao vivo: admins fora da lista "Zello por ligar" (`ZelloLiveTab.tsx:147`, `:201`).

A flag é a do **Zello** (`u.admin`, `server/zello.ts:142`), não o papel no dashboard. Não há nenhuma
exclusão por papel "admin" do dashboard na Atividade nem na Avaliação do dia (só o ranking de 4 semanas
filtra por cargo: `RANKING_POSITIONS = driver/senior_driver/extra`, `shared/evaluationRules.ts:59`,
`server/evaluationEngine.ts:335-337`). **Se a conta Zello usada no telemóvel do dono é admin na consola
Zello (provável para o dono), o GPS dele nunca é recolhido**, esteja ou não ligado a ele.

### B6 — A Avaliação "Dia" só mostra quem está na escala

`evaluateDay` parte de `listAssignments(date)` e devolve vazio sem escala
(`server/multiparkEvaluation.ts:118-121`); as pessoas são as linhas da escala (`:152-219`). Movimentos de
alguém fora da escala ficam no motor (`employee_day_metrics`), mas não aparecem neste separador.
**Explica** porque o dono não se vê no "Dia", mesmo com o agente ligado.

Pontos a confirmar no caso concreto (sem ler dados, a verificar pelo dono):
- a ficha dele tem `multiparkAgentUserId` igual ao `History.userId` das ações de hoje? (o resolvedor usa o
  id primeiro; se o id estiver errado e o nome certo, o nome só é usado quando o id não existe no mapa —
  `activityHelpers.ts:56`);
- o `agentName` no `History` pode vir vazio — o motor usa `COALESCE(History.agentName, Agent.name)` com
  `Agent` na mesma `parkId` (`movements.ts:120-125`); um agente sem `Agent` nesse parque fica só com o id;
- fuso: a BD Multipark é tratada como UTC sem fuso (`movements.ts:30`, `:56`); se as datas vierem em hora
  de Lisboa, há desvio de 1 h (no verão) — ações perto das 03:00 caem no dia operacional errado. Validar com
  `server/multiparkDb/probe.ts`;
- dia **operacional** (03h→03h) na Avaliação vs dia **civil** na Atividade do Dia — os números não batem
  entre ecrãs perto da meia-noite.

### B7 — A velocidade nunca entra na avaliação

O motor lê só `speed_alerts` com `employeeId` (`evaluationEngine.ts:133`, `evaluationCore.ts:469-487`) e
penalizações RH "speeding". Nada cria `speed_alerts` (B3), e os excessos da recolha (`speedViolations` nas
linhas/partes) não são usados.

### B8 — Emparelhamento "ao contrário" e sem controlo

- O QR identifica o **PDA**; o aparelho que o lê passa a ser esse PDA; a **pessoa** é quem tiver sessão
  aberta nesse browser — daí "alguém põe e diz que é ele" (`PdaRegisterPage.tsx`, `routers.ts:4404-4426`).
- Condutores/extras podem registar (`allowOwn` + `pdas: own:ve`); o segredo do QR é fixo e está à vista
  (basta uma foto); re-registar rouba o token ao aparelho verdadeiro sem aviso (`db.ts:6014-6019`).
- O token vive no `localStorage` do browser, não no aparelho (outro browser/modo privado = aparelho
  "desconhecido"; limpar dados = perde o registo).
- Não se confirma que o Zello instalado no aparelho é o `pdas.zelloUsername` configurado; nem que o Zello
  está ligado.
- Contas partilhadas: `claimOnLogin` corre uma vez por sessão do browser (`pdaDevice.ts:15-24`); uma conta
  partilhada com sessão aberta fica com o PDA sem fim; nada expira a ligação.
- Emparelhar um telemóvel pessoal "como PDA" funciona, mas o GPS continua a vir do utilizador Zello
  **configurado no PDA**, não do Zello que está de facto no telemóvel.

### B9 — Ligação de agentes presa ao histórico congelado

`agentIdForName` (`identityLink.ts:101-109`), varrimento (`identityLink.ts:~170-194`) e `unlinkedAgents`
(`routers.ts:7082-7093`) usam `multipark_booking_history`. Depois de hoje, agentes novos nunca aparecem em
"Agentes por ligar" e ligar pelo nome grava `multiparkAgentUserId = NULL` → a atribuição fica só pelo
nome (frágil a acentos, alcunhas e homónimos).

### Outras lacunas encontradas

- L1 — `setMultiparkAgentMapping` (`routers.ts:6855-6872`) grava só o nome (o separador "Dia" nunca envia
  o id), não limpa o mesmo agente noutra ficha e não regista em log.
- L2 — O aviso de "sem agente" no ponto só olha para o **nome** (`routers.ts:3325`) e não bloqueia nem
  avisa a chefia.
- L3 — Os `try/catch` silenciosos (ponto→PDA, fecho no check-out, `claimOnLogin`, `releaseOnLogout`)
  esconderam B1 durante semanas: a primeira linha do código Fase 2/ponto→PDA com `checkinStatus` já estava no
  primeiro commit (`752dbc5`, 6 ago).
- L4 — `pdaScope` (`server/cityScope.ts:88-92`) define a cidade de um PDA por quem lá fez check-in: um PDA
  novo (sem check-ins, e com B1 nunca os terá) é invisível para chefias de cidade.
- L5 — `pdaIntervalsForDay` usa `pda_checkins.zelloUsername` (cópia no momento do check-in), enquanto
  `resolveZelloUsernameForShift` usa `COALESCE(pdas.zelloUsername, …)`: mudar o Zello de um PDA a meio do dia
  dá resultados diferentes nos dois caminhos.
- L6 — `getZelloLocations` pede `max: 100` (`zello.ts:164`): com mais de 100 utilizadores com posição, há
  cortes.

---

## (c) Proposta

### c.1 Regras (do dono) traduzidas

1. **Guardamos "este aparelho pertence a esta pessoa neste período"** (atribuição aparelho→pessoa com
   início/fim). Enquanto atribuído, velocidades e trajetos desse aparelho (o seu utilizador Zello) são da
   responsabilidade dessa pessoa.
2. **Sem Zello, a app não trabalha**: para começar (atribuição/ponto) o Zello do aparelho tem de estar a
   reportar; se deixar de reportar X minutos com a app aberta/atribuída → alerta (TL/supervisor/quem
   estiver configurado) e bloqueio na app.
3. **Quem começa a trabalhar sem agente Multipark ligado está errado** → sinalizar (e, para extras/condutores,
   não deixar começar).

### c.2 Modelo de dados

Evoluir `pda_checkins` para atribuições de aparelho (é já, na prática, isso) em vez de criar tudo de novo:

- `pdas` → "aparelhos": + `kind` (`pda` | `telemovel_pessoal`), `ownerEmployeeId` (telemóvel pessoal:
  atribuição permanente), `deviceTokenHash` (em vez do token em claro), `tokenIssuedAt`,
  `lastSeenAt`. `zelloUsername` obrigatório para `status='active'`.
- `pda_checkins` → `device_assignments` (renomear ou vista): `deviceId`, `employeeId` (obrigatório),
  `startAt`, `endAt`, `source` (`dashboard` | `qr_pessoa` | `login_aparelho` | `ponto` | `manual`),
  `assignedById`, `endedById`, `endReason` (`logout` | `ponto_saida` | `substituido` | `expirado` |
  `manual`), `zelloUsername` (cópia). Uma só atribuição aberta por aparelho e por pessoa: coluna gerada
  `openDevice = IF(endAt IS NULL, deviceId, NULL)` com índice único (idem para `employeeId`).
- `device_enrollment_codes`: códigos de registo de aparelho de uso único, 10 min, criados no dashboard.
- `zello_presence`: `zelloUsername`, `lastReportAt`, `status`, `speed`, `lat`, `lon`, `battery`,
  `updatedAt` (1 linha por utilizador, atualizada pelo monitor).
- `speed_violations`: + `employeeId`, `deviceId`, `assignmentId` (atribuídos no momento).
- `gps_alerts`: + `employeeId`, `deviceId`, novos tipos `zello_silencioso`, `sem_atribuicao`,
  `sem_agente`.
- Definições (`app_settings`): `zello.silenceMinutes` (ex. 10), `zello.excludedUsers` (lista explícita,
  substitui a flag admin), destinatários via `notificationRouting` (novos kinds `zello_silent`,
  `missing_agent`, `speed_alert` já existe).

### c.3 Fluxo de emparelhamento

- **Registar um aparelho (uma vez, chefia)**: no dashboard, "Aparelhos → Registar" mostra um **QR/código de
  uso único** (10 min). O aparelho abre `/pda/registar` e lê/introduz o código → recebe o token (guardado
  com hash). O autocolante com segredo fixo deixa de servir para registar (passa a ser só etiqueta com o
  nome/ID do aparelho). Só `team_leader+` (tirar o `allowOwn` de `registerByQr`/`registerDevice`).
- **Atribuir a uma pessoa (cada turno)** — o sentido pedido, aparelho→pessoa, por um de dois caminhos:
  - A) **TL/admin atribui no dashboard** (lista de aparelhos × pessoas da escala do turno). Caminho
    principal.
  - B) **O aparelho mostra um QR rotativo** (ID + nonce assinado, 60 s) no ecrã inicial; a **pessoa lê-o
    com o próprio telemóvel, com a sua própria conta** → cria a atribuição. Prova presença física e
    identidade sem partilhar sessões no aparelho.
  - O login no aparelho deixa de "reclamar" o aparelho: no modo aparelho (browser com token) a app mostra
    "Este aparelho está com X desde HH:MM"; se a conta com sessão não for a pessoa atribuída → bloqueia
    ("pede ao TL para te atribuir"). Acaba o problema das contas partilhadas.
- **Fim**: ponto (saída), logout no aparelho, nova atribuição no mesmo aparelho (fecha a anterior com
  `substituido`), TL no dashboard, ou **expiração** (ex. 14 h → `expirado` + marcação para revisão).
- **Telemóveis pessoais**: `kind = telemovel_pessoal` + `ownerEmployeeId` → atribuição permanente
  (substitui `employees.zelloUsername`, que fica só como migração).

### c.4 Zello: batimento, alerta e bloqueio

- **Monitor ao vivo** (novo trabalho do agendador, `interval` de 5 min — o mais curto em uso hoje é o
  `mail-sync`; se o `/api/cron/tick` for chamado mais vezes, 1–2 min): uma chamada `location/get` (paginada,
  resolve L6) → atualiza `zello_presence`.
  - **Velocidade**: acima do limite configurado → `speed_violations` com `employeeId` da atribuição aberta
    do aparelho desse Zello (+ `speed_alerts` para o motor da avaliação) e aviso `speed_alert` para a
    cidade da pessoa; deduplicação por pessoa/10 min. Resolve B3 e B7 sem esperar pela recolha noturna.
  - **Silêncio**: atribuição aberta cujo Zello tem `lastReportAt` > X min → `gps_alerts` `zello_silencioso`
    + aviso (TL/supervisor/quem estiver configurado), repetido com escalonamento (ex. X e 3X).
  - **Zello a reportar sem atribuição** (a andar, > 5 km/h) → `sem_atribuicao` (o carro anda e ninguém é
    responsável).
- **Bloqueio**: no modo aparelho, a app consulta `devices.myStatus` a cada 60 s; Zello em silêncio > X min
  → ecrã a toda a largura "Liga o Zello" que só deixa fazer o ponto de saída. Para **começar** (atribuição
  ou ponto de entrada) exige-se Zello com report < 2 min. Limite honesto: não conseguimos bloquear a app da
  Multipark nem o Zello em si — o bloqueio é na nossa app + alerta + o tempo sem GPS fica marcado na
  avaliação (penalização configurável).
- A recolha noturna mantém-se (km/trajeto definitivo), mas parte o GPS pelas `device_assignments`.

### c.5 Agente Multipark obrigatório

- No início (atribuição ou ponto de entrada): a ficha tem de ter `multiparkAgentUserId` **validado ao vivo**
  na BD Multipark (`"Agent"`/`"User"`). Sem ele: extras/condutores **não começam** (erro explicativo) e a
  chefia recebe `missing_agent`; restantes cargos passam com aviso + alerta.
- Durante/depois do turno: pessoa com atribuição/ponto e **0 movimentos** no `History` (lido ao vivo) →
  sinal "trabalhou sem movimentos — agente certo?" na Atividade e na Avaliação.
- Catálogo de agentes e ligações lidos **ao vivo** (resolver B9): `agentIdForName`, "Agentes por ligar" e
  o varrimento de identidade passam a ler `History`/`Agent` da BD Multipark (via `server/multiparkDb`).
- `setMultiparkAgentMapping` passa a gravar o id (escolha numa lista de agentes ao vivo), a garantir
  unicidade e a ficar no log (L1).

### c.6 Atribuição de GPS, velocidades, trajetos e movimentos

- **GPS/velocidade/trajeto**: ponto do Zello Z no instante t → aparelho com `zelloUsername = Z` → atribuição
  aberta em t → pessoa. Sem atribuição → balde "sem responsável" + alerta. Um só caminho
  (`device_assignments`) para ao vivo, recolha, ponto e Atividade (resolve L5).
- **Movimentos**: `History.userId` → ficha (id do agente + agentes extra); o nome só como recurso
  sinalizado. **A Atividade do Dia lê ao vivo** (mesma fonte da Avaliação), com a cópia local só como
  recurso com aviso (resolve B2).
- **Cruzamentos**: movimento de um agente sem atribuição/ponto nesse momento → sinal; pessoa com atribuição
  e sem movimentos → sinal.
- Alinhar a noção de dia: mostrar na Atividade o dia operacional (03h→03h) ou, no mínimo, indicar a
  diferença.

### c.7 Administradores

- Deixar de excluir pela flag `admin` do Zello (B5). Exclusão só por lista explícita em Definições
  (consolas de despacho, contas de teste), e **quem tem atribuição aberta é sempre monitorizado e recolhido**,
  seja qual for o papel.
- No dashboard, admins entram na Atividade e nos alertas como toda a gente; o ranking de 4 semanas pode
  continuar a filtrar por cargo, mas a Avaliação "Dia" mostra também quem trabalhou **fora da escala**
  (secção própria) — resolve B6.

### c.8 Plano em PRs pequenos

| PR | Conteúdo | Ficheiros principais | Esforço |
|---|---|---|---|
| 1 | **Corrigir B1**: `checkinStatus` → `checkin_status` nos 9 SQL crus; teste que falha se aparecer `checkinStatus` em SQL cru; mostrar erro do `claimOnLogin`/ponto→PDA ao utilizador e registar em log (L3) | `server/db.ts`, `client/src/components/PdaDeviceBinder.tsx`, `server/routers.ts`, teste novo | 0,5 d |
| 2 | **Corrigir B2**: Atividade do Dia e gaveta com ações ao vivo da BD Multipark (`getAgentMovementSummaries` com `byDay`, detalhe por ids), cópia local só como recurso com aviso | `server/dayActivity.ts`, `server/multiparkDb/movements.ts`, `client/src/pages/OperationalPage.tsx` | 1–1,5 d |
| 3 | **B9 + L1**: catálogo/ids de agentes ao vivo (`agentIdForName`, `unlinkedAgents`, varrimento); `setMultiparkAgentMapping` com id, unicidade e log | `server/identityLink.ts`, `server/routers.ts`, `DayEvaluationTab.tsx`, `server/multiparkDb/*` | 1–1,5 d |
| 4 | **B5**: tirar a exclusão pela flag admin do Zello; lista explícita em Definições; incluir sempre quem tem atribuição | `dailyDriverCollection.ts`, `routers.ts` (gpsAlerts), `ZelloLiveTab.tsx`, `shared/appSettings.ts` | 0,5 d |
| 5 | **Monitor Zello ao vivo** (B3, B7, L6): `zello_presence`, violações com pessoa, `speed_alerts` para o motor, avisos com deduplicação; remover os `checkNow` mortos; limite do mapa = limite configurado | migração nova, `server/cronSchedule.ts`, `server/cronScheduler.ts`, `server/cronJobs.ts`, `server/zello.ts`, `server/db.ts`, `ZelloLiveTab.tsx` | 2 d |
| 6 | **Atribuições aparelho→pessoa** (modelo c.2): migração de `pda_checkins` (source/endReason/assignedBy/índice único), registo de aparelho por código de uso único, só chefias, token com hash; atribuir/terminar no dashboard; expiração | migração, `server/db.ts`, `server/routers.ts`, `OperationalPage.tsx`, `PdaRegisterPage.tsx`, `lib/pdaDevice.ts`, `shared/access.ts`, `cityScope.ts` (L4) | 3 d |
| 7 | **Modo aparelho**: QR rotativo no aparelho lido pela pessoa com a sua conta; bloqueio de sessão ≠ pessoa atribuída; fim no logout/ponto | `PdaDeviceBinder.tsx`, `DashboardLayout.tsx`, `useAuth.ts`, página nova no aparelho, `routers.ts` | 2 d |
| 8 | **Zello obrigatório**: silêncio > X min → alerta com escalonamento; `devices.myStatus` + ecrã de bloqueio; Zello a reportar exigido para começar (atribuição/ponto) | `cronJobs.ts`, `notify.ts`/`shared/notificationRouting.ts`, `DashboardLayout.tsx`, `routers.ts` (timeRecords.checkIn) | 1,5–2 d |
| 9 | **Agente obrigatório no início** + sinais "trabalhou sem movimentos" / "movimento sem atribuição" | `routers.ts` (checkIn/atribuição), `dayActivity.ts`, `multiparkEvaluation.ts`, `HRPage.tsx` | 1–1,5 d |
| 10 | **Avaliação "Dia"**: secção "fora da escala" (quem tem ponto/atribuição/movimentos sem linha na escala); GPS e partes por `device_assignments` na recolha (L5); nota sobre dia operacional vs civil | `multiparkEvaluation.ts`, `DayEvaluationTab.tsx`, `dailyDriverCollection.ts`, `server/db.ts` | 1–1,5 d |

Total aproximado: **14–17 dias**. Os PR 1, 2 e 4 (≈ 2,5 d) já resolvem o essencial do teste de hoje
(ligação no login, movimentos do dia, GPS de contas admin); o PR 5 dá as velocidades durante o dia.

### c.9 Verificações a fazer antes/depois (sem ler dados de produção aqui)

- `SHOW COLUMNS FROM pda_checkins` para confirmar `checkin_status` (B1) — pelo esquema e pelas migrações,
  é essa.
- Na consola Zello: a conta usada no telemóvel do dono tem "admin"? (B5)
- Na ficha do dono: `multiparkAgentUserId` preenchido e igual ao `userId` do `History` de hoje? (B6/B9)
- Correr `server/multiparkDb/probe.ts` para confirmar que `History.actionTime` está em UTC.
