---
modulo: avaliacao
grupo: Pessoas
pagina: avaliacao
titulo: Avaliação (dia e mês)
separadores: dia=Separador Dia, mes=Separador Mês, minha=A minha avaliação, contestacoes=Contestações
rotas: /avaliacao, /avaliacao-operacional
palavras: não deu para ler o fecho do mês, fecho do mês, fechar o mês, horário fixo, atraso num feriado, fechado até, reabrir, prémios, quem fecha o mês, atraso ao trabalho, 5 minutos, atraso de 5 min, entrega atrasada saiu, regra antiga, mudanças de lugar, mudança de lugar, movimento entre garagens, início do movimento, excesso do gps, limite 120, 120 km/h sem tolerância, 132 km/h, trava da velocidade, dia recolhido com outro limite, picos do gps, entrega atrasada, pesquisar condutor, procurar condutor, procurar pessoa, pesquisa no ranking, n.º de agente, filtros, filtro, filtros como no odoo, odoo, só com reclamações, excesso de velocidade, excessos de velocidade, regra, regras, pontos maior que, entre, tem, não tem, agrupar por, filtros guardados, abrir com este, csv filtrado, sheets filtrado, avaliação do mês na atividade diária, mês, mensal, avaliação do team leader, tl como condutor, tl como team leader, supervisão, equipa do dia, extras a mais, extras a menos, previsão, filtro de cidade, filtro de marca, avaliação, acidente, acidente confirmado, menos 6000, avaliação operacional, avaliação individual, avaliação do dia, ranking, pontuação, pontos da avaliação, movimentos do agente, levar ao parque, histórico do agente, buscar histórico, 4 semanas, recalcular, contestação, contestar, ajuste da avaliação, avaliações dos clientes, equipa do team leader, avaliação semanal
---
# Avaliação

A avaliação dos condutores e extras está numa só página: menu **Pessoas → Avaliação**. Tem dois separadores principais, **Dia** e **Mês** (antes "4 semanas"). Tem também **A minha avaliação** e, para quem gere, **Contestações**.

**De onde vêm os números**
- **Movimentos**: quem mexeu em que reserva, quando e em que fase. São lidos **em tempo real da base de dados da Multipark**: o histórico da app (recolha, movimento, pedido de entrega, entrega, cancelamento, alterações), o condutor que ficou registado no check-in e no check-out da reserva, as ocorrências que criou ou resolveu e as avaliações dos clientes nas reservas que fez. Não se copia nada.
- **GPS** (onde deixaram os carros e por onde andaram): continua a vir do **Zello**, guardado no dashboard.
- **Ponto, escala do Extras Dia, reclamações, alertas de velocidade e penalizações**: vêm do dashboard.
- **Excessos de velocidade do GPS do Zello** (desde 14 out 2026): vêm da recolha diária do Zello (ver "Excesso de velocidade" em "Como se contam os movimentos").
- A ligação entre o agente da app Multipark e a ficha do colaborador é a do RH (o agente ligado à ficha).
- A **Atividade do Dia** (menu Operacional, `/operacional`) lê as ações da mesma forma, **ao vivo** da BD da Multipark (dia civil de Lisboa, 00h–24h). Só os dias antes de 2 de março de 2026 vêm da cópia antiga guardada no dashboard. Se a BD da Multipark não responder, a página mostra um aviso amarelo e usa essa cópia antiga, que já não é atualizada (os dias recentes aparecem sem ações).

**Não há nada para ir buscar à mão.** Todas as noites o dashboard recalcula sozinho o último mês (31 dias).
- **Abrir um dia só mostra o que está guardado.** Não recalcula nem grava nada. Por cima aparece quando foi calculado.
- Para recalcular já, quem gere a avaliação usa **Recalcular este dia** (separador Dia) ou **Recalcular** (separador Mês).
- Um dia que ainda não foi calculado diz isso mesmo, em vez de mostrar zeros.

**Separador Dia**
- Escolhe o dia. Conta o **dia operacional**, das 03h às 03h de Lisboa: manhã das 03h às 15h e noite das 15h às 03h.
- **Equipa do dia** (em cima) é a avaliação do **supervisor**: pontos da equipa e média por pessoa, ações, custo e €/ação. Por baixo, um cartão por cidade com quem supervisiona (os supervisores com essa cidade), os team leaders, os condutores escalados e se havia **extras a menos, a mais ou certos** face à previsão do Extras Dia (horas·pessoa que faltaram ou sobraram e em que horas). "A mais" só aparece quando sobram pelo menos 4 h·pessoa.
- Aparece a equipa escalada no Extras Dia, por turno, com o team leader em destaque.
- O **team leader** é avaliado de duas maneiras: **como condutor** (os pontos dele, à direita) e **como team leader** (o cartão amarelo: pontos da equipa do turno, média por pessoa, ações, custo).
- Clicar no **nome** abre a ficha da pessoa. Para cada pessoa vês as ações por tipo, os pontos, o custo e as ações por hora.
- Por baixo de cada pessoa há um resumo: reservas em que mexeu, a hora da primeira e da última ação, check-ins e check-outs assinados, ocorrências criadas e resolvidas e, quando houver, as avaliações dos clientes.
- A seta abre a **lista de movimentos** do dia, com a hora, a fase (check-in, movimento, check-out), a ação, a reserva (abre a ficha), a matrícula, o parque e o que mudou. Abre também o **GPS do Zello** desse dia: km, tempo em movimento, velocidade máxima, excessos e o link do trajeto.
- Clicar nos pontos abre o detalhe das regras. Com ficha, é o mesmo detalhe do mês, com ajustes e contestações.
- O lápis ao lado do agente muda o nome de agente associado à ficha. Só aparece a quem gere o RH.
- **CSV** exporta o dia.
- **Procurar pessoa** (por cima dos turnos): escreve o nome ou o agente e só ficam os cartões dessa pessoa. A pesquisa só esconde cartões: os totais e o CSV continuam a ser do dia todo.

**Separador Mês**
- O mesmo separador está também em **Operações → Actividade Diária → Avaliação do mês** (é uma cópia: o mesmo ecrã, os mesmos números e a mesma regra de acesso). Aqui na Avaliação continua igual.
- Abre no **mês atual** (botão **Este mês**). Podes andar mês a mês ou escolher outro período. O link antigo `?tab=semanas` abre este separador.
- O **filtro de cidade e marca** do topo da app conta: a cidade é a do dia na escala (quem é de Lisboa e fez um dia no Porto entra no Porto; sem escala, vale a cidade da ficha). A marca filtra os movimentos lidos da Multipark pelos parques dela; os pontos guardados são por cidade (as pessoas trabalham para todas as marcas da cidade).
- **Ranking** por pontos, com a vista **Por hora**. Todas as colunas ordenam. Clicar no nome abre a ficha e clicar nos pontos abre o detalhe.
- Por cima do ranking estão a **pesquisa e os filtros** (ver a seguir).
- **Equipas — team leaders e supervisão**: por cidade (o supervisor), pessoas·dia, ações, pontos e média; e por team leader, os dias como TL, os pontos dele como condutor e os pontos e a média da equipa nesses dias (mesmo dia, cidade e turno). Todas as colunas ordenam.
- **Movimentos na BD da Multipark**: tabela por pessoa, lida no momento, com ações, check-ins, movimentos, check-outs, reservas, check-ins/check-outs assinados, ocorrências, avaliações dos clientes e a última ação. Mostra no máximo 62 dias de cada vez.
- **Recalcular** (quem gere a avaliação) volta a calcular o período já. Um período grande pode ficar a meio e o resto fica para o recálculo automático da noite.

**Pesquisar e filtrar o ranking (como no Odoo)**
- **Pesquisa**: escreve o nome ou o n.º de agente e o ranking filtra-se logo. Não contam acentos nem maiúsculas ("joao" encontra "João"). Enquanto escreves aparece **Procurar «…» em**: Nome ou n.º de agente, Cidade, Marca, Posto ou Equipa (TL), com quantas pessoas encontra em cada. Escolhe uma e a pesquisa passa a **chip** (o Enter faz o mesmo, no nome). No mesmo campo, as pesquisas juntam com "ou"; em campos diferentes, com "e".
- **Grupos**: **Cidade**, **Marca**, **Posto** (condutor, condutor sénior, extra, team leader), **Equipa** e **Só com…** (excessos de velocidade, reclamações, acidentes, atrasos ao trabalho, contestações abertas, com ajustes, pontos negativos). No mesmo grupo junta com "ou" (Porto ou Faro); entre grupos, com "e" (Porto e só com reclamações).
- **+ Regra**: regras sobre as colunas e as métricas: pontos (total, ganhos e perdidos), horas, dias, ações, recolhas e entregas, movimentos, levar ao parque, atrasos ao trabalho, excessos de velocidade, reclamações, acidentes, custo, ações e pontos por hora, ocorrências, penalizações, contestações abertas e dias como TL.
  - As horas são as do ponto (não as da escala) e o custo é em euros. Usa vírgula ou ponto nas casas decimais (7,5 = 7.5).
  - Operadores: **≥**, **≤**, **=**, **entre** (inclui os dois valores), **tem** (diferente de 0) e **não tem**. Por hora, quem não tem horas só cumpre **não tem**.
  - Escolhe se cumprem **todas as regras** ou **pelo menos uma**.
  - Exemplos: "Pontos ≥ 500 e Excessos de velocidade ≥ 1"; "Reclamações: tem".
- Cada filtro aparece como **chip**: o **×** tira esse e **Limpar tudo** tira todos.
- **Agrupar** por cidade, marca, posto ou equipa (TL), com o total de cada grupo (pessoas, pontos, horas e ações).
  - A cidade de cada pessoa é a da escala onde fez mais dias; sem escala, a da ficha.
  - A marca é a da ficha. É a mesma marca em todas as cidades: o Airpark de Lisboa e o do Porto aparecem juntos como **Airpark**.
  - A equipa é o TL com quem mais trabalhou (mesmo dia, cidade e turno). Quem só foi TL fica na própria equipa.
- **Filtros guardados**: guarda o filtro com um nome. Leva também o agrupar, a vista (Totais ou Por hora) e a ordem.
  - Podes **partilhá-lo com a equipa** (quem vê o ranking).
  - **Abrir com este** marca um por omissão (um por pessoa). Aplica-se uma vez por sessão, se não tiveres já outro filtro.
- Com filtro, os **cartões do topo** (Horas, Ações, Custo, Melhor), o **CSV** e o **Exportar para Sheets** levam só as pessoas filtradas, e dizem-no:
  - o CSV tem o filtro na primeira linha (com "12 de 48 colaboradores") e "_filtrado" no nome;
  - a folha tem "filtrado" no nome, o separador **Ranking (filtrado)** e um separador **Filtro**;
  - a folha leva também o filtro de cidade e marca do topo.
- A **posição (#)** é a do ranking do período, sem filtro.
- O filtro fica enquanto o separador do browser estiver aberto, aqui e na Atividade diária → Avaliação do mês.
- As **Equipas** e os **Movimentos na BD da Multipark**, por baixo, não seguem este filtro.

**Se aparecer um aviso amarelo**, a base de dados da Multipark não respondeu.
- O que está gravado **não é mexido**: nem o recálculo da noite nem o **Recalcular** gravam por cima. Antes podiam pôr zeros nos dias bons.
- O **Recalcular** avisa que nada foi recalculado. Tenta de novo daqui a pouco.
- Se uma leitura falhar, aparece **"Não foi possível carregar…"** com **Tentar de novo**, nunca "sem dados".

**Como se contam os movimentos**
- Os dias calculados antes das regras de agora seguiam as regras antigas. A avaliação do mês avisa quantos são ("N dia(s) calculado(s) com as regras antigas") e, a quem pode, mostra **Recalcular**. O recálculo da noite refaz sozinho os últimos 31 dias; para dias mais antigos (ex.: o início de setembro), carrega uma vez em **Recalcular** em Avaliação → Mês. Setembro e outubro não contam para prémios: os prémios começam em novembro.
- Recolha = check-in feito. Entrega = check-out feito.
- Cada vez que um carro muda de sítio, a app Multipark grava duas linhas: o **início** e o **fim**. Só o fim conta. "Parque" é a **garagem** (PD, PD FORA, COBERTO, Central…).
  - **Levar ao parque**: o carro foi arrumado (ainda não tinha garagem), por exemplo logo a seguir à recolha. Vale +{{regra:evaluation.points.firstMoveAfterPickup}}.
  - **Movimento entre parques**: o carro mudou de garagem (ex.: PD → COBERTO). Vale +{{regra:evaluation.points.movement}}.
  - **Mudança de lugar**: o carro ficou na mesma garagem, só mudou de lugar (ex.: PD 26/3 → PD 70/1). Não é movimento. Vale +{{regra:evaluation.points.spotChange}}.
- **Atraso ao trabalho** ({{regra:evaluation.points.delay}}): a entrada no ponto foi **{{regra:evaluation.lateArrivalFromMinutes}} minutos ou mais** depois da hora da escala. Contam minutos inteiros: numa escala das 03:00, entrar às 03:04:59 não é atraso; às 03:05:00 já é ({{regra:evaluation.points.delay}}), e às 03:10 também. Conta no máximo **{{regra:evaluation.maxLateArrivalsPerDay}} por dia**. Vale para **todos os que têm horário**: nos dias em que a pessoa está na escala do Extras-Dia conta a hora da escala; nos outros, o **horário fixo** da ficha do RH (Horário; para os funcionários — os extras regem-se pela escala). Nos dias livres do horário, nas férias ou baixas registadas no RH, fora do contrato e nos **feriados** (os nacionais e o municipal da cidade da ficha) não há atraso pelo horário fixo; quem estiver escalado no Extras-Dia num feriado tem a hora da escala. Com **"RH: fins de semana e exceções por data"** ligado, uma **exceção por data** na ficha (fim de semana de serviço, folga, feriado de serviço) ganha ao horário fixo nesse dia (ver a ajuda "RH e ponto"). Na mudança da hora de março, uma hora que não existe (01:30 de domingo) conta como 02:30 — quem entra às 02:30 não tem atraso.
- **Entrega atrasada: saiu**. Os tempos das entregas e das recolhas são da equipa, não de cada pessoa, e a hora marcada na ficha não conta para eles. Vale para todos os dias, também os de setembro e outubro (não são meses de prémios).
  - Nos dias antigos a coluna das entregas atrasadas fica guardada, com o rótulo "(regra antiga)", mas já não tira pontos nem aparece nos ecrãs, no CSV nem nos filtros. Os **atrasos** que se veem são sempre só os atrasos ao trabalho.
  - Os ajustes antigos de "entregas atrasadas" ficam no histórico do dia com "Sem efeito: regra retirada". Já não se pode ajustar nem contestar essa métrica.
  - Um filtro guardado com "Entregas atrasadas" perde só essa parte, e o ecrã avisa ("N partes do filtro deixaram de existir").
- **Excesso de velocidade** ({{regra:evaluation.points.speeding}}): os alertas de velocidade e as penalizações do RH e, além disso, **1 por dia** em que a velocidade máxima do GPS do Zello passou o limite. Se nesse dia (de calendário, ou no dia da avaliação) já houver um alerta, o GPS não conta outra vez. Se não der para ler o limite, o GPS não conta e aparece um aviso.
  - O limite está em **Definições → Parâmetros → "Limite de velocidade (GPS do Zello)"**: **120 km/h, sem tolerância** por omissão (conta acima de 120). Antes eram 10 % de tolerância (132 km/h); quem tinha o valor antigo gravado passou para 0 % sozinho, e fica no histórico das Definições. É um limite único, porque o Zello não diz em que estrada se vai.
  - Desde 14 out 2026 a velocidade máxima do dia já não tem os **picos falsos** do GPS (pontos imprecisos, acima de 250 km/h ou um salto isolado) e, acima do limite, só conta um **excesso confirmado**: pontos seguidos acima dele (2 por omissão). Antes deitava-se fora tudo acima de 150 km/h.
  - Os dias de GPS recolhidos antes contam pela velocidade máxima antiga, até se voltarem a dividir (**Atividade diária → Histórico Diário → Forçar re-divisão**) e recalcular.
  - **Trava do dia recolhido**: cada dia de GPS guarda o limite com que foi recolhido. Um dia só conta excesso acima do **maior** entre o limite de hoje e esse. Os dias recolhidos com o limite antigo (132) contam a **132** até serem re-divididos. Porquê: nesses dias, uma máxima entre 120 e 132 pode ser um ponto solto que nunca foi confirmado como excesso; contá-la a 120 inventava excessos. Na Atividade diária esse dia pode aparecer a vermelho (passou 120) sem tirar pontos.
- **Reclamação confirmada** ({{regra:evaluation.points.confirmedComplaint}}, uma vez por reclamação e condutor): uma reclamação não convertida com pontos aplicados (na reclamação ou ao condutor), positivos ou negativos. Conta no dia em que a reclamação foi criada.
- Início da recolha, pedido de entrega, início da entrega, alterações e criações aparecem na lista e contam como ações, mas não dão pontos.

**Fecho do mês (antes de pagar os prémios)**
- Em **Avaliação → Mês**, por cima do ranking, aparece **"Fechado até DD/MM/AAAA"** quando há meses fechados. Os dias até essa data **já não mudam**: o recálculo da noite, o **Recalcular**, os ajustes, anular ajustes, as contestações (criar, e aceitar com ajuste) e a re-divisão do GPS dos últimos 31 dias (Atividade diária) não lhes tocam. Recusar uma contestação, ou aceitá-la sem mexer nos números, continua a dar.
- **Quem fecha**: o super admin e as pessoas da lista **Definições → Parâmetros → Pessoas → "Avaliação: quem fecha o mês"** (o super admin escolhe as contas). Para fechar:
  1. Avaliação → **Mês**.
  2. Na barra "Fecho do mês", escolhe o último dia a fechar (vem preenchido com o fim do mês anterior).
  3. **Fechar até esta data** e confirma.
- **Reabrir**: **Reabrir** (nada fechado) ou fechar até uma data mais cedo. Cada mudança fica no histórico das Definições, com quem e quando.
- Só se fecha até ontem. Setembro e outubro não são meses de prémios: o primeiro fecho é o de **novembro, no início de dezembro**.
- O fecho congela os **números**, não as **regras**: a pontuação calcula-se ao ler. Depois do primeiro fecho, qualquer mudança nos pontos ou nas regras tem de dizer **a partir de que dia vale**, senão mudava meses já pagos.
- No detalhe de uma pessoa, os dias fechados têm a etiqueta **fechado** e não mostram Ajustar nem Contestar.
- Se a barra disser **"Não deu para ler o fecho do mês: por agora nada se recalcula nem se ajusta."**, a leitura da data do fecho falhou (não quer dizer que nada esteja fechado): enquanto não se souber até onde está fechado, o ecrã não deixa recalcular nem ajustar, para não mexer em dias já pagos. Recarrega a página daqui a pouco.

**A minha avaliação**
- Separador **A minha avaliação** (extras, condutores e os papéis com a Avaliação; o papel **utilizador** não tem este módulo): os teus pontos no período, uma **explicação** curta e o detalhe dia a dia. Só vês os teus dados.
- **Sem centro de custos** só funcionam os teus pontos e o **Contestar** (a explicação não aparece).
- A **explicação** é um texto curto a partir das linhas das regras (a pontuação é sempre a da tabela); quando foi escrita pela IA leva a etiqueta **IA**, e um team leader (ou acima) pode **escondê-la** ao colaborador.
- Se algo estiver errado num dia, abre o dia e carrega em **Contestar** e explica o que aconteceu (pelo menos 5 caracteres). A contestação fica **Em análise** até quem gere a avaliação a aceitar (às vezes com um ajuste dos pontos desse dia) ou recusar. Ninguém decide a sua própria.
- Os dias **fechados** (fecho do mês) já não se contestam. Se a leitura do fecho falhar, o ecrã pode mostrar **Contestar** num dia fechado, mas o servidor recusa.
- Sem ficha ligada à conta aparece "A tua conta não está ligada a uma ficha de colaborador — fala com o RH."

**Contestações**
- Separador **Contestações** (só quem gere a avaliação: supervisores, front e backoffice e a administração): as contestações por estado — **Em análise**, **Aceites** e **Recusadas**. Quando há contestações nesse estado aparece **Procurar pessoa…**, que filtra pelo nome.
- Nas **Em análise** aparece **Decidir**: vês o que a pessoa escreveu, escreves a **resposta** (pelo menos 3 caracteres, para aceitar e para recusar) e carregas em **Aceitar** (com ou sem ajuste dos pontos) ou **Recusar**.
- Um ajuste aceite entra nos **Ajustes manuais** desse dia, com quem o fez e a data.

**Quem vê o quê**
São as permissões de Definições → Permissões, iguais no ecrã e no servidor, com as permissões por utilizador.
- **Dia**: supervisores, da sua cidade, e para cima.
- **Mês**: team leaders, só a **sua equipa** (condutores e extras abaixo deles, e eles próprios), supervisores, front e backoffice e a administração.
- **Recalcular, ajustar e decidir contestações**: supervisores, front e backoffice e a administração. Ninguém ajusta nem decide a sua própria avaliação.
- **A minha avaliação**: cada pessoa com ficha. Funciona mesmo sem centro de custos.
- **Filtros guardados do ranking**: quem vê o Mês. Os partilhados aparecem a todos os que veem o Mês, e cada um aplica-o só aos dados que já vê. Só quem o criou o altera ou o apaga.
- **Contestações** tem **Procurar pessoa**, que filtra pelo nome.
- Todos veem só os dados das suas cidades.
- O link antigo `/avaliacao-operacional` abre o separador Dia.

**Acidentes: −6000 pontos**
- Um acidente conta **{{regra:evaluation.points.accidentOrDamage}}** pontos a quem conduzia, no dia operacional da ocorrência.
- Só contam os acidentes **a partir de 3 de outubro de 2026**. Os antigos não contam: nem as ocorrências antigas do dashboard, nem ajustes de acidentes em dias anteriores.
- Só conta depois de um **team leader** (ou acima) o confirmar na ocorrência, em **Operacional → Ocorrências**: abre a ocorrência, em **Foi um acidente?** escolhe quem conduzia e confirma.
- A sugestão são as pessoas das últimas ações nessa reserva antes da ocorrência.
- O team leader só confirma acidentes da sua equipa. Ninguém confirma um acidente seu.
- **Desfazer** (com o motivo) tira os pontos. A confirmação fica no histórico, com quem a desfez e porquê.
- Esse dia recalcula-se sozinho logo a seguir.

**Pontos que não se repetem**: uma penalização ligada a uma reclamação ou a um alerta de velocidade não volta a contar se essa reclamação ou esse alerta já contam noutro dia.

**Fichas juntas**: quando duas fichas da mesma pessoa são juntas, a que sai deixa de contar para ligar agentes pelo nome.

**Avaliação semanal antiga**: já não se gera, nem pela app nem sozinha à segunda-feira. As semanas gravadas ficam como histórico. O **Painel de Pessoas** mostra o mesmo ranking desta página, dos últimos 7 dias.
