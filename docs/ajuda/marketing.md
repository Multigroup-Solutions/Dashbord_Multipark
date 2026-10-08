---
modulo: marketing
titulo: Marketing
rotas: /marketing, /marketing/google-ads, /marketing/canais, /marketing/orcamentos, /marketing/web
palavras: reservas do marketplace, marketplace a zero, multipark.pt, parques de terceiros, alertas de lado, tirar alerta, tirados, repor alerta, ao vivo, base da multipark, atribuição, marketing, anúncios, google ads, meta, facebook, campanha, campanhas, roas, gasto, canais, clientes, orçamento, orçamentos, custo total de marketing, faturas google, despesas de marketing, comissões, email semanal, reservas indisponíveis, arquivar orçamento, regra 20 %, orçamento automático, reservas via net, ligadas, com link, gclid, conversões meta, custo por conversão
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

Na **Faturação** os anúncios entram como despesa de marketing por projeto: o gasto das plataformas até chegar a fatura do Google/Meta; nos dias do período de consumo dela, a fatura.

**Custo total de marketing** = gasto dos anúncios (Google + Meta, vindo das plataformas) + **outras despesas de marketing** (Despesas da categoria «Marketing»). As **faturas do Google e da Meta** lançadas nas Despesas **não se somam outra vez** — o gasto delas já está nos anúncios; o valor aparece à parte, só como informação.

**Quando a base da Multipark não responde**: o gasto aparece na mesma (é nosso) e as reservas, o ROAS e o custo por reserva ficam "—" com o aviso "Reservas da Multipark indisponíveis" — nunca 0. Os alertas de atribuição e de campanhas sem resultados ficam suspensos até voltar; os das recolhas continuam.

**Canais e clientes**
- O grupo **Anúncios (Google + Meta) — clientes novos** junta as reservas de clientes novos nos canais próprios; o custo é o gasto do Google Ads **e** da Meta.
- **Comissões dos parceiros**: a mesma regra da Faturação — sobre o valor **sem IVA** (salvo parceiros configurados "com IVA"). Um parceiro sem taxa aparece com **"taxa em falta"** e a comissão não é contada (antes contava como 0 %).
- "Cliente novo" é calculado só nos parques do filtro escolhido: por isso a soma das cidades pode dar mais do que o total nacional.
- Período máximo: 400 dias. Se o histórico for maior do que o limite de leitura, aparece um erro em vez de números cortados.

**Orçamentos**
- **Regra 20 %** (Jorge, 6 out 2026): o orçamento do **Google Ads** de cada marca/cidade é **20 % da faturação do mês anterior** dessa marca/cidade (reservas concluídas, **sem IVA**, **sem as do Marketplace**). Ex.: Airpark Lisboa em outubro = 20 % da faturação da Airpark Lisboa em setembro.
- **Marketplace**: 20 % do que lhe **ficou** no mês anterior (comissões dos parques de terceiros + os 20 % das reservas dos nossos parques que vieram pelo Marketplace). Numa reserva de 100 € ficam ~20 € (sem IVA um pouco menos) e o orçamento é 20 % disso.
- As linhas da regra aparecem com a etiqueta **Regra 20 %** e a base usada; não se arquivam (são calculadas). Um orçamento **posto à mão** para a mesma marca/cidade no Google Ads **manda** — e a linha diz quanto a regra dava. Se a base da Multipark não responder, aparecem só os postos à mão (com aviso).
- Gasto do dia 1 até **ontem** (hoje está a meio) contra o esperado pelos dias completos. Acima de **110 %** ou abaixo de **80 %** do esperado (a partir do 4.º dia) aparece um alerta.
- **Arquivar** (antes "Apagar") tira o orçamento da lista e dos alertas, mas fica no registo. Definir o mesmo orçamento outra vez repõe-no. Mudar um valor fica registado (antes → depois).
- Quem só vê parte das cidades de um orçamento (ex.: "Marca (todas as cidades)" visto por quem só tem Lisboa) vê o gasto dessa parte, sem ritmo.

**Anúncios → ligações utm/código**: ligar um utm_campaign ou código de desconto a uma campanha fica registado; se já estava noutra campanha, passa para esta e o registo diz de onde saiu. **Retirar** uma ligação arquiva-a (fica no registo).

**Reservas ligadas a uma campanha** (ROAS por campanha, coluna **Ligadas** na linha de cada campanha e alerta "campanha sem resultados") — Jorge, 8 out 2026: as campanhas davam **0 ligadas** porque o link da reserva, com o auto-tagging da Google, só traz o **gclid** (sem o ID da campanha). Agora a reserva liga-se, por esta ordem (cada reserva conta uma vez):
1. **ID da campanha no link** (campaignid / utm_campaign numérico) — ganha sempre;
2. **gclid → campanha (Google Ads)**: sem ID no link mas com gclid, a campanha **do clique** — de hora a hora a app lê no Google Ads de que campanha é cada clique (estado em **Integrações → Google Ads → Recolha**, "Cliques (gclid → campanha)");
3. **utm_campaign** ou **código de desconto** ligados à mão à campanha.
- No ROAS por campanha, por baixo do número aparece quantas vieram **pelo clique (gclid)**; passa o rato por cima para ver de onde veio cada uma. Na linha da campanha (separador da marca), o mesmo no título da célula **Ligadas**.
- Um gclid que o Google Ads não conhece (clique com mais de 90 dias, conta não recolhida, ou ainda por ler) **não liga** — a reserva fica como estava. gbraid/wbraid (iPhone) também não: a Google não os dá por clique.
- Se a leitura dos cliques estiver desligada ou a falhar, as reservas com cliques ainda por ler ligam-se só pelo link, como antes.

**Alertas** (independentes do período): campanhas com ≥ 50 € em 14 dias sem conversões nem reservas ligadas, ritmo do mês, orçamentos e recolhas.
- Ficam **de lado**, à direita do Painel (no telemóvel, por cima). Carrega no título para os encolher e voltar a abrir.
- Aparecem os 4 primeiros. **Ver todos** mostra o resto.
- O **X** tira um alerta da lista **para toda a gente** até ao fim do mês, como nas Reservas. Fica guardado quem tirou e quando; nada se apaga. Volta sozinho no mês seguinte, ou antes em **Tirados → Repor**. Com uma marca escolhida em cima, tirar vale só para essa marca.
- Um alerta de orçamento tirado não volta só porque a percentagem mudou. Volta se passar de "acima" para "abaixo" do orçamento, ou o contrário.

**Aviso vermelho no topo**: a recolha do Google Ads ou da Meta falhou, pede nova autorização ou está parada há mais de 26 h — abre **Integrações → Google Ads** (o link só aparece a quem pode abrir as Integrações; os outros avisam o administrador). Se o próprio aviso não se conseguir ler, aparece um erro com "Tentar de novo" (nunca fica tudo "verde" por engano).

**Conversões e reservas, lado a lado** (Dashboard, Anúncios por marca e por marca/cidade):
- **Conversões (Google + Meta)**: o que cada plataforma conta (Google à parte, Meta à parte). **Custo por conversão** = gasto ÷ essas conversões.
- **Reservas via net**: reservas reais da Multipark que **não são de parceiros** (site, telefone, Marketplace) — é o que os anúncios podem trazer. Não contam as de parceiros (com parceiro na reserva, origem de parceiro ou cobradas por um agregador como Parkos/Parkvia). Ao lado: o valor e o custo por reserva via net.
- **Marketplace** (marca das contas Multipark.pt/Multipark SA): as vendas pelo **multipark.pt** contam em **Marketplace <cidade>**, onde estão as campanhas "Multipark - <Cidade> - PT". Entram as dos **parques de terceiros** que nós vendemos (origem Marketplace ou com comissão nossa) e as dos **nossos parques** que vieram pelo multipark.pt (origem Marketplace) — estas saem da linha Airpark/Redpark/Skypark da cidade. Na Faturação, na Caixa e no CRM nada muda.
- **Com link**: das reservas via net, quantas trazem o **link de origem**. Sem link não há como saber de que anúncio veio a reserva.
- **Ligadas**: as que trazem a prova do clique no link (gclid/gbraid/wbraid do Google, fbclid da Meta, utm pago). Se uma marca tem conversões mas **0 ligadas**, o mais provável é o site dessa marca não guardar o link (ou o gclid) na reserva — vê a coluna "Com link".
- O **ROAS Google (reportado)** e as "conversões contadas pela Google" são só do Google Ads. Uma conta de anúncios que deixou de ser recolhida continua a contar com o gasto que já tinha.

**Email semanal** (segunda a partir das 8h, para os endereços em MARKETING_REPORT_EMAILS): desliga-se em Definições → Automações → **Email semanal de marketing**. Se a base da Multipark falhar, o email diz que as reservas estão indisponíveis.

**Configurações de Web & SEO e Google Business** (contas, recolhas): só quem vê todas as cidades.
