---
modulo: marketing
titulo: Marketing
rotas: /marketing, /marketing/google-ads, /marketing/canais, /marketing/orcamentos, /marketing/web
palavras: ao vivo, base da multipark, atribuição, marketing, anúncios, google ads, meta, facebook, campanha, campanhas, roas, gasto, canais, clientes, orçamento, orçamentos, custo total de marketing, faturas google, despesas de marketing, comissões, email semanal, reservas indisponíveis, arquivar orçamento, reservas via net, ligadas, com link, gclid, conversões meta, custo por conversão
---
# Marketing

Só super admin (ou quem tiver uma exceção de acesso ao Marketing).

As reservas (quantas, valor, de onde vieram, cliente novo ou não e se vieram de um anúncio) são lidas **ao vivo da base de dados da Multipark**, só dos nossos parques. A atribuição Google/Meta sai do link de origem da reserva (gclid, fbclid, utm). Os gastos em anúncios vêm do Google Ads e da Meta.

**Separadores**
- **Dashboard**: visão geral do marketing no período.
- **Anúncios**: gasto por marca e por campanha (Google Ads e Meta) e ROAS por campanha (sem IVA).
- **Canais e clientes**: de onde vêm as reservas e os clientes.
- **Orçamentos**: orçamento mensal por marca/cidade e o ritmo do gasto.
- **Web & SEO**: tráfego dos sites (Google Analytics 4), pesquisa Google (Search Console) e velocidade (PageSpeed) — ver a ajuda "Web & SEO".

**Custo total de marketing** = gasto dos anúncios (Google + Meta, vindo das plataformas) + **outras despesas de marketing** (Despesas da categoria «Marketing»). As **faturas do Google e da Meta** lançadas nas Despesas **não se somam outra vez** — o gasto delas já está nos anúncios; o valor aparece à parte, só como informação.

**Quando a base da Multipark não responde**: o gasto aparece na mesma (é nosso) e as reservas, o ROAS e o custo por reserva ficam "—" com o aviso "Reservas da Multipark indisponíveis" — nunca 0. Os alertas de atribuição e de campanhas sem resultados ficam suspensos até voltar; os das recolhas continuam.

**Canais e clientes**
- O grupo **Anúncios (Google + Meta) — clientes novos** junta as reservas de clientes novos nos canais próprios; o custo é o gasto do Google Ads **e** da Meta.
- **Comissões dos parceiros**: a mesma regra da Faturação — sobre o valor **sem IVA** (salvo parceiros configurados "com IVA"). Um parceiro sem taxa aparece com **"taxa em falta"** e a comissão não é contada (antes contava como 0 %).
- "Cliente novo" é calculado só nos parques do filtro escolhido: por isso a soma das cidades pode dar mais do que o total nacional.
- Período máximo: 400 dias. Se o histórico for maior do que o limite de leitura, aparece um erro em vez de números cortados.

**Orçamentos**
- Gasto do dia 1 até **ontem** (hoje está a meio) contra o esperado pelos dias completos. Acima de **110 %** ou abaixo de **80 %** do esperado (a partir do 4.º dia) aparece um alerta.
- **Arquivar** (antes "Apagar") tira o orçamento da lista e dos alertas, mas fica no registo. Definir o mesmo orçamento outra vez repõe-no. Mudar um valor fica registado (antes → depois).
- Quem só vê parte das cidades de um orçamento (ex.: "Marca (todas as cidades)" visto por quem só tem Lisboa) vê o gasto dessa parte, sem ritmo.

**Anúncios → ligações utm/código**: ligar um utm_campaign ou código de desconto a uma campanha fica registado; se já estava noutra campanha, passa para esta e o registo diz de onde saiu. **Retirar** uma ligação arquiva-a (fica no registo).

**Alertas** (independentes do período): campanhas com ≥ 50 € em 14 dias sem conversões nem reservas ligadas, ritmo do mês, orçamentos e recolhas.

**Aviso vermelho no topo**: a recolha do Google Ads ou da Meta falhou, pede nova autorização ou está parada há mais de 26 h — abre **Integrações → Google Ads** (o link só aparece a quem pode abrir as Integrações; os outros avisam o administrador). Se o próprio aviso não se conseguir ler, aparece um erro com "Tentar de novo" (nunca fica tudo "verde" por engano).

**Conversões e reservas, lado a lado** (Dashboard, Anúncios por marca e por marca/cidade):
- **Conversões (Google + Meta)**: o que cada plataforma conta (Google à parte, Meta à parte). **Custo por conversão** = gasto ÷ essas conversões.
- **Reservas via net**: reservas reais da Multipark que **não são de parceiros** (site, telefone, Marketplace) — é o que os anúncios podem trazer. Não contam as de parceiros (com parceiro na reserva, origem de parceiro ou cobradas por um agregador como Parkos/Parkvia). Ao lado: o valor e o custo por reserva via net.
- **Com link**: das reservas via net, quantas trazem o **link de origem**. Sem link não há como saber de que anúncio veio a reserva.
- **Ligadas**: as que trazem a prova do clique no link (gclid/gbraid/wbraid do Google, fbclid da Meta, utm pago). Se uma marca tem conversões mas **0 ligadas**, o mais provável é o site dessa marca não guardar o link (ou o gclid) na reserva — vê a coluna "Com link".
- O **ROAS Google (reportado)** e as "conversões contadas pela Google" são só do Google Ads. Uma conta de anúncios que deixou de ser recolhida continua a contar com o gasto que já tinha.

**Email semanal** (segunda a partir das 8h, para os endereços em MARKETING_REPORT_EMAILS): desliga-se em Definições → Automações → **Email semanal de marketing**. Se a base da Multipark falhar, o email diz que as reservas estão indisponíveis.

**Configurações de Web & SEO e Google Business** (contas, recolhas): só quem vê todas as cidades.
