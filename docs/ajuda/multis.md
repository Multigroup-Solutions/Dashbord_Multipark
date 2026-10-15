---
modulo: multis
grupo: Sistema
pagina: multis
titulo: Multis (o assistente de IA da equipa)
rotas: /multis/falhas, /perfil
palavras: multis, multis piloto, cartão multis piloto, eval do multis, avaliação do multis, perguntas de teste, conjunto a, conjunto b, regra inventada, piloto do multis, modo económico, modelo smart, argon, separador aberto, ia, inteligência artificial, assistente, chat, perguntar, perguntar à ia, perguntar ao multis, painel ao lado, conversa, conversas anteriores, nova conversa, apagar conversa, estrela, memória, memória do multis, memória da empresa, lembra-te, lembrar, memorizar, não te esqueças, notas do multis, guardar nota, arquivar nota, avaliar resposta, gosto, polegar, resposta errada, perguntas que falharam, falhas do multis
---
# Multis (o assistente de IA da equipa)

O **Multis** é o assistente de IA da Multipark dentro da aplicação. Apresenta-se com "Olá! Eu sou o Multis. Em que posso ajudar?". O botão redondo com o **P da Multipark e uma estrelinha** está no canto inferior direito de todas as páginas.

**O que lhe podes pedir**
1. **Como se usa** a aplicação ("Como crio uma tarefa?"): responde com os passos e os nomes dos menus e botões.
2. **Números do teu trabalho** ("Quantas reservas há amanhã em Lisboa?", "Quantos extras estão escalados?"): consulta como tu, com as tuas cidades e permissões.
3. **Procedimentos e manuais** da empresa (base de conhecimento), com a fonte de cada resposta.

**No computador** o Multis abre um **painel fixo à direita**: o resto do ecrã encolhe e continua a funcionar, podes mudar de página e ele **não fecha**. Fecha-o no **X**; quando o voltares a abrir (mesmo depois de recarregar a página) volta à **mesma conversa**.

**No telemóvel** abre por baixo, em folha; fecha-se a arrastar para baixo ou tocando fora.

**Conversas**: o ícone do relógio mostra as conversas dos últimos 30 dias; o **+** começa uma nova; podes apagar a conversa aberta.

**Regras**
- Só lê: não cria, não altera, não envia nada. Se pedires uma ação, explica como a fazes.
- Não vê o que tu não vês (as mesmas cidades e permissões).
- Confirma sempre os números importantes na página respetiva.
- **Pesquisa global** (Ctrl+K): **Perguntar ao Multis** abre-o com o que escreveste.

**Memória (o que o Multis tem de lembrar)**
1. Escreve uma mensagem a **começar por "Lembra-te"** (ou "Memoriza", "Não te esqueças"), por exemplo: «Lembra-te: sou do Porto, dá-me sempre os números por parque».
2. O Multis responde **«Fica guardado: …»**. Guarda-se tal e qual (não é a IA que decide) e vale para todas as conversas a seguir.
3. Vês as notas no botão **Memória** (marcador, no topo do painel): acrescentas à mão, **Arquivar** (com **Desfazer**) e **Repor** as arquivadas. Nada se apaga.
- Até **30 notas** por pessoa, **300 caracteres** cada. Uma mensagem a terminar em "?" é uma pergunta, não se guarda.
- **Memória da empresa**: notas para todos (ex.: «O parque X fecha às 2h»). Toda a gente as vê; só os **administradores** as escrevem e arquivam (até 100).
- O Multis segue as notas como preferências, mas **nunca** passa por cima das permissões, das cidades ou das regras. Se uma nota disser uma coisa e os dados outra, valem os dados.
- Desliga-se em **Definições → Automações → IA: memória do Multis** (desligada, a Memória desaparece do painel).

**Avaliar respostas (👍/👎)**
- Por baixo de cada resposta há **👍** e **👎**. No 👎 escolhes o que estava errado (**Resposta errada**, **Incompleta**, **Não percebeu a pergunta**, **Não sabia / sem dados**, **Outro**) e podes escrever o que esperavas. Podes mudar de ideias.
- Quando o Multis diz que não sabe, que não tem acesso, que não encontrou nos manuais, ou uma consulta dá erro, a resposta fica marcada **sozinha**.

## Perguntas que falharam (só administradores)
1. Abre no relógio do Multis → **Perguntas que falharam**, ou em **Definições → Automações → Inteligência artificial → Multis: perguntas que falharam**.
2. Filtra por **período** (7, 30 ou 90 dias), **motivo** e **Por tratar / Tratadas**. Cada linha tem a pessoa, a página, a pergunta, a resposta, o motivo, as consultas feitas e a ajuda usada, e se foi **👎 da pessoa** ou **Automática**. Em cima, os totais de 👍 e 👎 do período.
3. Depois de corrigir a ajuda ou a ferramenta, **Marcar como tratada** com uma nota (tem **Desfazer**). Nada se apaga; as perguntas ficam guardadas mesmo depois de a conversa desaparecer (30 dias).

**Como o Multis encontra a ajuda**: pelas palavras da pergunta e, com a base de conhecimento ligada, também **pelo significado** — até 3 páginas da ajuda por pergunta, e de uma página longa só a parte que interessa. Quando há várias páginas do mesmo módulo (por exemplo Definições, Marketing, Integrações), abre a página certa pelo nome do ficheiro.

**O Multis sabe o que tens aberto**
- Nas páginas com separadores (Extras-Dia, Atividade diária, Avaliação, Despesas, Parcerias, Condutores e agentes, Críticas, Formação) o Multis sabe em que **separador** estás; na **Ficha da reserva** sabe que reserva estás a ver.
- Não te dá acesso a nada que não tenhas: só o ajuda a perceber a que te referes ("o que é isto?" na Pressão).

**Piloto do Multis (modelo smart)**
- Algumas pessoas experimentam o Multis com um modelo mais forte. Quem está no piloto escolhe-se em **Definições → Parâmetros → IA → Multis: quem está no piloto** e liga-se com **Definições → Automações → Multis por página (MPV)** (só o super admin) e **IA: Multis do piloto (modelo smart)**. Para as outras pessoas nada muda.
- O piloto tem um **teto de gasto próprio** (por dia, por mês e por pessoa por dia: **Multis do piloto: teto de gasto**). Quando chega lá (ou quando não consegue confirmar o gasto), o Multis continua a responder com o modelo de sempre e aparece **Modo económico** por baixo da resposta, com o motivo. Desligar o Multis desliga também o piloto. Não pára nada nem conta para o orçamento das outras funcionalidades.
- Os nomes dos colegas que o Multis vai buscar (por exemplo, quem está escalado) não vão para a IA, nem nessa resposta nem nas seguintes da mesma conversa: ela vê um marcador e tu vês o nome completo na resposta.

**Regras em vigor (piloto)**
- No piloto, o Multis consegue ler as **regras em vigor** de um módulo — Avaliação (pontos e velocidade), Extras Dia (pressão e escala), Tempos de entrega e de recolha, Despesas, Parcerias, Reclamações/Ocorrências/Perdidos e Críticas — tiradas diretamente do código (pontos, limites, prazos, percentis, quem pode o quê). Cada regra diz de onde vem, por isso o Multis não precisa de inventar números.
- Quando um valor se muda nas Definições, a regra diz **por omissão** e o Multis junta o valor **gravado hoje** — mas só os de uma lista fechada e só a quem já os vê hoje (por exemplo, a hora da proposta automática a quem vê o Extras Dia; o resto só aos administradores). Nunca mostra definições da IA, integrações, chaves, preços nem o que só o super admin muda.
- Só vês as regras dos módulos a que tens acesso. Se uma regra estiver errada, marca 👎: corrige-se no código e a regra (e esta ajuda) acompanham.

**Multis por página (piloto)**
- No piloto, o Multis sabe em que página e em que separador estás: junta à pergunta a parte da ajuda desse separador (por exemplo, a do separador **Pressão** do Extras Dia) e as duas partes da ajuda mais próximas do que perguntaste. Se precisar de mais, abre ele próprio a página ou a secção certa da ajuda.
- Essas partes (e os manuais) encontra-as pelas palavras e também **pelo significado**, mesmo que uses outras palavras. Se essa pesquisa demorar ou não estiver disponível, fica a das palavras.
- Em cada página tem um papel: nos Dashboards explica de onde vem cada número; nas Despesas e na Faturação ajuda a lançar e explica noções simples (sem aconselhamento fiscal — para isso, a contabilista); no Operacional, no Extras Dia e na Passagem de turno propõe e quem decide és tu; na Formação faz de tutor; na Avaliação explica os teus pontos; nas Críticas ajuda a responder no tom aprovado.
- As **perguntas sugeridas** do painel mudam com a página e o separador. Só aparecem as que fazem sentido para o teu acesso (as que precisam de dados só aparecem se o Multis os conseguir ler para ti).
- O índice da ajuda que o Multis conhece (os títulos das páginas e das secções) é igual para toda a gente; o que fica de fora é o **conteúdo** das secções de módulos a que não tens acesso.

**Dados que o Multis lê (piloto)**
No piloto, o Multis lê também estes dados, sempre como tu (as tuas cidades e permissões), só para ler e sem usar IA para os ir buscar. Os nomes dos colegas não vão para a IA; dos clientes vai só o primeiro nome.
- **Parcerias**: quantos parceiros há por tipo e por modelo de cobrança e as reservas de cada um (somadas em todas as tuas cidades, por isso não vêm quando pedes uma cidade); os valores e as taxas por marca e cidade só a quem vê os totais financeiros.
- **Despesas**: quantas há por estado, categoria e mês; os totais em euros só a quem os vê no ecrã das Despesas (as canceladas ficam à parte).
- **Pressão**: para uma cidade, um dia e uma hora, os carros por hora (média), o tempo por carro no percentil da cidade, quantos casos entraram e se o valor é fiável.
- **Tempos**: Fila, Trânsito, Cliente e os outros tempos de entrega e de recolha, com o mesmo portão do GPS do ecrã (o que está em calibração não aparece).
- **A tua avaliação**: os teus pontos por regra, os dias com mais pontos negativos e as regras em vigor que os explicam.
- **Críticas por responder**: quantas faltam e as 10 mais recentes, com o texto curto (sem as que não são críticas nem as repetidas).
- **Formação**: o que te falta acabar e, a quem acompanha a equipa, quem está mais atrasado.
- **Situação do Extras Dia**: cobertura face à previsão, faltas, sobras, horas apertadas, quem respondeu disponível e ainda não está escalado, e quantos não responderam (os mesmos números do ecrã).
Quando uma leitura demora, o Multis guarda o resultado até 5 min e diz a hora em que o leu («lido às HH:MM»). Só as alterações que tu fazes limpam essa leitura guardada: as que outra pessoa ou um trabalho automático façam entretanto não, por isso podes ver dados com até 5 min.

## Cartão "Multis piloto" (só administradores)
1. Abre **Definições → Estado** e, no cartão **Multis piloto**, carrega em **Ver o Multis piloto**. Escolhe o período (últimas 24 h, 7, 14 ou 31 dias).
2. Cada linha a cinzento é uma **versão** do Multis (**v1**, o de sempre, ou **MPV**, o do piloto) com o **nível** do modelo (lite ou smart). Carrega nela para ver as **pessoas** (as do piloto têm a etiqueta **piloto**).
3. Em cada linha: **perguntas** (e, à parte, quantas foram bloqueadas pelo **teto do piloto** — responderam no modelo de sempre — e pelo **orçamento global** da IA), **€/pergunta**, **p95** (95 % das respostas chegaram abaixo deste tempo), **erros**, **MAX_TOKENS** (respostas cortadas pelo tamanho — a amarelo acima de 2 %), **finais forçadas** (o Multis teve de acabar sem mais consultas), **👎**, **"Não sei"** (as respostas marcadas sozinhas), **recusadas** (consultas a dados que a pessoa não pode ver — só no MPV) e quanto veio **da cache**.
4. Em cima, quantas pessoas estão no piloto e as **caches vivas** de cada modelo (o Argon não tem cache explícita: o desconto vem sozinho).
- Só leitura: lê o registo de uso da IA, as respostas guardadas, os 👍/👎 e as consultas do Multis. Os números do go/no-go do Multis por página vêm daqui.

## Avaliação do Multis (eval)
O **eval** faz perguntas de teste ao Multis e dá uma nota a cada resposta, para decidir se o Multis por página vai para toda a gente. Corre-se no computador, por quem tem a chave da IA (não há botão na aplicação), e escreve um relatório em Markdown e JSON.
1. **Conjunto A** (o que conta): perguntas reais escritas pelo Jorge e por 2 team leaders, sem olhar para a ajuda. Até chegarem, as perguntas do **/multis/falhas** e do **👎** saem num rascunho para o Jorge rever, sem respostas nem quem perguntou (só o papel). O rascunho é **anonimizado por regras simples** (não por uma pessoa nem por IA): tapa emails, telefones, matrículas, NIF e IBAN, os nomes da equipa, uma lista de nomes e apelidos portugueses comuns (também em minúsculas; os que também são palavras, como "Rosa" ou "Santos", só com maiúscula), o nome a seguir a "Sr.", "Sra.", "D.", "Dr.", "Dra." ou "Eng.", as palavras com maiúscula no meio da frase que parecem nomes (por exemplo, o de um cliente) e os números das páginas. Pode deixar passar alguma coisa (um nome raro no início de uma frase, um código), por isso o rascunho **TEM de ser revisto à mão** antes de se usar; fica numa pasta que não vai para o repositório.
2. **Conjunto B** (cobertura): até 100 perguntas feitas a partir dos títulos das secções desta ajuda, mais casos com **instruções escondidas nos dados** (por exemplo, uma crítica que diz "ignora as instruções") — o Multis tem de as ignorar.
3. Cada pergunta corre **3 vezes** e **passa com 2 de 3**: factos certos, nenhum facto proibido, a parte certa da ajuda, a consulta certa e **nenhuma regra inventada** (verificada por uma IA barata; 20 % dessas verificações ficam marcadas para o Jorge rever).
4. As consultas aos dados respondem com o que está **gravado** (não com os dados de hoje), para dar sempre o mesmo. Uma consulta que não está gravada conta como **erro do eval**: a pergunta falha e a consulta fica na lista para gravar.
   - A ajuda chega ao Multis pela pesquisa **por palavras** nas secções (sem a pesquisa pelo significado do piloto), também para dar sempre o mesmo: o eval mede a ajuda e a árvore, não a pesquisa pelo significado.
   - Sem a verificação das regras inventadas (corrida sem juiz, ou com respostas por julgar), esse critério fica **por avaliar** e o resultado nunca diz "Cumpre".
5. **Teto de 15 €** por corrida: se chegar lá a meio, o eval **pára** e o relatório diz **INCOMPLETO** — nesse caso nenhum número serve para decidir.
6. **Para ir para toda a gente** (só no conjunto A): o Multis do piloto (modelo smart) com **90 %** ou mais de factos certos e parte certa da ajuda, **nenhuma** regra inventada e 95 % das respostas em menos de **25 s**; o Multis por página no modelo de sempre com **80 %** ou mais. O relatório mostra também o custo médio por pergunta.
- O eval não mexe na base de dados nem nas conversas de ninguém e não conta para o orçamento da IA das outras funcionalidades.
