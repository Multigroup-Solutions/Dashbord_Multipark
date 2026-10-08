---
modulo: faturacao
titulo: Faturação
rotas: /faturacao, /financeiro, /anual
palavras: marketplace, dupla comissão, prior velho, preço inicial, preços iniciais, histórico, reservas.csv, ao vivo, base da multipark, faturação, faturacao, receita, margem, fecho previsto, previsão, realizado, custos detalhados, caixa, comissões, iva, receita esperada, marketing, anúncios, período de consumo, no-shows, financeiro, anual, totais
---
# Faturação

Receita, custos e margem por período (só super admin; o dashboard Financeiro é para admin e acima).

As reservas (receita, entregues, recolhidas, receita esperada) são lidas **ao vivo da base de dados da Multipark**, só dos nossos parques (Airpark, Redpark e Skypark em Lisboa, Porto e Faro — a cidade do parque é a reconhecida: Prior Velho e Moscavide contam como Lisboa, Maia como Porto…). As reservas do **Marketplace** dos parques de terceiros não entram na receita; nos nossos parques, uma reserva vinda pelo Marketplace paga 20 % ao Marketplace e, se também tiver parceiro, conta só o Marketplace (nunca duas comissões). Já não dependem de importações nem da cópia antiga. Se a base da Multipark não responder (ou faltar a permissão de ver totais), a página diz o porquê, em vez de números a zero, e tem um botão **Tentar de novo**.

**Ler a página**
1. Menu **Financeiro → Faturação**. Escolhe o período e, se quiseres, a marca/projeto.
2. Separadores:
   - **Realizado**: receita (com e sem IVA), entregues, comissões, custos e margem realizada até hoje.
   - **Custos detalhados**: despesas, salários, **equipa do dia**, parceiros. O **marketing** (anúncios Google Ads / Meta) entra nas despesas **por projeto**: o **gasto das plataformas** até chegar a fatura; nos dias do **período de consumo** de uma fatura do Google/Meta, a **fatura** (repartida pelos dias e projetos na proporção do gasto). As faturas do Google/Meta não contam na data da fatura (senão o mesmo gasto contava duas vezes); uma fatura sem período de consumo não conta e aparece um aviso. A **TSU patronal** não é calculada nos custos: entra pelas **Despesas** quando é paga (categoria TSU / Segurança Social — essa categoria tem de contar na margem; se estiver "fora da margem" aparece um aviso). A estimativa da TSU aparece só como informação. A equipa do dia conta as horas do **ponto** × tarifa do nível (até hoje), por nível e com o total igual ao cartão "Equipa do dia"; a escala do Extras Dia do período aparece só como referência (não soma — num período em curso, a escala dos dias que faltam entra no Fecho previsto).
   - **Previsão**: **Fecho previsto** = realizado + receita esperada − custos do período inteiro. Num período já terminado não há previsão.
   - A **Caixa** e a **Correção de caixa** passaram para o seu item do menu: **Financeiro → Caixa** (ver a ajuda "Caixa"). Os links antigos (/faturacao?tab=cash-check) vão lá ter sozinhos.
3. Os valores de margem são sem IVA. Despesas já contadas pelo RH/ponto não entram duas vezes.

**Anual** mostra o ano mês a mês, com o mesmo motor da Faturação: receita, despesas (com a TSU paga), comissões, ordenados e equipa do dia (os meses importados do histórico trazem a TSU calculada), IVA a pagar e lucro.
- O **mês em curso** conta o realizado até hoje, e os meses futuros só a previsão ("prev."). O **Fecho previsto** do ano soma o realizado dos meses passados com a previsão dos outros.
- Escolhe o **ano** (desde 2016), o intervalo **De / Até** (o "De" nunca fica depois do "Até") e o centro de custos. **Comparar com** mostra outro ano lado a lado.
- O **IVA cobrado** usa a taxa em vigor em cada dia. O **IVA dedutível** usa a taxa de cada categoria de despesa (por exemplo, rendas e pessoal sem IVA, autoliquidação a 0%).
- **Importar histórico** (Excel/CSV, anos antigos): os valores só entram nos meses sem dados na app e ficam marcados "hist.".
- A exportação (Excel/CSV) leva o ano inteiro.
- Se aparecer **"Não foi possível calcular o ano"**, é uma falha (por exemplo, a base de dados da Multipark em baixo), não um ano a zero: usa **Tentar de novo**.

As taxas de IVA e TSU mudam-se em **Definições → Parâmetros**.
