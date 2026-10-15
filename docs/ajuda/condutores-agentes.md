---
modulo: condutores_agentes
grupo: Pessoas
pagina: condutores-agentes
titulo: Condutores e agentes
separadores: drivers=Condutores, agents=Agentes, performance=Desempenho
rotas: /pessoas/condutores-agentes
palavras: tempos por condutor, tempos do condutor, fila, trânsito, tempo do cliente, no terminal, no p2, colegas, comparar com os colegas, mediana, p75, média, evolução, gráfico dos tempos, sem dados suficientes, em calibração, mudanças de lugar, mudança de lugar, quem vê condutores, acesso, dias acima do limite, limite de velocidade, 120 km/h, excesso de velocidade, picos do gps, dias com gps, dias sem gps, zello não ligado, atrasos, atrasos ao trabalho, entregas atrasadas, km, quilómetros, km sem movimentos, pontos da equipa, recolhas, escolher condutor, filtro de cidade, filtro de marca, tirar da lista, ligações, condutores, agentes, ranking, entregas, checkout, performance, ações do agente, histórico do agente, pessoa, ficha, desempenho, desempenho por pessoa, cobranças de parceiros, cobranças de pro, avenças, quem registou, atividade por hora, horas do dia, a que horas trabalha, chamadas perdidas, chamadas devolvidas, minutos ao telefone, emails pessoais, pesos, editar pesos, pesos do ranking, pontos do ranking, quanto vale cada coisa, repor omissões, 1 ponto 5 minutos, procurar nome, pesquisar, filtros, parâmetros, colunas, esconder colunas, só ativos, atraso à entrada
---
# Condutores e agentes

Em **Pessoas → Condutores e agentes**. Antes estavam nas Críticas.

## Quem vê (desde 14 out 2026)
- **Condutores** e **Agentes**: supervisor (as cidades dele), back office, admin e super admin. Front office e team leader já não veem (nem no menu, nem pelo link direto, nem na pesquisa, nem pelo botão **Abrir agente** do RH, nem pelo MCP). Uma permissão por pessoa (**Definições → Permissões**, módulo "Condutores e agentes") dá ou tira o acesso.
- **Desempenho**: só o super admin.

**Procurar e filtrar** (nos três separadores): escreve um nome na caixa **Procurar pelo nome…** (sem acentos e por palavras: "joao alv" encontra "João Alves"). Em **Filtros** pões parâmetros, por exemplo **Por hora ≥ 8** ou **Entregas ≤ 5**: escolhe a coluna, ≥ ou ≤, o valor e **Pôr**. Podes juntar vários; ficam em chips por baixo, cada um com um × para tirar. Quem não tem valor numa coluna (ex.: "—" no Por hora) não passa nesse filtro.

## Movimentos e mudanças de lugar (contam-se assim em todo o lado: aqui, na Avaliação, no Desempenho, na Atividade do dia e no Resumo do dia)
- Cada vez que um carro muda de sítio, a app Multipark grava duas linhas: o **início** e o **fim**. O início não conta (nem como ação). "Parque" é a **garagem** (PD, PD FORA, COBERTO, Central…).
  - **Levar ao parque**: o carro foi arrumado (ainda não tinha garagem), por exemplo logo a seguir à recolha. É movimento (+5 na avaliação).
  - **Movimento entre parques**: o carro mudou de garagem (ex.: PD → COBERTO). É movimento (+2).
  - **Mudança de lugar**: o carro ficou na mesma garagem e só mudou de lugar (ex.: PD 26/3 → PD 70/1). **Conta como ação**, não como movimento (+1 na avaliação).
- **Movimentos** = levar ao parque + entre parques. **Mudanças de lugar** têm coluna própria e abrem a lista delas.
- Antes, as mudanças de lugar davam sempre 0 (procuravam outro tipo de registo, que a Multipark não usa) e cada deslocação contava como dois movimentos (o início e o fim).

**Condutores**
- Uma linha por pessoa com as **recolhas**, **entregas**, **movimentos**, **mudanças de lugar** e os **km do GPS** (Zello) no período, lidos ao vivo da Multipark. **Movimentos** = levar ao parque + entre garagens; dentro da mesma garagem conta só como **mudança de lugar**. Só aparece quem mexeu em carros (mudanças de lugar incluídas). As várias contas de agente da mesma ficha somam.
- **Cidade e marca**: o filtro do topo da app. A marca filtra pelos parques dela.
- Escolhe o período (De/Até) e, se quiseres, **um condutor** (ou "Todos").
- Clicar no **nome** abre a ficha. Clicar num **número** abre esses movimentos (ex.: as entregas ou as mudanças de lugar desse condutor), com a matrícula, o parque e a hora.
- Todas as colunas ordenam; em baixo ficam os totais.

## Tempos de um condutor (desde 15 out 2026)
Se durante meses os colegas entregam todos entre 13 e 17 min e um condutor demora sempre 20 a 30, é importante saber. Por isso cada condutor tem os seus tempos, ao lado dos colegas.
1. Em **Condutores**, carrega no **relógio** da linha do condutor (coluna **Tempos**). Também aparecem por baixo da tabela quando escolhes **um condutor** em cima, e no detalhe do **Desempenho** (condutores e team leaders).
2. Escolhe o tempo nos botões: **Fila** (da chamada do cliente, ou do pendente, até o condutor pegar no carro), **Trânsito** (até chegar ao terminal, pelo GPS), **Cliente** (nas entregas em que fez o check-out: a espera pelo cliente no terminal), **No terminal** (nas recolhas que tirou do terminal) e **No P2** (nas recolhas que tirou do P2).
3. A tabela mostra a **última semana**, o **último mês** e os **últimos 6 meses**, uma linha por cidade e tipo de serviço (T1, T2, VIP, Outro): quantas medições (n), a **média**, a **mediana** e o **p75**, a mediana dos **colegas** (os outros condutores da mesma cidade e do mesmo serviço, sem o próprio) e a **diferença** (a âmbar quando o condutor demora mais).
4. O **gráfico** mostra a evolução, **por mês** ou **por semana**: a mediana do condutor a azul e a dos colegas a cinzento. Passa o rato (ou toca) num ponto para ver os números; **Ver em tabela** mostra-os todos.
- Com menos de **10 medições** numa linha aparece **"sem dados suficientes"** (nunca 0); no gráfico, esse ponto fica em falta.
- O Trânsito, o Cliente e o tempo no terminal dependem do GPS: até a calibração acabar só o super admin os vê, como provisórios; os outros veem **"Em calibração"**. Depois de o portão abrir (Definições → Parâmetros → **Tempos com GPS: portão**), aparecem por cidade e período quando há pelo menos 60 % de medições e 20 casos; abaixo disso, "Sem dados suficientes". A Fila e o P2 veem-se sempre.
- Os números vêm da tabela dos tempos (o cálculo da noite), até ontem. Sem ela, aparece "Sem tempos deste condutor". Se a leitura for grande de mais e chegar ao limite, entram os dias mais recentes e o cartão diz "Leitura cortada no limite".
- **Só informação: não dá pontos.** Não entra na Avaliação nem no ranking do Desempenho.
- Quem vê: quem vê os Condutores (supervisor nas suas cidades, back office, admin e super admin), só para fichas das suas cidades.

**Agentes**
- A mesma lista, com **todas** as ações de cada agente no período: recolhas, entregas, movimentos, mudanças de lugar, reservas em que mexeu e a última ação. **Movimentos** = levar ao parque + movimentos entre garagens (o início de cada movimento não conta); **mudanças de lugar** = o carro ficou na mesma garagem, só mudou de lugar. Primeiro a lista, depois o detalhe.
- Procura por **nome ou código do agente** (na caixa Procurar pelo nome…), ou escolhe a pessoa.
- Quem não tem ficha aparece com "sem ficha"; os parceiros com "parceiro".
- O botão **Abrir agente** da ficha do RH abre esta aba já com o detalhe dessa pessoa.
- Se o período tiver ações a mais, o detalhe diz quantas mostra e pede um período mais curto.
- **Quem gere o RH**: o ícone de corrente abre as **Ligações** da pessoa (unir/separar conta e agente); num agente sem ficha, o ícone do olho **tira-o da lista** (fica como "não é funcionário", desfaz-se no RH → Agentes; na Multipark não muda nada).
- No máximo 62 dias de cada vez.

## Desempenho (só o super admin; os outros nem veem a aba)
- **Colunas**: escolhe que colunas a tabela "Toda a gente" mostra, para caber no ecrã (fica guardado neste browser, por aba). Sem escolha, aparecem só as colunas com algum valor no período. Em **Filtros** há também **Só fichas ativas**.
- Tudo o que cada pessoa fez, por **dia, semana, mês ou ano** (setas para andar para trás e para a frente). Há uma aba por posto: **Back e front office**, **Supervisão**, **Team leaders** e **Condutores e extras**. A aba segue o papel da conta (front office, backoffice, supervisor, team leader); quem não tem um destes papéis fica pelo posto da ficha.
- Junta três fontes:
  - **Multipark**, pela avaliação diária: recolhas, entregas, movimentos, "pôs em recolha/entrega", reservas criadas e alteradas, ocorrências.
  - **Zello**: km, dias com GPS, velocidade máxima, dias acima do limite e dias de trabalho sem GPS. O limite está em **Definições → Parâmetros → "Limite de velocidade (GPS do Zello)"** (acima de 120 km/h, sem tolerância, por omissão).
  - **Dashboard**: horas (ponto ou escala), chamadas atendidas, feitas, perdidas e devolvidas e os minutos ao telefone, WhatsApp, emails enviados (pela dashboard e da caixa Gmail pessoal de cada um), respostas e fecho de reclamações, críticas Google respondidas, despesas lançadas e aprovadas, contagens e correções de caixa, tarefas, leads, passagens de turno, contas de parceiros, fechos de mês dos parceiros, extras do dia escalados, atualizações do CRM, perdidos e achados, dias como team leader e quantas pessoas tinha.
  - Também da **Multipark**: voos de regresso registados (as alterações à reserva que mexem no voo de regresso) e as cobranças, em duas colunas:
    - **Cobranças de parceiros**: os pagamentos de parceiros que um agente marcou e os créditos de parceiro lançados.
    - **Cobranças de Pro e avenças**: os pagamentos de clientes Pro e de avenças que um agente marcou.
    - A Multipark guarda sempre quem as registou, e é por aí que se sabe de quem são.
- No topo, os números do grupo e a **evolução**: por dia na semana e no mês, por mês no ano. A seguir, o **ranking**, por **pontos** ou por **pontos por hora**. O "por hora" só aparece com 4 h ou mais no período.
  - **Pontos**: a soma ponderada do que a aba mede, com os pesos da tabela "Como se contam os pontos desta aba". Nos condutores e team leaders o trabalho na rua conta pelos pontos da avaliação. Os dias acima do limite já descontam aí, como excesso de velocidade (−10), por isso não descontam outra vez no ranking. Colunas separadas para **Atrasos à entrada** (no máximo 1 por dia), **Entregas atrasadas** e **Mudanças de lugar**. **Ocorrências que registou** = as que a pessoa criou na app Multipark ou no dashboard (+1 cada).
  - **Nota**: 100 para o melhor.
- Na tabela, o **nome** abre a ficha no RH; o resto da linha abre o **detalhe** (a evolução dela e todos os números). Todos os cabeçalhos ordenam (um clique sobe, outro desce, o terceiro volta ao ranking).
- **Cidade e marca**: o filtro do topo. Com uma cidade escolhida, cada dia conta na cidade onde a pessoa trabalhou (a escala ou a avaliação do dia). Quem tem a ficha noutra cidade entra só com os dias que fez nesta. A marca conta como a cidade dela.
- **Condutores e extras**: quem não fez nada no período não aparece. **km sem movimentos** quer dizer que a pessoa tem km do Zello mas nenhum movimento na Multipark: o utilizador do Zello/PDA e o agente da Multipark não estão na mesma ficha. Carrega no aviso para abrir as **Ligações** e juntar.
- **Team leaders pela escala**: quem tem posto de condutor ou extra mas foi team leader em pelo menos metade dos dias escalados do período aparece nos Team leaders, com a etiqueta "TL pela escala".
- **A equipa**, nas abas Team leaders e Supervisão:
  - **Team leader**: o turno dele na escala (mesmo dia, cidade e turno, sem ele).
  - **Supervisor**: todos os escalados das cidades da conta dele, team leaders incluídos. Dois supervisores da mesma cidade partilham a equipa.
  - Para cada um mostra: dias com equipa, pessoas·dia, movimentos da equipa (recolhas, entregas e movimentos), custo da equipa (como na Atividade do dia), quem mexeu carros sem o Zello ligado, horas paradas (GPS), movimentos por pessoa·dia e € por movimento.
  - No supervisor mostra também as **extras a menos / a mais**: as horas·pessoa abaixo ou acima da previsão do Extras Dia. Só aparece com **Dia** ou **Semana**, porque a previsão é lida ao vivo, dia a dia.
  - **Pontos da equipa**: contam-se por dia e por pessoa da equipa, para uma equipa maior não ganhar só por ser maior. Por omissão, cada movimento dá +1, cada pessoa que mexeu carros sem Zello −20 e cada hora parada −2, sempre a dividir pelo número de pessoas da equipa (mudam-se em **Editar pesos**). Somam-se aos pontos do TL (que é avaliado também como condutor) e do supervisor.
- **Como se contam os pontos desta aba**: em cima, a régua e o que conta; a seguir, quanto vale cada coisa **agora** (com "alterado" ao lado do que já não é a omissão), em duas colunas a toda a largura (no telemóvel, uma só); por baixo, lado a lado, os pontos da avaliação (recolha +3, movimento +2…) e os da equipa.
  - A régua: **1 ponto ≈ 5 minutos de trabalho**, a mesma escala da avaliação (recolha ou entrega 3, movimento entre parques 2, levar ao parque 5, mudança de lugar 1). Por exemplo: reserva criada 2, email 1, chamada atendida 0,5 mais 0,2 por minuto ao telefone, fecho de mês de um parceiro 6, contagem de caixa 2. Horas e km não dão pontos.
  - **Mudar os pesos** (sem esperar por uma atualização da app; só o super admin):
    1. Abre a aba (ex.: **Back e front office**) e, em "Como se contam os pontos desta aba", carrega em **Editar pesos**.
    2. Cada linha passa a um número: escreve o novo peso (ex.: 0,5). **0 = não conta**; um número negativo desconta. Ao lado fica a omissão do código.
    3. Para pôr a contar uma coluna da aba que hoje não conta, escolhe-a em "Acrescentar uma coluna que não conta…" e carrega em **Acrescentar**.
    4. Nas abas **Team leaders** e **Supervisão** mudas também os 3 pontos da equipa (valem para as duas abas).
    5. Carrega em **Guardar**. O ranking recalcula logo, também para trás (os pontos calculam-se sempre na hora, não ficam guardados).
    - **Repor omissões da aba** volta a pôr no ecrã os pesos do código dessa aba (e os da equipa); fica gravado quando carregas em **Guardar**. **Cancelar** sai sem gravar.
    - Pesos entre −10 000 e 10 000, com uma casa decimal no máximo.
  - Fica registado quem mudou e quando: por baixo do botão e em **Definições → Parâmetros → Histórico de alterações**. Também se mudam em Definições → Parâmetros → **Pessoas (desempenho)** → "Pesos do ranking do Desempenho" (em JSON, para quem preferir).
- **Telefonemas da central**: contam quando a consola da Vodafone os regista na dashboard (Integrações → Central Vodafone), para quem atendeu ou ligou. As chamadas internas (com colegas do RH ou de extensões) não contam, exceto as do supervisor a ligar aos extras (a chamar o pessoal). As chamadas do WhatsApp contam sempre.
  - **Perdidas**: recebidas que a pessoa não atendeu. Aparecem a vermelho, mas não contam nos pontos (a chamada toca em várias consolas).
  - **Devolvidas**: a 1.ª chamada feita para um número (ou contacto) que teve uma perdida nas 24 h anteriores, de quem quer que fosse a perdida. Ligar outra vez à mesma pessoa já não conta como devolvida.
  - **Minutos ao telefone**: o tempo das atendidas e das feitas (a consola só manda minutos inteiros), mais o das chamadas do WhatsApp. Cada minuto vale 0,2 pontos (por omissão), além do que vale a chamada (0,5).
  - Os telemóveis One Net (Xsi) ainda não entram.
- **Emails**: contam os enviados pela dashboard e os enviados da **caixa Gmail pessoal** de cada um (O meu email, com o Gmail ligado), cada email uma vez — um email mandado pela dashboard da própria caixa não conta a dobrar. Os enviados diretamente das caixas partilhadas (info@, reservas@…) fora da dashboard não têm autor e não contam.
- **Atividade por hora do dia**: a que horas cada um trabalha mesmo, na hora de Lisboa.
  - Na aba, uma grelha com uma linha por pessoa (e "Toda a aba" em cima) e uma coluna por hora, das 0h às 23h: quanto mais escuro, mais ações nessa hora. **Cor por pessoa** = cada linha na sua escala (vê-se o padrão de cada um); **igual para todos** = a mesma escala (vê-se quem faz mais). Passa o rato (ou toca) numa célula para ver o número; **Ver em tabela** mostra todos os números. Aparecem as 25 pessoas com mais ações; **Mostrar todos** abre o resto.
  - No detalhe de cada pessoa, um gráfico de barras das 0h às 23h, com "das 7h às 19h · pico às 10h" (quem faz a noite aparece "das 15h às 2h").
  - Ações = **Multipark** (recolhas, entregas, movimentos, pôr em recolha/entrega, reservas criadas e alterações) + **dashboard** (chamadas atendidas e feitas, emails, WhatsApp, reclamações, críticas, caixa, despesas, tarefas, leads…). As perdidas e os minutos não entram.
  - A Multipark por hora é guardada pela avaliação diária, a partir da mesma leitura de sempre. Só existe **desde que isto entrou** (o recálculo da noite enche os últimos 31 dias); antes disso o ecrã diz "por hora desde…" e só entra a dashboard.

## O detalhe de uma pessoa: de onde vem cada número (Desempenho → clicar na linha)
- **Horas trabalhadas**: o ponto (sem os registos suspeitos); sem ponto, a escala. **Dias com trabalho**: dias com horas ou com ações.
- **Pontos da avaliação**: a soma dos pontos de cada dia da Avaliação (com os ajustes).
- **Recolhas, entregas, movimentos, levar ao parque, mudanças de lugar, pôs em recolha/entrega, alterações de reserva**: a Multipark, pela avaliação diária.
- **Atrasos ao trabalho** (−5 cada): a 1.ª picagem **5 minutos ou mais** depois da hora da escala ou, sem escala nesse dia, do horário fixo da ficha do RH (03:04:59 não conta; 03:05 já conta), no máximo 1 por dia. Nos dias antigos o número já vem sem as entregas atrasadas.
- **Entregas atrasadas: saíram**. A coluna saiu das abas e já não tira pontos. Os tempos de cada condutor (Fila, Trânsito, Cliente, terminal, P2, ao lado dos colegas) aparecem mais abaixo neste detalhe, só como informação (ver **Tempos de um condutor**).
- Por cima dos números, o detalhe explica em texto de onde vêm os atrasos ao trabalho, os excessos de velocidade e os dias sem GPS.
- **Km (GPS)**, **velocidade máxima**: o GPS do Zello das partes de PDA da pessoa (e do Zello fixo da ficha). A máxima já não tem os picos falsos do GPS.
- **Dias com GPS**: dias com pontos de GPS dela (dois PDAs no mesmo dia contam um dia). **Dias de trabalho sem GPS**: dias com trabalho e sem GPS, e porquê:
  - **sem Zello ligado à pessoa**: a ficha não tem Zello fixo e nesse dia não leu nenhum PDA com o QR. Liga-o em **Atividade diária → Ao vivo → "Utilizadores Zello ↔ Pessoas"** (ou faz o check-in do PDA pelo QR).
  - **com Zello mas sem GPS**: o Zello ou a localização estavam desligados, sem sinal, ou a recolha ainda não chegou a esse dia (o Zello só dá o dia completo 2 dias depois).
- **Dias acima do limite**: dias em que a velocidade máxima do GPS passou o limite (a mesma regra dos excessos que descontam na Avaliação). Os dias recolhidos antes de 14 out 2026 contam pela máxima antiga (a nota por baixo da tabela diz quantos), até se voltarem a dividir.

**Excessos de velocidade (GPS do Zello)**
- **Limite**: em **Definições → Parâmetros → "Limite de velocidade (GPS do Zello)"**: **120 km/h** (o máximo em Portugal, nas autoestradas) **sem tolerância** por omissão: conta acima de 120. Antes eram 10 % (132 km/h). O Zello não diz em que estrada se vai, por isso é um limite único (não há por tipo de via nem por cidade). As velocidades do Zello já vêm em km/h.
- **Dias recolhidos com outro limite**: cada dia de GPS guarda o limite com que foi recolhido. Nos **dias acima do limite** (aqui) e nos pontos da Avaliação, um dia só conta acima do **maior** entre o limite de hoje e esse. Os dias recolhidos com o limite antigo contam a **132** até se voltarem a dividir (Atividade diária → Histórico Diário → Forçar re-divisão): uma máxima entre 120 e 132 nesses dias pode ser um ponto solto que nunca foi confirmado. Quando há dias assim, aparece uma nota por baixo da tabela.
- **Excesso** = pontos de GPS seguidos acima do limite (2 por omissão; um troço de autoestrada com uma descida curta é **um** excesso). Com o Zello a mandar pontos espaçados (de minutos em minutos), o mesmo troço sem nenhum ponto abaixo do limite pelo meio também é **um** excesso. Um ponto sozinho só conta se a distância percorrida até ao ponto ao lado (a pelo menos 30 s) o confirmar.
- **Picos falsos** (nunca contam, nem para a máxima): pontos imprecisos (mais de 100 m), acima de 250 km/h, ou um salto isolado (sobe e desce mais de 15 km/h por segundo, ex.: 40 → 141 → 40 em 4 s). Antes deitava-se fora tudo acima de 150 km/h, e um 160 real desaparecia.
- **Pontos**: na Avaliação, **1 excesso de velocidade (−10) por dia** em que a máxima do GPS passou o limite; se nesse dia já houver um alerta ou uma penalização de velocidade, o GPS não conta outra vez. Os dias acima do limite não descontam outra vez no Desempenho.
- **Aviso**: com o interruptor **"Avisos de excesso de velocidade (GPS do Zello)"** ligado (Definições → Automações; desligado por omissão), cada excesso fica registado e o team leader e o supervisor da cidade recebem no sino "Excesso de velocidade", um por pessoa em cada recolha (a final, 2 dias depois, só volta a avisar se trouxer excessos que a das 23h ainda não tinha). Só avisa dias dos últimos 3; recolher à mão um dia antigo grava os excessos mas não avisa. O aviso não mexe nos pontos.
- A recolha do Zello é às 23h (provisória) e a final 2 dias depois. Para refazer um dia recolhido antes de 14 out 2026 com a regra nova: **Atividade diária → Histórico Diário → Forçar re-divisão** desse dia e depois **Recalcular** a Avaliação.

**Quando a leitura falha**
- Mostra **"Não foi possível carregar…"** com **Tentar de novo**, nunca "sem dados".
