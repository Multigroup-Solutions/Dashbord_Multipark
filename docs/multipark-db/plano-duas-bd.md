# Plano — o que fica na BD da Multipark e o que fica na nossa

27 set 2026. Baseado no mapeamento (`mapeamento.md`) e no perfil real da BD deles (corrida de 27 set):
46 418 clientes, 67 823 reservas e 280 mil ações no histórico. O sistema deles guarda histórico, clientes e ocorrências **desde 2 mar 2026**.
As reservas anteriores (2023 → fev 2026) foram importadas sem movimentos.

## Princípio (Jorge)

- As duas BD são da mesma empresa e ficam **separadas**. O Jorge faz a nossa (BD 1) e o Rafael faz a da Multipark (BD 2).
- **BD 2 = tudo o que é operacional.** O dashboard lê-a diretamente e não copia. É a referência e está sempre certa.
- **BD 1 = o que é nosso**: clientes (CRM), funcionários, emails, avaliações, pings do Zello, marketing e a **cópia financeira**
  de cada reserva, para conferir as caixas.
- Continuamos a receber as reservas pela API e pelo webhook na BD 1. Quando a BD 1 não bate com a BD 2, levanta-se um alerta.
- **Parques nossos**: ficamos com mais informação e fazemos a conferência da caixa.
  **Parques de terceiros**: ficamos só com os clientes, que são nossos, e somos nós que falamos com eles (emails, avisos, upsell).

---

## A. Fica na BD 2 (Multipark) — lemos diretamente, não copiamos

| O quê | Tabelas deles | Como o dashboard usa |
|---|---|---|
| Reserva "viva": estado, datas reais, fases (a entrar, em movimento, à espera da bagagem…), lugar, garagem, alocação | `Booking`, `Spot`, `Garage`, `Allocation` | Ficha da reserva e operação lêem direto |
| Histórico: quem, quando, onde (GPS em 25 %), cada campo com **antes → depois**, retrato completo da reserva em 51 % das ações | `History` (desde 2 mar 2026), `ActivityEvent` | Ficha da reserva, auditoria, avaliação dos funcionários |
| Vídeo do check-in (23 % das reservas) | `Booking.checkinVideo`, `Attachment` | Só o link: abrimos lá. Há três formatos: ~10 900 caminhos internos, ~4 600 links Firebase Storage e poucos S3. **Confirmar com o Rafael como se abrem os caminhos internos** |
| Assinaturas na entrada e na saída (16 %) | `Booking.checkinSignature` / `checkoutSignature` (imagem PNG guardada na própria BD) | Lidas só quando se abre a ficha |
| Ocorrências (1 760): tipo, prioridade, GPS, anexo, resolvida por quem | `Occurrence` | **Passam a ser lidas daqui.** O que fizemos para as ocorrências deixa de ser a fonte. Podem ser resolvidas num lado ou no outro |
| Chat da app com o cliente, emails enviados pela app deles | `ChatMessage`, `EntityEmailLog`, `AiEmailMessage` | Consulta na ficha da reserva. Os emails que saem pelo nosso email já chegam à nossa caixa |
| Agentes e permissões (cerca de 100 por agente) | `Agent`, `AgentInvite` | Consulta. A ligação agente ↔ funcionário fica na BD 1 |
| Configuração dos parques: regras de check-in e check-out, horários, bloqueios, tabela de preços, procedimentos | `Park`, `OperatingHours`, `ParkAvailabilityBlock`, `Pricing`, `Procedures` | Consulta |
| Faturas (InvoiceExpress, 8 800) | `Billing` | Consulta e ligação à reserva |
| Conexões e chaves de API | `ConnectionEndpoint`, `ConnectionDelivery`, `ApiKey` | Monitorização |

## B. Fica na BD 1 (nossa)

### B1. CRM — ficha do cliente (nova, tão ou mais completa que a do funcionário)

**Chave:** o email. A BD deles tem 46 418 fichas mas só 35 727 emails diferentes, porque há fichas repetidas para a mesma pessoa. Nós juntamo-las.

| Campo | De onde vem | Preenchido lá |
|---|---|---|
| Nome, email, telefone | `Client` | 100 % |
| NIF | `Client.nif` / `Booking.taxNumber` | ~25 % |
| Nome e morada fiscal | `Client.taxName`, `Booking.taxName` / `taxAddress` | 9–15 % / 4 % |
| Morada | Não existe lá (só a fiscal) | Recolher do nosso lado |
| IBAN | `Client.iban` está **vazio (0 %)** | Recolher do nosso lado (reembolsos, pro) |
| Carros: matrícula, marca, modelo, cor, tipo | `BookingVehicle` (100 % das reservas) + `Vehicle` (carros guardados na conta, 11 855) | Todos os carros que o cliente já trouxe |
| Km e autonomia | `Booking.vehicleKms` (8 %), `vehicleRange` (1,5 %) | Último valor conhecido |
| Língua | `Booking.language` (pt 96 %, en, es) | Para os emails |
| Pro, desconto, avença | `ProClient` (21 clientes, desconto 15 %), `ClientPlan` | Marca e condições |
| Parceiro ou agência que o trouxe | `Booking.partnerId` → `Partner` | Origem do cliente |
| Reservas: datas, parque, valor, pago, método, estado | cópia financeira (B2) | Histórico e métricas: n.º de reservas, gasto, frequência, última vinda |
| Avaliações que deu | `BookingReview` (215) + Google | Satisfação |
| Notas, consentimentos, segmentos (novo, recorrente, VIP, em risco) | Nossos | CRM já existente em /clientes, agora com tabela própria |

### B2. Cópia financeira da reserva — para conferir as caixas

Não é a reserva inteira. É o que serve para conferir dinheiro, **guardado em três momentos e sempre que muda**:

| Momento | O que se guarda |
|---|---|
| Criação | preço (`originalBookingPrice`), linhas de preço (estacionamento, valet, entrega, serviços, taxas, descontos), pago, método, origem, campanha, parceiro e % |
| Entrada (check-in) | preço, pago e método nesse momento |
| Saída (check-out) | preço final, pago, método, linhas de pagamento com a hora (`BookingPricingPayment`) |
| Cada alteração de preço ou de método | valor antes → depois, quem mudou e quando (vem do histórico deles: `modifiedFields`) |

**Conferência da caixa (parques nossos):** o back office recebe as caixas de todo o país. A caixa deles fica fechada na BD 2
(`cashierClosed`/`cashValidated`/`driverValidated`, com quem e quando). O dashboard compara, por parque e por dia, com a
cópia financeira e mostra alertas:
- o preço mudou depois da criação ou da entrada, com quem mudou;
- o método de pagamento na caixa não é o registado;
- o pago na caixa difere do esperado;
- a reserva está na caixa deles e não na nossa cópia, ou ao contrário.

### B3. Parques e serviços (catálogo nosso, para falar com os clientes)

- Lista dos parques com a marca **nosso / terceiro** (ver pergunta 1).
- Serviços extra de cada parque com o preço (207 lá: lavagens, carregamento elétrico, inspeção, polimento de faróis, flex…),
  tipos de entrega e taxas (Express 5–15 €, Noturno 9–20 €, Fim de semana 8–30 €).
- Uso: avisar o cliente antes de chegar ("está a chegar, quer uma lavagem?"), confirmações e pós-venda.
- Atualizado todos os dias a partir da BD 2. É uma cópia de catálogo, não de operação.

### B4. Comunicação com o cliente

A nossa caixa de email, os nossos templates e os avisos (chegada, upsell, avaliação, voo) ficam cá.
Os templates deles só têm confirmação (88) e servem de ideia.

### B5. Funcionários, avaliação e pontos

- **Fica cá:** fichas de RH, ponto, formação, pings do Zello (km, tempo parado, PDA) e a ligação agente ↔ funcionário.
- **Lê da BD 2:** os movimentos que cada funcionário fez, com que carros, quando e onde (`History` pelo `userId`/`agentName`),
  e as fases que fez (check-in e check-out com o seu id).
- A avaliação junta as três fontes: Zello (cá), movimentos (lá) e o perfil do funcionário (cá).

### B6. Marketing e parcerias

Campanhas de publicidade (Google Ads), atribuição (gclid/utm tirados do link de origem), contratos de parceria e as
críticas do Google ficam cá. A percentagem de cada parceiro passa a vir da BD 2:
Top Parking 40 %, Parkos 20 %, Parkvia 23 %, Parkivado 25 %, agências 10–20 %.

---

## C. O que deixa de ser preciso na BD 1

| Hoje | Passa a |
|---|---|
| Importar o histórico de cada reserva (`multipark_booking_history`) | Ler da BD 2. **Guardar o que já temos de antes de 2 mar 2026**: lá esse período só tem o retrato da migração |
| Garagem, lugar e km tirados do histórico | Ler da BD 2 |
| Ocorrências a partir das notas do histórico (`incidents` via parser) | Ler `Occurrence` da BD 2 |
| Colunas operacionais de `multipark_bookings` (fases, agentes, garagem) | Deixar de atualizar. Fica a cópia financeira (B2) e o cliente (B1) |
| Três redes de segurança do sync (hora a hora, janela futura, reconciliação diária) | Podem ficar mais leves. Mantém-se a API e o webhook para a cópia financeira, mais a comparação com a BD 2 |

## D. Limpezas a fazer do lado deles (pedir ao Rafael)

- **41 campanhas de link direto** herdadas do Firebase (ACP, Ordem dos Engenheiros, Clientes Fiéis…), todas com 0 reservas. Retirar.
- 50 mil movimentos marcados `firebase-migration`. É só informação: marcam as reservas migradas.
- Utilizador só de leitura para o dashboard e índices em `History(actionTime)` e `History(bookingId)`.

## E. Perguntas em aberto

1. **Que parques são nossos?** Pelo volume, o grupo é Airpark, Redpark e Skypark (Lisboa, Porto e Faro). Top-Parking Lisboa parou a 11 ago. Os restantes são de marketplace. Confirmar a lista.
2. Qual é a "uma coisa" que não vamos buscar à BD 2?
3. As avaliações dos outros parques: como guardar?
4. Os links e as "reservas agrupadas por origem": o que se quer ver?
5. Vídeos com caminho interno: qual é o endereço base para os abrir?
6. As reservas diferentes entre as duas BD (959 só nossas, 1 225 só deles) ficam para o script à parte, a investigar depois.

## F. Ordem proposta

1. **Ficha do cliente (B1)**: tabela de clientes na BD 1, carregada da BD 2 e das nossas reservas, com as fichas juntas por email.
2. **Cópia financeira (B2)**: preço, pago e método na criação, entrada e saída, mais o registo de alterações.
3. **Catálogo de parques e serviços (B3)**, com a marca nosso/terceiro.
4. **Ficha da reserva a ler a BD 2**: vídeo, assinaturas, histórico com GPS, ocorrências e chat.
5. **Conferência de caixa com alertas (B2)** para o back office.
6. **Avaliação dos funcionários a ler os movimentos da BD 2 (B5).**
7. Desligar o que deixa de ser preciso (C), depois de confirmado o histórico anterior a março.
