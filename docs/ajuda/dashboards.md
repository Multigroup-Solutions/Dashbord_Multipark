---
modulo: dashboards
grupo: Dashboards
pagina: dashboards
titulo: Dashboards (Geral, Financeiro, Operações, Pessoas, Suporte)
separadores: geral=Geral, financeiro=Financeiro, operacoes=Operações, pessoas=Pessoas, suporte=Suporte, marketing=Marketing
rotas: /dashboards, /dashboard, /financeiro, /operacoes-dashboard, /pessoas-dashboard, /suporte-dashboard
palavras: dashboards, dashboard geral, dashboard financeiro, dashboard operações, dashboard pessoas, dashboard suporte, entregues s/ iva, custos s/ iva, margem realizada, pagamentos nos próximos 7 dias, contratos a expirar, taxa aprovação exames, rating médio google, briefing do dia, km por condutor, sem acesso no dashboard, dívida atual
---
# Dashboards

Os **Dashboards** (no topo do menu) juntam num só sítio os números de cada área: separadores **Geral**, **Financeiro**, **Operações**, **Pessoas**, **Suporte** e **Marketing**. Cada um abre também pelo seu endereço (/dashboard, /financeiro, /operacoes-dashboard, /pessoas-dashboard, /suporte-dashboard, /marketing). Entrar na app, o menu e o "Sem acesso" estão na ajuda "Entrada, menu e Sem acesso".

## Quem vê os Dashboards
- A página **Dashboards** (permissão **Dashboards**) é de **admin e super admin** (ou de quem tenha essa permissão dada por pessoa, em Permissões).
- Os separadores aparecem todos a quem abre a página, mas os números de cada um pedem a permissão do módulo, verificada no servidor: o **Financeiro** pede o módulo Financeiro e a permissão de ver **totais financeiros** (`finance.view_totals`); o corte por papel (só admin e acima veem os números principais e os das despesas) é feito só no ecrã. O **Marketing** pede o Marketing (super admin).
- **"Sem acesso" só aparece em alguns sítios**: nos cartões do **Geral**, no **Operações**, nas **Ocorrências** do Suporte, no **Top 5** do Pessoas ("A tua conta não vê a avaliação de outras pessoas.") e no separador **Marketing**. Nos outros cartões, um pedido recusado aparece como **0**, como **"—"** ou como uma **lista vazia** — antes de concluir que é zero, confirma que a pessoa tem a permissão do módulo.
- A **cidade** e a **marca** escolhidas no topo da app valem em todos os dashboards (só aparecem as cidades que podes ver); as **datas** são de cada página. Onde um cartão não segue o filtro, está dito abaixo.
- Ao entrar (sem link de onde vieste): papel abaixo de team leader (utilizador, extra, condutor) → a ficha (RH); team leader ou acima **sem** a permissão Dashboards → Tarefas; **com** ela → /dashboard, que abre os **Dashboards** (separador Geral). Quem não tem os Dashboards e abre /, /dashboard ou /dashboards vai, sem aviso, para o 1.º ecrã do seu menu.

## Geral (o resumo de hoje)
Os números de **hoje**, de relance, e atalhos para os outros dashboards. Não tem barra de filtros: os cartões das reservas e das despesas seguem a cidade/marca do topo. Reclamações e críticas não seguem esse filtro, mas o servidor limita-as às **cidades da pessoa**; os colaboradores são sempre de todas as cidades.
- **Briefing do dia** (quem vê a Passagem de turno): um bloco por cidade, feito todos os dias por volta das 07:30 — **Entradas / saídas**, **Pico**, **Extras escalados / necessários** (a vermelho quando faltam) e **Prazos hoje (em atraso)**. A etiqueta "texto IA" quer dizer que o parágrafo foi escrito pela IA. **Ver detalhe** mostra as entradas/saídas por hora, os prazos, os pendentes da passagem de turno, o que se repete entre turnos, os alertas e o marketing.
- **Reservas Hoje**: reservas **criadas** hoje (sem as canceladas e sem as compras online por acabar). **Check-ins Hoje** / **Check-outs Hoje**: reservas com a entrada / a saída marcada para hoje, não canceladas e sem as compras online por acabar. **Cancelados Hoje**: canceladas hoje. Por baixo, "X este mês" (do dia 1 até hoje).
- **Receita Hoje**: o valor das reservas que **entram** hoje (sem as compras online por acabar), **com IVA**. Não é a receita da Faturação nem do Financeiro (essas contam as **saídas**, sem IVA) — por isso os números não batem, e está certo.
- As reservas são lidas **ao vivo da BD da Multipark**, só dos nossos parques e das tuas cidades; os dias são de Lisboa. Estes cartões pedem a permissão do Financeiro e a de ver totais.
- **Despesas Mês**: despesas com data neste mês (não canceladas), com o n.º de registos. **Pendente**: as despesas no estado **Pendente**, de sempre (não só do mês) — as **Em atraso** não entram aqui. Só admin e super admin veem estes dois com números; os outros papéis veem 0 €.
- **Reclamações**: todas as não arquivadas, em qualquer estado; "N em atraso" = passou o prazo e ainda está Nova ou Em análise.
- **Média Google**: média das estrelas das críticas (as sem estrelas não contam; as sem parque nem marca também não), com uma casa decimal; "N pendentes" = sem resposta enviada (um rascunho da IA não conta) e não fechadas. Sem críticas aparece 0,0 ★.
- **Colaboradores**: fichas ativas (de todas as cidades), com "N efetivos · N extras".
- **Dashboards · N atalhos**: botões para os dashboards que podes abrir.
- Cada cartão que não carrega diz **"Não carregou · tentar de novo"**; sem permissão diz **"Sem acesso"**. Exceção: as despesas (Despesas Mês e Pendente) nem são pedidas para quem não é admin e mostram 0 €.

## Financeiro (/financeiro)
Receita, custos e margem com a **mesma base da Faturação**: carros **entregues** (saída feita, CHECKED_OUT), **sem IVA**, no período escolhido. Filtros: **Período** (por omissão do dia 1 do mês até hoje), **Cidade** e **Marca**. O segundo seletor "Diário/Semanal/Mensal/Anual" não muda nenhum número.
- **Entregues s/ IVA**: as saídas do período, sem IVA ("até hoje" se o período chega a hoje), com o n.º de carros saídos.
- **Custos s/ IVA**: despesas (com a TSU paga) + salários + equipa do dia + comissões, no mesmo período; num período em curso, só até hoje.
- **Margem realizada** / **Margem s/ IVA**: entregues − custos (igual à Faturação). Num período que acaba hoje ou depois aparece também o fecho previsto (ver a ajuda da Faturação → Previsão).
- **Pendente (dívida atual)** e **Em Atraso (dívida atual)**: as despesas no estado Pendente e no estado Em atraso, **de sempre** (cada uma só no seu estado) — não dependem do período.
- **Dashboard de Despesas** (segue a cidade/marca, **não** o período): **Total Despesas** e **Pago** do ano civil; **Pendente** e **Em Atraso** de sempre; **Despesas Mensais** dos últimos 6 meses; **Por Categoria (Top 5)** e **Despesas por Categoria** só do mês atual.
- **Reservas criadas por cidade / por marca**: o valor **com IVA** das reservas **criadas** no período (o n.º de reservas aparece ao passar o rato). É outra base — não é a receita da Faturação. "Por marca" agrupa pelo nome do parque na Multipark. Estes dois gráficos **não** têm o corte por papel do ecrã: veem-nos todos os que têm o Financeiro e os totais.
- **Evolução mensal: entregues vs custos (s/ IVA)**: mês a mês, com o mesmo motor da Faturação; os meses que ainda não acabaram mostram a previsão a tracejado (**Receita esperada**, **Custos previstos**).
- **Pagamentos nos próximos 7 dias**: despesas pendentes que vencem de hoje a daqui a 7 dias, por ordem de data ("Hoje", "Amanhã", "N dias" — a vermelho com 1 dia ou menos, a amarelo com 3 ou menos).
- **Marketing** (só o super admin): gasto em anúncios Google/Meta, outras despesas de marketing, custo total, conversões, custo por conversão e ROAS (sem IVA), com **Ver marketing**.
- **Exportar para Sheets** (admin e acima, com o Drive configurado): leva os números para uma folha Google.
- Só admin e super admin veem os números principais e os das despesas (o corte é do ecrã); para os outros papéis aparecem a 0 sem erro.

## Operações (/operacoes-dashboard)
Visão geral operacional. Filtros: **Período** (por omissão os **últimos 30 dias**, hoje incluído), **Cidade** e **Marca**. A cidade e a marca mudam os gráficos **e** os 4 cartões de hoje; o período só muda os gráficos (os cartões "hoje" são sempre de hoje).
- **Reservas hoje** (criadas hoje, não canceladas), **Check-ins hoje**, **Check-outs hoje** e **Cancelados hoje**: só contagens, sem dinheiro, lidas ao vivo da BD da Multipark. Aqui as compras online ainda por acabar **contam** até a Multipark as dar como recolhidas ou canceladas (por isso o número pode ser diferente do Geral). Pedem só a permissão Dashboards.
- **Km ontem (GPS · N condutores)** e **Vel. máxima ontem (GPS)**: do GPS do Zello de **ontem**. O total de km e a velocidade máxima somam **todos** os condutores; o "N condutores" e a lista **Km por condutor** contam só quem fez mais de 0,5 km. Pedem o Histórico diário e não seguem a cidade do topo.
- **Reservas criadas por dia** (os dias a 0 não aparecem) e **Reservas por cidade**: as reservas criadas no período.
- **Km por condutor — ontem (GPS)**: os 12 condutores com mais km. Sem dados: a recolha provisória corre às 23:15 e a final 2 dias depois.
- Se a leitura das reservas falhar aparece **"Não foi possível ler as reservas da Multipark."** com **Tentar de novo**, e os gráficos dizem "Sem números (ver o aviso acima)" — não é zero.

## Pessoas (/pessoas-dashboard)
RH, desempenho e formação. A barra de filtros desta página **não muda nenhum número**. **Funcionários Ativos** e **Documentos em Falta** contam **todas as cidades**; os outros cartões seguem as cidades que podes ver.
- **Funcionários Ativos**: fichas ativas de todas as cidades, com "N permanentes".
- **Contratos a Expirar**: contratos que acabam nos **próximos 30 dias** — os que acabam **hoje** não contam (conta também fichas inativas com o contrato a acabar).
- **Documentos em Falta** (todas as cidades): soma, por ficha, os que faltam dos 7 obrigatórios (foto, cartão de cidadão, carta de condução, comprovativo do NIB, comprovativo de morada, contrato e termo de responsabilidade), com o n.º de colaboradores; só entram fichas que já têm pelo menos um documento.
- **Avaliados (7 dias)**: pessoas com dias avaliados nos últimos 7 dias operacionais (o dia começa às 03:00); "—" se a tua conta só vê a tua própria avaliação.
- **Taxa Aprovação Exames**: tentativas aprovadas ÷ todas as tentativas dos exames de carreira; "—" sem tentativas.
- **Distribuição por Posição** e **por Tipo de Contrato**: contagens das fichas (incluem as inativas).
- **Top 5 — últimos 7 dias**: os 5 com mais pontos na Avaliação. **Top 5 Quiz Ranking**: os 5 melhores do quiz, com o n.º de jogos e a melhor pontuação.
- Atenção: se a leitura das fichas ou dos documentos falhar, estes cartões mostram 0 em vez de um erro — confirma no RH antes de concluir.

## Suporte (/suporte-dashboard)
Reclamações, críticas Google, ocorrências e perdidos e achados. O **período não muda nenhum número**; a cidade/marca do topo vale para as Ocorrências (a marca filtra pela **cidade** dela), os Itens Perdidos e a lista das pendentes. Reclamações e críticas não seguem esse filtro, mas o servidor limita-as às cidades da pessoa.
- **Reclamações Abertas**: Novas + Em análise + Aguarda cliente; "N total" = todas as não arquivadas.
- **Rating Médio Google** (de 0 a 5) e **Reviews Pendentes** (sem resposta enviada — a mesma regra do Geral).
- **Ocorrências Abertas**: ao vivo da app Multipark, não resolvidas (fecham sozinhas do nosso lado, ao fim de 3 dias, só as de prioridade **média** sem palavras de dinheiro, danos ou reclamação no tipo nem nas notas; na Multipark continuam por resolver), sem os parques que a operação não faz. Se a leitura falhar diz "Leitura falhou — não é 0".
- **Itens Perdidos**: abertos (novos ou em investigação), não arquivados.
- Gráficos: **Reclamações por Estado** ("Fechadas" inclui as convertidas), **Distribuição de Ratings Google** (1★ a 5★) e **Ocorrências por Tipo** (pelo título da ocorrência).
- **Últimas Reclamações Pendentes**: as 5 reclamações Novas mais recentes, com cliente, matrícula, data e prioridade.
- Se a leitura das reclamações, das críticas ou dos perdidos falhar, esses cartões mostram 0 — confirma na página do módulo.

## Marketing (Dashboards → Marketing)
O mesmo dashboard da página **Marketing** (só o super admin): ver a ajuda do Marketing. O antigo /marketing-dashboard abre /marketing.
