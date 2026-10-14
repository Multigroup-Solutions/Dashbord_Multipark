---
modulo: condutores_agentes
titulo: Condutores e agentes
rotas: /pessoas/condutores-agentes
palavras: mudanças de lugar, mudança de lugar, movimentos que tocam no parque, quem vê condutores, acesso, dias acima do limite, limite de velocidade, 120 km/h, excesso de velocidade, picos do gps, dias com gps, dias sem gps, zello não ligado, atrasos, entregas atrasadas, km, quilómetros, km sem movimentos, pontos da equipa, recolhas, escolher condutor, filtro de cidade, filtro de marca, tirar da lista, ligações, condutores, agentes, ranking, entregas, checkout, performance, ações do agente, histórico do agente, pessoa, ficha, desempenho, desempenho por pessoa, cobranças de parceiros, cobranças de pro, avenças, quem registou, atividade por hora, horas do dia, a que horas trabalha, chamadas perdidas, chamadas devolvidas, minutos ao telefone, emails pessoais, pesos, editar pesos, pesos do ranking, pontos do ranking, quanto vale cada coisa, repor omissões, 1 ponto 5 minutos
---
# Condutores e agentes

Em **Pessoas → Condutores e agentes**. Antes estavam nas Críticas.

**Quem vê** (desde 14 out 2026)
- **Condutores** e **Agentes**: supervisor (as cidades dele), back office, admin e super admin. Front office e team leader já não veem (nem no menu, nem pelo link direto, nem na pesquisa, nem pelo botão **Abrir agente** do RH, nem pelo MCP). Uma permissão por pessoa (**Definições → Permissões**, módulo "Condutores e agentes") dá ou tira o acesso.
- **Desempenho**: só o super admin.

**Movimentos e mudanças de lugar** (como se contam em todo o lado: aqui, na Avaliação, no Desempenho, na Atividade do dia e no Resumo do dia)
- A app Multipark grava todas as deslocações de um carro como "movimento", mesmo quando o carro só muda de lugar dentro do parque. Por isso a dashboard separa-as pela ação anterior da **mesma reserva**:
  - **Levar ao parque**: o 1.º movimento depois da recolha. Conta como movimento (+5).
  - **Tirar do parque para a entrega**: o 1.º movimento depois do pedido de entrega (ou do início da entrega). Conta como movimento (+2).
  - **Mudança de lugar**: qualquer outro movimento. O carro já está no parque e só muda de lugar, garagem ou fila. **Conta como ação**, mas não como movimento nem dá pontos.
- **Movimentos** = só os que tocam no parque (os dois primeiros). **Mudanças de lugar** têm coluna própria e abrem a lista delas.
- Antes, as mudanças de lugar davam sempre 0 (procuravam outro tipo de registo, que a Multipark não usa) e entravam todas nos movimentos.

**Condutores**
- Uma linha por pessoa com as **recolhas**, **entregas**, **movimentos**, **mudanças de lugar** e os **km do GPS** (Zello) no período, lidos ao vivo da Multipark. Só aparece quem mexeu em carros (uma mudança de lugar também conta). As várias contas de agente da mesma ficha somam.
- **Cidade e marca**: o filtro do topo da app. A marca filtra pelos parques dela.
- Escolhe o período (De/Até) e, se quiseres, **um condutor** (ou "Todos").
- Clicar no **nome** abre a ficha. Clicar num **número** abre esses movimentos (ex.: as entregas desse condutor), com a matrícula, o parque e a hora.
- Todas as colunas ordenam; em baixo ficam os totais.

**Agentes**
- A mesma lista, com **todas** as ações de cada agente no período: recolhas, entregas, movimentos, mudanças de lugar, reservas em que mexeu e a última ação. Primeiro a lista, depois o detalhe.
- Procura por **nome ou código do agente**, ou escolhe a pessoa.
- Quem não tem ficha aparece com "sem ficha"; os parceiros com "parceiro".
- O botão **Abrir agente** da ficha do RH abre esta aba já com o detalhe dessa pessoa.
- Se o período tiver ações a mais, o detalhe diz quantas mostra e pede um período mais curto.
- **Quem gere o RH**: o ícone de corrente abre as **Ligações** da pessoa (unir/separar conta e agente); num agente sem ficha, o ícone do olho **tira-o da lista** (fica como "não é funcionário", desfaz-se no RH → Agentes; na Multipark não muda nada).
- No máximo 62 dias de cada vez.

**Desempenho** (só o super admin; os outros nem veem a aba)
- Tudo o que cada pessoa fez, por **dia, semana, mês ou ano** (setas para andar para trás e para a frente). Há uma aba por posto: **Back e front office**, **Supervisão**, **Team leaders** e **Condutores e extras**. A aba segue o papel da conta (front office, backoffice, supervisor, team leader); quem não tem um destes papéis fica pelo posto da ficha.
- Junta três fontes:
  - **Multipark**, pela avaliação diária: recolhas, entregas, movimentos, "pôs em recolha/entrega", reservas criadas e alteradas, ocorrências.
  - **Zello**: km, dias com GPS, velocidade máxima, dias acima do limite e dias de trabalho sem GPS.
  - **Dashboard**: horas (ponto ou escala), chamadas atendidas, feitas, perdidas e devolvidas e os minutos ao telefone, WhatsApp, emails enviados (pela dashboard e da caixa Gmail pessoal de cada um), respostas e fecho de reclamações, críticas Google respondidas, despesas lançadas e aprovadas, contagens e correções de caixa, tarefas, leads, passagens de turno, contas de parceiros, fechos de mês dos parceiros, extras do dia escalados, atualizações do CRM, perdidos e achados, dias como team leader e quantas pessoas tinha.
  - Também da **Multipark**: voos de regresso registados (as alterações à reserva que mexem no voo de regresso) e as cobranças, em duas colunas:
    - **Cobranças de parceiros**: os pagamentos de parceiros que um agente marcou e os créditos de parceiro lançados.
    - **Cobranças de Pro e avenças**: os pagamentos de clientes Pro e de avenças que um agente marcou.
    - A Multipark guarda sempre quem as registou, e é por aí que se sabe de quem são.
- No topo, os números do grupo e a **evolução**: por dia na semana e no mês, por mês no ano. A seguir, o **ranking**, por **pontos** ou por **pontos por hora**. O "por hora" só aparece com 4 h ou mais no período.
  - **Pontos**: a soma ponderada do que a aba mede, com os pesos da tabela "Como se contam os pontos desta aba". Nos condutores e team leaders o trabalho na rua conta pelos pontos da avaliação. Os **excessos de velocidade** descontam lá (−10 cada); os **dias acima do limite** só se mostram (até 14 out 2026 descontavam −10 aqui, o que contaria a dobrar). Para voltarem a descontar, dá-lhes peso em **Editar pesos**.
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
  - A régua: **1 ponto ≈ 5 minutos de trabalho**, a mesma escala da avaliação (recolha ou entrega 3, movimento que toca no parque 2, levar ao parque 5; mudança de lugar 0). Por exemplo: reserva criada 2, email 1, chamada atendida 0,5 mais 0,2 por minuto ao telefone, fecho de mês de um parceiro 6, contagem de caixa 2. Horas e km não dão pontos.
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

**O detalhe de uma pessoa: de onde vem cada número** (Desempenho → clicar na linha)
- **Horas trabalhadas**: o ponto (sem os registos suspeitos); sem ponto, a escala. **Dias com trabalho**: dias com horas ou com ações.
- **Pontos da avaliação**: a soma dos pontos de cada dia da Avaliação (com os ajustes).
- **Recolhas, entregas, movimentos, levar ao parque, mudanças de lugar, pôs em recolha/entrega, alterações de reserva**: a Multipark, pela avaliação diária.
- **Atrasos** = entregas atrasadas + entradas tardias no ponto, e o detalhe diz quantos de cada. Cada um −5.
  - **Entrega atrasada**: o carro chegou ao cliente mais de 15 min depois do pedido de entrega. Conta uma vez por entrega, contra quem a fez. Desde 14 out 2026, "chegou" é a hora em que a app marca o carro **no local de entrega**, quando a marca; senão é o check-out (antes era sempre o check-out, o que contava como atraso o tempo em que o cliente ainda estava nas malas). É a mesma medida do Extras → Pressão.
  - **Entrada tardia**: a 1.ª picagem depois da hora da escala (ao minuto).
- **Km (GPS)**, **velocidade máxima**: o GPS do Zello das partes de PDA da pessoa (e do Zello fixo da ficha). A máxima já não tem os picos falsos do GPS.
- **Dias com GPS**: dias com pontos de GPS dela (dois PDAs no mesmo dia contam um dia). **Dias de trabalho sem GPS**: dias com trabalho e sem GPS, e porquê:
  - **sem Zello ligado à pessoa**: a ficha não tem Zello fixo e nesse dia não leu nenhum PDA com o QR. Liga-o em **Atividade diária → Ao vivo → "Utilizadores Zello ↔ Pessoas"** (ou faz o check-in do PDA pelo QR).
  - **com Zello mas sem GPS**: o Zello ou a localização estavam desligados, sem sinal, ou a recolha ainda não chegou a esse dia (o Zello só dá o dia completo 2 dias depois).
- **Dias acima do limite**: dias com pelo menos um **excesso de velocidade** (ver abaixo). Os dias recolhidos antes de 14 out 2026 contam pela velocidade máxima do dia (a nota por baixo da tabela diz quantos), até se voltarem a dividir.

**Excessos de velocidade (GPS do Zello)**
- **Limite**: **120 km/h** (o máximo em Portugal, nas autoestradas), em **Definições → Parâmetros → "Limite de velocidade (GPS do Zello)"**, com uma tolerância em % (0 por omissão). O Zello não diz em que estrada se vai, por isso é um limite único (não há por tipo de via nem por cidade). As velocidades do Zello já vêm em km/h.
- **Excesso** = pontos de GPS seguidos acima do limite (2 por omissão; um troço de autoestrada com uma descida curta é **um** excesso). Um ponto sozinho só conta se a distância percorrida até ao ponto ao lado o confirmar.
- **Picos falsos** (nunca contam, nem para a máxima): pontos imprecisos (mais de 100 m), acima de 250 km/h, ou um salto isolado (sobe e desce mais de 15 km/h por segundo, ex.: 40 → 141 → 40 em 4 s). Antes deitava-se fora tudo acima de 150 km/h, e um 160 real desaparecia.
- **Pontos**: cada excesso desconta **−10** na Avaliação (como os alertas de velocidade). Conta no dia da recolha.
- **Aviso**: com o interruptor **"Avisos de excesso de velocidade (GPS do Zello)"** ligado (Definições → Automações; desligado por omissão), cada excesso fica registado e o team leader e o supervisor da cidade recebem no sino "Excesso de velocidade", um por pessoa e dia. Só avisa dias dos últimos 3 (a recolha das 23h e a final de 2 dias depois); recolher à mão um dia antigo grava os excessos mas não avisa.
- A recolha do Zello é às 23h (provisória) e a final 2 dias depois. Os dias recolhidos antes de 14 out 2026 não têm excessos (o limite antigo não existia): para os refazer, **Atividade diária → Histórico → Forçar re-divisão** desse dia e depois **Recalcular** a Avaliação.

**Quando a leitura falha**
- Mostra **"Não foi possível carregar…"** com **Tentar de novo**, nunca "sem dados".
