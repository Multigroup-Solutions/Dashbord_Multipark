---
modulo: multis
grupo: Sistema
pagina: multis
titulo: Multis (o assistente de IA da equipa)
rotas: /multis/falhas, /perfil
palavras: multis, piloto do multis, modo económico, modelo smart, argon, separador aberto, ia, inteligência artificial, assistente, chat, perguntar, perguntar à ia, perguntar ao multis, painel ao lado, conversa, conversas anteriores, nova conversa, apagar conversa, estrela, memória, memória do multis, memória da empresa, lembra-te, lembrar, memorizar, não te esqueças, notas do multis, guardar nota, arquivar nota, avaliar resposta, gosto, polegar, resposta errada, perguntas que falharam, falhas do multis
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
- Em cada página tem um papel: nos Dashboards explica de onde vem cada número; nas Despesas e na Faturação ajuda a lançar e explica noções simples (sem aconselhamento fiscal — para isso, a contabilista); no Operacional, no Extras Dia e na Passagem de turno propõe e quem decide és tu; na Formação faz de tutor; na Avaliação explica os teus pontos; nas Críticas ajuda a responder no tom aprovado.
- As **perguntas sugeridas** do painel mudam com a página e o separador. Só aparecem as que fazem sentido para o teu acesso (as que precisam de dados só aparecem se o Multis os conseguir ler para ti).
- O índice da ajuda que o Multis conhece (os títulos das páginas e das secções) é igual para toda a gente; o que fica de fora é o **conteúdo** das secções de módulos a que não tens acesso.
