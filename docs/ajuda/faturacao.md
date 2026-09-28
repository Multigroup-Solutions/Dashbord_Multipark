---
modulo: faturacao
titulo: Faturação
rotas: /faturacao, /financeiro, /anual
palavras: faturação, faturacao, receita, margem, fecho previsto, previsão, realizado, custos detalhados, caixa, comissões, iva, receita esperada, no-shows, financeiro, anual, totais, correção de caixa, conferência, era, é, webhook, preço mudou, preço zerado, método de pagamento, divergência, caixa fechada
---
# Faturação

Receita, custos e margem por período (só super admin; o dashboard Financeiro é para admin e acima).

**Ler a página**
1. Menu **Financeiro → Faturação**. Escolhe o período e, se quiseres, a marca/projeto.
2. Separadores:
   - **Realizado**: receita (com e sem IVA), entregues, comissões, custos e margem realizada até hoje.
   - **Custos detalhados**: despesas, salários + TSU, equipa do dia, parceiros.
   - **Previsão**: **Fecho previsto** = realizado + receita esperada − custos do período inteiro. Num período já terminado não há previsão.
   - **Caixa**: por cobrar e despesas a pagar com vencimento no período.
   - **Correção de caixa**: compara, quando carregas em **Comparar**, o que a Multipark nos disse pelo webhook (**era**) com a base de dados da Multipark agora (**é**). Ver abaixo.
3. Os valores de margem são sem IVA. Despesas já contadas pelo RH/ponto não entram duas vezes.

**Correção de caixa**
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

A comparação não corre sozinha e não grava nada: é só leitura. O "era" é a memória do webhook, que o dashboard guarda desde 28 set 2026 e **nunca reescreve nem apaga**: em cada webhook (criação, alteração, entrada, saída…) lê a reserva toda na base de dados da Multipark e guarda uma linha nova. Reservas mais antigas aparecem como "Só na Multipark". Vê quem tem a Faturação e pode ver os totais financeiros.

**Anual** mostra o ano mês a mês. As taxas de IVA e TSU mudam-se em **Definições → Parâmetros**.
