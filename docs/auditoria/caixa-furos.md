# Onde o dinheiro pode fugir — furos de caixa

27 set 2026 · análise só de leitura do código (ramo `claude/caixa-auditoria`). **Não foram lidos dados de produção.**
Complementa [`caixa-precos.md`](caixa-precos.md) (o caso do preço mudado, as regras R1–R11 e os PR 1–8).
Referências: `docs/multipark-db/plano-duas-bd.md`, `mapeamento.md` e `schema.md`.

"BD 2" é a base de dados da Multipark (a referência). "BD 1" é a nossa (dashboard, com a cópia financeira `multipark_bookings`).

---

## Resumo numa página

**A pergunta do dono:** de que maneiras pode um valor mudar ou desaparecer sem darmos por isso?

**A resposta curta:** de muitas, e hoje **nenhuma dá alerta**. Encontrámos **30 furos**. Em quase todos a BD 2 guarda o
rasto (quem, quando, de quanto para quanto), mas **ninguém o lê em lote nem o compara**. Do nosso lado guardamos só o último
valor e reescrevemo-lo em cada atualização.

**O que mais preocupa (prioridade 1):**

| # | Furo | Porquê |
|---|---|---|
| F1–F3 | Preço mexido, zerado ou linhas apagadas depois do check-in | O caso do teste. Nada avisa |
| F5 | Método mudado (dinheiro → multibanco, online ou parceiro) | É a forma mais simples de ficar com dinheiro vivo |
| F20 | Condutor recebe dinheiro e ninguém valida a entrega | A validação é só um "sim/não", sem valor contado |
| F21 | A contagem do back office e os gastos pagos da caixa não estão em lado nenhum | Não se consegue fazer "recebido − gastos = contado" |
| F19 | Caixa fechada e depois reaberta ou alterada | Não guardamos o estado da caixa ao longo do tempo |
| F9 | Reserva cancelada ou reembolsada depois de paga ou entregue | A receita desse dia baixa sem aviso |
| F25 | Muita gente pode editar preço, método e caixa na Multipark | Não sabemos quem tem essas permissões |

**O que já temos a nosso favor:**
- A BD 2 tem histórico campo a campo (`History.modifiedFields`), auditoria antes/depois (`ActivityEvent`), linhas e
  pagamentos datados (`BookingPricing`, `BookingPricingPayment`), cancelamentos com reembolso (`Cancellation`), faturas
  (`Billing`) e as três validações de caixa com quem e quando.
- Já lemos a BD 2 em modo só de leitura. A ficha da reserva mostra quase tudo isto, **mas só a quem a abrir**.
- No dashboard ninguém consegue editar valores da cópia financeira pelo ecrã. A Faturação é só do super admin.

**Vamos por aqui (secção 6):**
- **Fase 0, esta semana, sem código:** perguntas ao Rafael (secção 7) e decisões do dono (secção 8). Medir quantas vezes
  cada furo acontece, com contagens só de leitura (Anexo A).
- **Fase 1, parar de perder dados (≈ 2–3 dias):** PR 1 e 7 de `caixa-precos.md`, mais o PR 9 (guardar também pro, parceiro,
  campanha, crédito, origem do pagamento e cada pagamento).
- **Fase 2, detetar (≈ 5–6 dias):** PR 2–4 com as regras R1–R11 e as novas R12–R28. Uma varredura de 10 em 10 minutos
  abre casos em "Correção de caixa". Mais o retrato das permissões dos agentes.
- **Fase 3, ver, fechar e contar (≈ 5–7 dias):** ecrã e alertas (PR 5–6) e a contagem da caixa com os gastos (PR 10).
- **Fase 4, cruzar com o exterior (≈ 4–6 dias):** InvoiceExpress, Stripe, banco e terminal multibanco, parceiros (PR 11–14).

**Precisa do Rafael:** eventos quando se editam linhas, pagamentos, extras e caixa; nunca apagar reservas sem rasto; utilizador
só de leitura e índices; campo de valor contado. **Precisa do dono:** quem fecha casos, a lista dos parques nossos, onde se
regista a contagem e os gastos da caixa, fecho de mês, chaves só de leitura da InvoiceExpress e da Stripe e quem pode mexer em
preços na Multipark.

---

## 1. Como ler as tabelas

- **Prob.** (probabilidade): **A** alta (acontece todas as semanas ou é fácil de fazer), **M** média, **B** baixa.
  É uma estimativa pelo desenho dos sistemas. O Anexo A diz como a medir.
- **Impacto:** **€€€** dinheiro que some sem rasto, **€€** valor errado mas recuperável, **€** confusão e horas perdidas.
- **Rasto na BD 2:** onde a Multipark guarda a prova.
- **Hoje?** **Não** = nada deteta. **Parcial** = aparece num ecrã, mas só se alguém for ver, ou só uma parte.
  Com o ficheiro e a linha do código.
- **Regra:** a verificação a acrescentar. R1–R11 estão em `caixa-precos.md` §C.2. R12–R28 são novas (secção 3).

---

## 2. Os furos, um a um

### A. Preço, linhas e descontos

| # | O que acontece | Prob. · Impacto | Rasto na BD 2 | Hoje? | Regra |
|---|---|---|---|---|---|
| F1 | Preço editado depois da criação ou do check-in | A · €€€ | `History` UPDATE com `bookingPrice` em `modifiedFields`; `ActivityEvent`; `Notification` PRICE_CHANGED; `originalBookingPrice` | **Não.** A cópia reescreve `totalPrice` (`server/bookingRefresh.ts:31-39`). Só a ficha mostra "(na criação X €)" (`BookingFilePage.tsx:244-245`) | R1, R2 |
| F2 | Preço posto a 0 | A · €€€ | Idem, e linha PARKING/VALET a 0 | **Não** | R3 |
| F3 | Linhas de preço apagadas ou baixadas | A · €€€ | `BookingPricing` (desaparece ou `total` baixa, `updatedAt`). **Não sabemos se gera `History` ou webhook** | **Não.** Não guardamos linhas (`caixa-precos.md` A.2) | R4, R9 |
| F4 | Desconto ou código de campanha aplicado tarde (depois do check-in ou na saída) | M · €€ | `History` com `campaignId`, `discountAmount`, `discountApplied`; linha DISCOUNT nova; `Campaign.currentUses` | **Não.** `campaignId` e `discount` são reescritos (`multiparkBookingSync.ts:285`, `bookingRefresh.ts:34`). A ficha mostra o desconto atual (`bookingFile.ts:586`) | R12 |

### B. Pagamento

| # | O que acontece | Prob. · Impacto | Rasto na BD 2 | Hoje? | Regra |
|---|---|---|---|---|---|
| F5 | Método mudado depois de receber (dinheiro → multibanco, transferência, online ou parceiro) | A · €€€ | `History` com `paymentMethod`/`paymentSource`/`paymentBy`; `BookingPricing.paymentMethod`; `BookingPricingPayment.paymentMethod` | **Não.** `paymentMethod` é reescrito (`bookingRefresh.ts:20-21,41`) | R5 |
| F6 | "Pago" marcado sem dinheiro (sobe `amountPaid` sem pagamento, ou ao contrário) | M · €€€ | `BookingPricing.amountPaid` contra `SUM(BookingPricingPayment.amount)` da linha | **Não** | R6 |
| F7 | Pagamento parcial: o carro sai com valor em dívida | A · €€ | `BookingPricing.amountPaid < total` no check-out | **Parcial.** "Por cobrar" soma `remainingToPay` (`server/finance/cash.ts:74-75`), sem alerta nem seguimento | R6 |
| F8 | Pagamento dividido por vários métodos (parte online, parte dinheiro) | A · € | Vários `BookingPricingPayment` com métodos diferentes | **Não.** A Caixa atribui tudo a um só método (`cash.ts:72-73`) e ao dia da saída, não ao dia do pagamento (`cash.ts:5-10,41-46`) | R28 |

### C. Cancelamentos e reembolsos

| # | O que acontece | Prob. · Impacto | Rasto na BD 2 | Hoje? | Regra |
|---|---|---|---|---|---|
| F9 | Reserva cancelada depois de paga, de entrar ou até de sair | M · €€€ | `History` CANCEL com o estado anterior; `Cancellation` (motivo, `createdAt`); `Notification` BOOKING_CANCELLED; permissão `allowChangeBookingStatusAfterDone` | **Parcial.** A receita só conta CHECKED_OUT (`server/finance/engine.ts:209-213`): se passa a CANCELLED, o dia baixa sem aviso. A Caixa mostra o pago das canceladas só como informação (`cash.ts:80-81`) | R13 |
| F10 | Reembolso feito (ou prometido) sem justificação, ou maior do que o pago | M · €€ | `Cancellation.refund`, `refunded`, `refundedAmount`, `refundedAt`, `refundTransactionId` | **Não.** A cópia não tem reembolsos (`cash.ts:16-18`). Só a ficha mostra (`bookingFile.ts:726,835-839`) | R13 |

### D. A reserva muda de sítio, de dia ou desaparece

| # | O que acontece | Prob. · Impacto | Rasto na BD 2 | Hoje? | Regra |
|---|---|---|---|---|---|
| F11 | Reserva passada para outro parque (ou para um parque de terceiros) | B · €€ | `History` com `parkId`; `Booking.parkId` | **Parcial.** O `multipark-db-diff` vê "parque" (`server/multiparkDb/diff.ts:168`), mas só corre à mão | R14 |
| F12 | Datas mudadas depois de a caixa desse dia fechar (a reserva sai de um dia e entra noutro) | M · €€ | `History` com `checkOutDate`/`checkOut`; `cashierClosedAt` | **Parcial.** O diff vê "saída" (`diff.ts:166`), à mão | R14 |
| F13 | Reserva apagada na BD 2 (e às vezes recriada com outro id) | B · €€€ | **Pode não ficar rasto**: `History` depende da reserva (chave estrangeira). Resta talvez `ActivityEvent` e `ConnectionDelivery`. Cancelamentos "duplicado": 154 | **Parcial.** O diff lista "só nossa" (`diff.ts:171-180`), à mão. A nossa linha fica com o último valor e **continua a contar** na receita e na Caixa, porque a atualização falha e só reagenda (`multiparkBookingSync.ts:317-326`) | R15 |

### E. Pro, avenças, parceiros e crédito

| # | O que acontece | Prob. · Impacto | Rasto na BD 2 | Hoje? | Regra |
|---|---|---|---|---|---|
| F14 | Reserva marcada como pro ou avença (fatura ao mês) depois de entrar, ou sem cliente pro ativo | M · €€ | `History` com `pro`, `proClientId`, `clientPlanId`, `allowance`; `ProClient.active`; `ClientPlan` (máximo de reservas) | **Parcial.** A conta corrente Pro lê a BD 2 e marca o mês pago com valor em falta (`shared/crmPro.ts:171-174`) e os movimentos que somem (`server/crm/proSync.ts:113-117`). Mas os valores são reescritos sem histórico (`proSync.ts:105-109`) e a Caixa não separa pro (`cash.ts:69-73`) | R16 |
| F15 | Valor do parceiro mexido (`partnerAmountDue`, `partnerContributedAmount`) ou reserva passada para parceiro depois de paga em dinheiro | M · €€€ | `History` com esses campos e `partnerId`; `allowMoveBookingToPartner`; `PartnerPayment`/`PartnerPaymentSplit`; `PartnerCreditEntry` | **Não** para as alterações. As Parcerias lêem o valor atual ao vivo (`server/multiparkDb/partnerships.ts:94-98`) | R17 |
| F16 | Duas taxas para o mesmo parceiro: a da Multipark (`Partner.feePercentage`, `Booking.partnerFeeValue`) e a nossa (`partnerships.commissionRate`) | A · €€ | `Partner`, `Booking.partnerFee*` | **Não.** O Financeiro usa a nossa taxa (`engine.ts:521-536`). Não se compara com a deles | R17 |
| F17 | Crédito usado para pagar uma reserva | B · €€ | `Credit` (273), `Booking.creditId` | **Não.** `Credit` nunca é lido | R21 |

### F. Serviços extra

| # | O que acontece | Prob. · Impacto | Rasto na BD 2 | Hoje? | Regra |
|---|---|---|---|---|---|
| F18 | Serviço feito (lavagem, carregamento…) mas retirado da conta, a 0 ou por pagar | M · €€ | `BookingExtraService.done` e `price`; linha SERVICE em `BookingPricing`; `allowMarkExtraServiceAsDone`, `allowDeletePricingEntry` | **Não.** Na cópia, extras retirados **ficam lá** (`server/db.ts:5049`). O "feito" marcado no dashboard soma-se ao deles e nunca volta atrás (`db.ts:5056-5067`, `server/routers.ts:6205-6225`) | R18 |

### G. Faturas, notas de crédito e pagamentos online

| # | O que acontece | Prob. · Impacto | Rasto na BD 2 | Hoje? | Regra |
|---|---|---|---|---|---|
| F28 | Reserva paga e entregue sem fatura, ou fatura com valor diferente do pago | M · €€ | `Billing` (`amount`, `emited`, `invoiceExpressId`); `Park.autoEmitInvoices` | **Parcial.** Só na ficha (`bookingFile.ts:725`). Não há ligação à InvoiceExpress | R19 |
| F29 | Nota de crédito emitida depois do fecho | B · €€ | `Attachment` CREDIT_NOTE / INVOICE_WITH_CREDIT_NOTE; `Billing.invoiceExpressType` | **Parcial.** Só na ficha (`bookingFile.ts:804-805`) | R19 |
| F22 | Pagamento online contestado (disputa) ou reembolsado na Stripe, e a reserva continua "paga" | B · €€ | `Booking.disputeEvents`, `stripeChargeId`, `paymentIntentId`; `BookingPaymentLink` (estado, valor recebido); `Cancellation.refundTransactionId` | **Não.** A ficha tira `disputeEvents` de propósito (`bookingFile.ts:629`). `BookingPaymentLink` não é lido | R20 |

### H. Caixa física

| # | O que acontece | Prob. · Impacto | Rasto na BD 2 | Hoje? | Regra |
|---|---|---|---|---|---|
| F19 | Caixa fechada ou dinheiro validado, e depois reaberto ou mexido | M · €€€ | `cashierClosed`/`cashValidated`/`driverValidated` com `At`, `ById`, `ByName`. **A confirmar** se a reabertura fica na `History` (a ficha já sabe mostrar estes campos quando lá aparecem, `bookingFile.ts:246-248`) | **Não.** Só guardávamos os nomes, e já nem esses são atualizados (`multiparkBookingSync.ts:204-206` contra `:260`). A Passagem de turno mostra só o estado de agora (`server/multiparkDb/shiftState.ts:14-15`) | R22, R8 |
| F20 | Condutor recebe dinheiro e não o entrega (`driverValidated` fica por fazer) | A · €€€ | `BookingPricingPayment` "Dinheiro" com `recordedAt`; `checkOutDriverName`; `driverValidated*` | **Parcial.** A Passagem de turno conta o que falta validar (`shiftState.ts:14-15`), sem prazo nem alerta | R23 |
| F21 | O valor contado pelo back office e os gastos pagos da caixa não ficam registados | A · €€€ | **Nenhum.** `cashValidated` é só sim/não, sem valor. A BD 2 não tem gastos | **Não.** As despesas têm `paymentMethod = cash` (`drizzle/schema.ts:677`), mas sem parque nem caixa. As tabelas `finance_accounts` (tipo `cash`) e `expense_payments` existem (`drizzle/schema.ts:715-750`) e **não são usadas** | R24 |
| F26 | A mesma pessoa edita o preço ou o método e valida ou fecha a caixa dessa reserva | M · €€€ | `History.userId`/`agentName` contra `cashValidatedById`/`cashierClosedById` | **Não** | R25 |

### I. Técnicos (os dois sistemas)

| # | O que acontece | Prob. · Impacto | Rasto | Hoje? | Regra |
|---|---|---|---|---|---|
| F23 | Fuso e fronteira do dia: uma saída às 00:30 cai noutro dia; a caixa da Multipark é por turno, a nossa por dia de calendário | M · € | Timestamps "sem fuso" na BD 2 (tratados como UTC, `server/multiparkDb/read.ts:97-105`, `bookingRefresh.ts:1`); `Park.timezone` | **Parcial.** Os dias de Lisboa são coerentes em todo o dashboard (`engine.ts:9-15`, `cash.ts:65-67`), mas o dia da Caixa é o da saída, não o do pagamento nem o do turno | R24 (por turno) |
| F24a | Webhook perdido, atrasado, repetido ou de um tipo novo | M · €€ | `ConnectionDelivery` (estado, tentativas, erro) | **Parcial.** Alerta só **global** "sem webhooks há 3 h" (`server/syncHealth.ts:64-81`), não por parque. Tipos de evento novos são aceites e ignorados (`server/multiparkWebhook.ts:203-207`). Repetidos não fazem mal (`bookingDeliveryQueue.ts:99-101`). Falhas definitivas vão para "dead" (`bookingDeliveryQueue.ts:18-27`) | R10, R27 |
| F24b | A nossa cópia é reescrita e perde o "era" | A · €€€ | — | **Não** (`caixa-precos.md` §b). E 30 dias depois da saída a reserva deixa de ser relida (`multiparkBookingSync.ts:302-304,360-365`): uma mudança tardia sem webhook nunca chega | PR 1, R10 |

### J. Pessoas e permissões

| # | O que acontece | Prob. · Impacto | Rasto | Hoje? | Regra |
|---|---|---|---|---|---|
| F25 | Na Multipark, muitos agentes podem mexer em dinheiro. Há cerca de 100 permissões por agente e 1 412 condutores | A · €€€ | `Agent`: `allowEditBookingPrice`, `allowEditPricingTotal`, `allowEditPricingPaid`, `allowEditPaymentMethod`, `allowCreatePricingEntry`, `allowDeletePricingEntry`, `allowCashValidation`, `allowDriverValidation`, `allowCloseCashier`, `allowCancelBooking`, `allowChangeBookingStatusAfterDone`, `allowMoveBookingToPartner/Campaign/Allowance`, `allowEmitInvoice`, `notifyOnPriceChange`. Só há `updatedAt`, sem histórico | **Não.** Nada lê estas permissões. `multipark_agents` guarda só nome, papel e parque (`drizzle/schema.ts:1506-1516`) | R26 |
| F27 | No dashboard, mudanças nossas que mexem em valores | M · €€ | BD 1 | **Parcial.** Ninguém edita preços da cópia pelo ecrã: as únicas escritas são o sync (`multiparkBookingSync.ts:293`), o centro de custos (`server/projectAdmin.ts:135`) e a atribuição de anúncios (`server/integrations/googleAds/marketingStats.ts:304`). A Faturação é só do super admin (`shared/accessOverrides.ts:23`). **Mas:** mudar a taxa ou os códigos de um parceiro muda as comissões de meses passados e fica registado **sem o antes e o depois** (`routers.ts:6649`, `db.ts:3939-3953`). O "feito" dos extras fica registado com um id que muda a cada sync (`routers.ts:6224`, `db.ts:5059-5060`). As despesas sim, guardam antes e depois (`db.ts:590`) | R29 (auditoria nossa) |

---

## 3. Regras novas (continuam a lista R1–R11 de `caixa-precos.md`)

Todas correm sobre os retratos de `booking_price_snapshots`, as alterações de `booking_price_changes` e a leitura ao vivo
(PR 1–4). Só nos parques nossos, com tolerância de 0,01 €.

| # | Regra | Condição | Gravidade |
|---|---|---|---|
| R12 | Desconto ou campanha tardios | `campaignId`, `discountAmount` ou `discountApplied` mudou depois do check-in, ou linha DISCOUNT criada depois do check-in | alta |
| R13 | Cancelado ou reembolsado depois de pago | passa a CANCELLED vindo de CHECKED_IN/CHECKED_OUT, ou com pagamentos > 0; `refundedAmount > pago`; `refunded` sem `refundTransactionId` quando o pagamento foi online | **alta** |
| R14 | Mudou de dia ou de parque depois do fecho | `checkOut`/`parkId` mudou depois do `cashierClosedAt` do dia original, ou saiu para um parque de terceiros | média |
| R15 | Reserva desaparecida ou recriada | havia retrato e a BD 2 já não a tem; ou reserva nova com a mesma matrícula e datas sobrepostas até 48 h depois de uma cancelada ou desaparecida | **alta** |
| R16 | Pro ou avença marcado tarde | `pro`/`proClientId`/`clientPlanId`/`allowance` mudou depois do check-in; ou cliente sem `ProClient` ativo nesse parque; ou avença acima do máximo | média |
| R17 | Parceiro | `partnerAmountDue`/`partnerContributedAmount`/`partnerId`/`paymentSource` mudou depois da criação; `partnerAmountDue` diferente de valor × (1 − taxa); a nossa `commissionRate` diferente da taxa da Multipark | alta |
| R18 | Serviço feito sem cobrança | `BookingExtraService.done = true` sem linha SERVICE com `total > 0` paga; extra retirado depois de feito | média |
| R19 | Fatura | CHECKED_OUT com pagamento e sem `Billing` emitida 48 h depois, num parque com `autoEmitInvoices`; `Billing.amount ≠ pago`; nota de crédito depois do fecho | média |
| R20 | Pagamento online | `disputeEvents` preenchido; `BookingPaymentLink` FAILED ou CANCELED numa reserva dada como paga online; reembolso na Stripe sem `Cancellation` | alta |
| R21 | Crédito | `creditId` preenchido ou `Credit.value > 0`: pede justificação | média |
| R22 | Caixa reaberta | `cashierClosed` ou `cashValidated` passa de sim para não, ou `…At`/`…ById` mudam | **crítica** |
| R23 | Dinheiro do condutor por entregar | pagamento "Dinheiro" registado há mais de 12 h (valor a decidir) e `driverValidated = false` | **alta** |
| R24 | Contagem ≠ esperado | por parque e turno: dinheiro recebido (`BookingPricingPayment` "Dinheiro") − gastos pagos da caixa ≠ valor contado | **crítica** |
| R25 | Mesma pessoa | quem mudou preço ou método (History) é quem validou ou fechou a caixa dessa reserva | alta |
| R26 | Permissões | agente com permissões de dinheiro fora da lista aprovada; ou mudança nas permissões (retrato diário de `Agent`) | média |
| R27 | Webhook por parque | um parque nosso sem webhooks há N h enquanto a BD 2 mostra movimento nesse parque; evento de tipo desconhecido recebido | saúde |
| R28 | Método dividido | mais de um método nos pagamentos de uma reserva: a Caixa passa a somar por pagamento, não por reserva | informativa |
| R29 | Auditoria nossa | mudar taxa ou códigos de parceiro grava o antes e o depois e mostra o efeito nas comissões dos meses fechados | informativa |

---

## 4. O que se pode ligar a quê

```
                 InvoiceExpress (faturas)          Stripe / SIBS / terminal MB
                        ▲ invoiceExpressId              ▲ paymentIntentId, stripeChargeId, splitTransactionId
                        │                               │
 Parceiros ◄── partnerId ── MULTIPARK (BD 2) ── Booking.id ──► NOSSA CÓPIA (BD 1) ──► Financeiro / Caixa
 (extratos)     PartnerPayment   │  linhas, pagamentos,           externalId              │
                                 │  History, caixa                                         ▼
                                 ▼                                              Contagem do back office
                         CRM Pro (crm_pro_ledger)                              − gastos pagos da caixa
                         ProPayment, EntitySettlement                          = depósito no banco
```

| Ligação | Chave | O que confirma | Hoje | O que falta |
|---|---|---|---|---|
| Multipark ↔ nossa cópia | `Booking.id` = `externalId` | Preço, pago e método iguais; nenhuma reserva só de um lado | Diff à mão (`diff.ts:167`) | Varredura automática com memória (PR 2–4) |
| Multipark ↔ InvoiceExpress | `Billing.invoiceExpressId`, `Billing.invoice` | Fatura emitida com o valor pago; notas de crédito | Só a ficha | Chave só de leitura da InvoiceExpress (dono) e PR 11 |
| Multipark ↔ Stripe | `paymentIntentId`, `stripeChargeId`, `BookingPaymentLink`, `Billing.paymentIntentId` | Pago online = recebido na Stripe − reembolsos − disputas; bate com o *payout* | Nada | Chave Stripe restrita só de leitura (dono) e PR 12 |
| Multipark ↔ SIBS e terminal multibanco | `splitTransactionId`, `Submerchant`; pagamentos "Multibanco" do dia | Soma MB do parque e dia = extrato do terminal | Nada | Importar o extrato em CSV (`finance_import_batches`, `bank_csv`, já existe em `drizzle/schema.ts`) e PR 13 |
| Multipark ↔ contagem do back office | parque + turno + `BookingPricingPayment` "Dinheiro" | Dinheiro esperado = contado | **Impossível hoje:** o contado não fica registado | Registo "Contagem de caixa" na BD 1 (PR 10) ou campo na BD 2 (Rafael) |
| Contagem ↔ gastos pagos da caixa ("abater os gastos") | parque + dia; despesa com `paymentMethod = cash` | Contado = recebido − gastos com recibo | Despesas sem parque de caixa | Usar `finance_accounts` (uma conta "Caixa <parque>") e `expense_payments` (PR 10) |
| Contagem − gastos ↔ banco | depósito no extrato | O que saiu da caixa chegou ao banco | Nada | Importar extrato (PR 13) |
| Multipark ↔ CRM Pro | `ProPayment`, `EntitySettlement`, `Billing.periodKeys` | Mês pago = reservas do mês; nada some | Sim, em parte (`crmPro.ts:171-174`, `proSync.ts:113-117`) | Guardar o histórico dos valores (hoje reescritos, `proSync.ts:105-109`) e R16 |
| Multipark ↔ parceiros | `partnerAmountDue`/`Paid`, `PartnerPayment`/`Split`, `PartnerCreditEntry` | O extrato do parceiro (Parkvia, Parkos…) = soma do devido; a taxa é a acordada | Leitura ao vivo nas Parcerias | R17; importar extratos (PR 14) |
| Nossa taxa ↔ taxa deles | `partnerships.commissionRate` contra `Partner.feePercentage` | O custo de comissões do Financeiro está certo | Nada | R17 e decisão do dono sobre qual é a fonte |

---

## 5. Prioridades

Impacto × probabilidade. **P1** = entra na primeira volta da deteção. **P2** = a seguir. **P3** = quando houver tempo.

| Prioridade | Furos | Regras | Fase |
|---|---|---|---|
| **P1** | F1, F2, F3 preço e linhas · F5 método · F6 pago sem dinheiro · F19 caixa reaberta · F20 condutor · F21 contagem e gastos · F24b cópia reescrita · F25 permissões · F26 mesma pessoa | R1–R6, R8, R9, R22–R26 | 1, 2 e 3 (F21 com o PR 10) |
| **P2** | F4 desconto · F9, F10 cancelamento e reembolso · F13 apagada · F15, F16 parceiro · F14 pro · F24a webhook por parque | R12, R13, R15, R16, R17, R27, R10 | 2 |
| **P3** | F7, F8 parcial e dividido · F11, F12 parque e datas · F17 crédito · F18 extras · F28, F29 faturas · F22 Stripe · F23 fuso · F27 auditoria nossa | R14, R18–R21, R28, R29, R11 | 2, 3 e 4 |

---

## 6. Caminho — "vamos por aqui"

### Fase 0 — esta semana, sem código

1. **Rafael** responde às perguntas da secção 7.
2. **Dono** decide os pontos da secção 8.
3. **Medir** (Anexo A): contagens só de leitura, com autorização, fora das horas de ponta. Dizem quais furos são reais e
   quanto valem. Só totais, nenhum dado pessoal.
4. A leitura de confirmação da reserva do teste (`caixa-precos.md` §b).

### Fase 1 — parar de perder dados (≈ 2–3 dias)

| PR | O quê |
|---|---|
| 1 | Retratos `booking_price_snapshots` + `booking_price_changes`; guardar o payload do webhook (`caixa-precos.md`) |
| 7 | Voltar a gravar as três validações de caixa (bool + At + ById + ByName), `originalBookingPrice`, `discountAmount`, `paymentSource`; extras retirados; diff agendado (`caixa-precos.md`) |
| **9 (novo)** | O retrato passa a levar também: `campaignId`, `discountApplied`, `pro`, `proClientId`, `clientPlanId`, `allowance`, `partnerId`, `partnerAmountDue`, `partnerContributedAmount`, `partnerFeeValue`, `creditId`, `paymentBy`, os pagamentos um a um e os extras com `done`. O `hash` cobre tudo. Tirar o limite de 30 dias da releitura para as reservas com caixa por fechar. **0,5–1 d** |

### Fase 2 — detetar (≈ 5–6 dias)

| PR | O quê |
|---|---|
| 2 | Leitura da BD 2 para caixa (`cashLive.ts`), agora também com `Cancellation`, `Billing`, `Credit`, `BookingPaymentLink`, `BookingExtraService` e `disputeEvents` (só sim/não, sem o conteúdo) |
| 3 | Motor de regras R1–R11 **+ R12–R28**, com a explicação automática em PT-PT e testes com os casos deste documento (**+1 d** sobre o previsto) |
| 4 | Cron `cash-sweep` de 10 em 10 min e fecho do dia (D-1, D-2), com R27 por parque |
| **14a (novo)** | Retrato diário das permissões de `Agent` dos parques nossos e R26 (quem pode mexer em dinheiro, e o que mudou). **0,5 d** |

### Fase 3 — ver, fechar e contar (≈ 5–7 dias)

| PR | O quê |
|---|---|
| 5 | Ecrã "Correção de caixa" (fila, detalhe, fecho com explicação) |
| 6 | Alertas: no momento para R3, R6, R8, R13, R22, R23, R24; resumo diário às 08:00 |
| **10 (novo)** | **Contagem da caixa e gastos:** uma conta "Caixa <parque>" em `finance_accounts`; o back office regista o valor contado por parque e turno; as despesas pagas da caixa passam a ter essa conta (`expense_payments`) e recibo. A página Caixa mostra "recebido em dinheiro − gastos = esperado · contado · diferença" (R24). **2 d** |
| **15 (novo)** | Auditoria nossa: o antes e o depois ao mudar taxas e códigos de parceiro, e o id estável no "feito" dos extras (R29). **0,5 d** |

### Fase 4 — cruzar com o exterior (≈ 4–6 dias, depende das chaves)

| PR | O quê |
|---|---|
| **11** | InvoiceExpress: ler as faturas e notas de crédito pelo `invoiceExpressId` e comparar com `Billing` e com o pago (R19) |
| **12** | Stripe: pagamentos, reembolsos, disputas e *payouts* contra `paymentIntentId`/`BookingPaymentLink` (R20) |
| **13** | Extratos do banco e do terminal multibanco em CSV (`finance_import_batches`), por parque e dia |
| **14** | Extratos dos parceiros e agregadores contra `partnerAmountDue` e `PartnerPayment` (R17) |

**Total:** cerca de 16–22 dias, dos quais 9–12 já estavam em `caixa-precos.md`. As fases 1 e 2 já apanham os furos P1,
exceto a contagem (F21), que precisa do PR 10.

---

## 7. O que pedir ao Rafael

| # | Pedido | Para os furos |
|---|---|---|
| 1 | Confirmar se editar ou apagar `BookingPricing`, `BookingPricingPayment` e `BookingExtraService` gera `BOOKING_UPDATED` e uma linha em `History` ou `ActivityEvent`. Se não gerar, passar a gerar | F3, F6, F18 |
| 2 | Registar em `History`/`ActivityEvent` a reabertura da caixa e das validações, as mudanças de reembolso (`Cancellation`), de crédito (`Credit`) e de permissões (`Agent`) | F10, F17, F19, F25 |
| 3 | Nunca apagar reservas: cancelar, ou apagar com rasto (`ActivityEvent` BOOKING_DELETED e webhook) | F13 |
| 4 | Utilizador só de leitura para o dashboard e índices `History(bookingId)`, `History(actionTime)`, `BookingPricing(updatedAt)`, `BookingPricingPayment(recordedAt)` (os dois primeiros já pedidos) | todos |
| 5 | No webhook, mandar o `updatedAt` e um resumo dos valores (preço, pago, método), ou um evento próprio para preço e pagamento | F1–F6, F24 |
| 6 | Existe algum sítio onde fica o **valor contado** na validação do dinheiro? Se não, acrescentar `cashCountedAmount` (ou fazemos nós no PR 10) | F21 |
| 7 | Confirmar que todas as horas estão em UTC e o que querem dizer `checkInTime`/`checkOutTime` (texto) | F23 |
| 8 | Do lado deles: pedir um motivo obrigatório ao mudar preço, método ou estado depois do check-in | F1–F5, F9 |

## 8. O que o dono tem de decidir

| # | Decisão |
|---|---|
| 1 | Quem fecha os casos da "Correção de caixa" (novo papel de conferência de caixa) e com que tolerância |
| 2 | A lista final dos parques nossos (`plano-duas-bd.md` E.1) |
| 3 | Onde se regista a contagem e os gastos da caixa: no dashboard (PR 10) ou na Multipark (pedido 6 ao Rafael). Se os gastos pagos da caixa têm de ter recibo |
| 4 | Prazo para o condutor entregar o dinheiro (R23, por exemplo 12 h) |
| 5 | **Fecho de mês:** depois de fechado, uma mudança não reescreve o mês, entra como ajuste no mês seguinte e abre caso |
| 6 | Chaves só de leitura da InvoiceExpress e da Stripe, e envio dos extratos do banco e do terminal multibanco |
| 7 | Quem pode, na Multipark, mudar preço, método, pagos, linhas e caixa. Separar quem mexe em preços de quem fecha a caixa |
| 8 | Taxa dos parceiros: passa a valer só a da Multipark, ou mantemos a nossa com alerta quando diferem |

---

## Anexo A — medir antes de construir (só leitura, só contagens)

Esboços, **não corridos**. Correr só com autorização do Jorge ou do Rafael, pelo utilizador só de leitura, fora das horas de
ponta. Devolvem números, sem nomes nem matrículas. Onde entra a `History` (sem índices), limitar sempre a um mês de reservas
pelo `bookingId IN (…)`.

| Mede | Esboço |
|---|---|
| F1/F2: preço mudado depois do check-in, por mês | `History` UPDATE com `modifiedFields LIKE '%bookingPrice%'` e `actionTime` > hora do `CHECK_IN` da mesma reserva, nas reservas CHECKED_OUT de um mês |
| F5: método mudado | idem com `%paymentMethod%` ou `%paymentSource%` |
| F9: canceladas depois de entrar | `History` CANCEL em reservas que têm `CHECK_IN` antes |
| F18: extras feitos sem cobrança | `BookingExtraService.done = true` sem `BookingPricing` SERVICE com `amountPaid > 0` na mesma reserva |
| F28: entregues sem fatura | CHECKED_OUT com pagamentos > 0 e sem `Billing.emited = true`, por parque |
| F20: dinheiro por validar | reservas com pagamento "Dinheiro" e `driverValidated = false` mais de 12 h depois da saída |
| F22: disputas | `count(*) WHERE "disputeEvents" IS NOT NULL` |
| F25: quem pode mexer em dinheiro | `Agent` dos parques nossos, ativos: contagem por `role` de `allowEditPricingTotal`, `allowEditPricingPaid`, `allowEditPaymentMethod`, `allowDeletePricingEntry`, `allowCloseCashier`, `allowChangeBookingStatusAfterDone` |
| F26: mesma pessoa | reservas em que o `userId` de um UPDATE de preço ou método = `cashierClosedById` ou `cashValidatedById` |
