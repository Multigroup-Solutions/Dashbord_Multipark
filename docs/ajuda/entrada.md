---
modulo: dashboards
grupo: Dashboards
pagina: dashboards
titulo: Dashboards, entrada e menu ("Sem acesso")
separadores: geral=Geral, financeiro=Financeiro, operacoes=Operações, pessoas=Pessoas, suporte=Suporte, marketing=Marketing
rotas: /dashboards, /dashboard, /financeiro, /operacoes-dashboard, /pessoas-dashboard, /suporte-dashboard, /, /modulos
palavras: dashboards, dashboard geral, dashboard financeiro, dashboard operações, dashboard pessoas, dashboard suporte, entregues s/ iva, custos s/ iva, margem realizada, pagamentos nos próximos 7 dias, contratos a expirar, taxa aprovação exames, rating médio google, briefing do dia, km por condutor, entrar no pda, sessão do pda, a sessão termina em 10 s, sessão terminou, google nos pdas, sem google no pda, o chrome guarda a palavra-passe, código por email, acesso@, pede o código ao tl, entrar com email, palavra-passe, esqueci a palavra-passe, pedir código, código de entrada, código de 6 algarismos, cria a tua palavra-passe, agora não, palavra-passe bloqueada, com o teu papel entra-se com google, repor acesso, entrar com código, liga a tua conta, sou novo, candidatar-me, já me candidatei, outro email, código por email, voltei, inativo, desativado, entrar, login, google, sem acesso, acesso recusado, não consigo entrar, sessão, sair, perfil, menu, página em branco, erro, versão nova, recarregar, sem centro de custos, notificação não abre, instalar app, ícone
---
# Dashboards, entrada e menu ("Sem acesso")

Os **Dashboards** (no topo do menu) juntam num só sítio os números de cada área: separadores **Geral**, **Financeiro**, **Operações**, **Pessoas**, **Suporte** e **Marketing**. Cada um abre também pelo seu endereço (/dashboard, /financeiro, /operacoes-dashboard, /pessoas-dashboard, /suporte-dashboard, /marketing). Mais abaixo: entrar na app, o menu e o "Sem acesso".

## Quem vê os Dashboards
- A página **Dashboards** (permissão **Dashboards**) é de **admin e super admin** (ou de quem tenha essa permissão dada por pessoa, em Permissões).
- Os separadores aparecem todos a quem abre a página, mas os números de cada um pedem a permissão do módulo, verificada no servidor: o **Financeiro** pede o Financeiro, a permissão de ver **totais financeiros** e um papel de admin ou acima; o **Marketing** pede o Marketing (super admin). Sem permissão, o cartão diz **"Sem acesso"** — não é zero.
- A **cidade** e a **marca** escolhidas no topo da app valem em todos os dashboards (só aparecem as cidades que podes ver); as **datas** são de cada página. Onde um cartão não segue o filtro, está dito abaixo.
- Ao entrar, quem vê os Dashboards vai para o **Geral**; quem não os vê vai para as Tarefas (team leaders) ou para a ficha (extras e condutores).

## Geral (o resumo de hoje)
Os números de **hoje**, de relance, e atalhos para os outros dashboards. Não tem barra de filtros: os cartões das reservas e das despesas seguem a cidade/marca do topo; reclamações, críticas e colaboradores são sempre de todas as cidades.
- **Briefing do dia** (quem vê a Passagem de turno): um bloco por cidade, feito todos os dias por volta das 07:30 — **Entradas / saídas**, **Pico**, **Extras escalados / necessários** (a vermelho quando faltam) e **Prazos hoje (em atraso)**. A etiqueta "texto IA" quer dizer que o parágrafo foi escrito pela IA. **Ver detalhe** mostra as entradas/saídas por hora, os prazos, os pendentes da passagem de turno, o que se repete entre turnos, os alertas e o marketing.
- **Reservas Hoje**: reservas **criadas** hoje (sem as canceladas e sem as compras online por acabar). **Check-ins Hoje** / **Check-outs Hoje**: reservas com a entrada / a saída marcada para hoje, não canceladas. **Cancelados Hoje**: canceladas hoje. Por baixo, "X este mês" (do dia 1 até hoje).
- **Receita Hoje**: o valor das reservas que **entram** hoje, **com IVA**. Não é a receita da Faturação nem do Financeiro (essas contam as **saídas**, sem IVA) — por isso os números não batem, e está certo.
- As reservas são lidas **ao vivo da BD da Multipark**, só dos nossos parques e das tuas cidades; os dias são de Lisboa. Estes cartões pedem a permissão do Financeiro e a de ver totais.
- **Despesas Mês**: despesas com data neste mês (não canceladas), com o n.º de registos. **Pendente**: todas as despesas por pagar, de sempre (não só do mês). Só admin e super admin veem estes dois com números; os outros papéis veem 0 €.
- **Reclamações**: todas as não arquivadas, em qualquer estado; "N em atraso" = passou o prazo e ainda está Nova ou Em análise.
- **Média Google**: média das estrelas das críticas (as sem estrelas não contam; as sem parque nem marca também não), com uma casa decimal; "N pendentes" = sem resposta enviada (um rascunho da IA não conta) e não fechadas. Sem críticas aparece 0,0 ★.
- **Colaboradores**: fichas ativas (de todas as cidades), com "N efetivos · N extras".
- **Dashboards · N atalhos**: botões para os dashboards que podes abrir.
- Cada cartão que não carrega diz **"Não carregou · tentar de novo"**; sem permissão diz **"Sem acesso"**; um 0 é mesmo 0.

## Financeiro (/financeiro)
Receita, custos e margem com a **mesma base da Faturação**: carros **entregues** (saída feita, CHECKED_OUT), **sem IVA**, no período escolhido. Filtros: **Período** (por omissão do dia 1 do mês até hoje), **Cidade** e **Marca**. O segundo seletor "Diário/Semanal/Mensal/Anual" não muda nenhum número.
- **Entregues s/ IVA**: as saídas do período, sem IVA ("até hoje" se o período chega a hoje), com o n.º de carros saídos.
- **Custos s/ IVA**: despesas (com a TSU paga) + salários + equipa do dia + comissões, no mesmo período; num período em curso, só até hoje.
- **Margem realizada** / **Margem s/ IVA**: entregues − custos (igual à Faturação). Num período que acaba hoje ou depois aparece também o fecho previsto (ver a ajuda da Faturação → Previsão).
- **Pendente (dívida atual)** e **Em Atraso (dívida atual)**: as despesas por pagar e em atraso **de sempre** — não dependem do período.
- **Dashboard de Despesas** (segue a cidade/marca, **não** o período): **Total Despesas** e **Pago** do ano civil; **Pendente** e **Em Atraso** de sempre; **Despesas Mensais** dos últimos 6 meses; **Por Categoria (Top 5)** e **Despesas por Categoria** só do mês atual.
- **Reservas criadas por cidade / por marca**: o valor **com IVA** das reservas **criadas** no período (o n.º de reservas aparece ao passar o rato). É outra base — não é a receita da Faturação. "Por marca" agrupa pelo nome do parque na Multipark.
- **Evolução mensal: entregues vs custos (s/ IVA)**: mês a mês, com o mesmo motor da Faturação; os meses que ainda não acabaram mostram a previsão a tracejado (**Receita esperada**, **Custos previstos**).
- **Pagamentos nos próximos 7 dias**: despesas pendentes que vencem de hoje a daqui a 7 dias, por ordem de data ("Hoje", "Amanhã", "N dias" — a vermelho com 1 dia ou menos, a amarelo com 3 ou menos).
- **Marketing** (só o super admin): gasto em anúncios Google/Meta, outras despesas de marketing, custo total, conversões, custo por conversão e ROAS (sem IVA), com **Ver marketing**.
- **Exportar para Sheets** (admin e acima, com o Drive configurado): leva os números para uma folha Google.
- Só admin e super admin veem os números principais e os das despesas; para os outros papéis aparecem a 0 sem erro.

## Operações (/operacoes-dashboard)
Visão geral operacional. Filtros: **Período** (por omissão os **últimos 30 dias**, hoje incluído), **Cidade** e **Marca** — mexem nos gráficos das reservas; os cartões "hoje" são sempre de hoje.
- **Reservas hoje** (criadas hoje, não canceladas), **Check-ins hoje**, **Check-outs hoje** e **Cancelados hoje**: só contagens, sem dinheiro, lidas ao vivo da BD da Multipark. Aqui as compras online ainda por acabar **contam** até a Multipark as dar como recolhidas ou canceladas (por isso o número pode ser diferente do Geral). Pedem só a permissão Dashboards.
- **Km ontem (GPS · N condutores)** e **Vel. máxima ontem (GPS)**: do GPS do Zello de **ontem** (só contam condutores com mais de 0,5 km); pedem o Histórico diário e não seguem a cidade do topo.
- **Reservas criadas por dia** (os dias a 0 não aparecem) e **Reservas por cidade**: as reservas criadas no período.
- **Km por condutor — ontem (GPS)**: os 12 condutores com mais km. Sem dados: a recolha provisória corre às 23:15 e a final 2 dias depois.
- Se a leitura das reservas falhar aparece **"Não foi possível ler as reservas da Multipark."** com **Tentar de novo**, e os gráficos dizem "Sem números (ver o aviso acima)" — não é zero.

## Pessoas (/pessoas-dashboard)
RH, desempenho e formação. A barra de filtros desta página **não muda nenhum número**: tudo segue só as cidades que podes ver.
- **Funcionários Ativos**: fichas ativas, com "N permanentes".
- **Contratos a Expirar**: contratos que acabam nos **próximos 30 dias** (conta também fichas inativas com o contrato a acabar).
- **Documentos em Falta**: soma, por ficha, os que faltam dos 7 obrigatórios (foto, cartão de cidadão, carta de condução, comprovativo do NIB, comprovativo de morada, contrato e termo de responsabilidade), com o n.º de colaboradores; só entram fichas que já têm pelo menos um documento.
- **Avaliados (7 dias)**: pessoas com dias avaliados nos últimos 7 dias operacionais (o dia começa às 03:00); "—" se a tua conta só vê a tua própria avaliação.
- **Taxa Aprovação Exames**: tentativas aprovadas ÷ todas as tentativas dos exames de carreira; "—" sem tentativas.
- **Distribuição por Posição** e **por Tipo de Contrato**: contagens das fichas (incluem as inativas).
- **Top 5 — últimos 7 dias**: os 5 com mais pontos na Avaliação. **Top 5 Quiz Ranking**: os 5 melhores do quiz, com o n.º de jogos e a melhor pontuação.
- Atenção: se a leitura das fichas ou dos documentos falhar, estes cartões mostram 0 em vez de um erro — confirma no RH antes de concluir.

## Suporte (/suporte-dashboard)
Reclamações, críticas Google, ocorrências e perdidos e achados. O **período não muda nenhum número**; a cidade/marca do topo vale para as Ocorrências, os Itens Perdidos e a lista das pendentes (reclamações e críticas são sempre de todas as cidades).
- **Reclamações Abertas**: Novas + Em análise + Aguarda cliente; "N total" = todas as não arquivadas.
- **Rating Médio Google** (de 0 a 5) e **Reviews Pendentes** (sem resposta enviada — a mesma regra do Geral).
- **Ocorrências Abertas**: ao vivo da app Multipark, não resolvidas (as de prioridade média fecham sozinhas do nosso lado ao fim de 3 dias), sem os parques que a operação não faz. Se a leitura falhar diz "Leitura falhou — não é 0".
- **Itens Perdidos**: abertos (novos ou em investigação), não arquivados.
- Gráficos: **Reclamações por Estado** ("Fechadas" inclui as convertidas), **Distribuição de Ratings Google** (1★ a 5★) e **Ocorrências por Tipo** (pelo título da ocorrência).
- **Últimas Reclamações Pendentes**: as 5 reclamações Novas mais recentes, com cliente, matrícula, data e prioridade.
- Se a leitura das reclamações, das críticas ou dos perdidos falhar, esses cartões mostram 0 — confirma na página do módulo.

## Marketing (Dashboards → Marketing)
O mesmo dashboard da página **Marketing** (só o super admin): ver a ajuda do Marketing. O antigo /marketing-dashboard abre /marketing.

## Entrar na app

**Entrar**: "Entrar com Google" na página inicial. Depois de entrar vais para o teu ecrã: o Dashboard (quem o vê), as Tarefas (team leaders) ou a tua ficha (extras e condutores).

## Entrar com email e código (só com o interruptor **Entrar com email e código** ligado em Definições → Automações; vem desligado — desligado, entra-se só com a Google, como sempre)
- A página de entrada passa a ter **Email**, **Palavra-passe** e **Entrar**. O botão **Entrar com Google** continua lá.
- **Primeira vez ou esqueceste-te? Pedir código**: escreve o email e carrega aí. Aparece "Pedimos o código ao TL e ao supervisor de serviço. Pede-lhes o código de 6 algarismos." Escreve o código **no mesmo aparelho onde o pediste** (noutro não funciona). Vale **10 minutos** e dá para errar **5 vezes**. Dá para colar. **Pedir outro código** só passado 1 minuto (os 3 últimos pedidos deste aparelho continuam a valer).
- Depois do código aparece **Cria a tua palavra-passe** (pelo menos 8 caracteres; não pode ser fácil como 12345678, nem ter o teu nome, nem uma data como o dia de anos). **Agora não** salta este passo — da próxima vez pedes outro código.
- O código vai para o **team leader de serviço** e os **supervisores** da cidade da tua ficha (os que têm o ponto aberto; se nenhum tiver, todos os da cidade). Sem cidade (conta nova, candidato) vai para o **RH e os admins**. Eles recebem no sino, no telemóvel (se ativaram os avisos) e em Atividade diária → Ao Vivo → **Códigos de entrada**, e dão-te o código.
- No teu sino fica "Entraste com um código enviado a TL X / supervisor Y às HH:MM". Se não foste tu, avisa o RH.
- É a **mesma conta** que com a Google (mesmo email = mesma pessoa): as mesmas permissões, a mesma ficha, o mesmo histórico. Serve qualquer email (Gmail, Hotmail, Sapo…) — o da conta ou, para extras e condutores, um dos emails da ficha. No Gmail, pontos e "+" contam como o mesmo email.
- O ecrã diz sempre o mesmo, exista ou não a conta. Um email que não existe só cria uma conta (utilizador, com "Liga a tua conta") depois do código certo.
- Depois do código valem as mesmas regras da Google: desativado não entra; inativo extra/condutor entra como utilizador ("Voltei"); ficha bloqueada mostra o ecrã de bloqueio.
- **Só para utilizadores, extras e condutores.** Team leaders, supervisores, back/front office e admins entram com a Google — com a palavra-passe aparece "Com o teu papel entra-se com Google".
- **Palavra-passe errada 5 vezes no mesmo dia** (em qualquer aparelho): até ao fim do dia só se entra com código, e o dono da conta é avisado no sino. A mensagem é sempre "Email ou palavra-passe errados".
- **Repor acesso** (Utilizadores, quem gere a conta): tira a palavra-passe, termina as sessões em todos os aparelhos e avisa a pessoa (fica nos Logs). Ninguém define a palavra-passe de outra pessoa.
- Tudo fica nos Logs: código pedido e a quem foi, entradas (Google, código, palavra-passe), palavra-passe criada/mudada/reposta, tentativas erradas.
- Uma conta Google cujo email já está noutra conta ligada a **outra** Google não se junta sozinha: a entrada é recusada e os admins são avisados (juntam em Ligações).

## Entrar num PDA (só com **Entrar com email e código** ligado; desligado, os PDAs entram como sempre, com a Google)
- Num **PDA registado** (registado pelo QR) a sessão fica **presa a esse PDA** e acaba sozinha quando: dás **saída do ponto** (em qualquer aparelho, também no telemóvel), carregas em **Sair**, **outra pessoa entra** no PDA, o ponto esquecido é fechado sozinho, ou ao fim de **16 horas**. Funciona também para quem ainda não tem ficha (contas novas, candidatos).
- Depois da saída do ponto aparece o **resumo da saída** (horas, km do Zello) e **"A sessão termina em 10 s"**; depois volta à página de entrada para a pessoa seguinte. **Terminar já** sai logo.
- **Team leaders e supervisores** entram num PDA registado com **código** (sem palavra-passe). O código só vai a quem está **acima** da pessoa (o código de um TL vai aos supervisores; o de um supervisor ao backoffice e aos admins) — nunca a um colega do mesmo nível, que podia entrar como ele. Fora dos PDAs continuam com a Google.
- **Google nos PDAs** (Definições → Automações, só o super admin; vem **ligado**, como hoje): desligado, o botão **Entrar com Google** desaparece nos PDAs registados (página de entrada, "Iniciar sessão" e registo do PDA). Telemóveis e PCs ficam sempre com o Google. Só dá para desligar com **Entrar com email e código** ligado.
- Quem já tinha entrado no PDA com a Google **não é posto fora**: ao abrir a app, a sessão passa a sessão do PDA.
- No PDA a página pede ao Chrome para **não sugerir** emails nem palavras-passe, e o email escrito não fica para a pessoa seguinte. Para o Chrome **não guardar** nada, faz a limpeza única de cada PDA (ver a ajuda do Ponto → PDAs) — sem ela o Chrome pode perguntar se quer guardar a palavra-passe.
- Um separador antigo aberto no PDA não termina a sessão de quem entrou depois.

## Código por email (definição **Código de entrada vai para**, Definições → Operação; vem em **TL + supervisor de serviço**)
- Com **email**, o código vai para o email da própria pessoa, enviado pela conta **acesso@multipark.pt** (uma conta só para isto, nunca uma caixa da Comunicação — se for, não envia). O email traz só o código e "escreve-o no aparelho onde pediste" (sem link) e nunca aparece na Comunicação.
- Se o email não sair, aparece **"Não conseguimos enviar o email agora — pede o código ao TL"** e o código vai para o TL e o supervisor de serviço, como hoje.
- No máximo **10 emails de código por dia** para o mesmo endereço (ninguém enche a caixa de outra pessoa). O código nunca vai no assunto do email, só no texto.
- No teu sino fica "Entraste com um código enviado para o teu email às HH:MM".
- **Acesso recusado** (conta desativada ou não registada): aparece a mensagem na página de entrada e **não** volta a mandar para a Google em ciclo. Fala com a administração.
- **Conta nova**: qualquer conta Google entra como **utilizador**. Se ainda não está em nenhuma ficha, aparece **"Liga a tua conta"** com duas opções:
  1. **Sou novo — quero candidatar-me**: escolhes a cidade (ou "Ainda não sei") e cria-se a tua ficha de **candidato** (com o nome e o email da Google, e a cidade escolhida — assim o supervisor dessa cidade vê-a) e a candidatura no Recrutamento, e abre **A minha ficha** para preencheres os dados e carregares os documentos. O supervisor revê e o RH aprova. Se já houver ficha ou candidatura com esse email, liga a essa (nunca cria outra).
  2. **Já me candidatei / já trabalhei convosco com outro email**: escreve o **email ou o telefone** que usaste. A resposta é sempre a mesma (não diz se encontrou). Com o código por email ligado (Definições → interruptor "Liga a tua conta: código por email"), chega um código de 6 algarismos ao email que está na ficha/candidatura (vale 10 minutos, 5 tentativas) e a conta liga-se ao escrevê-lo; senão o pedido vai para o RH. No máximo 5 pedidos por dia. Nunca se liga só pelo nome.
- **Inativo ≠ desativado**: quem ficou **inativo** (inatividade, fora do país, a pedido, fim de contrato, baixa, documentos, mudança de função) e é extra/condutor volta a entrar como **utilizador** — vê a ficha, atualiza os dados e os dias livres e carrega em **Voltei, quero trabalhar**. A ficha só volta a ativa quando o RH reativa. Quem foi **desativado** (roubou, despedido, trabalha mal, comportamento, faltas, segurança, outro, conta/ficha duplicada) fica bloqueado. A estrutura (team leaders, supervisores, back/front office, admins) inativa também fica bloqueada, como antes.
- Os antigos **"Suspenso: sem atividade"** passam a inativos quando voltam a entrar: no ecrã de bloqueio aparece "Sai e volta a entrar com a Google".
- **"Não foi possível verificar a sessão"**: o servidor não respondeu. A sessão pode continuar válida — carrega em **Tentar de novo** antes de voltar a entrar.
- Se a entrada com a Google falhar, a página de erro diz o que fazer, sem detalhes técnicos; se pedir, dá à administração a **referência** que aparece.
- Cada entrada e cada entrada recusada ficam nos Logs (só o super admin os vê).

**O que abre para quem**
- O **Perfil** e o **Menu** abrem para todos, incluindo extras e condutores.
- Um ecrã do menu que não é para ti mostra **"Sem acesso a esta página"** com **Ir para o início** e **Sair** (antes saltava em silêncio para outra página).
- **Sem centro de custos**: aparece o aviso, mas abrem o teu perfil, a tua ficha, a disponibilidade e a avaliação. Se a leitura do acesso falhar, aparece o erro com "Tentar de novo" (não é o mesmo que não ter centro de custos).
- **Acesso bloqueado** (documentos/penalizações) e **Sem acesso** têm o botão **Sair** — num PDA partilhado, a pessoa seguinte consegue entrar.

**Dashboard**: cada cartão que não carrega diz **"Não carregou · tentar de novo"** (antes mostrava 0); sem permissão diz **"Sem acesso"**. Os atalhos só mostram os dashboards que podes abrir.

**Notificações** (sino): se não carregarem aparece o erro, não "Sem notificações". Carregar numa notificação para a página onde já estás abre mesmo o registo certo.

**Links do calendário**: o turno de um extra leva à **Disponibilidade**; a escala do dia e a passagem de turno abrem o dia (e a cidade) certos.

**Erros numa página**: aparece "Esta página encontrou um erro" com **Recarregar** — o menu continua a funcionar. Se a aplicação foi atualizada com a página aberta, recarrega sozinha uma vez (ou diz "Há uma versão nova").

**Sair**: também apaga as pesquisas recentes guardadas neste aparelho.

**Instalar no telemóvel**: o ícone e o arranque ("/") estão certos para qualquer papel.
