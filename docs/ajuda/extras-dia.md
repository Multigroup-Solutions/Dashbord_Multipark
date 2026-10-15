---
modulo: extras_dia
grupo: Operações
pagina: extras-dia
titulo: Extras-Dia
separadores: dia=Ver a previsão, pressao=Separador "Pressão"
rotas: /extras-dia
palavras: indisponível, avisou que não está, não vou estar, de férias, ausente, lembretes da escala, lembrete das 10:30, lembrete das 14:30, proposta às 11:00, confirmação às 15:00, novas tentativas, ficou por avisar, ficaram por avisar, completar com quem respondeu, dia mexido à mão na confirmação, cobertura baixa, p60, percentil, percentil da cidade, média por hora, contagem real, mais escuro, tempos, fila, trânsito, nosso tempo, na meta, total pedido assinatura, início da entrega, no terminal, no p2, até arrumado, t2 atrasadas, hora apertada pela fila, de onde vêm os tempos, cobertura dos tempos, em calibração, sem dados suficientes, zellos que não batem, zonas em falta, garagens sem papel, diagnóstico dos tempos, calibração, coordenadas das garagens, recolha atrasada no T2, sonda dos tempos, sonda62, copiar resumo, cobertura do GPS, intervalo entre pontos, paragem no terminal, tempo por carro das recolhas, tempo por carro das entregas, quadro das recolhas, entregas e recolhas separadas, juntas, habitual, dias livres habituais, habitual não neste dia, mexido à mão, a mão humana manda, tirados à mão, proposta voltou a pôr, sistema voltou a pôr, reprocessar, dia a dia, a meio, notas do dia, notas internas, nota do dia, nota interna, trabalhou mal, carta < 3 anos, carta pendente de validação, sem carta, aviso da carta, faltam escalar, falta gente, disponíveis por escalar, escalados, indicador de pessoal, aviso de trabalho por email, pré-visualização do aviso, email pessoal, madrugada, 00h às 03h, até às 3h, 24 horas, das 03h às 03h, pode ser team leader na escala, quem pode ser TL, pesquisar pessoa, ficha do RH, p75 explicado, dados de uma janela anterior, fora do aeroporto, oriente, sete rios, rossio, entrecampos, estação, terminal 2, recolha pelo meio, entrega e recolha, recolha no regresso, tempos medidos na escala, escala com os tempos medidos, tempo por carro, minutos por carro, condutor por carro, tempo por condutor, na estrada, horas cheias, tempos medidos, percentil, pessoas no turno, sem cidade, funcionários na escala, arquivo da escala, tirar da escala, aviso desatualizado, previsão incompleta, proposta automática, suspender, compras online por pagar, pressão, hora apertada, horas apertadas, tempo de entrega, tempo de recolha, horas de ponta, carga, extras dia, extras, escala, escalar, turno, turnos, previsão, pico, condutores necessários, team leader, TL, avisar, aviso de trabalho, preencher com disponíveis, cobertura, slots, lavagens, chegadas, saídas, mandar para casa, custo escalado
---
# Extras-Dia

Planeamento do dia seguinte: chegadas, saídas, lavagens e quantos condutores são precisos por hora, e a escala dos extras.

**Ver a previsão**
1. Menu **Operações → Extras Dia**.
2. Em cima à direita escolhe a **Data base** (a previsão é para o dia seguinte) e a cidade (📍). Só vês as cidades a que tens acesso.
3. Vês a hora de pico, as chegadas/saídas por hora, as lavagens (hoje, amanhã, depois de amanhã) e os "Slots ainda por cobrir".
4. As reservas são lidas **ao vivo da BD da Multipark**: os parques nossos da cidade, sem as canceladas e sem os **Parques que a operação não faz** das Definições (por exemplo, um parque do Porto que a operação não faz não entra na previsão nem nos blocos).
   - As compras online ainda por pagar **contam**, porque vão ser recolhidas na mesma.
   - Se a BD da Multipark não responder, a página usa a cópia local das reservas e mostra um aviso amarelo; os números podem estar desatualizados.
   - Se a leitura vier **cortada no limite**, aparece "Previsão incompleta". Com a previsão incompleta (cortada ou só da cópia), a proposta automática e os avisos de falta de gente ficam parados.
5. **Quantos extras por hora** (regra do dono, 3 out): conta o **tempo que cada condutor leva por carro**, que depende de quantas pessoas estão no turno, **com o TL incluído** (2 pessoas = TL + 1 extra). Quem conduz são os extras; o TL vai buscá-los. Por omissão:
   - **Lisboa**: 2 pessoas → 75 min por carro; 3–4 → 60 min; 5–6 → 45 min; 7 ou mais → 30 min.
   - **Porto e Faro**: no mínimo 2 extras + o TL; com 3 pessoas → 30 min por carro (2 condutores × 2 carros = 4 carros por hora).
   - Os números da previsão e da escala automática são **extras além do TL**. A regra muda-se em Definições → Parâmetros ("Tempo por carro conforme as pessoas no turno").
   - **Onde é cada serviço** (regra do dono, 5 out): no aeroporto cada reserva pesa um bloco de 20 min, e o **T2** pesa 30 min nas recolhas. Só são **fora do aeroporto** (60 min por reserva, linha a vermelho):
     - **Lisboa:** Oriente, Sete Rios, Rossio e Entrecampos. Tudo o resto é T1 ou T2, diga o tipo de entrega o que disser.
     - **Porto:** nada; é tudo no aeroporto.
     - **Faro:** só a estação de comboios.
6. A tabela **Por hora** mostra sempre as **24 horas do dia operacional (das 03h às 03h)**, mesmo as que não têm chegadas nem saídas, separadas em **Manhã (03h–15h)** e **Noite (15h–03h)**.
   - A barra ao lado do total mostra a carga dessa hora: verde = chegadas, laranja = saídas, à escala da hora mais cheia do dia.
   - **Condutores** = extras precisos nessa hora, **além do team leader**. Passa o rato pelo cabeçalho para ver a regra das pessoas por turno.
   - Carrega numa hora para ver os blocos de 20 min; num bloco, para ver as reservas.
7. Na tabela **Por hora**, a etiqueta **hora apertada** marca as horas que, desde abril de 2026, estiveram no top 20 % desse dia da semana em carros por hora ou em tempo de entrega (p75 do Total). Passa o rato por cima para ver o motivo. Com **"Hora apertada pela Fila"** ligada na cidade (ver Pressão), a parte das entregas lentas usa a **Fila**.

## Separador "Pressão" (quando é que aperta)
1. Em cima, escolhe o separador **Pressão** (o separador **Dia** é a previsão de sempre).
2. Logo em cima escolhe o **grupo de parques** (a cidade toda, uma marca + cidade como Airpark Lisboa, ou o Marketplace) e **o que queres ver no mapa**, nos botões grandes:
   - **Carros por hora**: chegadas + saídas concluídas nessa hora, média por dia.
   - **Total (pedido → assinatura)** (antes "Tempo de entrega"): minutos desde o cliente pedir o carro (pendente) até assinar a entrega. Junta a fila, o caminho até ao terminal e a espera pelo cliente. Os números não mudaram, só o nome.
   - Na cidade toda há mais três:
     - **Tempo por carro**: minutos de cada condutor por carro, do início de um serviço ao início do seguinte do mesmo condutor. Inclui o regresso, o trânsito e as esperas. Uma **entrega com recolha pelo meio** (o mesmo condutor começa uma recolha até 30 min depois de entregar) conta como **um** serviço.
       - O valor do mapa é o **percentil da cidade** (Definições → Parâmetros → **Percentil do tempo por carro, por cidade**): por omissão **p{{regra:extras.timesPercentile.lisbon}} em Lisboa** e **p{{regra:extras.timesPercentile.porto}} no Porto e em Faro**. O botão diz qual está em uso (ex.: "Tempo por carro (p{{regra:extras.timesPercentile.porto}})"). Os outros mapas (Total, Início da entrega → assinatura, Tempos) usam sempre o **p75**.
       - Por cima do mapa escolhe **Entregas**, **Recolhas** ou **Juntas**. Entregas = os serviços que começam com o início de uma entrega (a recolha pelo meio fica dentro dela); Recolhas = os que começam com o início de uma recolha (inclui levar o carro ao parque). **Juntas** é o quadro de antes, as duas juntas, e é o que a escala usa. Mesmas regras, mesmas cores e mesma legenda.
       - Logo a seguir à mudança (12 out 2026) só há **Juntas**: o cálculo da noite relê os dias desde abril com as entregas e as recolhas separadas, e os botões **Entregas** e **Recolhas** acendem quando acabar. Enquanto isso, a Pressão mostra o último cálculo completo.
     - **Início da entrega → assinatura** (antes "Na estrada"): desde que o condutor pega no carro (em entrega) até o cliente assinar. Junta o caminho e a espera pelo cliente no terminal.
     - **Tempos**: os tempos separados, da tabela dos tempos (o cálculo da noite). Escolhe ao lado qual:
       - entregas: **Fila** (da chamada do cliente, ou do pendente, até pegar no carro — é a que serve para acertar os extras), **Trânsito** (até chegar ao terminal, pelo GPS), **Nosso tempo** (Fila + Trânsito), **% na meta**, **Cliente** (a espera pelo cliente no terminal) e **Total**;
       - recolhas: **Cliente** (da chamada ao check-in), **No terminal**, **No P2**, **Até arrumado** e **% T2 atrasadas**.
       - Mostra-se o p75 (ou a %) por dia da semana × hora, desde abril. Células com menos de {{regra:extras.pressureMinSample}} casos ficam em branco. Por cima diz em quanto % das entregas (ou recolhas) esse tempo está medido.
       - Os tempos com GPS (Trânsito, Nosso, % na meta, Cliente das entregas, No terminal, T2) estão **em calibração**: só o super admin os vê, marcados como provisórios; os outros veem "Em calibração". Quando o super admin abrir o portão (Definições → Parâmetros → **Tempos com GPS: portão**), aparecem na cidade com pelo menos {{regra:serviceTimes.gpsGate.minCoveragePct}} % das entregas medidas e {{regra:serviceTimes.gpsGate.minN}} medições (por omissão); abaixo disso, "Sem dados suficientes".
       - Se a janela tiver tempos de mais e a leitura chegar ao limite, entram os dias mais recentes e por cima diz "Leitura cortada no limite". Mudar o portão ou a meta vale logo (não fica à espera da cache).
       - O botão só aparece quando há tempos guardados (o cálculo da noite **Tempos de entrega e de recolha** está ligado, ou um dia foi reprocessado à mão).
     - **Pessoas a trabalhar**: quantas pessoas diferentes trabalharam nessa hora, **sempre com o TL** (se nessa hora não carregou em nenhum botão na app, junta-se 1). São TL os colaboradores com posto Team Leader e o agente da Multipark ligado à ficha.

### Ler o mapa e onde aperta

3. **O mapa (dia da semana × hora)** ocupa quase o ecrã. Por cima diz em palavras o que a cor quer dizer; por baixo há a legenda (os 4 tons de azul com os valores, cinzento = sem dados, contorno laranja = hora apertada, horas a âmbar = horas de ponta). Nos tempos, mais escuro = mais minutos (pior); no **% na meta** é ao contrário: **mais escuro = mais entregas na meta (melhor)**.
   - **Carrega numa célula** (ou passa o rato) para ver o detalhe dessa hora: volume, carros em simultâneo, entrega, recolha, por carro (juntas, só entregas e só recolhas), na estrada, recolhido → no parque e pessoas.
   - **O que é o p75?** Ordenam-se os casos dessa hora do mais rápido ao mais lento: o p75 é o valor a 75 % do caminho. Em 3 de cada 4 vezes demorou isso ou menos; só 1 em 4 demorou mais. Usa-se em vez da média para os dias maus contarem sem que um caso raro estrague tudo.
   - **E o percentil da cidade?** O **Tempo por carro** usa o percentil escolhido para a cidade (por omissão p{{regra:extras.timesPercentile.lisbon}} em Lisboa e p{{regra:extras.timesPercentile.porto}} no Porto e em Faro; o que está em uso aparece no botão). É a mesma conta, a esse ponto do caminho: num p*N*, em *N* % das vezes demorou isso ou menos. Abaixo de 75 é menos prudente do que o p75 (mais perto do meio — a mediana é o p50); acima, mais prudente. A caixa "O que é o p75 (e o p…)?" do ecrã explica o p75 e o percentil da cidade.
   - **Média por hora vs contagem real**: **Carros por hora** é a **média por dia** desse dia da semana e hora em toda a janela (ex.: 4,5 carros/h às sextas 17h), não a contagem de um dia concreto; para o dia real vê a Atividade diária → **Semana** (contagens desse dia). Os tempos são percentis dos casos de toda a janela.
   - A **Semana** da Atividade diária mostra o tempo por carro sempre em **p75** (em todas as cidades): no Porto e em Faro não bate com a Pressão, que usa o percentil da cidade (por omissão o p{{regra:extras.timesPercentile.porto}}) — é a mesma medição com outro percentil.
   - Uma célula **cinzenta** não tem dados: sem movimento nessa hora, ou menos de {{regra:extras.pressureMinSample}} casos (pouco fiável).
   - Se o último cálculo de um grupo falhou, aparece um aviso amarelo e o mapa mostra os dados do dia anterior que correu bem (em vez de ficar vazio).
4. **Onde aperta**: frases curtas com os blocos mais apertados, por exemplo "sextas 17–20h em Lisboa: 42 saídas/h, entrega p75 28 min".
   - **Hora apertada pela Fila** (Definições → Parâmetros → **Hora apertada pela Fila (por cidade)**, **desligada** por omissão): ligada numa cidade, a parte "entregas lentas" da hora apertada (no mapa, em "Onde aperta" e na escala do separador **Dia**) usa o p75 da **Fila** em vez do total — a Fila é o que mostra se falta gente; o total também tem o caminho e a espera pelo cliente. Só quando a Fila está medida em pelo menos **60 %** das entregas da cidade; abaixo disso fica o total e por baixo diz porquê. Desligada, as horas apertadas ficam exatamente como até aqui.

### Tempo por carro por condutor e carga × tempo de entrega

5. **Tempo por carro, por condutor** (só na cidade toda): tabela por número de pessoas a trabalhar (os escalões da tabela de máximos das Definições).
   - **Horas cheias**: cada pessoa teve pelo menos um serviço nessa hora. É aqui que se vê a capacidade.
   - **Horas calmas**: o intervalo inclui esperar por trabalho.
   - Ao lado aparece o **máximo** da tabela, para comparar.
   - O valor é o p{{regra:extras.timesPercentile.lisbon}} em Lisboa e o p{{regra:extras.timesPercentile.porto}} no Porto e em Faro (por omissão): em {{regra:extras.timesPercentile.lisbon}} % (ou {{regra:extras.timesPercentile.porto}} %) das vezes foi isto ou menos. Muda-se em Definições → Parâmetros → **Percentil do tempo por carro, por cidade**.
   - A cinzento: menos de {{regra:extras.pressureMinSample}} serviços, pouco fiável.
6. **Carga × tempo de entrega**: tabela que compara o tempo de entrega consoante os carros tratados nessa hora, separando horas de ponta (07–10h e 17–20h, aproximação do trânsito) do resto do dia.

### Notas do dia

7. **Notas do dia** (por cidade): o cartão **Notas do dia DD/MM** mostra as notas internas desse dia de trabalho (das 03h às 03h do dia seguinte).
   - O dia começa no **dia da escala** da página; muda-se com as setas ou a data, e **Dia da escala** volta a ele.
   - Cada dia pode ter **várias notas**, cada uma com quem a escreveu e quando, e (se quiseres) uma hora, das 03h às 02h da madrugada seguinte.
   - Escreve quem pode editar o Extras-Dia (TL, supervisor e acima); quem só vê, lê. Só se vêem as notas das tuas cidades.
   - **Arquivar** (o ícone da caixa) tira a nota do dia; só o pode fazer quem a escreveu ou um administrador. Fica no registo de atividade.
   - Ao **carregar numa célula** do mapa, o detalhe mostra também as notas das **últimas 4 datas com esse dia da semana**: as do dia todo e as dessa hora. As células das 00h–02h são a noite do dia anterior (ex.: quinta 01h mostra as notas de quarta à noite).
   - No separador **Dia**, ao lado dos parques, aparece **Notas do dia: N**; carrega para ir às notas.

### De onde vêm os dados (desde abril, lidos todas as noites)

8. Os dados vêm da BD da Multipark **desde 3 de abril de 2026** e a janela **cresce todos os dias**: nunca se deita fora o que já foi medido, para no próximo ano haver o ano inteiro. O dia de início muda-se em Definições → Parâmetros → **Tempos medidos desde**.
   - Todos os dias a partir das 04:45 (tarefa automática **Extras-Dia: pressão**) lê-se da BD da Multipark **só o dia de ontem**, de cada grupo de parques, e junta-se aos dias já guardados. Se uma noite falhar, na seguinte apanham-se os dias em falta. Os números são os mesmos de antes: os tempos de cada dia guardam-se ao milissegundo e os percentis calculam-se sobre todos os dias, como quando se lia a janela inteira.
   - Um dia guardado **não se volta a ler**: uma correção feita depois na Multipark a um dia já guardado só entra se esse dia for reprocessado (super admin, à mão: `/api/cron/extras-pressure?reprocessar=AAAA-MM-DD` ou `?reprocessar=AAAA-MM-DD..AAAA-MM-DD`; se a resposta trouxer `done: false`, repete com o `cursor` que vem nela).
   - A primeira corrida depois desta mudança preenche todos os dias desde 3 de abril, um dia de cada vez: leva várias horas de ticks e o agendador mostra **A meio (retoma)**. Até acabar, o separador mostra o último cálculo completo.
   - Ficam de fora os **Parques que a operação não faz**; quando essa lista (ou os parques de um grupo) muda, os dias desse grupo voltam a ler-se sozinhos — também pode levar algumas horas.
   - **Escala com os tempos medidos** (Definições → Parâmetros, por cidade; **desligado** por omissão): desligado, a escala e a previsão usam só a tabela de máximos, como até aqui.
   - Ligado numa cidade, a previsão, a escala automática e a estimativa passam a usar o tempo por carro **medido nas horas cheias** (com o percentil da cidade), mas **nunca acima do máximo** da tabela.
   - Um escalão com menos de 30 serviços medidos continua com o valor da tabela. Na previsão, a linha da capacidade diz em cada escalão se é **medido** (com o máximo ao lado) ou **tabela**.

## De onde vêm os tempos (só o super admin)
1. Em **Extras-Dia → Pressão**, perto do fim, o cartão **De onde vêm os tempos** mostra, por cidade e semana (as últimas 8):
   - **Entregas**: quantas, com **chamada** do cliente no início da Fila, com a chegada pelo **GPS** e pelo **botão** "Cheguei";
   - **Recolhas**: quantas, com a saída do terminal pelo **GPS** e pelo **início do movimento na app**;
   - **Zello não bate** (sem Zello ou condutor por ligar à ficha), **Zonas em falta** (sem zona de destino, do terminal ou do T2) e os principais motivos sem medição.
2. A verde, as coberturas de GPS a partir de **60 %**: é a partir daí (e com 20 medições) que, com o portão aberto, os tempos com GPS se mostram a toda a gente nessa cidade.
3. Por baixo: as **garagens sem papel** (acrescenta-as em Definições → **Papéis das garagens**) e quantas linhas dos últimos 14 dias foram calculadas com outra versão ou outras zonas (refazem-se sozinhas nas noites seguintes).
- Só contagens: nada de reservas, nomes nem telefones.

## Diagnóstico dos tempos (calibração) (só o super admin)
1. Em **Extras-Dia → Pressão**, no fim da página, está o cartão **Diagnóstico dos tempos (calibração)**. Só o super admin o vê e só ele o pode correr.
2. Escolhe o **Último dia** (por omissão, há 3 dias: o GPS desse dia já é o final), quantos **Dias** para trás (só esse dia, 7 ou 14) e a **Cidade** (ou **Todas**). Depois carrega em **Correr**.
   - Lê um dia de cada vez e cada dia pode demorar até um minuto. Podes carregar em **Parar** e ver o que já veio.
   - Com **Todas**, os botões **Juntas**, **Lisboa**, **Porto** e **Faro** mudam o que vês.
3. Aparecem os números que acertam os tempos de entrega e de recolha, cada um com o parâmetro que fecha:
   - intervalo entre os pontos do GPS;
   - cobertura do GPS por entrega e por recolha (e porque falta);
   - paragem no terminal antes do check-out (o carro parado ou o condutor a pé), com a regra do plano e o recurso ao lado;
   - chamadas antes do pendente e do "em recolha";
   - "Cheguei" e "À espera das malas";
   - quem marca cada estado;
   - estados e sequências das recolhas, e onde se marca o "em recolha";
   - garagens de destino e se há **P2**;
   - saída do terminal e chegada ao T2 (conta como **atrasada** quando o condutor chega mais de **15 min** depois de o cliente ligar);
   - **coordenadas das garagens** na Multipark: de onde vêm, quantas garagens há na cidade, quantas têm coordenadas válidas e se a posição da app no fim dos movimentos bate com elas (distância mediana);
   - ficheiros do GPS, relógio e definições.
   - Em cima, a **Leitura rápida** diz o que cada critério dá com os números de agora.
4. Carrega em **Copiar resumo** e cola na conversa com o Claude. Cada corrida também fica no registo do servidor (linhas `[sonda62]`), por isso também basta dizer "corri".
- **Só lê**: não grava nada, não manda nada a ninguém e não tem interruptor. Mostra só totais e percentagens, nunca nomes, telefones, matrículas nem reservas.
- Se uma leitura falhar (BD da Multipark, chamadas, GPS), aparece no quadro amarelo **O que falhou**, com o motivo, e o resto aparece na mesma. Um dia com ficheiros do GPS por ler (prazo ou mais de 60 ficheiros) fica como **leitura parcial**.
- O que dependia de uma leitura que falhou **não entra nas contas desse dia** (não conta como zero). Em cima, a **Leitura rápida** diz quantos dias têm dados e que leituras falharam.

**Recolha pelo meio de uma entrega**
1. Quem leva um carro ao aeroporto volta ao parque com o carro de uma recolha, se houver uma aí: essa recolha não lhe custa um carro a mais.
2. Conta como "pelo meio" a recolha no **mesmo terminal**, entre **10 min antes e 30 min depois** da hora da entrega, e só uma recolha por entrega. As entregas fora do aeroporto (as estações) nunca contam.
3. Por baixo da linha da capacidade aparece 🔁 com quantas recolhas são pelo meio e quanto muda o pico de extras.
4. Liga-se por cidade em Definições → Parâmetros → **Recolha pelo meio de uma entrega** (desligado por omissão). Ligado, a previsão, a escala automática e a estimativa deixam de contar essas recolhas como carro (no T2 fica só a meia extra).

## Escalar a equipa (Team Leader, Supervisor e acima)
1. Na secção **Equipa Manhã / Noite**, carrega em **Adicionar**, **escreve o nome** da pessoa e escolhe-a da lista do RH; depois as horas de início e de fim.
   - **Só entra na escala quem está registado no RH.** Já não se escreve um nome à mão: se a pessoa não aparece, cria primeiro a ficha em Recursos Humanos.
   - A lista põe primeiro quem começa pelo que escreveste. Está dividida: a cidade da escala, outras cidades, e no fim quem não tem cidade na ficha (não se pode escolher).
   - O turno tem no mínimo 3 h e no máximo 12 h.
   - O início é a partir das 03h; da 0h às 3h é a noite do dia anterior (24h–27h).
   - A mesma pessoa não pode ficar a horas sobrepostas no mesmo dia, nem noutra cidade.
   - **Habitual**: quem não respondeu à disponibilidade dessa semana mostra os **dias livres habituais** desse dia da semana (ex.: "habitual: Qui tarde"; a azul quando costuma estar livre no turno que estás a escalar — manhã ⇐ Manhã, noite ⇐ Tarde ou Noite; "habitual: não neste dia" quando não costuma). Passa o rato para ver o resumo todo. É só uma dica: a proposta automática e o **Preencher com disponíveis** não a usam.
   - **Carta**: na lista aparece "Carta < 3 anos", "Carta pendente de validação" ou "Sem carta" quando a carta não está validada. Ao escolher essa pessoa aparece um **aviso** — podes escalar na mesma (não bloqueia). A carta valida-se no RH (ver a ajuda "RH e ponto").
2. Ou usa **Preencher com disponíveis**: escala quem marcou disponibilidade, pelos turnos que a previsão sugere. Lê a disponibilidade da mesma forma que a proposta automática.
   - A proposta automática e o **Preencher com disponíveis** só usam **extras da cidade da escala**. Quem não tem cidade na ficha, é de outra cidade ou é funcionário (condutor, TL, frontoffice…) nunca entra sozinho.
   - **Quem não tem cidade não pode ser escalado**, nem à mão: define primeiro a cidade na ficha (Recursos Humanos).
   - Um **funcionário** só entra na escala posto à mão e **não recebe avisos** (nem de trabalho, nem de turno cancelado, nem por email). Na lista para escolher, os extras aparecem antes dos funcionários.
3. Define o **Team Leader** do turno (tem de vir do RH).
   - Na lista só aparece quem tem **conta no dashboard com permissões de Team Leader**: papel Team Leader ou acima (supervisor, front office, back office, administração), ou a permissão **"Pode ser Team Leader na escala"** dada à conta. Os extras e condutores sem isso já não aparecem, e o posto na ficha do RH não chega.
   - Para pôr um extra a fazer de TL: dá-lhe a permissão "Pode ser Team Leader na escala" em **Permissões** (ou muda o papel da conta para Team Leader em **Utilizadores**). A partir daí aparece na lista.
   - Quem não tem conta não pode ser TL: cria-lhe primeiro a conta em Utilizadores.
   - A regra vale também ao guardar: se alguém tentar pôr como TL uma pessoa sem estas permissões, o dashboard recusa e diz o que falta. Um TL que já estava escalado continua; só se verifica quando a pessoa entra como TL.
4. Carrega em **Avisar este turno**: abre uma janela com o **aviso de trabalho de cada pessoa**, já com o dia e as horas **dela** nesse turno (início → fim, ou a hora de "mandado p/ casa"; uma noite aparece "das 22h às 03h"), a cidade e o ponto de encontro. Não é preciso ir à Disponibilidade escrever o dia à mão.
   - **Canais**: WhatsApp (template "aviso de trabalho") e **email** ("Aviso de trabalho — sexta 25/09, 18h–03h"); os dois vêm ligados e podes desligar um. O email segue mesmo que o WhatsApp não esteja configurado.
   - O email vai para o email de trabalho da ficha ou, se não houver, para o **pessoal**. Quem tem "Não enviar email/WhatsApp" na ficha ou pediu STOP não recebe por esse canal.
   - **Só recebem as linhas confirmadas.** As propostas por confirmar aparecem assinaladas a roxo e não recebem: confirma a escala primeiro.
   - A janela diz **quem fica de fora e porquê** (já avisado destas horas, sem email, sem telemóvel válido, funcionário…). Carrega em **Enviar**; no fim aparece o resultado por pessoa e canal.
   - **Carregar duas vezes não reenvia**: cada linha recebe um aviso por versão e canal. Se mudares as horas ou a pessoa, a linha volta a receber.
   - Ao lado de cada pessoa aparece o estado: avisado, ✓ confirmou, ✗ não pode e, à parte, o do **email** (email, email falhou, sem email).
   - **Aviso desatualizado** quer dizer que as horas mudaram depois do aviso; avisa outra vez.
   - Para um dia que já passou, não se avisa nem se confirma. Fica tudo no registo de atividade.
5. Se não houver trabalho, usa "Mandado p/ casa" na linha da pessoa.
6. **Falta de gente** (por turno e na escala automática): o aviso diz se há quem escalar ou não.
   - **"Faltam escalar 2 às 02h (há 2 disponíveis: Ana, Rui)"**: há extras da cidade que podem a essa hora e ainda não estão na escala desse dia. Escala-os (ou usa a proposta automática).
   - **"Falta gente às 02h (faltam 2; ninguém disponível)"**: ninguém disponível; pede disponibilidade a quem não respondeu.
   - Em **Ver hora a hora**: "precisas N (além do TL) · escalados M · disponíveis por escalar K". As propostas contam como escaladas; o TL nunca conta; quem foi mandado para casa conta até essa hora.
   - **A disponibilidade lê-se como o calendário**: o que o extra marca num dia é desse dia. Quem marcou **terça 00h–03h** pode na **noite de segunda** (02h de segunda = madrugada de terça); quem marcou "segunda 18h–03h" pode até às 03h. A grelha da Disponibilidade, a proposta automática, o "Preencher com disponíveis" e a lista para escolher pessoas leem tudo da mesma forma.
   - Na lista para escolher a pessoa, ao lado do nome aparecem as horas em que pode nesse dia de trabalho (ex.: "18h–01h").
7. **Tirar da escala** pergunta antes. Se a pessoa já tinha sido avisada, recebe um aviso de que saiu. A linha não se apaga: fica no arquivo da escala, com quem a tirou e quando. Quem tiras não volta a ser proposto para esse dia (ver "Proposta automática").

**Proposta automática**
- **A mão humana manda.** O sistema faz só a **primeira** proposta de um dia e cidade em que ainda ninguém mexeu. A partir do momento em que alguém mexe nos condutores desse dia — põe, tira, muda horas, manda para casa, usa o Preencher com disponíveis, refaz a proposta, confirma ou suspende — a proposta automática **já não muda esse dia**.
  - No dia aparece o selo **"Mexido à mão por Márcia às 15:42 — a proposta automática já não muda este dia"**.
  - Pôr ou mudar o **Team Leader** não conta: a proposta nunca mexe no TL.
  - Na confirmação automática (às {{regra:extras.autoConfirmAt}}, por omissão), um dia mexido à mão segue a definição **Dia mexido à mão na hora da confirmação** (por omissão {{regra:extras.manualEditAtConfirm}}): ver "Horas da escala automática" abaixo. Se não queres que confirme sozinho, usa **Suspender envio automático**.
- **Quem tiras à mão não volta.** Quem foi tirado à mão de um dia nunca mais é proposto para esse dia — nem pela proposta automática, nem por **Proposta automática** carregada à mão, nem pelo **Preencher com disponíveis**. O resumo diz quantos ficaram de fora (ex.: "2 tirados à mão ficam de fora"). Podes sempre voltar a pôr essa pessoa à mão.
- **Refazer a proposta** só substitui as linhas que a proposta tinha criado e que ainda estão por confirmar. Quem foi posto à mão, quem foi editado e quem já está confirmado ficam. As linhas substituídas vão para o arquivo.
- Editar uma linha não apaga as notas e fica registado quem alterou.
- **Suspender envio automático** trava a confirmação e os avisos do cron nesse dia (e, como é mexer no dia, a proposta automática também já não corre nele).
- **Pedir disponibilidade a quem não respondeu**: o número do botão é o número de extras da cidade sem resposta, e é a eles que o pedido vai.
- **Ordem dos candidatos**: a proposta escolhe primeiro quem cobre mais horas com falta de gente e, depois, pela avaliação (pontos médios por dia nas últimas 4 semanas), o custo, a equidade e a fiabilidade. A avaliação mudou (atraso ao trabalho só a partir de 5 min, sem "entrega atrasada", velocidade acima de 120 km/h), por isso a **ordem** de quem é proposto pode mudar. A procura e quantos extras são precisos não mudam. Fica certo depois do recálculo da noite (os 31 dias cobrem as 4 semanas).

## Horas da escala automática, lembretes e novas tentativas
- **Quando** (por omissão): a proposta automática sai a partir das **{{regra:extras.autoProposeAt}}** e a confirmação, com o aviso de trabalho a cada extra (WhatsApp e email), a partir das **{{regra:extras.autoConfirmAt}}** do dia anterior (por omissão; mudam-se em Definições → Parâmetros → Extras-dia). O sistema vê de 15 em 15 min, das 08h às 23h: sai até 15 min depois da hora.
- **Lembretes** ({{regra:extras.reminderLeadMin}} min antes, por omissão às **{{regra:extras.reminderProposeAt}}** e às **{{regra:extras.reminderConfirmAt}}**): no sino, com o estado da escala de amanhã — no da proposta, quantos extras ainda não responderam à disponibilidade; no da confirmação, quantos estão propostos, as faltas, se o dia foi mexido à mão ou está suspenso, e o que mexer agora faz à confirmação (conforme a regra do dia mexido à mão). Um por dia, cidade e hora.
  - A quem e em que dias: Definições → Parâmetros → **Lembretes da escala: a quem e em que dias**, por cidade — papéis (team leader, supervisor, front office, back office), dias da semana (o dia em que o lembrete sai) e contas a juntar (ex.: a Márcia, ou um admin). Por omissão: TL e supervisor da cidade, todos os dias.
  - Interruptor **Extras-dia: lembretes antes da proposta e da confirmação** (Definições → Automações): {{regra:extras.remindersFlag}} por omissão.
- **Dia mexido à mão na hora da confirmação** (Definições → Parâmetros; por omissão {{regra:extras.manualEditAtConfirm}}):
  1. **Confirma na mesma** — como está (é o que se faz hoje, até o Jorge decidir).
  2. **Não confirma e avisa** — confirma-se à mão em **Confirmar escala**. Com o interruptor dos avisos da escala ligado, o TL, o supervisor e o back office da cidade (e os admins) recebem o aviso (sino e email); se às {{regra:extras.manualHoldRepeatAt}} o dia continuar por confirmar (e o 1.º aviso tiver saído há pelo menos 1 h), o aviso repete-se uma vez. **Com os avisos da escala desligados ninguém seria avisado**, por isso, enquanto estiverem desligados, o dia mexido à mão é confirmado na mesma (as Definições dizem-no ao lado da opção).
  3. **Só se a última mudança tiver mais de {{regra:extras.manualEditSettleMin}} min** — se mexeste às 14:50, confirma às 15:30. Uma mudança depois das ~23:15 já não chega a ser confirmada (a última volta é às 23:45): sai o aviso, para confirmares à mão.
  - No cartão da escala aparece o que vai acontecer a esse dia.
- **Completar com quem respondeu** ({{regra:extras.reminderLeadMin}} min antes da confirmação, interruptor **Extras-dia: completar com quem respondeu antes da confirmação**, {{regra:extras.completeFlag}} por omissão): num dia com a proposta automática ainda intocada, acrescenta às horas em falta os extras que marcaram disponibilidade depois da proposta. Só acrescenta (nunca tira ninguém); num dia mexido à mão não faz nada. O lembrete da confirmação diz quem entrou.
- **Novas tentativas do aviso de trabalho**: um envio que falha (ex.: a Meta em baixo) volta a ser tentado {{regra:extras.notifyRetryStepMin}}, 60 e 90 min depois da tentativa anterior — {{regra:extras.maxNotifyAttempts}} tentativas ao todo (ex.: 15:00 → 15:30 → 16:30 → 18:00). Se alguém **ficou por avisar** — nenhum canal chegou: falhou em todas as tentativas, número inválido, sem contacto ou pediu STOP —, o TL, o supervisor e o back office da cidade recebem um aviso (sino e email) com os nomes e o porquê, para lhes ligarem. Os funcionários postos à mão (que nunca recebem avisos) não contam. As falhas de antes desta mudança (3 tentativas) não ganham uma 4.ª.
- **Cobertura baixa**: se, depois da confirmação automática, a escala cobrir menos de {{regra:extras.coverageAlertPct}} % das horas×condutor previstas, sai o mesmo aviso, com as faltas. Se a confirmação automática falhar, também.
- **Estes avisos** (dia por confirmar, por avisar, cobertura baixa, confirmação falhada) só saem com o interruptor **Extras-dia: avisos da escala** (Definições → Automações; {{regra:extras.scheduleAlertsFlag}} por omissão) — o email também. Se ninguém da cidade os receber, vão aos admins; se nem assim, tenta outra vez nas voltas seguintes (até 3).

**Quem vê o quê**
- Quem só vê a escala (por exemplo, um condutor) vê as escalas e os turnos, **sem euros** e sem os botões de ação.
- Custos e taxas dos extras: quem planeia a escala.
- Custo do Team Leader: vem do salário, por isso só o vê quem vê salários ou os totais financeiros.
- O custo da escala é uma **estimativa**: o extra recebe pelas horas de ponto.
- Os **extras e utilizadores** não abrem o Extras Dia (é a escala de todos). A disponibilidade deles marca-se em **A minha disponibilidade**: se abrirem o Extras Dia, aparece "Sem acesso" com o botão **Abrir a minha disponibilidade**.

**Notas**
- "Formação em falta" = a pessoa ainda não concluiu a formação obrigatória.
- **Indisponível (avisou a DD/MM)**, **De férias** ou **Ausente** (só com o mapa de férias ligado — ver a ajuda "RH e ponto" → Mapa de férias): a pessoa avisou que não está nesse dia (o extra marcou "não vou estar", ou tem férias ou uma ausência aprovadas). Aparece ao escolher a pessoa e na linha dela. Nunca bloqueia; quem escala decide. Se a pessoa avisou **antes** de ser escalada e faltar, a falta desse dia fica **sem pontos**; avisos depois de escalada não tiram a falta. Uma baixa aparece só como "Ausente", sem o motivo.
- **Notas internas** (team leader e acima): o ícone do caderno na linha da pessoa abre as notas internas dela e deixa escrever uma nova, já com o dia da escala (ex.: "trabalhou mal neste dia"). Ficam na ficha do RH; a pessoa nunca as vê.
- O **Custo escalado (estimativa)** e as horas pagas atualizam-se à medida que escalas.
- Se uma leitura falhar, aparece **"Não foi possível carregar…"** com **Tentar de novo**, nunca "nenhum condutor escalado".
- No telemóvel, o nível, as horas pagas e o custo de cada pessoa aparecem por baixo do nome.
