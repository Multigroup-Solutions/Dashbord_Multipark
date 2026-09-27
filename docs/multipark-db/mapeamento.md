# BD da Multipark — mapeamento de tudo o que guarda

Levantamento de 27 set 2026, feito sobre o esquema real (`schema.md`, PostgreSQL 17, 81 tabelas).
Complementa-se com o **perfil** (modo `perfil` do workflow manual). O perfil mostra o que cada
coluna guarda de facto: % preenchida, datas, valores de categoria, chaves JSON e onde estão os vídeos e as assinaturas.

**Princípio (Jorge, 27 set):** as duas BD ficam separadas. A da Multipark é a referência e está sempre
certa. A nossa continua a receber pela API e guarda os valores. **Não é para trazer tudo para cá, é para ter acesso**:
lemos diretamente da BD deles quando precisamos.

Legenda da coluna "Nós": ✅ já temos · 🟡 temos parte · ❌ não temos.

---

## 1. Reserva (`Booking`, ~67 700 linhas, 105 colunas)

| O quê | Colunas | Nós |
|---|---|---|
| Datas previstas e reais | `checkInDate`/`checkOutDate` (dia) + `checkIn`/`checkOut` (hora real), `checkInTime`/`checkOutTime` | ✅ |
| Estado | `status` (BOOKED, CHECKING_IN, CHECKED_IN, MOVING, PENDING_CHECKOUT, CHECKING_OUT, CHECKED_OUT, CANCELLED, PENDING) | ✅ |
| Hora de cada fase da operação | `checkingInAt`, `movingAt`, `pendingCheckoutAt`, `checkingOutAt`, `arrivedAtDeliveryAt`, `baggageWaitingAt`, `customerCheckinEta` (min) | ❌ |
| Quem fez o check-in e o check-out | `checkInDriverId`/`Name`, `checkOutDriverId`/`Name` | 🟡 (tirado do histórico) |
| Onde está o carro | `spotId` → `Spot`, `garageId` → `Garage`, `externalGarage`/`externalRow`/`externalSpot`, `allocation` (n.º) + `allocationId` | 🟡 (só garagem/lugar do histórico) |
| Voos e atrasos | `departingFlight`, `returnFlight`, **`departingFlightEta`, `returnFlightEta`** (hora prevista atualizada do voo) | 🟡 (voos sim, ETA não) |
| Veículo na reserva | `vehicleId` → `BookingVehicle`, **`vehicleKms`**, **`vehicleRange`** (autonomia elétricos) | 🟡 |
| Vídeo e assinaturas | **`checkinVideo`**, **`checkinSignature`**, **`checkoutSignature`** (base64 ou URL), mais a tabela `Attachment` | ❌ |
| Preço | **`originalBookingPrice`** (preço na criação), `bookingPrice` (atual), `parkingPrice`, `deliveryPrice`, `discountAmount`, `discountApplied`, `priceValidated`, `currency` | 🟡 (sem o preço original nem o desconto) |
| Pagamento | `paymentMethod`, `paymentBy`, `paymentSource` (STRIPE, PARKVIA, PARKOS, PARKFLOW…), `paymentIntentId`, `stripeChargeId`, `splitTransactionId`, `disputeEvents`, `paymentReminderSentAt`, `onlinePaymentRequestedAt` | 🟡 (método e pago sim) |
| **Caixa** | `cashValidated`/`At`/`ById`/`ByName`, `driverValidated`/`At`/`ById`/`ByName`, `cashierClosed`/`At`/`ById`/`ByName` | 🟡 (só os nomes) |
| Origem | **`origin`** (GENERAL_FORM, MANUAL, MARKETPLACE, IMPORTED, API, MOBILE_APP, PARTNER_API, PARTNER_DASHBOARD, CLIENT_PLAN), `originUrl`, `externalReference`, `externalCampaign`, `createdBy`, `idempotencyKey` | 🟡 (origem e URL sim) |
| Campanha e desconto | `campaignId` → `Campaign` (com `discountCode`), `discountAmount`, `discountApplied` | 🟡 (sem o código) |
| Parceiro | `partnerId`, **`partnerFeeType`, `partnerFeeValue`, `partnerAmountDue`, `partnerAmountPaid`, `partnerContributedAmount`**, `commissionAmount` | 🟡 (só o id) |
| Pro, avença, crédito | `pro`, `proClientId`, `clientPlanId`, `allowance`, `creditId`, `bookingFeeId` | 🟡 (só `pro`) |
| Cliente e faturação | `clientId`/`customerId` → `Client`, `taxName`, `taxNumber`, `taxAddress`, `language` | 🟡 |
| Integrações | `odooId`, `firebaseId`, `firebaseSyncedAt`/`Error` (legado Firebase) | ❌ |
| Outros | `remarks`, `deliveryType`, `deliveryLocation`, `requestEvaluation`, `checkoutReminderSentAt` | ✅ / 🟡 |

## 2. Linhas de preço, pagamentos e caixa

| Tabela | O que guarda | Nós |
|---|---|---|
| `BookingPricing` (~92 800) | Cada linha da conta da reserva: `description`, `category` (PARKING, VALET, SERVICE, FEE, DISCOUNT, ADJUSTMENT), `total`, `amountPaid`, `paymentMethod`, `extraServiceId` | ❌ |
| `BookingPricingPayment` (~39 700) | Cada pagamento feito a uma linha: `amount`, `paymentMethod`, **`recordedAt`** (quando foi pago) | ❌ |
| `BookingFee` | Taxa extra por reserva (`description`, `value`), por exemplo atraso | ❌ |
| `ExtraFee` / `CampaignExtraFee` | Taxas por parque/campanha: EXPRESS, NIGHT, WEEKEND | ❌ |
| `BookingPaymentLink` (86) | Links de pagamento Stripe enviados ao cliente (estado, valor recebido, método) | ❌ |
| `Cancellation` (~1 100) | Cancelamento: `cancellationType` (motivo), `cancellationObs`, `refund`, `refunded`, `refundedAmount`, `refundedAt` | 🟡 (só data e motivo) |
| `Billing` (~8 650) | Faturas: `amount`, `provider`, `invoice`, `invoiceExpressId`/`Type`, `emited`, período | ❌ |
| `EntitySettlement` (195) | Acertos de parceiros, pro e avenças: período, `paidAt`, `method`, `amount`, `source`, comprovativo | ❌ |
| `Submerchant` (25) | Contas SIBS de cada parque para *split* de pagamentos (comissões, mínimos/máximos) | ❌ |

**A caixa não é uma tabela à parte.** É o conjunto das linhas de preço e dos pagamentos de cada reserva
(com o método e a hora), mais três validações na reserva, cada uma com quem e quando:

1. o condutor entregou o dinheiro (`driverValidated`);
2. o dinheiro foi conferido (`cashValidated`);
3. a caixa foi fechada (`cashierClosed`).

**Alerta pedido (Jorge):** na criação guardamos o valor e se está pago. Quando a caixa é feita, comparamos
com a BD deles: `bookingPrice` contra o nosso, `paymentMethod` e as linhas de `BookingPricingPayment`.
Se algo mudou, levanta-se um alerta. Para saber **quem** mudou e **quando** há duas fontes:

- `originalBookingPrice` contra `bookingPrice`;
- o histórico: movimentos `UPDATE` com `modifiedFields` e `snapshot`, e o `ActivityEvent` com o antes e o depois.

## 3. Histórico e auditoria

| Tabela | O que guarda | Nós |
|---|---|---|
| `History` (~280 600) | Cada ação sobre a reserva, com quem (`userId`, `agentName`), o quê (`changeType`: CREATED, UPDATE, CHECKING_IN, CHECK_IN, MOVEMENT, PENDING_CHECKOUT, CHECKING_OUT, CHECK_OUT, CANCEL), quando (`actionTime`), **onde (`lat`, `lng`)**, `modifiedFields` (o que mudou), `remarks`, `platform`, `userAgent` e **`snapshot`** (JSON com o estado da reserva nesse momento) | 🟡 (sem GPS nem snapshot) |
| `ActivityEvent` (~8 500) | Registo de auditoria mais recente, para qualquer entidade: `eventType`, **`snapshot` e `previousSnapshot`** (antes e depois), autor (`actorId`, `actorEmail`, `actorDisplayName`, `actorRole`), `ip`, `platform`, títulos traduzidos | ❌ |
| `Notification` (~27 900) | Notificações aos agentes: preço alterado, reserva editada, cancelada, ocorrência criada, chat | ❌ |

O histórico permite reconstruir cada reserva passo a passo: quem mexeu no carro, quando, onde estava e o que mudou.

## 4. Vídeo, fotos, assinaturas e anexos

| Onde | O que guarda |
|---|---|
| `Booking.checkinVideo` | Vídeo do carro no check-in (URL) |
| `Booking.checkinSignature` / `checkoutSignature` | Assinatura do cliente na entrada e na saída (base64 ou URL) |
| `Attachment` (~1 500, por reserva) | `type`: VEHICLE_VIDEO, VEHICLE_PHOTO, SIGN_DOCUMENT, PAYMENT_PROOF, DOCUMENT, CREDIT_NOTE, INVOICE_WITH_CREDIT_NOTE, OTHER + `url` |
| `ProClientAttachment`, `PartnerAttachment`, `ClientPlanAttachment` | Documentos de pro, parceiros e avenças |
| `Park.checkinRequireVideo`, `checkinRequireSignature`, `checkoutRequireSignature`, `checkinRequireVehicleKms` | Que parques obrigam a vídeo, assinatura e quilómetros |

Hoje não temos nada disto. Com o acesso, basta mostrar na ficha da reserva o link do vídeo, a assinatura e as fotos.

## 5. Cliente

| Tabela | O que guarda | Nós |
|---|---|---|
| `Client` (~45 900) | Nome, email, telefone, NIF, IBAN, nome fiscal, cobrança automática (MIT), `anonymizedAt` (RGPD) | 🟡 (colunas na reserva e CRM por email) |
| `ProClient` (61) | Clientes pro por parque: `discount` (15 % por omissão), dados fiscais, ativo | 🟡 (só a marca `pro`) |
| `ProPayment` (22) | Pagamentos periódicos dos pro (período, reservas incluídas, split por parque) | ❌ |
| `Allowance` / `ClientPlan` / `ClientPlanPayment` / `ClientPlanPendingPeriod` | Avenças e planos: preço por período, cadência, máximo de reservas, renovação, pagamentos, períodos em atraso | ❌ |
| `Credit` (273) | Crédito a favor numa reserva | ❌ |
| `Vehicle` (~10 900) | Os carros que cada cliente guardou na conta | ❌ |
| `Driver` (48) | Outra pessoa que vai entregar ou levantar o carro | ❌ |
| `AccountDeletionRequest` | Pedidos de apagar a conta (RGPD) | ❌ |

## 6. Veículo da reserva

`BookingVehicle` (~65 200) guarda por reserva a matrícula, marca, modelo, cor, tipo (MOTORCYCLE, CAR, VAN, TRUCK) e lugares.
Na reserva ficam também `vehicleKms` e `vehicleRange`. Nós temos a matrícula, a marca, o modelo e a cor.
Os quilómetros só os temos quando aparecem no histórico.

## 7. Agentes e condutores

| Tabela | O que guarda | Nós |
|---|---|---|
| `Agent` (~2 240) | Cada agente em cada parque: `role` (ADMIN, SUPERVISOR, ACCOUNTANT, DRIVER, JUNIOR, PARTNER, LEADER), ativo, **cerca de 100 permissões** (fechar caixa, validar dinheiro, editar preço, cancelar…), `comissionFee`, ativação e desativação automáticas, notificações | 🟡 (`multipark_agents`: nome, papel e parque) |
| `AgentInvite` (118) | Convites por email, com as permissões pedidas | 🟡 |

Não há uma tabela de utilizadores, porque a autenticação é externa. O email do agente só aparece nos convites.

## 8. Parceiros

| Tabela | O que guarda | Nós |
|---|---|---|
| `Partner` (462) | Parceiro por parque: `partnerType` (AGENCY, AGGREGATOR, PARTNER), **`feeType` (PERCENTAGE/FIXED), `feePercentage` (10 % por omissão), `feeFixedValue`**, dados fiscais, cobrança automática, agentes autorizados a criar reservas | 🟡 (`partnerships` configurado à mão) |
| `PartnerMember` | Membros da conta do parceiro com permissões e comissão própria | ❌ |
| `PartnerPayment` / `PartnerPaymentSplit` | Pagamentos dos parceiros e divisão por parque (comissão, líquido) | ❌ |
| `PartnerCreditEntry` | Saldo do parceiro: créditos ganhos e aplicados | ❌ |
| `PartnerCommission` | Comissão da plataforma por parque (2 % por omissão) | ❌ |
| Na reserva | `partnerFeeType`, `partnerFeeValue`, `partnerAmountDue`, `partnerAmountPaid`, `partnerContributedAmount` | ❌ |

A percentagem de cada parceiro vem direta da BD deles, sem configuração manual.

## 9. Campanhas, códigos de desconto e origens

| Tabela | O que guarda | Nós |
|---|---|---|
| `Campaign` (41) | `accessType`: **PUBLIC, LINK_ONLY (link direto), DISCOUNT_CODE**, mais `discountCode`, `discountType` (%, valor), `discountValue`, `minimumAmount`, usos atuais e máximos, datas, `bookingCount`, `revenue` | 🟡 (id e nome) |
| `CampaignPricing` / `CampaignDeliveryType` / `CampaignExtraService` / `CampaignExtraFee` | Preços, entregas, serviços e taxas próprios de cada campanha | ❌ |
| `WebsiteCheckout` (594) / `BookingDraft` (745) | Checkouts do site e rascunhos: o que o cliente pediu, o preço calculado e se chegou a reservar | ❌ |
| `ParkInviteRequest` | Pedidos vindos de um link com datas e origem (`sourceUrl`) | ❌ |

As campanhas LINK_ONLY são os links diretos herdados do Firebase, que o Jorge quer retirar.
O legado Firebase fica em `Booking.firebaseId` e `firebaseSyncedAt` e em `Park.syncToFirebase` e `firebaseBrand`.
As "reservas agrupadas por origem" correspondem a `Booking.origin` + `originUrl` + `externalReference`.

## 10. Serviços extra e entregas

| Tabela | O que guarda | Nós |
|---|---|---|
| `ExtraService` (207) | Catálogo por parque: nome, preço, preços por tipo de veículo | ❌ |
| `BookingExtraService` (~23 500) | Serviços de cada reserva: nome, preço, **`done`** (feito ou não) | ✅ (`multipark_booking_extras`) |
| `DeliveryType` (68) | Tipos de entrega por parque: preço, local, **ligar X minutos antes**, hora e local de saída | 🟡 (só o nome) |
| `Pricing` (144) | Tabela de preços por parque: tipo de lugar × veículo × hora/dia/semana/mês | ❌ |

## 11. Parques e marketplace

| Tabela | O que guarda | Nós |
|---|---|---|
| `Park` (55) | Nome, cidade, morada, GPS, estado, **`listingType` (ON_PLATFORM = marketplace, DIRECTORY)**, tipos, lugares, métodos de pagamento, **tipos de ocorrência e de cancelamento configurados**, regras de check-in e check-out (vídeo, assinatura, km, localização obrigatória), dias bloqueados, faturação automática, fuso horário | 🟡 (33 parques fixos no código) |
| `Garage` (21) / `Spot` (~1 640) | Garagens e lugares (fila, lugar, tamanho, carregador elétrico) | ❌ |
| `Allocation` (38) | Números de alocação por parque e tipo de lugar (prefixo, mínimo, máximo) | ❌ |
| `OperatingHours` / `ParkAvailabilityBlock` | Horário e bloqueios de disponibilidade | ❌ |
| `Procedures` (110) | Procedimentos escritos por parque (passos) | ❌ |
| `Subscription` (~1 450) | Plano de cada conta na plataforma Multipark (FREE, PROFESSIONAL, ENTERPRISE, PARTNER) | ❌ |

## 12. Ocorrências

`Occurrence` (~1 760) guarda o título (tipo), a prioridade (LOW, MEDIUM, HIGH), quem criou (`agentName`), **onde (`lat`, `lng`)**,
a reserva e o parque, as notas, o anexo, e se está resolvida, quando e por quem.

**Decisão (Jorge, 27 set):** as ocorrências passam a ser lidas diretamente daqui e podem ser resolvidas num lado ou no outro.
O que fizemos para as ocorrências no dashboard (parser das notas do histórico, `incidents`) deixa de ser a fonte.

## 13. Emails, chat e templates

| Tabela | O que guarda | Nós |
|---|---|---|
| `EntityEmailLog` (~6 400) | Cada email enviado por reserva, pro, parceiro ou avença: tipo, destinatário, assunto, quem enviou, quando | ❌ |
| `AiEmailMessage` (~2 800) | Emails da caixa Gmail deles, com categoria IA (RESERVA, RECLAMACAO, PARCEIRO, FINANCEIRO, OUTRO), resumo, rascunho de resposta, estado, cliente ou parceiro ligado | ❌ (temos a nossa caixa Gmail) |
| `EmailTemplate` (88) | Templates por parque e língua: CONFIRMATION, PICKUP, DELIVERY, EVALUATION, CANCELLATION, FLIGHT_INFO, BILLING, OTHER | ❌ (servem de ideia para os nossos) |
| `ChatMessage` (~2 200) | Chat da app entre o cliente e o parque, por reserva, com lido e não lido e anexos | ❌ |

Só ficam aqui os emails trocados pela app deles. Os que saem pelo nosso email já chegam à nossa caixa.

## 14. Avaliações

`BookingReview` (205) guarda uma avaliação por reserva: parque, cliente, `rating` e `comment`.
`Booking.requestEvaluation` e `Park.checkoutRequestEvaluation` controlam o pedido de avaliação no check-out.
O Jorge vai explicar como quer guardar as avaliações dos outros parques.

## 15. API, conexões e agregadores

| Tabela | O que guarda |
|---|---|
| `ApiKey` (38) | Chaves por parque e parceiro: estado, limite, IPs permitidos, último uso, n.º de pedidos (a chave em si só existe como *hash*) |
| `ConnectionEndpoint` (51) | Ligações de saída e entrada por parque: GENERIC_WEBHOOK, PARKFLOW, OPTITRAVEL; OUTBOUND_PUSH ou INBOUND_PULL |
| `ConnectionDelivery` (~8 300) | Cada webhook enviado (reserva criada, alterada, cancelada): estado, tentativas, erro, código de resposta |
| `ConnectionExternalRef` | Referência externa da reserva em cada ligação |
| `AggregatorProcessedEvent` / `AggregatorQuarantineItem` | Reservas vindas de agregadores (PARKVIA) e as que ficaram em quarentena (valor em dívida, falta de matriz, erro) |

## 16. Outros

`EntityNote` (notas internas por reserva, pro, parceiro ou avença), `SavedBookingFilter`, `UserPreference`,
`AiConversation`/`AiMessage` (assistente IA deles), `CommunityArticle`/`Article*` (artigos da comunidade).

---

## O que resolve já, com acesso direto

1. **Ficha da reserva completa**: vídeo, assinaturas, fotos, histórico com GPS e snapshot, quem fez cada fase e a que horas, lugar e garagem, km.
2. **Caixa com alerta**: preço original contra o atual, linhas e pagamentos com hora e método, as três validações com quem e quando. Alerta quando o que temos guardado não bate com o que está lá.
3. **Parceiros com a percentagem real** e o valor devido e pago por reserva, sem configurar à mão.
4. **Campanhas com código e tipo de acesso**. Identificar os links diretos do Firebase para retirar.
5. **Ocorrências lidas diretamente**, com GPS e anexo.
6. **Voos com ETA** e taxas de atraso cobradas (linhas FEE e `BookingFee`).
7. **Estatísticas operacionais exatas** a partir das horas das fases e do histórico.

---

## Anexo — o que está de facto preenchido (perfil de 27 set 2026)

| O quê | Valor real |
|---|---|
| Início do sistema | Histórico, clientes e ocorrências desde **2 mar 2026**; reservas importadas desde 2023 |
| Clientes | 46 418 fichas, 35 727 emails distintos; telefone 100 %, NIF ~25 %, IBAN 0 % |
| Estado das reservas | CHECKED_OUT 61 300 · CANCELLED 5 483 · BOOKED 587 · CHECKED_IN 450 |
| Origem | API 58 898 · formulário 4 520 · manual 3 199 · marketplace 624 · painel de parceiro 388 · importada 175 · avença 19 |
| Vídeo / assinaturas | vídeo em 23 % (caminhos internos, Firebase Storage, S3); assinaturas em 16 % (imagem PNG na BD) |
| Histórico | UPDATE 91 506 · CREATED 67 823 · MOVEMENT 52 641 · CHECK_IN 16 732 · CHECK_OUT 15 347 · CANCEL 1 159; GPS em 25 %; `modifiedFields` guarda cada campo com `from` → `to` |
| Plataforma das ações | PDA Android 66 863 · web 17 951 · Windows 9 749 · iPhone 4 472 |
| Linhas de preço | PARKING 14 549 · VALET 14 533 · SERVICE 5 719 · FEE 1 392 · DISCOUNT 371 · ADJUSTMENT 41 (Flexível, Express, Noturno, lavagens, carregamento, Kiss&Fly, "Alteração serviços (+X€)") |
| Caixa | dinheiro conferido em 33 % das reservas, condutor validado 28 %, caixa fechada 24 % (desde nov 2025/mar 2026) |
| Voos | voo de regresso 70 %, ida 25 %; hora prevista atualizada em 9 % / 2 % |
| Cancelamentos | por email 366 · duplicado 154 · outro 118 · cliente cancelou 92 · no show 82 · erro na reserva 68 · não compareceu 64 … |
| Ocorrências | Outro(s) 1 171 · Pagamento 296 · Erro de sistema 162 · Reclamação 65 · Fatura 32 · carro/chaves mal arrumados 31 · reembolso 16 …; resolvidas só 2,8 % |
| Emails enviados pela app | serviços extra 3 282 · fatura 2 673 · info de voo 532 · confirmação 530 · link de pagamento 60 |
| Parceiros | 465: agências 348, agregadores 113; % mais comuns 20 % (160), 15 % (138), 10 % (109); Top Parking 40 %, Parkos 20 %, Parkvia 23 % |
| Campanhas | 43, das quais 41 de link direto (Firebase) sem reservas e 2 com código |
| Agentes | DRIVER 1 412 · ADMIN 304 · PARTNER 201 · SUPERVISOR 156 · LEADER 155 |
| Parques | 56; os que têm volume são Airpark, Redpark e Skypark (Lisboa, Porto e Faro) e Top-Parking Lisboa (parado desde 11 ago) |
