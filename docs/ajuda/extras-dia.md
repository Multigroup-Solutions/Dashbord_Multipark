---
modulo: extras_dia
titulo: Extras-Dia
rotas: /extras-dia
palavras: notas do dia, notas internas, nota do dia, nota interna, trabalhou mal, carta < 3 anos, carta pendente de validação, sem carta, aviso da carta, faltam escalar, falta gente, disponíveis por escalar, escalados, indicador de pessoal, aviso de trabalho por email, pré-visualização do aviso, email pessoal, madrugada, 00h às 03h, até às 3h, 24 horas, das 03h às 03h, permitir ser TL, pesquisar pessoa, ficha do RH, p75 explicado, dados de uma janela anterior, fora do aeroporto, oriente, sete rios, rossio, entrecampos, estação, terminal 2, recolha pelo meio, entrega e recolha, recolha no regresso, tempos medidos na escala, escala com os tempos medidos, tempo por carro, minutos por carro, condutor por carro, tempo por condutor, na estrada, horas cheias, tempos medidos, percentil, pessoas no turno, sem cidade, funcionários na escala, arquivo da escala, tirar da escala, aviso desatualizado, previsão incompleta, proposta automática, suspender, compras online por pagar, pressão, hora apertada, horas apertadas, tempo de entrega, tempo de recolha, horas de ponta, carga, extras dia, extras, escala, escalar, turno, turnos, previsão, pico, condutores necessários, team leader, TL, avisar, aviso de trabalho, preencher com disponíveis, cobertura, slots, lavagens, chegadas, saídas, mandar para casa, custo escalado
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
7. Na tabela **Por hora**, a etiqueta **hora apertada** marca as horas que, desde abril de 2026, estiveram no top 20 % desse dia da semana em carros por hora ou em tempo de entrega (p75). Passa o rato por cima para ver o motivo.

**Separador "Pressão"** (quando é que aperta)
1. Em cima, escolhe o separador **Pressão** (o separador **Dia** é a previsão de sempre).
2. Logo em cima escolhe o **grupo de parques** (a cidade toda, uma marca + cidade como Airpark Lisboa, ou o Marketplace) e **o que queres ver no mapa**, nos botões grandes:
   - **Carros por hora**: chegadas + saídas concluídas nessa hora, média por dia.
   - **Tempo de entrega**: minutos desde o cliente pedir o carro até o ter na mão.
   - Na cidade toda há mais três:
     - **Tempo por carro**: minutos de cada condutor por carro, do início de um serviço ao início do seguinte do mesmo condutor. Inclui o regresso, o trânsito e as esperas. Uma **entrega com recolha pelo meio** (o mesmo condutor começa uma recolha até 30 min depois de entregar) conta como **um** serviço.
     - **Na estrada**: do início da entrega até entregue.
     - **Pessoas a trabalhar**: quantas pessoas diferentes trabalharam nessa hora, **sempre com o TL** (se nessa hora não carregou em nenhum botão na app, junta-se 1). São TL os colaboradores com posto Team Leader e o agente da Multipark ligado à ficha.
3. **O mapa (dia da semana × hora)** ocupa quase o ecrã. Por cima diz em palavras o que a cor quer dizer; por baixo há a legenda (os 4 tons de azul com os valores, cinzento = sem dados, contorno laranja = hora apertada, horas a âmbar = horas de ponta).
   - **Carrega numa célula** (ou passa o rato) para ver o detalhe dessa hora: volume, carros em simultâneo, entrega, recolha, por carro, na estrada, recolhido → no parque e pessoas.
   - **O que é o p75?** Ordenam-se os casos dessa hora do mais rápido ao mais lento: o p75 é o valor a 75 % do caminho. Em 3 de cada 4 vezes demorou isso ou menos; só 1 em 4 demorou mais. Usa-se em vez da média para os dias maus contarem sem que um caso raro estrague tudo.
   - Uma célula **cinzenta** não tem dados: sem movimento nessa hora, ou menos de 5 casos (pouco fiável).
   - Se o último cálculo de um grupo falhou, aparece um aviso amarelo e o mapa mostra os dados do dia anterior que correu bem (em vez de ficar vazio).
4. **Onde aperta**: frases curtas com os blocos mais apertados, por exemplo "sextas 17–20h em Lisboa: 42 saídas/h, entrega p75 28 min".
5. **Tempo por carro, por condutor** (só na cidade toda): tabela por número de pessoas a trabalhar (os escalões da tabela de máximos das Definições).
   - **Horas cheias**: cada pessoa teve pelo menos um serviço nessa hora. É aqui que se vê a capacidade.
   - **Horas calmas**: o intervalo inclui esperar por trabalho.
   - Ao lado aparece o **máximo** da tabela, para comparar.
   - O valor é o p75 em Lisboa e o p60 no Porto e em Faro: em 75 % (ou 60 %) das vezes foi isto ou menos. Muda-se em Definições → Parâmetros → **Percentil do tempo por carro, por cidade**.
   - A cinzento: menos de 5 serviços, pouco fiável.
6. **Carga × tempo de entrega**: tabela que compara o tempo de entrega consoante os carros tratados nessa hora, separando horas de ponta (07–10h e 17–20h, aproximação do trânsito) do resto do dia.
7. **Notas do dia** (por cidade): o cartão **Notas do dia DD/MM** mostra as notas internas desse dia de trabalho (das 03h às 03h do dia seguinte).
   - O dia começa no **dia da escala** da página; muda-se com as setas ou a data, e **Dia da escala** volta a ele.
   - Cada dia pode ter **várias notas**, cada uma com quem a escreveu e quando, e (se quiseres) uma hora, das 03h às 02h da madrugada seguinte.
   - Escreve quem pode editar o Extras-Dia (TL, supervisor e acima); quem só vê, lê. Só se vêem as notas das tuas cidades.
   - **Arquivar** (o ícone da caixa) tira a nota do dia; só o pode fazer quem a escreveu ou um administrador. Fica no registo de atividade.
   - Ao **carregar numa célula** do mapa, o detalhe mostra também as notas das **últimas 4 datas com esse dia da semana**: as do dia todo e as dessa hora. As células das 00h–02h são a noite do dia anterior (ex.: quinta 01h mostra as notas de quarta à noite).
   - No separador **Dia**, ao lado dos parques, aparece **Notas do dia: N**; carrega para ir às notas.
8. Os dados vêm da BD da Multipark **desde 3 de abril de 2026** e a janela **cresce todos os dias**: nunca se deita fora o que já foi medido, para no próximo ano haver o ano inteiro. O dia de início muda-se em Definições → Parâmetros → **Tempos medidos desde**.
   - O recálculo é diário a partir das 04:45 (tarefa automática **Extras-Dia: pressão**).
   - Ficam de fora os **Parques que a operação não faz**; uma mudança nessa lista só conta a partir do cálculo seguinte.
   - **Escala com os tempos medidos** (Definições → Parâmetros, por cidade; **desligado** por omissão): desligado, a escala e a previsão usam só a tabela de máximos, como até aqui.
   - Ligado numa cidade, a previsão, a escala automática e a estimativa passam a usar o tempo por carro **medido nas horas cheias** (com o percentil da cidade), mas **nunca acima do máximo** da tabela.
   - Um escalão com menos de 30 serviços medidos continua com o valor da tabela. Na previsão, a linha da capacidade diz em cada escalão se é **medido** (com o máximo ao lado) ou **tabela**.

**Recolha pelo meio de uma entrega**
1. Quem leva um carro ao aeroporto volta ao parque com o carro de uma recolha, se houver uma aí: essa recolha não lhe custa um carro a mais.
2. Conta como "pelo meio" a recolha no **mesmo terminal**, entre **10 min antes e 30 min depois** da hora da entrega, e só uma recolha por entrega. As entregas fora do aeroporto (as estações) nunca contam.
3. Por baixo da linha da capacidade aparece 🔁 com quantas recolhas são pelo meio e quanto muda o pico de extras.
4. Liga-se por cidade em Definições → Parâmetros → **Recolha pelo meio de uma entrega** (desligado por omissão). Ligado, a previsão, a escala automática e a estimativa deixam de contar essas recolhas como carro (no T2 fica só a meia extra).

**Escalar a equipa** (Team Leader, Supervisor e acima)
1. Na secção **Equipa Manhã / Noite**, carrega em **Adicionar**, **escreve o nome** da pessoa e escolhe-a da lista do RH; depois as horas de início e de fim.
   - **Só entra na escala quem está registado no RH.** Já não se escreve um nome à mão: se a pessoa não aparece, cria primeiro a ficha em Recursos Humanos.
   - A lista põe primeiro quem começa pelo que escreveste. Está dividida: a cidade da escala, outras cidades, e no fim quem não tem cidade na ficha (não se pode escolher).
   - O turno tem no mínimo 3 h e no máximo 12 h.
   - O início é a partir das 03h; da 0h às 3h é a noite do dia anterior (24h–27h).
   - A mesma pessoa não pode ficar a horas sobrepostas no mesmo dia, nem noutra cidade.
   - **Carta**: na lista aparece "Carta < 3 anos", "Carta pendente de validação" ou "Sem carta" quando a carta não está validada. Ao escolher essa pessoa aparece um **aviso** — podes escalar na mesma (não bloqueia). A carta valida-se no RH (ver a ajuda "RH e ponto").
2. Ou usa **Preencher com disponíveis**: escala quem marcou disponibilidade, pelos turnos que a previsão sugere. Lê a disponibilidade da mesma forma que a proposta automática.
   - A proposta automática e o **Preencher com disponíveis** só usam **extras da cidade da escala**. Quem não tem cidade na ficha, é de outra cidade ou é funcionário (condutor, TL, frontoffice…) nunca entra sozinho.
   - **Quem não tem cidade não pode ser escalado**, nem à mão: define primeiro a cidade na ficha (Recursos Humanos).
   - Um **funcionário** só entra na escala posto à mão e **não recebe avisos** (nem de trabalho, nem de turno cancelado, nem por email). Na lista para escolher, os extras aparecem antes dos funcionários.
3. Define o **Team Leader** do turno (tem de vir do RH).
   - Na lista aparecem primeiro quem já pode ser TL e, a seguir, o resto do RH ("ainda sem permissão de TL").
   - Para pôr um extra a fazer de TL, escolhe-o e carrega em **Permitir ser TL**: dá-lhe a permissão "Pode ser Team Leader na escala" ali mesmo, sem ires às Permissões (só para quem gere as Permissões; fica no registo de atividade).
   - A permissão é da **conta** do dashboard: se a pessoa não tem conta, muda o posto no RH para Team Leader ou cria-lhe a conta.
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
7. **Tirar da escala** pergunta antes. Se a pessoa já tinha sido avisada, recebe um aviso de que saiu. A linha não se apaga: fica no arquivo da escala, com quem a tirou e quando.

**Proposta automática**
- **Refazer a proposta** só substitui as linhas que a proposta tinha criado e que ainda estão por confirmar. Quem foi posto à mão, quem foi editado e quem já está confirmado ficam. As linhas substituídas vão para o arquivo.
- Editar uma linha não apaga as notas e fica registado quem alterou.
- **Suspender envio automático** só trava a confirmação e os avisos do cron; a proposta automática desse dia continua a correr.
- **Pedir disponibilidade a quem não respondeu**: o número do botão é o número de extras da cidade sem resposta, e é a eles que o pedido vai.

**Quem vê o quê**
- Quem só vê a escala (por exemplo, um condutor) vê as escalas e os turnos, **sem euros** e sem os botões de ação.
- Custos e taxas dos extras: quem planeia a escala.
- Custo do Team Leader: vem do salário, por isso só o vê quem vê salários ou os totais financeiros.
- O custo da escala é uma **estimativa**: o extra recebe pelas horas de ponto.
- Os **extras e utilizadores** não abrem o Extras Dia (é a escala de todos). A disponibilidade deles marca-se em **A minha disponibilidade**: se abrirem o Extras Dia, aparece "Sem acesso" com o botão **Abrir a minha disponibilidade**.

**Notas**
- "Formação em falta" = a pessoa ainda não concluiu a formação obrigatória.
- **Notas internas** (team leader e acima): o ícone do caderno na linha da pessoa abre as notas internas dela e deixa escrever uma nova, já com o dia da escala (ex.: "trabalhou mal neste dia"). Ficam na ficha do RH; a pessoa nunca as vê.
- O **Custo escalado (estimativa)** e as horas pagas atualizam-se à medida que escalas.
- Se uma leitura falhar, aparece **"Não foi possível carregar…"** com **Tentar de novo**, nunca "nenhum condutor escalado".
- No telemóvel, o nível, as horas pagas e o custo de cada pessoa aparecem por baixo do nome.
