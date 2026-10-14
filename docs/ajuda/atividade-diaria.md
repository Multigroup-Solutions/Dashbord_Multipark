---
modulo: atividade_diaria
titulo: Actividade Diária (quem fez o quê, GPS e PDAs)
rotas: /operacional
palavras: re-dividir os últimos 31 dias, re-divisão em segundo plano, limite de velocidade, 120 km/h, 132 km/h, picos do gps, início do movimento, mudança de lugar, mudanças de lugar, telemóveis pessoais, telemóvel pessoal, é um telemóvel pessoal, telemóvel do team leader, telemóvel do supervisor, zello amarelo, linha do tempo do terminal, terminal vazio, buraco no terminal, ainda estás no terminal, no aeroporto, fora do aeroporto, sem gps, terminal agora, quem está no terminal, pôr no terminal, passar o terminal, fechar o terminal, semana, quadro da semana, semana por hora, entregas por hora, recolhas por hora, quantas entregas, tempo por carro, p75, dia operacional, resumo do dia, quem trabalhou, dia do condutor, velocidade máxima, velocidade por entrega, excesso de velocidade, km da equipa, horas paradas, parado no turno, entregas mais lentas, entrega lenta, pedidos à espera, excesso de pedidos, chefe de turno, equipa do turno, sem passagem de turno, entregas a tempo, entregas atrasadas, recolhas atrasadas, horas trabalhadas, tempo parado, reclamações dos carros que saíram, reclamações das saídas, avaliação do mês, ranking do mês, dono do pda, zello do pda, nome do zello, trajeto, mapa das velocidades, geojson, recolher dados, forçar re-divisão, escolher pessoa, actividade diária, atividade diária, atividade do dia, quem fez o quê, recolhas, entregas, movimentações, no horário, fora do horário, escalados, km, quilómetros, gps, zello, velocidade, excessos, histórico de velocidade, ao vivo, mapa, pda, pdas, check-in do pda, retirar pda, agente por ligar, parceiro, pda sem login, ponto
---
# Actividade Diária

Menu **Operações → Actividade Diária**: quem fez o quê nas reservas, o **Resumo do dia**, a **Semana** por hora, a **Avaliação do mês**, os km e as velocidades do GPS (Zello), os PDAs e o **Rádio** (gravações do Zello, provas e transcrições), que passou a ser um separador daqui.

**Que abas vês**
- Só aparecem as abas a que a tua conta tem acesso. **Atividade do Dia**, **Semana** e **Ao Vivo** pedem a Actividade Diária; **Histórico Diário**, o Histórico diário (GPS); **PDAs**, os PDAs; **Rádio**, o Rádio.
- **Resumo do dia** pede a permissão **Passagem — Resumo do dia** (supervisor e acima), a mesma de quando estava na Passagem de turno.
- **Avaliação do mês** pede a mesma permissão do separador **Mês** da Avaliação (team leader e acima).
- **Condutores e extras** veem só **O meu histórico de velocidade**: os km e as velocidades deles, dia a dia, nos últimos 30 ou 90 dias.

**Atividade do Dia**
- Escolhe **Hoje**, **Ontem**, **Últimos 7d**, **Últimos 30d**, **Este mês** ou um **Intervalo**. O intervalo pode ter até **93 dias**; acima disso aparece o aviso e não se pede nada.
- Os cartões mostram recolhas, entregas, movimentações, cancelamentos, ações no horário e fora dele, km do GPS, pessoas ativas, as **reclamações dos carros que saíram** e, para quem vê os totais financeiros, o custo dos extras.
- **Reclamações (carros que saíram)**: quantas reclamações estão ligadas às reservas que **saíram** (entrega feita) nesses dias operacionais (03:00 → 03:00), seja qual for o dia em que a reclamação chegou. A ligação é a da Ficha da reserva (o n.º ou o id da reserva na reclamação). Não contam as arquivadas nem as convertidas noutro caso. Por baixo diz de quantas saídas. Passa o rato para ver a regra. É só o número: a página de Reclamações não tem este filtro. Se não se conseguir ler, aparece **—** com o motivo, nunca 0.
- A tabela **Quem fez o quê** tem uma linha por pessoa. O tipo vem escrito ao lado do nome:
  - sem nada: colaborador com ficha ligada;
  - **🤝 (parceiro)**: agência ou parceiro que marca pelo portal;
  - **⚠ (agente por ligar)**: agente da Multipark sem ficha ligada (liga-o em **RH → Agentes**);
  - **📡 (PDA sem login)**: km de um PDA sem ninguém com login.
- As ações contam no dia do **turno**: a noite que passa a meia-noite fica no dia em que começou.
- Clica no **nome** para abrir a **ficha** da pessoa no RH. Clica no resto da linha (ou carrega em Enter) para abrir **o dia dessa pessoa**: ações, GPS com o trajeto, PDAs e ponto.
- **Todas as pessoas** (por cima da tabela) escolhe uma pessoa só; **Todas** volta à lista toda.

**Resumo do dia** (supervisão)
- Estava na **Passagem de turno** e passou para aqui (12 out 2026), com tudo o que tinha. Na Passagem de turno ficou só uma ligação para cá.
1. Separador **Resumo do dia**. Escolhe o dia e a cidade. O dia é o operacional (03:00 → 03:00).
2. **Cartões do topo**: recolhas, entregas, pendente→entrega, entregas >15/>30 min, recolhas atrasadas, **reclamações do dia** (as que chegaram nesse dia), **reclamações dos carros que saíram** (a mesma regra da Atividade do Dia) e ainda:
   - **Km da equipa**: os km do GPS da Atividade diária.
   - **Excesso de velocidade**: quantas pessoas tiveram excessos, a velocidade máxima do dia e o total de excessos.
   - **Horas paradas**: o total do "Parado" da tabela e a média por pessoa.
   - Num dia com movimentos a mais aparece o aviso de que os tempos são só de uma parte do dia.
3. **Terminal — linha do tempo** (só com o interruptor "Terminal no ponto (aeroporto)" ligado): quem esteve no terminal da cidade nesse dia, **de que horas a que horas**, como entrou e como saiu, e **até que hora contou** para o pagamento (ex.: "contou até 16:40 (último GPS no aeroporto)" ou "por confirmar").
   - Entre duas pessoas aparecem os buracos a amarelo: **"terminal vazio 12:10–12:40"**.
   - "sem nível +1" = condutor ou TL no terminal (o valor não muda).
4. **Passagens de turno**: um cartão por turno (Manhã/Noite) e cidade.
   - Diz se houve passagem: **"Passagem feita às 15:05 por X"** (e quem a recebeu) ou **"Sem passagem de turno"** a vermelho.
   - Por **chefe de turno** (o TL da escala): a equipa, as **entregas** (a tempo, atrasadas >15 min, >30 min) e as **recolhas** (a tempo, atrasadas >15 min face à entrada prevista). São os mesmos limites dos cartões, só da equipa desse TL.
   - Equipa = o turno do TL na escala (mesmo dia, cidade e turno), sem os TL, como no Desempenho. O que o próprio TL fez aparece à parte. Com dois TL no mesmo turno há uma linha por TL. "Sem medida" = entregas sem pedido (pendente) registado ou recolhas sem entrada prevista.
5. **Entregas mais lentas do dia**: toca numa para abrir:
   - a reserva (com o link para a **Ficha da reserva**);
   - a linha do tempo: pedido (pendente), quem pegou no carro, entregue, minutos;
   - **o que se passava nesse horário**: os outros pedidos da mesma cidade à espera entre o pedido e a entrega, com a hora do pedido, quando foram entregues, por quem e quanto demoraram. Também quantos já estavam à espera quando este entrou, o pico de pedidos à espera e quem entregou entretanto. Serve para ver se a demora foi por excesso de pedidos.
6. **Quem trabalhou**: por pessoa, as **horas** trabalhadas (as do ponto; com "~" quando não há picagens e é o tempo com o Zello ligado), os **km**, a **velocidade máxima**, os **excessos** e o tempo **parado**. Todas as colunas se ordenam.
   - Clica no **nome** para abrir a ficha da pessoa no RH.
   - Clica no resto da **linha** para ver o dia dessa pessoa: cada recolha, entrega e movimento com a hora, a reserva (link para a Ficha), o parque, o tempo pendente→entregue de cada entrega, o atraso de cada recolha e a **velocidade máxima em cada entrega** (o GPS dele entre o pedido e a entrega; a vermelho acima do limite dos excessos). Em cima: km do dia, velocidade máxima, excessos, horas trabalhadas e paradas.
   - **Km, Vel. máx. e Excessos** são os mesmos da Atividade diária (o dia inteiro).
   - **Parado** = com o Zello ligado mas sem andar, **dentro do turno**: entre as picagens do ponto; sem picagens, nas horas da escala. Sem nenhum dos dois fica o dia inteiro, com "~". Conta só o tempo entre reports do Zello a menos de 1 h (a mesma regra do Histórico Diário e do Desempenho): o tempo com o Zello desligado não é "parado".
   - "*" no Parado = GPS incompleto (um ficheiro não se leu ou o dia seguinte ainda não foi recolhido). Se o GPS do turno não se conseguir ler, aparece o aviso com **Tentar de novo** e o Parado fica o do dia inteiro, com "~".
   - O GPS do próprio dia só chega às 23h (provisório) e o final dois dias depois: antes disso a velocidade de cada entrega e o parado aparecem "—".

**Semana**
- O quadro da **Pressão** do Extras Dia, mas para **uma semana escolhida**, de **domingo a sábado**.
1. Escolhe a **cidade** (as tuas) e a **semana**: ◀ ▶ andam uma semana; **Ir para o dia** abre a semana (a começar no domingo) desse dia; **Esta semana** volta à atual.
2. Escolhe **Entregas** ou **Recolhas** e **Quantidade** ou **Tempo por carro**.
3. Cada **linha** é um dia **operacional** (03:00 → 03:00). As **colunas** são as horas, das 03h às 02h: as colunas 00, 01 e 02 são a madrugada a seguir, ainda desse dia.
   - **Quantidade**: carros entregues (entrega feita) ou recolhidos (recolha feita) nessa hora.
   - **Tempo por carro**: a métrica da Pressão, minutos entre o início de uma entrega (ou recolha) e o início do serviço seguinte do mesmo condutor, dos serviços começados nessa hora. Mostra-se o **p75**: em 3 de cada 4 vezes foi isto ou menos. Em **itálico** com contorno tracejado: menos de 5 serviços (pouco fiável).
   - A coluna **Total** é o dia todo; a linha **Total** é a semana toda nessa hora. Nas quantidades são somas; no tempo é o p75 de todos os serviços (não a média das células).
   - Mais escuro = mais carros (ou mais minutos). Cinzento = sem casos. Na semana atual, as horas que ainda não chegaram ficam em branco, tracejadas.
4. **Carrega numa célula** (ou num total) para ver o detalhe: quantos foram entregues (ou recolhidos) e quantos pedidos houve, o tempo por carro (n.º, média, mediana e p75), o **pendente → entregue** dos pedidos dessa hora (ou, nas recolhas, o tempo da recolha, de começada a feita) e quantas pessoas tiveram ações.
- Uma semana já fechada vem dos dias que o cálculo da noite da Pressão guardou; a semana atual (ou uma que não esteja guardada) lê-se na hora da BD da Multipark, só dessa cidade e dessa semana. Por baixo do quadro diz de onde veio. Não entram os parques que a operação não faz.
- Se a leitura falhar aparece o motivo, nunca um quadro a zeros.

**Avaliação do mês**
- É o mesmo separador **Mês** da **Avaliação** (Pessoas → Avaliação), aqui também: o período (**Este mês** ou outro), o **ranking** (Totais / Por hora, CSV, Google Sheets e **Recalcular** para quem gere a avaliação), as **equipas** do mês, os **movimentos** na BD da Multipark e o sistema de pontos. Os números são os mesmos dos dois lados.

**Histórico Diário**
- O GPS de um dia por pessoa: km, horas em movimento e paradas, velocidades, excessos, bateria e trajeto. **Export CSV** descarrega a tabela.
- **Excessos** e **velocidade máxima** (desde 14 out 2026): o limite é o de **Definições → Parâmetros → "Limite de velocidade (GPS do Zello)"** (acima de 120 km/h, sem tolerância, por omissão; até à tarefa 62 eram 132 km/h). Um excesso é um troço com pontos seguidos acima do limite (não cada ponto), e os picos falsos do GPS (pontos imprecisos, acima de 250 km/h ou um salto isolado) não contam nem para a máxima. Os dias recolhidos antes ficam como estavam; **Forçar re-divisão** de um dia volta a calcular a máxima e os excessos desse dia com a regra nova. Num dia recolhido com o limite antigo (132), uma máxima entre 120 e 132 pode aparecer a vermelho aqui sem tirar pontos na Avaliação, até o dia ser re-dividido.
- **Re-dividir os últimos 31 dias** (só o super admin, por cima do histórico de velocidade): pede **uma vez** a re-divisão dos últimos 31 dias com o limite de hoje (para setembro e outubro contarem acima de 120 km/h). Corre **em segundo plano** (de 5 em 5 minutos, continua de onde ficou), mostra quantos dias e linhas já fez e pode **Parar**. É o mesmo que o "Forçar re-divisão" de cada dia: não vai ao Zello, não muda os km e não avisa ninguém. Os pontos da Avaliação acertam-se no recálculo da noite (ou com Recalcular em Avaliação → Mês).
- **Movimentações** (Atividade do dia): só os movimentos que tocam no parque (levar ao parque e entre garagens). A app grava cada deslocação em duas linhas (início e fim): o **início** não conta, nem como ação. As **mudanças de lugar** (o carro ficou na mesma garagem) contam nas ações e aparecem como "Mudança de lugar" na gaveta de cada pessoa e no Resumo do dia.
- Abre no último dia que o Zello já entrega completo (há 2 dias). **Ontem** ainda não vem do Zello, por isso aparecia vazio.
- Clica no **nome** para abrir a ficha. Clica no resto da linha para ver o **histórico de velocidade** dessa pessoa: a velocidade máxima e a média em movimento, dia a dia.
- **Trajeto** abre o dia no **mapa**, pintado pela velocidade:
  - azul claro é devagar e azul escuro é depressa;
  - a **vermelho** está o que passou o limite dos excessos;
  - estão marcados o início, o fim e o ponto da velocidade máxima;
  - por baixo aparece um gráfico com a velocidade ao longo do dia e a linha do limite;
  - um dia com muitos pontos é reduzido para o mapa, mas os excessos ficam sempre.
- A recolha corre de madrugada. Quem gere o Histórico diário tem dois botões:
  - **Recolher Dados** vai buscar agora ao Zello o GPS do dia escolhido (km, velocidades, trajeto) de todos os utilizadores. O Zello só dá um dia completo 2 dias depois; o de hoje fica provisório.
  - **Forçar re-divisão** volta a repartir o GPS já recolhido pelas pessoas que tinham cada PDA (pelos check-ins de PDA). Usa-se depois de corrigir um check-in. Não volta ao Zello nem muda os km; desde 14 out 2026 refaz a velocidade máxima e os excessos desse dia com o limite em vigor (sem avisar ninguém).

**Ao Vivo**
- **Terminal agora** (em cima; só com o interruptor "Terminal no ponto (aeroporto)" ligado): por cidade, **quem está no terminal e desde quando**, como entrou (pelo GPS, na entrada do ponto, passado pelo colega, posto pelo TL) e quem pediu o lugar. "Livre" = ninguém.
  - O **team leader e acima**, só nas suas cidades, têm **Pôr** (terminal livre), **Passar** e **Fechar** (terminal ocupado). Escolhe a pessoa (só aparecem as que têm o ponto aberto e trabalham nessa cidade) e escreve sempre o **motivo**. Não precisa de GPS.
  - A pessoa recebe o aviso no sino. Fica registado quem fez, quando e porquê (Logs). Nada se apaga.
  - "sem ponto aberto" ao lado do nome: a pessoa já deu saída — quem chegar ao terminal entra logo.
  - O GPS de quem está no terminal (de 5 em 5 min, pelo Zello do aparelho com a pessoa): **no aeroporto ✓**, **fora (a 3,2 km)** ou **sem GPS**. "Sem GPS" nunca conta como fora.
  - **perguntámos se ainda está**: o GPS viu-a fora há mais de 20 min e a pessoa ainda não respondeu ao "Ainda estás no terminal?". Sem resposta em 15 min o lugar fica livre e recebes o aviso (também no telemóvel quando perguntamos).
- **Códigos de entrada** (só com **Entrar com email e código** ligado): os pedidos dos últimos 15 minutos cujo código veio para ti (TL de serviço e supervisores da cidade; sem cidade, RH e admins) — nome, foto da ficha, aparelho e o código. Dá-o só à própria pessoa, quando ta pedir. Os que já foram usados ou passaram do prazo ficam por baixo, sem o código.
- Mapa com a posição de cada condutor. Atualiza sozinho a cada 30 segundos.
- Em cima fica uma linha só: quantos estão no mapa, a hora da última leitura e os alertas contados (acima do limite de velocidade, bateria fraca, sem reportar há mais de 1 h). Carrega num alerta para ver os nomes.
- **Atualizar** lê tudo de novo (posições, ligações Zello ↔ pessoas e PDAs) e volta a mostrar toda a gente no mapa.
- **Utilizadores Zello ↔ Pessoas**:
  - Nos **PDAs** manda o check-in do dia.
  - Se o PDA é de uma pessoa, escolhe-a como **dono do PDA**. O dono fica com o GPS sempre que ninguém fez check-in no PDA, também nos km de antes e de depois do check-in de outra pessoa (antes esses km ficavam "sem login").
  - Nos telemóveis pessoais, escolhe a pessoa.
  - Um PDA de outra cidade já não aparece como telemóvel pessoal.

**PDAs**
- Os PDAs da cidade, quem está com cada um e desde quando.
- Cada PDA mostra o seu **Zello** e se bate certo com a lista do Zello: certo, com outras maiúsculas, escrito de outra maneira (por exemplo "extra12" contra "Extra_12"), não existe, sem Zello, ou repetido noutro PDA. Quando há um nome parecido, quem edita PDAs tem **Corrigir para …**. O GPS só se liga à pessoa quando o Zello do PDA é exatamente o do Zello.
- Os nomes do Zello comparam-se sem ligar a maiúsculas.
- Os alertas **Sem PDA ou Zello** (ponto aberto sem PDA, Zello desligado, movimentos sem ponto) ficam pequenos, ao lado (no telemóvel, por cima). Carrega no título para os encolher. **Visto** marca que trataste; **+ nota** abre a caixa para escreveres porquê.
- **Novo PDA**, **editar** e **QR** para quem edita PDAs. O olho abre o **histórico** do PDA (os últimos 100 check-ins, com "Em uso" ou "Devolvido").
- Com **Entrar com email e código** ligado, só o team leader (ou acima) lê o QR, os supervisores são avisados quando um PDA passa para outro aparelho e a sessão no PDA acaba na saída do ponto. A **limpeza única de cada PDA** (uma conta Google da empresa; Chrome sem guardar palavras-passe) está na ajuda do Ponto → PDAs.
- **Retirar** (o caixote, só administração) passa o PDA a **Inativo**. Nunca se apaga: o histórico de quem o teve e o GPS partido por pessoa ficam.

**Telemóveis pessoais** (por baixo dos PDAs)
- São os telemóveis de uma pessoa (team leaders, supervisores, qualquer um), **não** PDAs partilhados. Cada pessoa regista o seu no **Perfil → Este telemóvel → Registar este telemóvel como meu**.
- Cada um aparece com o nome de quem tem sessão nele agora (**"Telemóvel de Márcia Costa"**, "Agora com…"). Sem ninguém, mostra quem lá esteve por último. O **dono** é quem o registou.
- O **Zello** é o da ficha do dono (a conta Zello instalada no telemóvel). Quem entra no telemóvel de outra pessoa não lhe muda nem lhe tira o Zello. Sem Zello na ficha não fica amarelo (há quem não use); só fica amarelo se o Zello da ficha não bater com a lista do Zello.
- Um telemóvel pessoal não tem sessão presa, não acaba na saída do ponto, não tem check-ins de PDA, não avisa "mudou de aparelho" e não muda o nome no Zello.
- Botão **Pessoal?** ("É um telemóvel pessoal", num PDA registado, para quem edita PDAs, do team leader para cima): para o telemóvel de alguém que foi registado por engano como PDA. Escolhes de quem é (a lista traz quem já o teve; ou **Ninguém por agora**, e quem carregar em **Registar este telemóvel como meu** nesse telemóvel fica dono). O PDA passa a **Inativo** (o histórico fica), a sessão de PDA que lá estiver acaba, o check-in aberto fecha e o telemóvel passa sozinho a pessoal na próxima entrada (os avisos no telemóvel passam a ser da pessoa).
- O **Zello** do PDA: se a ficha do dono não tem nenhum (e mais ninguém o tem), passa para a ficha. Se a ficha já tem outro (ou outra ficha tem este), não se mexe e aparece um aviso a dizer qual era, para confirmares na ficha. Com **Zello: nome de quem tem o PDA** ligado, a conta Zello do telemóvel deixa de ter nome de PDA e fica com o nome do dono.
- **Deixar de ser pessoal**: o dono no próprio telemóvel, ou quem edita PDAs na lista. Nunca se apaga.

**Quando a leitura falha**
- Aparece um aviso vermelho **"Não foi possível carregar…"** com **Tentar de novo**. Os cartões mostram **—** em vez de 0. Uma falha nunca aparece como "sem atividade", "sem dados" ou "nada em aberto".
- Sem permissão aparece **"Sem acesso"**.

Cada pessoa só vê as pessoas, os PDAs e o GPS das suas cidades.
