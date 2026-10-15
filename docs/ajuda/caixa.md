---
modulo: caixa
grupo: Financeiro
pagina: caixa
titulo: Caixa
separadores: dia=Separadores, confirmacao=Confirmação da caixa, resumo=Separadores, correcao=Correção de caixa — casos
rotas: /caixa
palavras: caixa por dia, 03:00, dia da caixa, quem fechou, quem entregou, despesas do turno, dia certo, dia não certo, caixa, dinheiro, recebido, por cobrar, no-shows, correção de caixa, conferência, era, é, webhook, preço mudou, preço zerado, método de pagamento, divergência, caixa fechada, invoicexpress, stripe, viva wallet, talão, talao, foto do talão, multibanco, tpa, transferência, fim do mês, pro, agregador, agente, recebimento, comprovativo, confirmar pagamentos, contagem, fecho de caixa
---
# Caixa

**Financeiro → Caixa** (29c, 6 out 2026: "uma coisa é faturação, outra coisa é caixa"). Tem permissão própria: dá-se a quem faz a correção de caixa sem abrir a Faturação (Permissões → módulo **Caixa**). Quem já tinha a Faturação continua a ver a Caixa.

As reservas e os pagamentos são lidos **ao vivo da base de dados da Multipark**, só dos parques que operamos.

**Separadores**
- **Por dia** (abre aqui; por omissão a última caixa já fechada): a caixa de cada dia **por cidade**, só nos parques que operamos.
  - **O dia da caixa vai das 03:00 às 03:00 do dia seguinte** (hora de Lisboa): a caixa fecha no fim do turno da noite, em n+1. O que se recebe às 01:30 de dia 7 ainda conta na caixa de dia 6. Enquanto não passar das 03:00 do dia seguinte, o dia aparece **Em curso**.
  - **Recebido** no dia por método (dinheiro, multibanco/TPA, online/Stripe, MB Way…), pelos pagamentos registados na Multipark nesse dia da caixa (03:00 → 03:00).
  - **Despesas do turno**: as que o team leader lançou na **Passagem de turno** (ver abaixo). Abatem ao dinheiro.
  - **Tem de estar em dinheiro** = recebido em dinheiro − despesas do turno − gastos escritos na contagem. **Contado** = soma das contagens dos parques; **Diferença** = contado − tem de estar ("—" enquanto nenhum parque estiver contado).
  - **Por condutor** (quem fez a saída): saídas, valor, em dinheiro, se **entregou o dinheiro ao líder** e se a **caixa foi fechada** (e por quem). Quem tem dinheiro por entregar aparece primeiro.
  - **Correção do dia**: **Dia certo** ou **Dia não certo**, com o motivo (o que mudou, se está correto ou não). "Não certo" pede sempre motivo; "certo" com diferença também. Só se faz depois de a caixa fechar (03:00 do dia seguinte). Cada gravação fica no **Histórico** (quem, quando, esperado e contado). Precisa de Caixa → editar.
- **Confirmação** (13 out 2026): a confirmação da caixa **reserva a reserva**, por cidade e dia (03:00 → 03:00), só nos parques que operamos. Ver **Confirmação da caixa** abaixo.
- **Resumo**: o dinheiro no período — recebido (por método de pagamento), por cobrar, no-shows pré-pagos e canceladas com pagamento (só informativo). As despesas a pagar estão na **Previsão** da Faturação.
- **Correção de caixa**: casos da varredura automática, contagem da caixa por parque e dia, multibanco do dia (talões), confirmar pagamentos (Stripe, Viva, fim do mês), preços iniciais e o **Comparar** era / é.

**Correção de caixa — casos**
1. No topo do separador **Correção de caixa** está a fila **Casos da varredura automática** (por explicar, por defeito), com as gravidades em cima. Filtra por **Fechados / resolvidos** ou **Todos** e pela gravidade.
2. Carrega num caso para ver: o motivo, a tabela **era / é** (retratos do webhook e da varredura contra a Multipark agora), **quem mexeu no dinheiro** (História da Multipark) e o histórico do caso. Avisos a vermelho: **Mesma pessoa** (quem mudou o preço ou o método também validou ou fechou a caixa) e **Sem rasto na Multipark** (o dinheiro mudou sem nenhuma alteração registada).
3. Quem confere a caixa (Caixa → gerir, ou Faturação → gerir) pode: **Em análise** (vais corrigir na Multipark — quando a varredura confirmar, passa sozinho a **corrigido na Multipark**), **Fechar com explicação** (motivo + explicação de pelo menos 10 carateres; "Perda aceite" fica à parte), **Reabrir** e **Só juntar nota**. Tudo fica no histórico do caso, com quem e quando.
4. Um caso fechado **reabre sozinho** se a divergência mudar; um resolvido reabre se voltar.
5. Avisos: os casos graves (preço zerado, pago ≠ esperado, caixa fechada com divergência ou reaberta, reembolso por explicar, dinheiro do condutor por entregar, contagem ≠ esperado) mandam logo um aviso **Caixa: casos graves** (sino e email); todas as manhãs, depois do fecho do dia, chega o **Caixa: resumo diário** com o que falta explicar por cidade.

**Contagem da caixa**
1. Em **Contagem da caixa** escolhe o parque e o dia. Aparece o **recebido em dinheiro** nesse dia da caixa, das 03:00 às 03:00 do dia seguinte (pagamentos em dinheiro registados na Multipark). Por omissão abre a caixa em curso (antes das 03:00 ainda é a do dia anterior).
2. Acrescenta os **gastos pagos da caixa** (descrição, valor e n.º do recibo, se houver) e escreve o **valor contado**. O ecrã mostra o **esperado** (recebido − gastos) e a **diferença**.
3. **Gravar contagem** (precisa de Caixa → editar). Se não bater (tolerância de 1 cêntimo), abre um caso **crítico** "Contagem ≠ esperado"; quando voltares a gravar e bater, resolve-se sozinho. Cada gravação fica registada (quem, quando, quanto).

**Confirmar pagamentos (online, multibanco e fim do mês)**
1. **Online (Stripe)**: todos os dias (a partir das 07:00), as saídas de ontem e anteontem pagas online são confirmadas na própria Multipark: tem de lá estar o pagamento Stripe (id de pagamento na reserva ou numa fatura, ou um link de pagamento pago). Se não estiver, abre caso "Pago online sem pagamento Stripe na Multipark".
2. **Multibanco (talão)**: em **Contagem da caixa**, escolhe o parque e o dia. Em **Multibanco do dia** aparecem os pagamentos por multibanco registados na Multipark nesse dia da caixa (03:00 → 03:00). Para cada talão: escreve o valor, tira a **foto do talão** (no telemóvel abre a câmara) e carrega em **Juntar talão**. O talão liga-se sozinho ao pagamento com o mesmo valor (ou à reserva que escolheres). No fim carrega em **Confirmar multibanco do dia**: fica registado quem confirmou; o que ficar sem talão, ou talões sem pagamento, abre um caso "Multibanco sem talão". Tirar um talão não apaga (fica registado quem e quando). Precisa de Caixa → editar.
3. **Viva Wallet (CSV)**: em **Confirmar pagamentos**, importa o extrato exportado da Viva Wallet (colunas Date, Time, Amount, Channel). Cada pagamento por multibanco procura uma transação do terminal com o mesmo valor, no mesmo dia ou no seguinte; os que não aparecem abrem caso. Os links de pagamento (Smart Checkout) não contam para o multibanco. Precisa de Caixa → gerir.
4. **Fim do mês (Pro, agentes, agregadores)**: escolhe o mês. Aparece por cliente Pro e por parceiro o **devido do mês** na Multipark, contando as reservas que **saíram** nesse mês (uma reserva que entrou no mês passado e saiu neste conta neste; uma que entra neste e sai no próximo conta no próximo). Parceiros: soma do devido pelo parceiro; Pro: preço das reservas. Ao lado aparece o que está **em atraso** dos 12 meses anteriores (ainda por pagar na Multipark): um pagamento pode trazer meses em atraso, e só é diferença se passar o devido do mês mais o que está em atraso, ou se não chegar ao devido do mês. Carrega em **Registar recebido**: valor, data, nota e o comprovativo (foto ou PDF). Se o recebido não bater com o devido, abre caso "Recebimento mensal ≠ devido". Precisa de Caixa → gerir.
5. **Cruzamentos automáticos** (Stripe, Viva Wallet, InvoiceExpress): estão **desligados** por omissão e confirma-se à mão. Liga-se em **Definições → Automações** (só super admin), depois de pôr as chaves só de leitura na Vercel: `STRIPE_READ_KEY` (restrita, `rk_`), `VIVA_MERCHANT_ID` + `VIVA_API_KEY`, `INVOICEXPRESS_ACCOUNT` + `INVOICEXPRESS_API_KEY`. O cartão mostra se cada um está ligado e se tem chave.

**Preços iniciais (histórico da Multipark)**
1. Em **Correção de caixa**, no cartão **Preços iniciais**, carrega o CSV exportado do histórico da Multipark (reservas.csv: o preço com que cada reserva foi criada).
2. O cartão mostra quantas reservas entraram e como a nossa cópia antiga se compara: **igual** ao preço inicial, **reescrita** (tem o preço de agora, porque o sync escrevia por cima), **com outro valor**, **não está na cópia** ou **sem preço na criação**. As maiores diferenças ficam listadas.
3. A partir daí, o **Comparar** e a conferência da ficha da reserva começam o "era" neste preço inicial (marcado "preço inicial do histórico"). Voltar a importar atualiza, nunca apaga. Precisa de Caixa → gerir.

**Correção de caixa — comparar um dia**
1. Separador **Correção de caixa**. Escolhe um ou mais parques (por defeito, os nossos; **Só os nossos** e **Limpar** ajudam) e o **dia** (hora de Lisboa).
2. Carrega em **Comparar**. São comparadas as reservas com **saída** nesse dia. Só aparecem as que têm divergência, as mais graves primeiro:
   - **Preço zerado**: o webhook disse um preço e agora é 0 € (ou as linhas somam 0 €).
   - **Preço mudou depois do check-in** ou **depois da criação**: era X €, agora é Y €. Diz também se nenhum webhook avisou da última alteração.
   - **Linhas de preço retiradas ou baixadas**: a soma das linhas já foi maior num retrato de um webhook (ou é menor do que o preço que o webhook disse), ou a reserva saiu sem linhas.
   - **Método de pagamento mudou**: por exemplo, era Dinheiro e agora é Multibanco, ou ficou vazio.
   - **Pago ≠ esperado**: depois da saída, o que foi pago não bate com a soma das linhas (as Pro faturam ao mês e não entram).
   - **Cancelada depois de entrar**.
   - **Caixa fechada com divergência**: a caixa desta reserva já foi fechada e há outra divergência. É a mais grave.
   - **Só na Multipark**: nunca nos chegou nenhum webhook desta reserva, por isso não há "era" para comparar.
   - **Só na memória do webhook** (lista à parte): o webhook deu-a com saída nesse dia, mas agora a Multipark diz outro dia, outro parque, ou já não a tem.
3. Cada linha mostra era / é, o esperado e o pago, o método antes → depois e abre a **ficha da reserva**, onde está a **Conferência (era / é)** completa com quem mudou e quando.
4. São comparadas até 200 saídas de cada vez. Se houver mais, carrega em **Comparar as seguintes**.

O botão **Comparar** é só leitura. Além dele, desde 29 set 2026 há uma **varredura automática** (trabalho `cash-sweep`, de 3 em 3 horas, e `cash-close` todas as manhãs para as saídas de ontem e anteontem): vê as reservas dos nossos parques que mudaram, as que estão dentro e as que saíram nas últimas 48 h, guarda um retrato do dinheiro sempre que muda (assim há "era" mesmo quando não chega webhook) e abre **casos** com as mesmas regras e mais estas: desconto ou campanha depois do check-in, reembolso por explicar, mudou de dia ou de parque depois do fecho, reserva desaparecida, pro ou avença marcado tarde, valores do parceiro mudados, serviço feito sem cobrança, sem fatura (48 h depois de sair paga, para quem pediu fatura com NIF; as outras fazem-se no fim do mês e só contam passado o fecho do mês + 48 h), fatura ≠ pago, pagamento online com disputa ou link falhado, crédito usado, caixa ou validação reaberta, dinheiro do condutor por entregar (o condutor entrega ao líder no próprio dia — validação do condutor até às 6 h da manhã seguinte — e o líder entrega ao back office no dia seguinte — dinheiro conferido até ao fim desse dia; a tolerância é sempre 0,01 €), permissões de dinheiro de um agente mudadas e parque sem webhooks com movimento. Um caso resolve-se sozinho quando a Multipark deixa de ter a divergência e reabre se ela voltar. O "era" é a memória do webhook, que o dashboard guarda desde 28 set 2026 e **nunca reescreve nem apaga**: em cada webhook (criação, alteração, entrada, saída…) lê a reserva toda na base de dados da Multipark e guarda uma linha nova. Reservas sem webhooks guardados usam, no Comparar, a cópia antiga como "era" (marcada "cópia antiga"). Vê quem tem a Caixa (ou a Faturação) e pode ver os totais financeiros.

**Despesas do turno (Passagem de turno)**
1. Na **Passagem de turno**, em **Valores**, o cartão **Despesas do turno**: tira a **foto do talão** (a IA lê-o e preenche descrição, valor, fornecedor, NIF, n.º, data, IVA e categoria), confirma e carrega em **Lançar**. Sem IA, escreve a descrição e o valor.
2. A despesa entra **logo nas Despesas** (paga, em dinheiro, no centro de custos da cidade, com o talão) e **abate à caixa do dia** (Caixa → Por dia). Cada uma tem **Abrir nas Despesas** para ver o detalhe lá.
3. O total vai para "Tickets/despesas pagos" da passagem. **Anular** deixa a despesa cancelada (sai da caixa e dos totais, fica no histórico) — só quem a lançou ou quem gere a passagem de turno.

**Confirmação da caixa**
1. **Team leader** (fim do turno): fecha a caixa na Multipark e depois, na **Passagem de turno → Fecho da caixa do turno**, escreve o **dinheiro recebido** dos condutores (antes das despesas), o **Multibanco recebido** e o **total que dava a caixa na Multipark**. O dinheiro vai em envelope selado para o cofre.
2. **João** (dia seguinte), em **Caixa → Confirmação**: escolhe a cidade e o dia. Vê:
   - as contas do dia: dinheiro e MB registados na Multipark, despesas do turno, o que tem de haver, o que o team leader declarou e a **diferença do dia**;
   - **cada reserva lado a lado**: o preço **quando nasceu** (1.º webhook, a nossa memória — não se altera), o original da Multipark, o preço final, o devido (− crédito + taxa), o pago por método e as 3 validações da Multipark (conferida, condutor, caixa fechada, com quem e quando);
   - por omissão só aparecem as reservas a **amarelo** ou **vermelho**; as certas ficam escondidas ("Mostrar também as certas").
3. **Cores**: **verde** = está tudo bem; **amarelo** = a rever (ex.: caixa por fechar na Multipark, preço subiu sem causa visível, reserva anterior à memória); **vermelho** = tem de ser justificado: preço que **baixou**, pago a menos, crédito dado, pagamento negativo ou com método desconhecido, método fora do balcão numa reserva normal, Multibanco **sem talão**, online que **não bate com a Stripe** (ou que não se conseguiu verificar), transferência sem comprovativo, validações fora de ordem, cancelada depois do check-in. **Para cima pode** (mais dias, extra, taxa); **para baixo nunca sem justificação**.
4. **Multibanco**: em cada pagamento MB sem talão, **Anexar talão** (foto + valor, tem de ser igual ao pagamento). O mesmo ficheiro nunca serve duas vezes.
5. **Justificar**: motivo da lista, explicação (pelo menos 20 carateres) e, nas perdas, **comprovativo** (foto ou PDF). Um vermelho justificado passa a **amarelo à espera do Jorge**.
6. **Valores do dia**: o João escreve o dinheiro do **envelope** e o **MB** dos talões (e uma nota, obrigatória se houver diferença) e **Fecha o dia**. Não fecha com vermelhos por justificar, com um turno por declarar, antes das 03:00 do dia seguinte ou sem os dados completos da Multipark.
7. **Diferença do dia > 30 €** (ou justificações por aprovar) → o dia fica **amarelo no mês** ("à espera do Jorge") e o Jorge recebe um aviso na app; **> 70 €** também por email.
8. **Jorge** (Caixa → gerir), em **Confirmação → Mês**: vê os dias a amarelo e **aprova** o dia (aprova as justificações por decidir) ou aprova/recusa cada justificação. **Recusar reabre o dia.** Quem fechou o dia ou justificou não o pode aprovar.
9. **Depois de fechado**: **de hora a hora** (trabalho `cash-confirm-recheck`, ver a ajuda do Agendador) o sistema relê os dias fechados dos últimos 45 dias, primeiro os que há mais tempo não eram relidos (até 200 por corrida); se a Multipark mudou o dinheiro de uma reserva selada, ou se uma reserva entrou/saiu do dia, ou se uma validação voltou de "sim" a "não", o dia **reabre sozinho** e o Jorge é avisado.
10. **Registo**: tudo o que se faz fica num registo que não se apaga, em cadeia (cada passo leva o carimbo do anterior); o ecrã mostra **Registo íntegro**. Justificações, decisões e ficheiros nunca se apagam (um ficheiro retirado continua guardado).
