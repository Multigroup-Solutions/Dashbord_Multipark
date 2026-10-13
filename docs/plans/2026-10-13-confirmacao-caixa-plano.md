# Confirmação da caixa reserva a reserva — plano (v5)

Data: 13 out 2026 · Pedido do Jorge · Revisor: **João Alves** (utilizador 5326, papel `backoffice`, agente Multipark `cmhds78p50000j1pvbld5rvpp`).
Auditoria adversarial em 5 rondas: v1 35, v2 62, v3 76, v4 88, **v5 APROVADO (93/100), condicionado ao §25**. Respostas aos achados no §21–§24 (+ N6 incorporado no §6.1).

## 0. Objetivo, princípios e papéis

Cada euro de cada dia fica provado, reserva a reserva:

- **Dinheiro**: contado às cegas por quem o tem; 2.ª contagem (ou depósito no banco) independente; o sistema bate com os recebimentos.
- **Multibanco**: cada pagamento MB tem transação do adquirente ou talão, ao cêntimo; cada lote do terminal bate.
- **Online**: cada pagamento online tem prova no prestador (Stripe plataforma, Stripe site ou SIBS), ao cêntimo.
- **Fora do balcão** (PRO, avença, parceiros, agregadores): cada reserva tem a sua linha num documento de faturação.
- **Preço**: lado a lado, o preço quando nasceu (nossa memória), o original da Multipark, o final e o pago. **Para cima pode** (mais tempo, extra, taxa). **Para baixo nunca sem justificação**: vermelho, botão "Justificar", comprovativo.
- **O que está bem só aparece** (verde, recolhido). Na dúvida nunca é verde: **falha fechado**.

Princípios:

1. **Fonte independente** da origem do preço (nossa memória, só acréscimo).
2. **Falha fechado**: corte de dados, leitura em falha, prestador sem resposta, 404, dado em falta → nunca verde; o dia não sela.
3. **Exatidão**: cada valor arredondado ao cêntimo (half-even) antes de somar; tolerância 0,00 €; sub-cêntimos são achado.
4. **Completude e corte**: todo o recebimento entra; tudo o que entra ou sai de um dia selado é detetado, **sem limite de idade**.
5. **Custódia**: condutor → custódio (team leader) → saco numerado → cofre → banco, com saldo que passa de turno para turno.
6. **Segregação**: quem tem o dinheiro conta; o João revê e faz a 2.ª contagem; quem justifica não aprova acima dos limites; o João não valida caixa na Multipark (conforme D2); o extrato bancário é carregado por quem não toca no dinheiro; um terceiro (contabilista) revê mensalmente.
7. **Imutabilidade verificável**: só acréscimo + triggers (se suportados) + cadeia de hashes + **âncora externa por evento crítico** fora do alcance da app + ficheiros com SHA-256.
8. **Cliente como controlo**: recibo digital automático ao cliente com o valor e o método pagos.
9. **Nunca escrevemos na Multipark.**

Papéis:

| Papel | Quem | Faz |
|---|---|---|
| **Condutor** | Quem faz a saída | Recebe; entrega o dinheiro e os talões ao custódio |
| **Custódio** | Team leader do turno (cidade) | Recebe dos condutores; contagem 1 cega **antes** de fechar a caixa na Multipark; saco numerado e selado, fotos; talões e lotes MB; despesas do turno com talão |
| **Revisor** | João Alves | Revê reserva a reserva; contagem 2 cega do saco (ou confirma depósito); justifica; sela o dia. Não valida caixa na Multipark (conforme D2) |
| **Aprovador** | Jorge (super_admin) | Aprova acima dos limites, M5, exceções, reaberturas, fundos, terminais, revisores; amostragem |
| **Tesouraria** | Jorge ou contabilidade (nunca custódio/revisor) | Carrega o extrato bancário (ficheiro do banco) |
| **Auditor externo** | Contabilista | Revisão mensal de selos, amostragem, reaberturas e âncoras |

## 1. Factos que condicionam o desenho

be-multipark `main` (9 out 2026); `production` = `main` + merges até 9 out, sem alterações em preços, pagamentos, caixa ou webhooks (só street-parking/EMEL, `deliveryType` opcional). Página `agent/cashier` do repositório `Multipark` (branch production).

- Ecrã da caixa da Multipark: `CHECKED_OUT` por `checkOutDate` (data, 00:00–23:59), até 1000, dependente do utilizador. Cartões: Total Esperado no Dia (Σ `bookingPrice` não CANCELLED/PENDING), Preço Total Original (Σ `originalBookingPrice`, 0 → `bookingPrice`), **Total Recebido = Σ `BookingPricing.amountPaid`**, Por Receber (com crédito e taxa), Crédito Dado. Fora do balcão conta só o pago. O modal de fecho mostra o esperado e calcula a diferença em tempo real; "em mão" só vai para o Excel.
- `checkOutDate` é **só data**; `checkOut` tem data e hora. Ambos, e `checkOutDriverId/Name`, vêm de quem faz a saída.
- `originalBookingPrice`: 0 nas migradas do Firebase; vindo do cliente na API pública/agregadores; possível backfill.
- `bookingPrice` = Σ `BookingPricing.total`. Crédito, **`BookingFee`** (cobrada pelo agente, **sem linha de pagamento**) e **`serviceFeeAmount`** (marketplace) ficam fora.
- Linhas/pagamentos apagados e recriados em cada recálculo (ids novos, `recordedAt` mantido); redistribuição de excedente cria pagamentos com `recordedAt = agora` e método dominante/"Unknown"; corte de pagamentos quando o total desce; acerto PRO reescreve `recordedAt`. `amountPaid` pode divergir de Σ pagamentos; linhas antigas do Firebase têm `amountPaid` sem pagamentos.
- Pagamentos: amount (pode ser negativo), paymentMethod (texto livre), recordedAt (escolhido pelo cliente no editor/API), **sem "quem registou"**.
- A API pública aceita `*At/*ByName` de validação e `checkOutDriverName` do cliente. O backend não bloqueia edições depois de validada/fechada; a ordem dos 3 passos só é imposta nos endpoints internos.
- Online: Stripe **plataforma** e **site** (PIs do site dão 404 na plataforma; metadata `draft_id`/`park_id`, `booking_id` opcional) e **SIBS** (`splitTransactionId`, método "Online"). Reembolsos em `Cancellation`.
- Fora do balcão com ligação por reserva: `Billing.bookingId`, `ProPayment.bookingIds[]`, `PartnerPayment.bookingIds[]`, pagamentos de avença (`ClientPlanPayment`/consumo).
- Multibanco: só texto, valor, hora.
- History com `snapshot` completo depois de cada evento, campos `userId`, `agentName`, `platform`; sem índice por `bookingId`; algumas escritas de pagamentos sem History.
- Webhook de saída mínimo; não dispara em edições de linhas/pagamentos/validações; `BOOKING_CREATED` pode chegar ~7 min atrasado; autenticação por assinatura HMAC ou só Bearer.

Nosso dashboard: memória do webhook (desde 28/09/2026 19:23) sem crédito/taxa/avença/PI/`serviceFeeAmount`/`checkOutDriverId`/`paymentSource`, `discountApplied` como booleano, cortes a 50/1000/5000/60 000; dia de caixa **D 03:00 → D+1 03:00** (decisão 30a), turnos manhã 03–15 e noite 15–03; despesas do turno por cidade×turno; contagem atual não cega e editável; `booking_initial_prices` sobrescrita; Stripe 404 = "sem conclusão"; `/api/file` sem cidade; MCP pessoal lê tudo; app com Gmail `gmail.modify`; storage S3/Vercel Blob com credenciais que apagam.

## 2. Decisões do Jorge

Decididas pelo Jorge a 13 out 2026 (D3 por confirmar depois de explicada). Onde o resto do plano diga outra coisa, vale esta tabela.

| # | Decisão | Decidido |
|---|---|---|
| D1 | Fluxo físico | Condutores entregam ao **team leader** (custódio), que conta, valida na Multipark e regista o valor recebido; **envelope selado no cofre**; o **João, no dia seguinte**, faz a confirmação na dashboard (conta o envelope = contagem 2) e valida os valores. Tudo certo → não acontece nada. Falta **> 10 €** (já descontadas as despesas do turno) → o João fecha, mas fica **à espera da aprovação do Jorge** |
| D2 | João valida na Multipark? | **Não** — o João valida **só na dashboard** (M5 fica só para exceções) |
| D3 | Ordem contar → fechar na Multipark | **Por confirmar** (explicação enviada ao Jorge a 13 out) |
| D8 | João vê o esperado na Multipark? | **Sim, mantém** — tem de perceber o que se passa e procurar o porquê. A contagem 2 do João deixa de ser cega; fica como risco residual (§20), mitigado pela comparação com a contagem 1 do team leader (G2) |
| D4 | Aprovações | O João **pode fechar o dia e justificar** tudo com explicação; **tudo o que ele justificar fica amarelo "à espera do Jorge"** para o Jorge ver e aprovar depois (não bloqueia o fecho). Falta de dinheiro > 10 € na gaveta é sempre para o Jorge. Os limites 20 €/dia e 100 €/mês e a amostragem deixam de ser precisos: o Jorge revê tudo o que foi justificado |
| D5 | Prestadores | **Stripe** (o Jorge cria uma chave de leitura para a dashboard; confirmar se cobre também a conta do site) e **Viva Wallet** (terminais Multibanco). **Sem SIBS** — tudo o que é SIBS sai do plano; um pagamento "Online" sem prova Stripe é vermelho |
| D6 | Multibanco | Para já **só a foto dos talões** (com IA a ler e o João a confirmar); deixar preparado para ligar à **API da Viva Wallet** (já existe integração `server/external/vivaWallet.ts`) para ficar verde automático |
| D7 | Recibo ao cliente | **Não** — o §16 sai do plano; risco residual (§20) |

**Efeito no selo (§10) e nas aprovações (§11):** o João sela o dia mesmo com justificações pendentes; o dia fica "**selado pelo João — à espera do Jorge**" até o Jorge aprovar todas as justificações (amarelas). Cada aprovação do Jorge é um evento com âncora. Uma justificação recusada pelo Jorge volta a vermelho e reabre o dia.

## 3. O dia, a gaveta e os universos

- **Dia operacional** D 03:00 → D+1 03:00 (Lisboa); turnos manhã 03–15 e noite 15–03.
- **Gaveta** = cidade × turno (unidade física de custódia). Parque só informativo.
- **Universo A — saídas do dia**: `CHECKED_OUT` com `checkOut` (data e hora) no dia operacional; `checkOutDate` só como intervalo largo (D−1..D+1) para usar o índice.
- **Universo B — recebimentos do dia noutras reservas**: aumentos de dinheiro/MB (§8) atribuídos às gavetas do dia em reservas fora do A.
- **Universo C — fugas**, por duas vias:
  - **transições** vistas nos nossos retratos: depois do check-in → CANCELLED/BOOKED/PENDING; CHECKED_OUT → outro estado; mudança para parque que não revemos;
  - **atributos** (apanha o que aconteceu entre duas varreduras): reservas CANCELLED/BOOKED/PENDING, atualizadas no dia, com `checkInDriverId` ou `checkingInAt` preenchidos, ou com evento de check-in (CHECKING_IN/CHECK_IN) no History. **Não** se usa `checkIn` (é obrigatório e tem sempre a hora prevista). Teste: cancelamento normal sem check-in não entra no C.
  - Pertence à gaveta em que a detetámos pela primeira vez. Vermelho. Mais: CHECKED_IN com mais de 12 h para lá do check-out previsto → amarelo "saída em atraso".
- **Faixa "como na Multipark"**: os 5 cartões recalculados como o endpoint deles (por `checkOutDate`, 00–24, fora do balcão, sem filtros nem limite), com a explicação da diferença para as gavetas.

## 4. Origem do preço e base

Origens:
1. **M-payload**: `bookingPrice` do corpo cru do `BOOKING_CREATED`; confiança alta só com `sigOk` (HMAC válido) e `payloadHash` guardados; só Bearer → confiança média.
2. **M-leitura**: retrato da nossa memória lido da BD até 120 s depois do `eventCreatedAt`, com linhas, pagamentos, crédito, taxa, campanha (id e %), PRO (% numérica), avença, parceiro, `paymentSource`, PI/charge, `serviceFeeAmount`.
3. **Dependentes**: History `CREATED.snapshot`, `originalBookingPrice` (P2), `booking_initial_prices` (import, só acréscimo).

**Base**: se há M-* → máximo das M-* (P2 e dependentes não entram); se não há → máximo das dependentes (O3).

- O1 `origin_conflict` — origens não coincidem: vermelho se P2 < M-*; amarelo nos outros casos.
- O2 `origin_late` — só M-leitura tardia: amarelo.
- O3 `no_independent_origin` — nunca verde por omissão: amarelo de revisão; vermelho se P3 < qualquer dependente.
- Cobertura de webhooks por parque (R27): parque sem `BOOKING_CREATED` para reservas criadas → o selo desse parque bloqueia.

## 5. Regras por reserva

**Variação do preço** (P3 contra a base):
- V1 subida explicada → verde: PARKING maior com `checkOut` real > reservado; SERVICE com `extraServiceId` + History `EXTRA_SERVICE_ADDED(_CHECKIN)`; FEE criada no check-in/out; VALET/PARKING por mudança de entrega/parque/veículo no History.
- V2 subida sem causa → amarelo.
- V3 descida → **vermelho**. Exceções verdes só com atributos na origem M-*: PRO com % na origem; campanha com id e % na origem e não editada depois; avença desde a origem.
- V4 linha negativa fora de "Desconto campanha"/"Desconto PRO" justificadas → vermelho.
- V5 `down_explained` — descida **antes do check-in** por alteração de datas/extras/entrega feita **pelo cliente**: `History.userId` = id do cliente no serviço de utilizadores, obtido pela ligação explícita `customerId` → email do `Client` → id no serviço de utilizadores, ou um utilizador técnico de uma **lista fechada** (site/API pública); **nunca** um id da lista de agentes, e `'system'` nunca conta como cliente (é usado por fluxos internos); o `platform` não conta (vem do corpo do pedido). Com reembolso no prestador igual à descida (se já estava pago) → verde com a prova anexada automaticamente; sem reembolso → **amarelo**, nunca verde automático. Depois do check-in, ou feita por agente → V3.

**Pagamento**:
- P1 `underpaid` — (P3 − crédito + `serviceFeeAmount` quando cobrado no balcão) − Σ pagamentos > 0 numa reserva de balcão → vermelho. **A `BookingFee` não entra aqui** (ver P8).
- P2 `overpaid` → amarelo.
- P3 `credit_given` — vermelho; amarelo só com reclamação/perdido **anterior** ao crédito, decidida por pessoa que não o revisor nem o condutor, valor ≥ crédito.
- P4 `negative_payment` → vermelho.
- P5 `unknown_method` → vermelho.
- P6 `refund` — confirmado no prestador → amarelo; não confirmado → vermelho.
- P7 `paid_ledger_mismatch` — `amountPaid` de uma linha ≠ Σ dos seus pagamentos → vermelho; **exceção**: linha sem nenhum pagamento em reserva migrada do Firebase (`originalBookingPrice = 0` e origem anterior à memória) → amarelo "linha antiga sem registo".
- P8 `booking_fee` — `BookingFee` > 0: o custódio indica, na sua gaveta, se a recebeu em **dinheiro ou MB** (um toque por reserva, antes da contagem 1); entra no esperado do método escolhido; sem indicação → vermelho. Testes com taxa em dinheiro e em MB.
- P9 `off_counter_mismatch` — método fora do balcão numa reserva sem atributos fora do balcão na origem → vermelho.
- P10 `transfer_unproven` — transferência bancária → vermelho até corresponder a um movimento do extrato carregado pela tesouraria (§6.4) ou aprovação.
- P11 `off_counter_by_agent` — aumento de um método fora do balcão (PRO_PLAN, Crédito, CLIENT_PLAN, parceiro) feito por um **agente**, e não pelos fluxos de acerto (PRO, parceiro, avença, ledger de entidade) → **vermelho imediato**, mesmo em reserva PRO/parceiro legítima. Como se sabe:
  - "na saída" = `recordedAt` a ±15 min de `checkOut` **e** evento de saída no History;
  - "pelo editor" = History com diff de `pricings` que introduz o método, com `userId` de agente;
  - os fluxos de acerto escrevem sem History e correspondem a um documento de acerto (abaixo) → não contam.
  - Antes de ativar: consulta de diagnóstico de 90 dias (quantos pagamentos fora do balcão nasceram na saída ou no editor em reservas PRO/parceiro) e **regra de negócio escrita** para a extensão PRO na saída (se a extensão de uma reserva PRO é faturada no acerto, aceita-se com documento; senão é balcão).
  - Testes: "PRO_PLAN" pelo editor numa reserva PRO; "PRO_PLAN" na saída; acerto PRO legítimo.

**Fora do balcão legítimo**: cinzento; cada reserva tem de estar num **documento de acerto**: `ProPayment`, `PartnerPayment` ou `ClientPlanPayment` com a reserva em `bookingIds`, ou fatura de entidade (`Billing` com `bookingId` nulo ligada ao mesmo acerto). **`Billing.bookingId` (fatura normal da reserva) não serve de prova.**
- Conciliado = documento existe, **não está PENDING** (pago), e Σ dos valores devidos das reservas do documento = `amount` do documento (tolerância 0,00 €), com o **valor devido definido por tipo**: parceiro = `partnerAmountDue` da reserva (comissão já descontada); PRO = preço depois do desconto PRO (considerando `parkSplits` quando o documento cobre vários parques); avença = quota/consumo da reserva. Fórmulas validadas na fase 0 com documentos reais antes de ativar; enquanto não validadas → cinzento "por validar", não verde.
- Documento PENDING → cinzento "por receber da entidade", com aviso de idade a partir de 60 dias.
- Sem documento até ao fecho do mês seguinte → vermelho, reabre o dia. Implementado na **fase 5**.

**Validações da Multipark** (3 ícones com quem/quando):
- M1 entregue sem `cashierClosed` → amarelo com prazo (§10).
- M2 violação de ordem → vermelho.
- M3 alteração **humana**, ou que mude o acumulado (§8), depois do nosso primeiro visto da validação ou do `actionTime` do History (nunca `cashValidatedAt` declarado) → vermelho. Operações automáticas classificadas (§8) não contam.
- M4 reaberta → vermelho.
- M5 validador (`*ById`) na lista fixa de ids de agente do João, ou o João editou linhas/pagamentos no History → aprovador (com D2 = sim é exceção).
- M6 `*ByName` sem `*ById` ou incoerente → vermelho.

**Integridade**:
- I1 `recorded_at_suspect` — um **aumento** do acumulado (§8) cujo `recordedAt` declarado é antes da criação, > 48 h antes/depois do nosso primeiro visto desse aumento, ou incoerente com check-in/out → vermelho. Aumentos já existentes à data de arranque → "pré-existente" (§8).
- I2 `method_switched` — dinheiro acumulado mudou de método (fora das operações automáticas) → vermelho.
- I3 online sem prova → vermelho.
- I4 leitura cortada → o dia não sela.
- I5 sub-cêntimo → amarelo.

## 6. Dinheiro: gaveta, trânsito, contagens, cofre e banco

**6.1 Trânsito com o condutor** (passo nosso, não depende da Multipark)
- Cada aumento de dinheiro/MB de balcão (§8) nasce "em trânsito" com quem o recebeu:
  - na saída → `checkOutDriverId`;
  - no check-in → `checkInDriverId`;
  - noutros casos (editor de preços, reserva cancelada com pagamento, sem condutor identificável) → "por confirmar pelo custódio" do turno em que o aumento foi visto: entra na lista do custódio como os outros, com a opção "não recebido" (→ vermelho); nunca entra na gaveta sem confirmação.
- **Lista fresca**: abrir o fluxo da gaveta e gravar a contagem 1 obriga a uma **releitura ao vivo** das reservas da cidade com pagamentos ou saídas no dia operacional (primeiro visto atualizado nesse momento); a contagem 1 (valor, foto, saco) grava-se **sempre**, com âncora — se a releitura falhar ou vier cortada, o que falha fechado é só a confirmação da lista e o cálculo de G1, que ficam "pendentes de releitura" (uma releitura posterior nunca altera a contagem 1). Testes: saída às 14:50 aparece na lista às 15:00; Multipark em baixo no fecho do turno.
- O custódio fecha o trânsito no fluxo da gaveta com **"Recebi do condutor X"**, por condutor × turno: o ecrã mostra a lista dos aumentos desse condutor (reserva, valor, método) e o custódio confirma com um toque (ou marca linhas como "não recebido" → vermelho imediato). A hora é a do nosso servidor, sem atraso de varredura.
- `driverValidated` da Multipark serve só de confirmação extra nas saídas (divergência entre os dois → amarelo).
- O dinheiro entra na gaveta do turno em que o custódio confirmou. Em trânsito há mais de 2 h depois do fim do turno em que foi recebido → vermelho por condutor ("dinheiro por entregar").
- Testes: pago no check-in; reserva cancelada com pagamento; pagamento pelo editor; saída no fim do turno entregue no turno seguinte; condutor que entrega só parte.

**6.2 Esperado da gaveta**
```
abertura   = contagem 1 da gaveta anterior da cidade (saldo que passa de turno para turno; 1.ª vez = fundo de caixa aprovado);
             uma diferença G2 resolvida entra como movimento explícito da gaveta, aprovado (nunca altera a contagem 1)
esperado   = abertura
           + Σ dinheiro entregue à gaveta (6.1, A + B)
           + Σ BookingFee indicadas em dinheiro (P8)
           − Σ despesas do turno da gaveta (só do custódio, com talão, criadas no turno)
           − Σ sacos retirados (6.3)
G1         = contagem 1 − esperado   (sempre a 1.ª contagem; recontagens só explicam)
```
Os "gastos da contagem" atuais (`cash_count_expenses`) **deixam de entrar** (no R24 e no Por dia), substituídos pelas despesas do turno.

**6.3 Contagens e saco**
- **Contagem 1 (custódio, cega)**: no fecho do turno, na passagem de turno; o servidor não devolve o esperado (app, `/api/v1`, MCP, Excel) antes da contagem 1; foto do dinheiro e do saco selado com o n.º; nunca editável. Ordem obrigatória (D3): `contagem1.at` < **hora efetiva** do primeiro `cashierClosed` de qualquer reserva da gaveta; senão G1 marcado "não cega" → aprovador. Procedimento escrito para os custódios: nada se fecha na Multipark antes da contagem 1.
- **Hora efetiva de uma validação/fecho** = a mais antiga entre `*At` (posto pelo servidor nos endpoints internos), `History.actionTime` do evento e o nosso primeiro visto. `*At` e History a divergir mais de 5 min → M6 vermelho (o `*At` pode vir forjado da API pública).
- **Consulta leve às validações**: só os campos de validação (com `*At`/`*ById`) das reservas do dia, de 5 em 5 min nas janelas 13:00–16:00 e 01:00–04:00 (fins de turno) e de 30 em 30 min no resto, pelo índice `parkId, status, checkOutDate`. Reduz o atraso do primeiro visto para ≤ 5 min nos fins de turno.
- Teste: fecho na Multipark antes da contagem com a varredura atrasada → "não cega".
- **Contagem 2 (João, cega)** — D1 recomendado: ao receber o saco; o ecrã esconde valores de dinheiro (total e por reserva) da gaveta até a contagem 2 estar gravada. G2 = contagem 2 − contagem 1 ≠ 0 → vermelho.
- **Saco**: n.º único, gaveta de origem, valor da contagem 1 e 2, quem levou, quando, para onde (cofre/banco). Saldo do **cofre** da cidade = Σ sacos entrados − Σ sacos depositados; conferência semanal do cofre pelo João (contagem cega dos sacos selados) → G4 `safe_mismatch`.
- **Depósito**: talão de depósito com o n.º do saco; G3 = movimento do extrato ≠ valor do saco, ou sem movimento até D+3 → vermelho.

**6.4 Extrato bancário (fase 1)**
- Carregado pela **tesouraria** (Jorge ou contabilidade; nunca custódio nem revisor) como ficheiro do banco (CSV/OFX/PDF original), com SHA-256 e quem/quando; ou por exportação direta do banco quando disponível.
- Serve G3 (depósitos) e P10 (transferências). Sem extrato carregado → G3/P10 ficam vermelhos (exceção com prazo possível).

**6.5 Fundo de caixa**: por cidade, com data de efeito, só o aprovador altera, cada alteração gera evento e aviso ao auditor externo.

**6.6 Despesas que abatem**: só do custódio do turno, com talão obrigatório, criadas dentro do turno; o João não cria nem edita; criada/anulada depois da contagem 1 ou do selo → reabre.

## 7. Multibanco

- **Terminais**: lista fechada de TID por cidade/parque (só aprovador).
- **Feed do adquirente** (Viva já integrada; outros se houver) → verde automático, transação guardada como prova.
- **Talão** (sem feed): fotografado pelo custódio no turno (ou pelo João); comprimido no browser; SHA-256 (**duplicado exato bloqueia**) e hash percetual (**quase-duplicado só assinala**); IA lê valor, data/hora, TID, últimos 4, autorização, tipo; campos da IA gravados; alteração humana → assinalada, aprovador.
- Bate quando: valor = pagamento, TID na lista, data no dia operacional, tipo compra, (TID + autorização + valor + data) único em todo o histórico.
- **Lote do terminal** (Z) por **terminal × lote**, com a hora do fecho do lote: Σ vendas − anulações − devoluções = Σ talões do TID nessa janela = Σ pagamentos MB nessa janela. Talões de turnos ainda sem lote → pendente (não vermelho) até ao fecho do lote. Terminal da lista sem lote em 26 h → vermelho.
- Talão sem pagamento → MB2 vermelho.

## 8. Acumulado, primeiro visto e operações automáticas

- Unidade de conciliação: **acumulado por (reserva × método)**, Σ dos pagamentos (cêntimos, half-even).
- Em cada retrato (webhook, varredura, revisão) comparamos o acumulado com o anterior:
  - **Aumento** → evento com primeiro visto, gaveta (via 6.1), `recordedAt` declarado (para I1).
  - **Descida** → imputada à gaveta do **aumento mais recente** desse (reserva × método) → D1 nessa gaveta.
  - **Igual** → nada, mesmo que ids/`recordedAt` mudem.
- Operações automáticas da Multipark, reconhecidas antes de qualquer D1/M3/I2:
  - **Recriação** (recálculo): ids novos, mesmo acumulado por método → ignorada.
  - **Redistribuição**: Σ da reserva constante; transferência entre métodos para o dominante/"Unknown" com `recordedAt` = hora do recálculo → evento "redistribuição" (amarelo se envolve dinheiro; I2 só se o dinheiro passa a Online/fora do balcão).
  - **Corte**: descida do acumulado igual à descida do total da linha no mesmo retrato → evento "corte" (amarelo; vermelho se a linha era de dinheiro já entregue a uma gaveta selada → D1).
  - **Acerto PRO**: só `recordedAt` muda → ignorado.
  - Cada uma com testes.
- **Arranque**: primeiro visto inicial semeado a partir dos `receivedAt` dos retratos da memória com `detailJson` (desde 28/09); pagamentos anteriores → "pré-existente" (amarelo, sem I1). Data de corte: o 1.º dia selado é o dia seguinte ao arranque da fase 6.

**Vigilância dos dias selados (sem limite de idade)**:
- **Fluxo de alterações**: reservas com `Booking.updatedAt`, `BookingPricing.updatedAt`, `Credit.updatedAt`, `BookingFee.updatedAt` posteriores ao último cursor, e pagamentos novos → relidas; se pertencem (ou passam a pertencer) a um dia selado → hash do estado por reserva comparado com o do selo.
- **Na atribuição**: um aumento/descida/transição que cai numa gaveta selada → D1 imediato.
- **Releitura rotativa**: todas as reservas seladas relidas por ids num ciclo de 30 dias (apanha o que não mexe em `updatedAt`, como o acerto PRO).
- Selo guarda **hash do estado por reserva** (preço, linhas, pagamentos, crédito, taxa, validações), não somas.
- Orçamento: corridas parciais com cursor (como a varredura atual), cobertura medida; ciclo incompleto em 30 dias → alerta.

## 9. Online

- `CASH_STRIPE_CHECK` ligado; chave restrita da conta Stripe do site; SIBS por `splitTransactionId` (API ou relatório); sem acesso → vermelho "não verificável".
- A classe do pagamento online (Stripe plataforma, Stripe site, SIBS) vem **da prova**, não do texto do método.
- Vínculo: link SETTLED → `WebsiteCheckout` (metadata `draft_id` → `WebsiteCheckout.bookingId`, `park_id`) → Booking PI/charge → Billing.
- Verificar: `succeeded`, `amount_received` = parte da reserva (+ `serviceFeeAmount`), `currency=eur`, `livemode`, vínculo à reserva e ao parque, sem reembolso/disputa não explicado.
- PIs vindos da API pública sem vínculo verificável: unicidade + valor + data + parque → **amarelo**, nunca verde.
- 404/timeout/conta desconhecida → vermelho "não verificável".
- Unicidade global de PI/charge/SIBS em todo o histórico (S5). Reembolsos/disputas com paginação completa.

## 10. Selo (por cidade e dia)

Selar exige: gavetas com contagem 1 (G1 = 0, ≤ 1 € auto-justificado, ou justificado/aprovado) e contagem 2 ou depósito (ou pendente D+3); MB conciliado (lotes pendentes permitidos até ao fecho do lote); online verificado; nenhum vermelho por justificar; aprovações feitas; M1 resolvido ou exceção; leituras completas; cobertura de webhooks OK.

**Exceções com prazo**: só o aprovador; lista explícita, prazo, escalada; vencida → vermelho diário.

Selo canónico com: 5 cartões, gavetas, contagens, sacos, MB, online, perdas, **hash do estado por reserva**, despesas, ids de justificações e ficheiros, hash do selo anterior da cidade. Relatório PDF + Excel com o hash.

## 11. Justificar e aprovar

- Motivo de lista fechada; explicação ≥ 20 carateres; valor calculado; comprovativo obrigatório nas perdas; ficheiros com SHA-256.
- **Desconto comercial**: exige autorização registada **antes da saída** no módulo de autorizações (fase 5), por pessoa fora da cadeia de custódia do turno (supervisor; Jorge acima de 20 €).
- "Noutro parque/dia": transferência com duas pontas que soma zero e consome a sobra.
- "Corrigido na Multipark": bloqueia o selo (ou exceção); só conta se a correção no History for de alguém que não o revisor nem o condutor e não mover o valor para fora do balcão.
- Aprovador: acima dos limites D4, M5, G1 > 1 €, G2, G3, G4, MB2, S5, P9, P11, "não cega". Amostragem semanal de 10 % das auto-aprovadas (com registo). Revisão mensal pelo auditor externo.
- Justificar, aprovar, contar, fechar, reabrir: **só em sessão interativa** (nunca MCP nem chaves de API).

## 12. Trilho, imutabilidade e âncora

- Tabelas novas só acréscimo, com teste-guarda; **triggers `BEFORE UPDATE/DELETE`** se o MySQL de produção os suportar (verificar na fase 0) com o utilizador da app sem `TRIGGER`/`SUPER`; se não suportar, fica escrito e a garantia passa a ser a âncora.
- Cadeia de hashes por cidade em `cash_confirm_events`.
- **Âncora por evento crítico** (contagem 1, contagem 2, saco, aprovação, selo, reabertura, alteração de fundo/terminal/revisor): cada evento escrito num bucket com **Object Lock / WORM** com credenciais só de escrita, separadas das da app; **resumo diário por email** com o hash da cadeia (e a lista de eventos críticos do dia) para um destinatário **fora de qualquer caixa ligada à app** (ex.: email da contabilidade).
- Ficheiros em `cash/confirm/<cidade>/...` no mesmo bucket bloqueado (ou cópia).

Tabelas: `cash_confirm_events`, `_items`, `_justifications`, `_approvals`, `_files`, `_counts`, `_bags`, `_safe_checks`, `_mb`, `_terminal_batches`, `_psp_ids`, `_accumulated` (aumentos/descidas por reserva×método com primeiro visto e gaveta), `_transits`, `_seals`, `_anchors`, `_bank_statements`, `_bank_lines`, `_authorizations` (descontos), `_receipts_sent` (recibos ao cliente). Mutáveis com evento: `_days`, `cash_drawer_floats`, `cash_terminals`, `cash_reviewer_agents`, `_fee_methods` (P8).
Memória do webhook: + crédito, taxa, avença, PI/charge, `serviceFeeAmount`, `checkOutDriverId`, `paymentSource`, `partnerId`, `discountApplied` numérico, campanha e %, `sigOk`, corpo cru do `BOOKING_CREATED`. `booking_initial_prices` passa a só acréscimo.

## 13. Dicionário de métodos

`shared/paymentMethodKind.ts`, único, a partir da consulta de diagnóstico (valores distintos de 12 meses), correspondência exata normalizada; classes `cash`, `card_terminal`, `online` (subclasse pela prova), `transfer`, `off_counter`, `unknown`; "Cartão de crédito" → `card_terminal`, "Crédito" → `off_counter`; valor novo → `unknown` (P5) + alerta.

## 14. Permissões

- `caixa` passa a só poder ser dada pelo super_admin.
- João: `caixa` ver+editar nas suas cidades, `finance.view_totals`. Custódios: só o fluxo da gaveta do seu turno. Tesouraria: só extratos.
- `/api/file` com regra por cidade para `cash/confirm/<cidade>`.
- Esperado e valores de dinheiro da gaveta não saem antes das contagens (app, `/api/v1`, MCP).
- Alterações aos agentes da lista de revisores (incl. `identityLinks.*` pelo MCP) → alerta ao super_admin.

## 15. Leituras da Multipark e desempenho

Paginadas, sem cortes (I4); History só por exceção com limite de tempo; fonte principal = memória e retratos; fluxo de alterações por `updatedAt`; pedir índices à Multipark.

## 16. Recibo ao cliente (D7)

No **primeiro `cashierClosed`** (estado final; ou 24 h depois da saída se ainda não fechou), email/SMS ao cliente: reserva, valor total, pago por método, crédito/desconto. Qualquer alteração do acumulado por método depois do envio → **recibo corrigido** ao cliente + achado amarelo. Quem cobrou menos ou noutro método é exposto pelo próprio cliente; respostas do cliente entram como reclamação. Fase 5. Na fase 0 (com a D7): contactos lidos ao vivo da Multipark no envio (a memória redige-os), base legal RGPD (execução do contrato / interesse legítimo, texto revisto), e confirmar se a Multipark já envia recibo, para não duplicar.

## 17. Ecrã

Separador "Confirmação" em `/caixa`: cidade → dia → turno.
1. Faixa "como na Multipark" + explicação.
2. Gavetas: trânsito por condutor, contagem 1 (sem esperado até contar), contagem 2 (sem valores até contar), sacos, cofre, despesas, taxas por método (P8), diferença.
3. MB por terminal/lote, Online por prestador, fora do balcão por documento.
4. Tabela reserva a reserva (só não-verdes por omissão): cliente · matrícula · condutor · M-payload · M-leitura · P2 · P3 · pago por método · crédito/taxa · validações · cor · ação.
5. Universos B e C, exceções, aprovações, Selar (com o que falta), Relatório.

## 18. Fases

0. **Levantamento final**: diagnóstico de métodos; D1–D8; triggers no MySQL; chave Stripe do site; SIBS; TIDs; bucket WORM; destinatário da âncora.
1. **Memória e leituras**: campos em falta, corpo cru do CREATED, acumulado e primeiro visto (semeado), trânsito, leitores paginados com falha fechado, dicionário, correção R24/Por dia/`fileRoute`, compressão de fotos.
2. **Motor de achados**: regras §4–§9 como funções puras; testes por regra, exceção, operação automática e cada cenário de fraude das auditorias.
3. **Trilho**: tabelas, triggers, cadeia, âncoras, unicidade PSP, extrato.
4. **Gaveta e custódia**: contagem 1 na passagem de turno (antes do fecho na Multipark), sacos, cofre, contagem 2, depósito, despesas restritas, P8.
5. **Ecrã, MB (IA + lotes), online (2 Stripe + SIBS), fora do balcão por documento, autorizações de desconto, recibo ao cliente, justificar/aprovar.**
6. **Selo e vigilância** (fluxo de alterações, releitura rotativa), relatórios.
7. **Modo sombra 2 semanas**: 5 cartões = Multipark em 100 % dos dias; 0 falsos verdes em 100 reservas revistas à mão; todos os cenários de fraude das quatro auditorias simulados e apanhados; 0 vermelhos falsos do Universo C em cancelamentos normais; 0 G1 de fronteira de turno causados pela lista de trânsito; tempo do João medido (meta ≤ 2 h/dia no total; acima disso, plano de redução: feeds de adquirente, auto-verdes com prova automática).
8. **Fase 2**: payouts/comissões Stripe e SIBS ligados ao banco; extrato automático.

## 19. Pedidos à Multipark (Rafael)

1. Bloquear no backend edições depois de validada/fechada; ordem dos 3 passos em todos os caminhos; não aceitar `*At/*ByName` do cliente.
2. "Quem registou" em cada pagamento; `recordedAt` do servidor.
3. `BookingFee` como pagamento com método.
4. Guardar "em mão" do fecho.
5. Webhook em edições de linhas/pagamentos/correção/final-price/validações/reembolsos.
6. Permissão no `cashier/multi-park`; índices `History(bookingId)`, `BookingPricingPayment(recordedAt)`.
7. Dizer se o backfill do `originalBookingPrice` correu.

## 20. Riscos residuais aceites (por escrito)

- Quem fecha na Multipark vê o esperado (mitigado pela ordem contagem 1 → fecho medida pela hora efetiva e pela 2.ª contagem).
- **D8 = manter (decidido)**: o João vê o esperado na Multipark; a contagem 2 não é cega (mitigado por G2 contra a contagem 1 do team leader e pela revisão do Jorge).
- **D7 = sem recibo (decidido)**: conluio custódio + condutor (cobrar ao cliente por fora ou noutro método) fica mais difícil de apanhar; mitigado por P9/P11, contagem 2, Stripe/talões, revisão do Jorge de tudo o que é justificado e auditor externo.
- **D4 = João fecha e justifica, Jorge aprova depois (decidido)**: o controlo do Jorge é posterior (detetivo), não preventivo; mitigado por o dia ficar "à espera do Jorge" e por recusa reabrir o dia.
- Se o MySQL não suportar triggers, a imutabilidade antes da âncora depende do código (mitigado pela âncora por evento crítico).

## 21. Resposta à auditoria v1

| # | Resolução |
|---|---|
| 1 | P9 + P11 + fora do balcão por documento de faturação por reserva (§5) |
| 2 | Fluxo de alterações + atribuição + releitura rotativa, sem limite de idade (§8) |
| 3 | Saldo turno a turno, sacos, cofre, depósito, extrato pela tesouraria (§6) |
| 4 | P8 com método indicado pelo custódio, fora do P1 (§5) |
| 5 | 2 Stripe + SIBS, 404 vermelho, `serviceFeeAmount`, vínculo `draft_id`, unicidade global (§9) |
| 6 | Esperado escondido, ordem contagem 1 → fecho (D3), contagem 2 cega (§6) |
| 7 | Acumulado por reserva×método com operações automáticas especificadas (§8) |
| 8 | O3 (§4) |
| 9 | M-payload com `sigOk`, M-leitura ≤ 120 s, O2 (§4) |
| 10 | Campos na memória (§12, fase 1) |
| 11 | I4 (§5, §15) |
| 12 | P7 com exceção Firebase (§5) |
| 13 | M3/M5/M6 (§5) |
| 14 | TIDs, lotes, SHA bloqueia, phash assinala, IA gravada (§7) |
| 15 | Limites com teto mensal, amostragem, autorizações prévias (§11) |
| 16 | "Corrigido na Multipark" (§11) |
| 17 | Janela 03:00, gaveta cidade×turno, trânsito, `checkOut` com hora (§3, §6) |
| 18 | Despesas restritas; gastos da contagem retirados (§6) |
| 19 | Triggers, âncora por evento crítico fora da app, WORM (§12) |
| 20 | History por exceção, fluxo de alterações, cobertura (§8, §15) |
| 21 | Universo C por transições (§3) |
| 22–31 | Transferência de duas pontas; créditos com reclamação anterior e terceiro; campanha na origem; P10; dicionário exato; permissões; exceções com prazo; faixa igual ao endpoint; half-even; production verificado |

## 22. Resposta à auditoria v2

| # | Grav. | Resolução |
|---|---|---|
| 1 | ALTO | Taxa fora do P1; P8 com método (dinheiro/MB) indicado pelo custódio; testes (§5) |
| 2 | ALTO | Universo C por transições + dia = gaveta do primeiro visto; CHECKED_IN em atraso amarelo (§3) |
| 3 | ALTO | Primeiro visto sobre aumentos do acumulado; descidas à gaveta do aumento mais recente; algoritmos das 4 operações automáticas; testes (§8) |
| 4 | ALTO | Ordem contagem 1 antes do 1.º `cashierClosed` da gaveta; senão "não cega" → aprovador; D3 (§2, §6) |
| 5 | ALTO | D1–D3 desenhadas com opção recomendada e alternativa; confirmação do Jorge antes da aprovação final e da fase 4; D4–D7 com data-limite (§2) |
| 6 | ALTO | Base: P2 só sem M-*; V5 descida explicada antes do check-in com prova (§4, §5) |
| 7 | ALTO | Trânsito com o condutor até ao 1.º `driverValidated`; imputação ao turno da entrega; > 2 h vermelho (§6.1) |
| 8 | ALTO | Extrato carregado pela tesouraria (nunca custódio/revisor) com SHA na fase 1; sem extrato → vermelho (§6.4) |
| 9 | ALTO | Fora do balcão por `Billing.bookingId` / `ProPayment.bookingIds` / `PartnerPayment.bookingIds` / avença; P11 na saída; fase 5 (§5) |
| 10 | MÉDIO | `draft_id` → `WebsiteCheckout`; API pública amarelo (§9) |
| 11 | MÉDIO | Valores de dinheiro escondidos até à contagem 2 (§6.3, §17) |
| 12 | MÉDIO | Universo A por `checkOut` (data e hora) (§3) |
| 13 | MÉDIO | Fluxo de alterações por `updatedAt`, atribuição, releitura rotativa, hash por reserva; sem contradição de idade (§8) |
| 14 | MÉDIO | SHA bloqueia, phash só assinala, unicidade por campos (§7) |
| 15 | MÉDIO | Lote por terminal×lote; pendente até ao lote (§7) |
| 16 | MÉDIO | Âncora por evento crítico, destinatário fora da app, WORM; triggers verificados na fase 0 (§12) |
| 17 | MÉDIO | Módulo de autorizações na fase 5, autorizador fora da custódia; recibo ao cliente (§11, §16) |
| 18 | MÉDIO | M3 com classificação das operações automáticas (§5) |
| 19 | MÉDIO | Primeiro visto semeado da memória; "pré-existente"; data de corte (§8) |
| 20 | MÉDIO | G1 ≤ 1 € auto-justificável; meta e plano de redução do tempo (§10, §18) |
| 21 | BAIXO | Classe online pela prova (§9) |
| 22 | BAIXO | `sigOk` + `payloadHash`; Bearer = confiança média (§4) |
| 23 | BAIXO | Auditor externo mensal (§0, §11) |

## 23. Resposta à auditoria v3

| # | Grav. | Resolução |
|---|---|---|
| 1 | ALTO | Trânsito fechado por um passo nosso "Recebi do condutor X" por condutor × turno; check-in → `checkInDriverId`; editor/cancelada → custódio; `driverValidated` só confirmação; testes (§6.1) |
| 2 | ALTO | Hora efetiva = mais antiga de `*At`/History/primeiro visto; divergência > 5 min → M6; consulta leve de 5 em 5 min nos fins de turno; D3 por hora efetiva; procedimento escrito; teste (§6.3) |
| 3 | ALTO | Prova só por `ProPayment`/`PartnerPayment`/`ClientPlanPayment` (ou fatura de entidade com `bookingId` nulo), não PENDING, Σ = `amount`; `Billing.bookingId` excluído; P11 abrange o editor; testes (§5) |
| 4 | MÉDIO | "Na saída" por `recordedAt` ±15 min + evento de saída; diagnóstico 90 dias; regra escrita da extensão PRO (§5 P11) |
| 5 | MÉDIO | Alternativas D2 (prazo D+2, exceção) e D3 (lista de quem pode fechar, regra vermelha) com verificação (§2) |
| 6 | MÉDIO | V5 pelo `History.userId` do cliente/utilizador técnico; sem reembolso nunca verde (§5) |
| 7 | MÉDIO | Abertura = contagem 1; G2 resolvido = movimento explícito aprovado (§6.2) |
| 8 | MÉDIO | Universo C também por atributos de check-in (§3) |
| 9 | MÉDIO | Recibo no 1.º `cashierClosed`; recibo corrigido em alterações (§16) |
| 10 | MÉDIO | D8 (retirar `allowCashboxView` ao João) ou risco residual escrito (§2, §20) |
| 11 | BAIXO | "conforme D2" (§0) |
| 12 | BAIXO | WORM por evento + resumo diário por email (§12) |

## 24. Resposta à auditoria v4

| # | Grav. | Resolução |
|---|---|---|
| N1 | ALTO | `checkIn` retirado do Universo C por atributos; teste "cancelamento normal não entra" (§3) |
| N2 | MÉDIO | Releitura ao vivo obrigatória ao abrir a gaveta e ao gravar a contagem 1 (falha fechado); todos os aumentos passam pela confirmação do custódio (§6.1) |
| N3 | MÉDIO | Valor devido por tipo de documento, validado na fase 0; até lá "por validar" (§5) |
| N4 | MÉDIO | Ligação explícita do cliente; lista fechada de utilizadores técnicos; `'system'` nunca é cliente (§5 V5) |
| N5 | BAIXO | Contactos ao vivo, RGPD e duplicação tratados na fase 0 com a D7 (§16) |

## 25. Condições da aprovação (da auditoria)

1. Antes da fase 4: decisões do Jorge por escrito — D1, D2, D3, D8; se forem as alternativas de D2/D3, as regras delas entram no motor (fase 2) antes do modo sombra.
2. Fim da fase 0: D4–D7; triggers verificados (sem suporte → escrito no §20); bucket WORM e destinatário da âncora com credenciais separadas; diagnósticos (métodos 12 meses, P11 90 dias, valor devido por tipo de documento).
3. Fase 1: N2. Fase 2: N4.
4. Saída do modo sombra: critérios da fase 7.

## 26. Decisões finais do Jorge (13 out, 2.ª resposta) — valem por cima de tudo o que está acima

- **Sem contagens cegas.** "A ideia não é fazer contas cegas, é que as contas deem bem." O team leader conta o dinheiro dos condutores **sabendo o que cada um lhe tem de dar** (para poder corrigir), **fecha primeiro na Multipark** e depois declara na **Passagem de turno**: dinheiro recebido, Multibanco recebido e o total que dava a caixa na Multipark. Envelope selado no cofre. Caem: contagem 1 cega, esconder o esperado, ordem contagem → fecho (D3), D8, "não cega".
- **O João** confirma no dia seguinte na dashboard (envelope e MB), procura as diferenças e **fecha sempre** com as explicações. Valida **só na dashboard** (D2).
- **Diferença do dia > 30 €** → o dia fica **amarelo no mês** para o Jorge confirmar + **notificação na app**; **> 70 €** → também **email**. As justificações do João ficam a amarelo à espera do Jorge (D4).
- **Stripe**: uma chave vê todas as contas; muita coisa na Stripe não é dos nossos parques — a caixa é **só dos parques que operamos**. **Sem SIBS.** Multibanco = Viva Wallet.
- **Multibanco**: para já **só foto dos talões**; deixar preparado para a API (D6).
- **Sem recibo ao cliente** (D7).

## 27. Entrega 1 (código desta PR)

Implementado:
- **Passagem de turno**: 3 campos novos (`cashierCashReceived`, `cashierMbReceived`, `cashierMultiparkTotal`, migração 0645).
- **Caixa → Confirmação** (cidade × dia 03:00→03:00, parques operados): universo = saídas do dia + reservas com pagamentos no dia + canceladas depois do check-in (por `checkInDriverId`/`checkingInAt`, nunca `checkIn`); leitura ao vivo com **falha fechado** (LIMIT+1 → `truncated`, o dia não fecha).
- **Motor de achados** (`shared/cashConfirm.ts`, puro, cêntimos half-even): preço que baixou (base = 1.º webhook BOOKING_CREATED, só o original da Multipark sem memória; desconto PRO/campanha só até ao valor das linhas), subida sem causa, sem origem, origem em conflito, webhook de criação tardio (> 2 min), pago a menos/mais (devido = final − crédito + `BookingFee`), crédito, pagamento negativo, método desconhecido (dicionário exato), fora do balcão numa reserva normal, linha ≠ pagamentos, linha antiga, sub-cêntimo, MB sem talão do mesmo valor ligado à reserva, online sem Stripe / sem PI / 404 / valor ou estado diferente, transferência, caixa por fechar, validações fora de ordem, cancelada depois do check-in, pagamento do dia numa reserva sem saída. Chaves dos achados pelo conteúdo (a Multipark recria ids).
- **Justificar** (motivo da lista + ≥ 20 carateres + comprovativo nas perdas), **talões/comprovativos** com sha256 único (o mesmo ficheiro nunca serve duas vezes; retirar fica registado), **valores do João**, **fechar** (bloqueios: antes das 03:00, Multipark em falha, dados cortados, vermelhos por justificar, turno por declarar, diferença sem nota), **selo** (estado de cada reserva com hash + cabeça da cadeia), **aprovar/recusar** pelo Jorge (quem fechou/justificou não aprova; recusar reabre; com diferença > 30 € o dia aprova-se à parte), **reabrir** com motivo.
- **Registo só acréscimo** em cadeia de hashes por cidade × dia (verificado no ecrã), teste-guarda contra UPDATE/DELETE/TRUNCATE/REPLACE/DROP.
- **Avisos**: `cash_confirm_alert` (app, > 30 € e dias reabertos) e `cash_confirm_alert_email` (> 70 €), só para quem gere a Caixa.
- **Varredura** às 06:15 (depois do fecho diário existente): relê os dias fechados dos últimos 45 dias; dinheiro mudado, reservas que entram/saem do dia ou validação que volta a "não" → **reaberto** + aviso.
- **Vista do mês** para o Jorge.

Fica para a Entrega 2 (registado; o motor já falha fechado nestes casos):
- API da Viva para os talões ficarem verdes sem foto (o motor aceita transações do adquirente como talões — `mbReceipts`); IA a ler o talão.
- Âncora externa (WORM/email da contabilidade) e triggers na BD; hoje a imutabilidade é por código + teste + cadeia verificada no ecrã.
- Enriquecer a memória do webhook (crédito, taxa, avença, PI, % de desconto) e o "primeiro visto" dos pagamentos; regras P11/V5 pelo History.
- Extrato bancário (depósitos e transferências por extrato): hoje a transferência fica vermelha até comprovativo + aprovação do Jorge.

### 27.1 Depois da auditoria do código (ronda 1: 45/100)

- **Âmbito por reserva**: as **saídas** do dia levam todas as regras (preço, pagamentos, Stripe, validações). As reservas **só com pagamento no dia** (pré-pagas, pagas no check-in) e as **canceladas** levam só as regras do dinheiro desse dia — o preço e a Stripe conferem-se no dia da saída, nunca duas vezes. O selo de uma reserva só com pagamento guarda só os pagamentos do dia (pelo conteúdo): um pré-pago que sai daqui a 5 dias não reabre o dia de hoje; um acerto PRO com data no passado (sem balcão) não entra num dia selado.
- **Dinheiro**: o team leader tem de declarar dinheiro **e** MB em cada turno (0 escreve-se); o João tem de gravar o envelope e os talões; a diferença conta-se em separado (dinheiro e MB) e o alerta usa a soma dos valores absolutos (uma não esconde a outra). A taxa extra (`BookingFee`, cobrada em dinheiro e nunca registada na Multipark) entra no dinheiro esperado e não dá "pago a menos".
- **Justificações** presas ao código, ao valor e a um comprovativo ainda anexado; um comprovativo serve uma só justificação e é sempre da reserva.
- **Marcas PRO/parceiro** só contam se já existiam no 1.º webhook; ganhas depois → vermelho.
- **Base do preço** = preço líquido com que nasceu (sem "cobertura" por linhas de desconto quando há memória). Saída antecipada → vermelho próprio sem comprovativo obrigatório. Pagamento negativo que espelha uma linha de desconto não é achado.
- **Pagamento registado > 30 min depois da saída** (recriado pela Multipark) → vermelho.
- **Saídas por concluir** entram no dia (vermelho); canceladas pela data do `Cancellation`.
- **Stripe**: só para as saídas do dia; leituras guardadas na nossa BD (`cash_confirm_stripe_checks`, só acréscimo); justificar/fechar/varredura não chamam a Stripe; desligada ou por ler → o dia não fecha (bloqueio, não vermelhos em massa).
- **Selo** inclui as contas do dia (declarações, despesas, taxas, envelope, talões) e os parques; a varredura usa os parques do selo (mudar parques operados não reabre dias); declarações/despesas mudadas depois do fecho reabrem; a passagem de turno não deixa mudar os valores da caixa de um dia confirmado.
- **Integridade**: cadeia + selo (sha256 = hash gravado = evento "selar") + cada justificação, decisão, ficheiro e retirada com o seu evento; fechar exige a mesma cabeça da cadeia que foi lida; horas em DATETIME(3) UTC.
- **Segregação**: quem declarou não fecha; quem mexeu no dia não aprova; reabrir à mão avisa e o próximo fecho volta a precisar do Jorge; recusar avisa quem fechou.
- **Varredura** com cron próprio (`cash-confirm-recheck`, de hora a hora, retomável).
- **Mês** mostra todos os dias (os nunca abertos como "por fechar").

Riscos aceites (por escrito):
- A mesma folha fotografada duas vezes passa no sha256 (a foto é recodificada): o valor do talão bate com o pagamento e o Jorge revê; fica para a Entrega 2 a API da Viva.
- A leitura por `recordedAt` não tem índice na Multipark (é a mesma consulta do "Por dia" já em produção); pedido de índice ao Rafael.
- Reembolso ou disputa Stripe depois do fecho: não reabre o dia (a Stripe não é relida na varredura); é apanhado pela verificação diária existente (R20 → casos da Correção de caixa).

### 27.2 Depois da ronda 2 (74/100)

- **Liquidações** (acertos PRO/parceiro/avença registados > 30 min depois da saída, numa reserva fora do balcão): fora das regras do dia, do "balcão do dia" e do selo da saída; `CARD`/`MIT_*` passam a "fora do balcão". Um acerto PRO não enche o dia de vermelhos nem reabre o dia da saída.
- **Taxa extra** vai para o método do maior pagamento de balcão da saída (dinheiro ou MB; sem balcão, dinheiro); reservas fora do balcão não somam taxa.
- **Alerta** = o maior entre a diferença (contado vs esperado) e a quebra (declarado pelo team leader vs contado pelo João); o desvio do "total que dava a Multipark" também pede nota.
- **Marcas** só se confiam com memória lida da BD e com o campo preenchido; senão amarelo "sem prova de origem" (sem vermelho falso). **Avença/plano** → amarelo (a memória não guarda quando foi ligado).
- **Quem declarou** = quem escreveu os valores da caixa (`cashierDeclaredById`, gravado quando esses campos mudam); nas antigas, quem criou a passagem.
- PaymentIntent antigo abandonado não dá vermelho se outro pagamento Stripe da reserva foi bem-sucedido; falha a gravar uma leitura da Stripe aparece no ecrã; pelo MCP não se chama a Stripe; a varredura lê o selo dia a dia; saída por concluir que fecha depois das 03:00 sai do dia sem o reabrir.
- A migração 0645 **nunca correu em nenhuma BD** (só commits locais, sem deploy): editá-la no sítio é seguro.

Riscos aceites (por escrito), além dos do §27.1:
- `late_payment`/`checkout_unfinished` podem dar vermelhos legítimos-mas-chatos (dívida paga noutro dia); o valor continua no dinheiro do dia em que foi registado (é onde está o envelope) e o João justifica. Medir no **modo sombra** (fase 7) com os dias reais antes de contar como definitivo.
- Se o único gestor da Caixa mexer num dia, ninguém o aprova: o Jorge não anexa nem justifica (só decide).
- Ficheiro órfão no storage se a gravação falhar a meio (não conta para nada; sem linha na BD).
