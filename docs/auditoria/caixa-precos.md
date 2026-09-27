# Auditoria — preços, pagamentos e conferência de caixa

27 set 2026 · análise só de leitura do código (ramo `claude/caixa-auditoria`, a partir de `origin/main` e8eab2e).
Não foram lidos dados de produção. Referências: `docs/multipark-db/plano-duas-bd.md` (B2), `mapeamento.md` (§1–3) e `schema.md`.

> **Ver também [`caixa-furos.md`](caixa-furos.md)**: todos os sítios por onde o dinheiro pode fugir (não só o preço), o que
> se pode cruzar com o quê, as regras novas R12–R29, as prioridades e o caminho por fases, que continua os PR deste documento.

## O teste do dono

Pegou numa reserva que já tínhamos (pela API ou pelo webhook) e, no Multipark, tirou o preço, pôs um preço, voltou a tirá-lo e
deixou 30 € numa linha. O carro saiu com 0 €. O dashboard **não mostrou nada**: nem o outro preço, nem um alerta.

**Pedido:** no check-out há dois preços, o que era (o que guardámos na criação ou no check-in) e o que é. Têm de bater. Se não
batem, a reserva vai para uma área **"Correção de caixa"**, para quem confere a caixa perceber porque falta dinheiro. O mesmo
vale para uma mudança de método de pagamento. Ninguém pode mudar um valor numa aplicação sem a outra dar por isso.

---

## Resumo (TL;DR)

1. **A cópia financeira é só "o último valor".** Cada atualização reescreve `totalPrice`, `totalPaid`, `paymentMethod`,
   `discount`… em `multipark_bookings` com o que a API devolve nesse momento. Não se guarda o preço da criação nem o do check-in,
   e não fica histórico. Não há tabela de retratos de preço.
2. **Nenhum código compara preços para a caixa.** A página Caixa soma o `totalPaid` atual. O `multipark-db-diff` compara o
   nosso preço com o `bookingPrice` deles, mas corre **só à mão** (workflow manual), não grava nada e não aparece em nenhuma página.
   A ficha da reserva mostra "(na criação X €)" só a quem a abrir, e só se `originalBookingPrice > 0`.
3. **O webhook não garante nada.** O payload traz o `bookingPrice` e o `paymentMethod` do momento, mas é deitado fora de
   propósito. Uma edição feita só nas linhas (`BookingPricing`) pode nem mexer em `Booking.updatedAt` nem gerar `BOOKING_UPDATED`.
   Sem webhook, a rotação de 6 h em 6 h reescreve o valor sem avisar.
4. **A BD da Multipark tem tudo o que falta:** `originalBookingPrice`, linhas `BookingPricing`, pagamentos datados
   `BookingPricingPayment`, `History.modifiedFields` (antes → depois, com quem e quando), `ActivityEvent` (retrato antes e
   depois), `Notification` do tipo `PRICE_CHANGED` e as três validações de caixa com quem e quando. Já lemos tudo isto ao vivo e
   em modo só de leitura, reserva a reserva, na ficha (`server/multiparkDb/bookingFile.ts`). Falta fazê-lo **em lote e
   com regras**.

---

## (a) Como funciona hoje

### A.1 Entrada: webhook → fila → detalhe da API

| Passo | Onde | O que faz |
|---|---|---|
| Receção | `server/multiparkWebhook.ts:175-223` | Verifica HMAC/Bearer, faz `parseMultiparkWebhook` e grava em `multipark_webhook_jobs` antes do ACK (202). |
| Payload | `server/multiparkWebhook.ts:77-113` | `BOOKING_CREATED` / `BOOKING_UPDATED` / `BOOKING_CANCELLED` com `bookingPrice` e `paymentMethod` **do momento do evento**. |
| Fila | `server/bookingDeliveryQueue.ts:97-133`, cron `multipark-deliveries` de 15 em 15 min (`server/cronSchedule.ts:69`, `server/cronJobs.ts:48-83`) | Reclama um trabalho, processa e conclui, com backoff e dead-letter. |
| Processar | `server/multiparkWebhook.ts:136-161` | **Ignora o payload** (linhas 149-150: "Nenhum estado, preço ou matrícula do evento substitui dados mais recentes"). Vai buscar `/bookings/:id` à API e chama `enrichBookingsBatch`. |
| Gravar | `server/jobs/multiparkBookingSync.ts:243-300` (`applyBookingDetail`) + `server/bookingRefresh.ts:18-43` (`bookingDetailCore`) | `UPDATE multipark_bookings SET …` com `totalPrice = pricing.totalPrice ?? pricing.total ?? bookingPrice`, `parkingPrice`, `deliveryCharges`, `extrasTotal`, `discount`, `remainingToPay`, `totalPaid` e `paymentMethod`. **Reescreve.** |
| Limpeza | `server/cronJobs.ts:251` → `purgeCompletedDeliveries({ days: 30 })` | Apaga os trabalhos concluídos (com o payload) ao fim de 30 dias. |
| Rotação | `server/jobs/multiparkBookingSync.ts:360-365` | Sem webhook, volta a ler a reserva: de 6 em 6 h nas recentes (±7 dias) e semanalmente nas vivas. Também reescreve. |

As redes de segurança (sync de hora a hora, janela futura, reconciliação diária) saíram a 27 set (`plano-duas-bd.md` §C).
Hoje só resta o webhook e esta rotação.

### A.2 O que guardamos (`multipark_bookings`, `drizzle/schema.ts:1235-1333`)

| Temos | Não temos |
|---|---|
| `totalPrice`, `parkingPrice`, `deliveryCharges`, `extrasTotal`, `discount`, `remainingToPay`, `totalPaid`, `paymentMethod` (só o **valor atual**) | `originalBookingPrice`, `priceValidated`, `paymentSource`, `paymentBy`, `discountAmount`/`discountApplied` |
| `sourceUpdatedAt` (impede recuar para uma resposta mais antiga, `multiparkBookingSync.ts:291-296`) | Linhas de preço (`BookingPricing`) e pagamentos datados (`BookingPricingPayment`) |
| `cashValidatedByName`, `driverValidatedByName`, `cashierClosedByName` | Os booleanos de caixa, o `…At` e o `…ById`. **E os três nomes já não são atualizados:** `bookingToRecord` preenche-os (`:204-206`), mas `applyBookingDetail` só copia uma lista fechada de chaves (`:260`), onde eles não entram |
| `multipark_booking_extras` (serviços) | A remoção de linhas: `upsertBookingExtras` sai sem fazer nada quando a lista vem vazia (`server/db.ts:5049`), por isso extras retirados **ficam lá** |
| — | Retrato de preço na criação, no check-in e no check-out, ou histórico de alterações. **Não há tabela para isso.** `rawJson` também não é atualizado pelo detalhe (fica fora da lista de `:260`) |

### A.3 O que as páginas mostram

| Página | Fonte | Compara preços? |
|---|---|---|
| Faturação → **Caixa** (`client/src/pages/InvoicesPage.tsx:743-770`, `server/finance/cash.ts:48-98`) | `SUM(totalPaid)` das reservas entregues, por dia de saída e por `paymentMethod`, mais `remainingToPay` | **Não.** Só soma os valores atuais. Uma reserva a 0 € fica só "menos receita", sem aviso |
| Financeiro (`server/finance/engine.ts:318-348`) | `SUM(totalPrice)`, `parkingPrice`… atuais | Não |
| Ficha da reserva `/reserva/:id` (`client/src/pages/BookingFilePage.tsx:244-275`, `server/multiparkDb/bookingFile.ts`) | BD 2 ao vivo: preço, `originalBookingPrice`, linhas, pagamentos, faturas, histórico com antes → depois, `ActivityEvent` e as três validações | Só uma pista visual, "(na criação X €)", **quando alguém abre a ficha** e só se `originalBookingPrice > 0`. Não há lista, alerta nem registo |
| Passagem de turno (`server/multiparkDb/shiftState.ts:156-181`, `ShiftHandoverLiveState.tsx:141-196`) | BD 2 ao vivo | Conta o que falta fechar ou validar. Não compara valores |
| `multipark-db-diff` (`server/multiparkDb/diff.ts:167`, `server/_core/api-entry.ts:228`) | As duas BD, e o `bookingPrice` deles contra o nosso `totalPrice` | Sim, mas **só à mão** (`.github/workflows/multipark-db-schema.yml:18-19`, só `workflow_dispatch`). `gravado: false` (`diff.ts:343`): não fica guardado e não chega a nenhuma página |

Os alertas automáticos que existem são "webhook parado" (`server/syncHealth.ts:64`) e o estado da fila. **Nenhum é sobre dinheiro.**

---

## (b) Porque é que o teste não mostrou nada

Há dois caminhos possíveis, conforme o Multipark tenha ou não enviado `BOOKING_UPDATED`. Nos dois o resultado é o mesmo.

**Se houve webhook (uma ou várias entregas):**
1. Cada entrega entra na fila com o `bookingPrice` do momento (`multiparkWebhook.ts:86-87,110-111`).
2. O processamento ignora esse valor (`:149-150`) e lê o estado **atual** na API (`:145-147`).
3. `bookingDetailCore` escreve por cima de `totalPrice`, `totalPaid` e `paymentMethod` (`bookingRefresh.ts:30-41`), e o
   `applyBookingDetail` grava (`multiparkBookingSync.ts:293-296`). Os passos intermédios (sem preço → X → sem preço → 30) e o
   preço de origem **perdem-se**: fica só o último.
4. O payload ainda está em `multipark_webhook_jobs`, mas ninguém o lê e é apagado ao fim de 30 dias (`cronJobs.ts:251`).

**Se não houve webhook** (a edição foi só nas linhas `BookingPricing`/`BookingPricingPayment`; o próprio mapeamento avisa que
"alterações só em tabelas-filhas … podem não mexer" em `updatedAt`, `server/multiparkDb/queries.ts:116-117`):
1. A nossa cópia fica com o preço antigo até à rotação (6 h nas reservas recentes, `multiparkBookingSync.ts:364-365`).
2. A rotação reescreve o preço e ficamos no caso anterior. Não há diferença guardada nem alerta.

**E depois, em qualquer dos casos:**
- A página **Caixa** mostra o `totalPaid` atual (0 €) somado ao do dia. Não sabe que a reserva "valia" outra coisa (`cash.ts:69-73`).
- O **diff** compara o nosso preço com o deles. Depois da reescrita os dois são iguais, e além disso nunca corre sozinho (`diff.ts:167`, workflow manual).
- A **ficha** só avisa se alguém a abrir e se `originalBookingPrice > 0` e for diferente de `bookingPrice`
  (`BookingFilePage.tsx:244-245`). Não sabemos se o Multipark mexe no `originalBookingPrice` quando se tira e repõe o preço, nem se
  ele está a 0 nas reservas importadas (`schema.md`: `originalBookingPrice … não nulo, omissão 0`). Mesmo que aparecesse, é uma nota
  âmbar numa página, não um caso.
- **Não há área nenhuma** onde isto pudesse aparecer, nem código que compare o preço "de antes" com o "de agora", porque o "de
  antes" nunca foi guardado.

Conclusão: o sistema foi desenhado para ter o valor **mais recente**, não para **auditar** alterações. O teste não falhou por
avaria: essa função não existe.

> **Para confirmar o caminho exato** (só leitura, com autorização do Jorge ou do Rafael, sobre a reserva do teste): em
> `ConnectionDelivery` ver se houve `BOOKING_UPDATED` e em que estado ficou; em `History` ver as linhas `UPDATE` com
> `modifiedFields` sobre `bookingPrice`, `parkingPrice` e `paymentMethod`; e ver `ActivityEvent`, `Notification` com
> `PRICE_CHANGED`, `BookingPricing` e `BookingPricingPayment`. Do nosso lado, ver `multipark_webhook_jobs` pelo
> `bookingExternalId`. Isto diz se a edição gerou webhook e onde o Multipark regista uma edição feita só nas linhas.

---

## O que a BD da Multipark oferece para detetar (leitura ao vivo)

| Fonte | Para quê | Hoje lemos? |
|---|---|---|
| `Booking.originalBookingPrice` contra `bookingPrice` | Preço da criação contra o atual | Sim, na ficha (`bookingFile.ts:583`) |
| `Booking.parkingPrice`, `deliveryPrice`, `discountAmount`, `discountApplied`, `priceValidated`, `paymentMethod`, `paymentSource`, `paymentBy` | Decomposição e método | Na ficha |
| `BookingPricing` (linha: `category`, `total`, `amountPaid`, `paymentMethod`, `createdAt`/`updatedAt`) | Linhas retiradas, zeradas ou acrescentadas (ADJUSTMENT, DISCOUNT) | Na ficha (`bookingFile.ts:717`) e em somas (`dayBookings.ts:206`, `shiftState.ts:66`) |
| `BookingPricingPayment` (`amount`, `paymentMethod`, `recordedAt`) | O que foi pago, como e quando: é a verdade da caixa | Na ficha (`:720`) e em `pro.ts` |
| `History` com `changeType = UPDATE` e `modifiedFields` (`{campo:{from,to}}`), `agentName`/`userId`, `actionTime`, `platform`, `snapshot` | **Quem mudou, quando, de onde e de quanto para quanto** | Na ficha (`parseModifiedFields`, `bookingFile.ts:~300`) |
| `ActivityEvent` (`snapshot`/`previousSnapshot`, `actorDisplayName`, `actorRole`, `ip`) | Auditoria mais recente, útil se a edição das linhas não passar pela `History` | Na ficha (`:751`) |
| `Notification` com `type = PRICE_CHANGED` | Sinal nativo do Multipark de que o preço mudou | **Não** |
| `Booking.cashierClosed`/`cashValidated`/`driverValidated` com `At`, `ById` e `ByName` | Caixa fechada com ou sem divergência, e por quem | Na ficha e na passagem de turno |
| `Billing` (`amount`, `invoice`, `emited`) | Faturado ≠ pago ≠ esperado | Na ficha |
| `ConnectionDelivery` | Se o Multipark nos enviou (ou não) o evento | Só contagens no perfil (`profile.ts:200`) |

A ligação é **só de leitura** em três camadas (`server/multiparkDb/client.ts`) e existe na Vercel (`DATABASE_URL_MULTIPARK`).
Os índices que interessam existem em `Booking` (`parkId+updatedAt`, `parkId+status+checkOutDate`) e em `BookingPricing(bookingId)`.
**Faltam** `History(actionTime)` e `History(bookingId)`, já pedidos ao Rafael (`plano-duas-bd.md` §D). Sem eles, a varredura
da `History` tem de ser limitada às reservas de uma janela, pelo `bookingId IN (…)`, e nunca por tempo sobre a tabela inteira.

---

## (c) Proposta — "Correção de caixa"

### C.1 Dados a guardar (BD 1, só a cópia financeira de B2)

**`booking_price_snapshots`**: uma linha por retrato, **nunca atualizada, só acrescentada**.

| Coluna | Nota |
|---|---|
| `bookingExternalId`, `parkId`, `projectId` | |
| `moment` | `creation` · `checkin` · `checkout` · `change` · `webhook` · `sweep` |
| `source` | `webhook_payload` · `api_detail` · `bd2_live` · `history` |
| `bookingPrice`, `originalBookingPrice`, `parkingPrice`, `deliveryPrice`, `discountAmount`, `priceValidated` | |
| `linesTotal`, `linesPaid`, `linesJson` | `BookingPricing`: id, categoria, total e pago por linha |
| `paymentsTotal`, `paymentsJson` | `BookingPricingPayment`: valor, método e `recordedAt` |
| `paymentMethod`, `paymentSource`, `status` | |
| `sourceUpdatedAt`, `capturedAt`, `hash` | `hash` de (preço, linhas, pagamentos, método) para só gravar quando algo muda |

**`booking_price_changes`**: uma linha por alteração, com o antes → depois.
Colunas: `field`, `from`, `to`, `changedAt`, `changedBy` (agente), `platform` e `evidence` (`history:<id>` · `activity:<id>` ·
`snapshot_diff`). Vem da `History.modifiedFields` e do `ActivityEvent` da BD 2. Quando a BD 2 não explica a alteração, vem da
diferença entre dois retratos nossos, marcada "sem autor na Multipark", que é ela própria um sinal.

**`cash_cases`** (Correção de caixa):
`id`, `bookingExternalId`, `parkId`, `day` (dia de Lisboa da saída), `rules[]`, `expected`, `actual`, `paid`, `delta`,
`methodExpected`/`methodActual`, `state` (`aberto` · `em_análise` · `justificado` · `corrigido_na_multipark` · `perda_aceite`),
`severity`, `openedAt`, `lastSeenAt`, `closedAt`, `closedBy`, `explanation` (**obrigatória ao fechar**),
`attachmentUrl` (opcional).

**`cash_case_events`**: auditoria **só de acréscimo** (quem abriu, viu, comentou, mudou o estado ou reabriu, e quando).

**Momentos a retratar:**
1. **Criação**: o payload do `BOOKING_CREATED` (o `bookingPrice` do momento) mais a primeira leitura da BD 2.
2. **Check-in**: quando o estado passa a `CHECKED_IN` (webhook ou varredura), ou pelo `History.CHECK_IN.snapshot`.
3. **Check-out**: quando passa a `CHECKED_OUT` e depois do fecho de caixa (`cashierClosedAt`).
4. **Cada alteração**: cada webhook (guardar o payload em vez de o deitar fora) e cada diferença encontrada na varredura.

Para reservas antigas, o retrato da criação pode ser reconstruído a partir de `History` (`CREATED.snapshot`) e de
`originalBookingPrice` (só desde 2 mar 2026).

### C.2 Regras de deteção

| # | Regra | Condição | Gravidade |
|---|---|---|---|
| R1 | Preço mudou depois da criação | `bookingPrice(agora) ≠ retrato de criação` (ou `≠ originalBookingPrice`) | média |
| R2 | Preço mudou depois do check-in | `bookingPrice` ou `linesTotal` no check-out `≠` retrato do check-in | **alta** |
| R3 | Preço zerado | antes > 0 e agora = 0, ou linha PARKING/VALET a 0 | **alta** |
| R4 | Linhas retiradas | linha que existia no retrato anterior e já não existe, ou que baixou de valor; ou DISCOUNT/ADJUSTMENT novo depois do check-in | alta |
| R5 | Método de pagamento mudou | `paymentMethod` da reserva ou das linhas `≠` retrato anterior, sobretudo Online → Dinheiro ou → vazio | alta |
| R6 | Pago ≠ esperado | `SUM(BookingPricingPayment.amount) ≠ esperado` no check-out (esperado = retrato do check-in, mais os extras feitos) | **alta** |
| R7 | Só de um lado | a reserva está na caixa deles e não na nossa cópia, ou ao contrário (o `so_deles`/`so_nossa` do diff, no dia) | média |
| R8 | Caixa fechada com divergência | `cashierClosed = true` e há R1–R6 abertas, ou `cashValidated` sem `driverValidated` | **crítica** |
| R9 | Alteração sem rasto | dois retratos diferentes sem nenhuma `History`/`ActivityEvent` que explique a mudança | alta |
| R10 | Nossa cópia desatualizada | a BD 2 mudou (`updatedAt` ou linhas) e não nos chegou webhook há mais de 30 min | informativa (saúde) |
| R11 | Faturado ≠ pago | `Billing.amount ≠ pago` no check-out | média |

Tolerância de 0,01 €. Os parques de terceiros não abrem casos (`plano-duas-bd.md`, princípio), mas R7 e R10 servem de saúde.
Cada caso guarda **a explicação automática**: "Preço 45 € → 0 € por *Agente X* (PDA) às 14:02; linha Estacionamento retirada;
saiu às 14:10; pago 0 €; caixa fechada por *Y* às 20:00".

### C.3 Quem mudou e quando

Por ordem de prioridade:
1. `History` com `UPDATE`: `modifiedFields[campo].from/to`, `agentName`, `actionTime`, `platform`, `lat`/`lng`.
2. `ActivityEvent`: `previousSnapshot` → `snapshot`, `actorDisplayName`, `actorRole`, `ip`.
3. `Notification` com `PRICE_CHANGED`: a hora e o parque.
4. `BookingPricing.updatedAt` / `BookingPricingPayment.recordedAt`: dizem quando, mas não quem.
5. Sem nenhuma destas: "sem autor na Multipark", o que abre R9.

O agente liga-se ao funcionário pela ligação agente ↔ funcionário que já existe (`identityLink`), para aparecer o nome na nossa ficha.

### C.4 Ecrã de back office — Faturação → "Correção de caixa"

- **Fila por parque e dia** (parques nossos). Contadores por regra e estado, e uma coluna "a mais / a menos" em €.
- **Linha do caso:** reserva, matrícula (mascarada), dois preços lado a lado (**"era" / "é"**), pago, método antes → depois,
  a regra, quem mudou e quando, e o estado da caixa (condutor, dinheiro, fechada: quem e quando).
- **Detalhe:** a linha de tempo dos retratos (criação → check-in → alterações → check-out → caixa) e a lista `booking_price_changes`,
  com uma ligação à ficha `/reserva/:id` e "Ver na Multipark".
- **Fechar o caso exige uma explicação** (texto mínimo e motivo numa lista: desconto autorizado, erro de introdução corrigido,
  cortesia, pagamento noutro canal, perda). O estado "corrigido na Multipark" só se aceita se a varredura seguinte confirmar os valores.
- **Auditoria:** `cash_case_events`, só acrescentada e visível no caso. Um caso fechado **reabre sozinho** se o preço voltar a mudar.
- **Permissões:** vê quem tem acesso à Faturação e à cidade. Fecha só quem tem o papel de conferência de caixa (a acrescentar a `docs/permissoes.md`).
- **Na página Caixa:** um cartão "Por explicar: N casos / X €" que leva à fila, e o recebido do dia com a nota "inclui X € em casos abertos".

### C.5 Alertas

- **No momento:** R3, R6 e R8 em parques nossos, com notificação ao responsável da cidade e à conferência de caixa (pelos canais de
  `docs/notificacoes.md`), no máximo uma por caso.
- **Resumo diário** (08:00) por parque: casos abertos de ontem, em € e por regra.
- **Saúde:** R10 em quantidade (por exemplo, mais de 5 reservas com a cópia desatualizada numa hora) quer dizer que o webhook está a
  falhar para esse parque. Vai para Definições → Estado do sistema.

### C.6 Garantir que nenhuma alteração passa em silêncio

O webhook **não chega**: a edição das linhas pode não o disparar, e os payloads perdem-se. A garantia vem de uma **varredura ao vivo** independente:

1. **Varredura de caixa** (cron novo `cash-sweep`, de 10 em 10 min): na BD 2, só leitura, as reservas dos **parques nossos** com
   `updatedAt`, `BookingPricing.updatedAt`, `BookingPricingPayment.recordedAt` ou `History.actionTime` na última janela (15 min,
   com folga) **e** todas as ativas (BOOKED com entrada hoje, CHECKED_IN, MOVING, PENDING_CHECKOUT, CHECKING_OUT) e as que
   saíram nas últimas 48 h. Para cada uma: calcular o `hash` e, se for diferente do último retrato, gravar o retrato e as
   alterações e avaliar as regras. A leitura das filhas faz-se pelo `bookingId IN (…)` da janela, que usa os índices existentes.
2. **Fecho do dia** (cron diário, D-1 e D-2): repetir a varredura sobre todas as saídas do dia e todas as caixas fechadas, e
   correr R7 (só de um lado). Se não houver varredura desse dia, fica um alerta vermelho.
3. **Guardar o payload do webhook como retrato** (`source = webhook_payload`) antes de o descartar. É barato e dá o valor que o
   Multipark tinha quando notificou.
4. **Pontos de controlo:** retratos obrigatórios no check-in e no check-out. Se faltar um, a reserva vai para a fila com "sem retrato de check-in".
5. **Tornar o `multipark-db-diff` automático e com memória:** agendado (diário), só com o que diz respeito a dinheiro, e a gravar em
   `cash_cases` (R7/R10) em vez de apenas devolver JSON.
6. **Pedir ao Rafael:** confirmar se editar ou apagar `BookingPricing` gera `BOOKING_UPDATED` e `History`/`ActivityEvent`. Se
   não gerar, pedir que gere. Pedir também os índices `History(actionTime)` e `History(bookingId)` (já pedidos) e,
   idealmente, `BookingPricing(updatedAt)`.

Com 1 e 2, **uma alteração na BD 2 é vista em ≤ 10 min**, haja webhook ou não. Com 3 e 4 temos sempre o "era". Com R9 uma
alteração sem rasto também abre caso.

---

## PRs propostos (pequenos e por ordem)

| # | PR | Conteúdo | Esforço |
|---|---|---|---|
| 1 | **Parar de perder o "era"** | Migração `booking_price_snapshots` + `booking_price_changes`. No `processMultiparkWebhookEvent`, gravar o payload (`bookingPrice`, `paymentMethod`, `event`) como retrato antes de ler a API. No `applyBookingDetail`, gravar um retrato quando o `hash` muda e quando o estado passa a CHECKED_IN ou CHECKED_OUT. Testes puros do `hash` e da diferença | 1–1,5 d |
| 2 | **Leitura da BD 2 para caixa** (`server/multiparkDb/cashLive.ts`) | Consultas só de leitura e parametrizadas: reservas da janela ou ativas dos parques nossos, com as linhas, os pagamentos, a `History` (UPDATE com campos de preço ou método) e o `ActivityEvent` pelo `bookingId IN`. Mapeadores puros e testes | 1,5 d |
| 3 | **Motor de regras** (`server/finance/cashRules.ts`, puro) | R1–R11 a partir dos retratos e das alterações, a explicação automática em PT-PT e testes com casos como o do dono (preço → 0, linha retirada, método trocado, caixa fechada) | 1–1,5 d |
| 4 | **Cron `cash-sweep` + fecho do dia** | Agendador (`cronSchedule.ts`), janela e ativas de 10 em 10 min, D-1/D-2 diário, gravação de retratos e alterações, abertura, atualização e reabertura de `cash_cases`, e estado em Definições | 1,5 d |
| 5 | **Ecrã "Correção de caixa"** | Separador em Faturação: fila por parque e dia, detalhe com a linha de tempo, fecho com explicação obrigatória, `cash_case_events`, permissões e cartão na página Caixa | 2–3 d |
| 6 | **Alertas** | R3/R6/R8 no momento, resumo diário e saúde R10 pelos canais existentes | 0,5–1 d |
| 7 | **Pequenas correções na cópia atual** | Voltar a gravar `cashValidated`/`driverValidated`/`cashierClosed` (bool + At + ByName) e `originalBookingPrice`, `discountAmount`, `paymentSource` em `applyBookingDetail`. `upsertBookingExtras` passa a aceitar lista vazia (linhas retiradas). O `multipark-db-diff` passa a agendado e a gravar | 0,5–1 d |
| 8 | **Retratos de trás** (opcional) | Reconstruir os retratos de criação e check-in a partir de `History.snapshot` e `originalBookingPrice` desde 2 mar 2026, para os parques nossos | 1 d |

Os PR 9 a 15 (outros furos, contagem da caixa e gastos, cruzamentos externos) estão em [`caixa-furos.md`](caixa-furos.md) §6.

**Total:** cerca de 9–12 dias. Os PR 1 e 7 podem entrar já: deixam de se perder dados e não mudam nenhum ecrã.
Os PR 2 a 4 dão a deteção, o 5 e o 6 o ecrã e os alertas.

**Antes de começar (sem código):** a leitura de confirmação da reserva do teste (secção b), feita por quem tem autorização, e a
resposta do Rafael sobre os eventos gerados pelas edições de `BookingPricing`.
