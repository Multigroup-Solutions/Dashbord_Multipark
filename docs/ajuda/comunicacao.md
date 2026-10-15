---
modulo: comunicacao
grupo: Comunicação
pagina: comunicacao
titulo: Comunicação (email e calendário)
rotas: /comunicacao, /comunicacao/meu-email, /calendario
palavras: não lidas, por tratar, aberta, abertas, filtros, por responder, todas, drive da empresa, conta google errada, drive pessoal, calendário, agenda, google calendar, a minha agenda, eventos, novo evento, criar evento, reunião, google meet, videochamada, convidados, convite, vista dia, vista semana, vista mês, dia inteiro, calendário multipark, ocupado, mostrar calendário, esconder calendário, ativar calendário, caixas de email, caixa inicial, estrela, como no gmail, ligar, telefonar, enviar email, enviar whatsapp, ficha do cliente, ficha da reserva, ficha do colaborador, email, emails, gmail, caixas por tema, mover para, separar pela ia, movido pela ia, a ia separou, corrigir a caixa, ficou no info, faturação, parcerias, alterações, serviços extra, arquivo, arquivadas, retenção, emails antigos, sem confirmação, enviar outra vez, duplicado, desativar caixa, caso por criar, emails que não criaram o caso, fotos no email, por classificar, alias, etiqueta, caixa, caixas, info@, comercial@, admin@, reclamacoes@, perdidos@, responder, reencaminhar, enviar como, alias, assinatura, conta google, ligar conta, o meu email, ligações, anexos, mostrar imagens, rascunho ia, automáticos, mostrar automáticos, nova reserva, notificações de reserva, disponibilidade, pedidos de disponibilidade, lembrete, recursos-humanos@, extras, comunicações automáticas, escala, triagem, testar a triagem, por confirmar, reclamação noutra caixa, perdido noutra caixa, críticas lidas, ocorrência da app, rever emails antigos, varrimento
---
# Comunicação (email)

Os emails das caixas partilhadas da empresa e o teu próprio email @multipark, dentro do dashboard. Todo o email entra e sai pela API do Gmail; cada email é separado pelo alias a que foi enviado (tabela em Definições → Comunicação — ver a ajuda "Email por alias").

## Caixas de email (menu **Comunicação → Caixas de email**)
1. As caixas ficam à esquerda, **umas por baixo das outras, como no Gmail**: carregas numa e a lista muda logo ao lado, sem sair da página. Cada caixa mostra quantos emails tem **por ler**. Só vês as caixas do teu módulo; algumas (ex.: admin@) são só para a administração.
   - **O meu email** está na mesma lista (em **Pessoal**), por baixo das caixas da empresa.
   - As caixas que são **tuas** (o endereço está em teu nome ou da tua função) têm o ícone de pessoa.
   - **Caixa inicial**: carrega na **estrela ★** ao lado de uma caixa e é essa que abre quando entras. Sem estrela, abre a primeira que é tua (ou a primeira da lista). Cada pessoa tem a sua.
   - Aqui só há email. O WhatsApp tem a entrada dele: **Comunicação → WhatsApp**.
   - No PC, o **menu do lado recolhe** quando entras nas caixas, para os emails terem o ecrã todo; abre-o no botão do menu quando precisares e, ao sair, volta como estava.
   - No telemóvel, a caixa escolhe-se na lista do topo.
   - **Trabalha sempre daqui:** o que envias pelo dashboard fica registado na conversa e ligado ao cliente — também do **O meu email** (uma mensagem nova para um cliente fica no separador **Comunicações** da ficha dele).
2. Por cima da lista escolhes o que queres ver: **Não lidas · Por responder · Todas** (cada uma com o número ao lado).
   - As **caixas partilhadas abrem sempre em Não lidas**. O **O meu email** e a pesquisa da barra de cima ("ver todos") abrem em **Todas**.
   - **Por responder**: o cliente escreveu e ainda ninguém respondeu (sem as resolvidas).
   - O resto está no botão **Filtros**, ao lado da pesquisa (o número no botão diz quantos estão ligados): **estado da conversa**, **responsável**, **marca**, **Mostrar automáticos** e, para o super admin, **Arquivo (+5 anos)**. Os filtros ligados aparecem por baixo, cada um com um **×** para o tirar.
   - O **estado** é o trabalho da equipa, não se o email foi lido: **Por tratar** (ainda há o que fazer — antes chamava-se "Aberta"), **Pendente** (à espera de alguém) e **Resolvida**.
   - Lista vazia: carrega em **Ver todas** para tirar os filtros.
   - Pesquisa por assunto, nome ou email na caixa de pesquisa.
3. Abre a conversa: **Responder**, **Responder a todos** ou **Reencaminhar**. O email sai pelo endereço (alias) a que o cliente escreveu, com a assinatura da marca. Se o alias não estiver configurado como "Enviar email como" no Gmail, aparece um erro a explicar o que falta.
   - Carregar duas vezes em **Enviar**, ou carregar outra vez depois de um erro, **nunca manda dois emails** ao cliente.
   - Se o Gmail não responder (rede, prazo), o editor diz **"O Gmail não confirmou o envio — pode ter chegado ao cliente"**. Vê na pasta Enviados (ou espera uns minutos) antes de usar **Confirmei que não saiu — enviar outra vez**.
   - Uma **mensagem nova** numa caixa por cidade fica na cidade do alias (ou na tua) e já ligada ao cliente.
   - Os anexos têm de ser carregados por ti nesse editor.
4. **Rascunho IA** põe uma sugestão no editor — revê sempre antes de enviar. Nada é enviado sozinho.
5. Atribui um **Responsável** e muda o estado. A lista de responsáveis só mostra quem pode responder nessa caixa **e** vê a cidade da conversa. Um email novo do cliente reabre uma conversa resolvida.
6. **Por classificar** (só admin e super admin): emails que chegaram por um endereço fora da tabela de aliases (ex.: em Bcc). Abre e carrega em **Atribuir à caixa** — ver a ajuda "Email por alias".
7. **Notificações automáticas de reserva** (os emails "Nova Reserva" que o sistema Multipark manda para a caixa "Reservas (geral)", ~4000 por mês): ficam guardadas, mas **escondidas** nas listas. Carrega em **Filtros → Mostrar automáticos** para as ver (aparecem com a etiqueta "Automático"). A **pesquisa** encontra-as sempre. Não contam como por ler nem geram avisos.
8. **Emails que a aplicação envia sozinha** (pedidos e lembretes de disponibilidade aos extras — "Disponibilidade — semana de…", "Lembrete: ainda não indicaste a tua disponibilidade" —, avisos de escala, turnos cancelados, lembretes de formação, notificações e relatórios): também ficam **escondidos** como automáticos, mesmo quando saem por recursos-humanos@. Não aparecem como conversas abertas, não contam como por ler, por responder nem abertas, e não ficam para atribuir. **Se a pessoa responder**, a conversa passa a normal e aparece na caixa (quem respondeu foi uma pessoa). Os envios a um extra ficam na ficha dele: **Recursos Humanos → abre o colaborador → Comunicações automáticas** (data, tipo, assunto e estado *Enviado*/*Respondido*; o assunto abre a conversa). Os que já estavam na caixa antes desta mudança foram limpos uma vez, automaticamente.

## O resto da Comunicação (menu, por esta ordem)
- **Caixas de email → O meu email → Drive → WhatsApp → Central → Calendário → Tarefas.**
- **Drive** abre o **Drive da empresa** (o Shared Drive configurado em Definições → Comunicação → Google Drive; se ainda não estiver ligado, a lista dos Drives partilhados) num separador ao lado, **na tua conta Google** — a que ligaste no Perfil → Google ou, sem ela, o email com que entras no dashboard. Assim, num telemóvel ou browser com várias contas Google, já não abre a pessoal. Se a conta não estiver aberta nesse browser, o Google pede para entrar com ela. Os ficheiros ligados a uma ficha continuam no separador Drive dessa ficha.
- **Central**: as chamadas da consola da Vodafone. Cada um vê as suas; admin e super admin veem as de todos (ver a ajuda "Central").
- **Tarefas**: as mesmas Tarefas das Operações, também aqui.

**Caixas por tema**
- As caixas são as mesmas do WhatsApp: além das que já havia (Reclamações, Perdidos, Críticas, Ocorrências, RH, Info, Comercial…) há **Alterações**, **Cancelamentos**, **Serviços extra**, **Parcerias** e **Faturação** — caixas "por tema", sem endereço próprio. Os pedidos para **cancelar** uma reserva (ou o reembolso de uma cancelada) vão para **Cancelamentos**; mudar datas, horas, voo ou matrícula fica em **Alterações**.
- **A IA lê e separa sozinha** (interruptor **"IA: separar emails e WhatsApp pelas caixas"**, Definições → Automações, **ligado por omissão**): cada email recebido numa caixa partilhada (info@, reservas@, recursos-humanos@…) é lido **uma vez** e a IA decide **pelo sentido** do que a pessoa escreve — nunca por uma palavra solta. Uma conversa nova vai para a caixa do tema — RH, Reservas, Alterações, Cancelamentos, Serviços extra, Reclamações, Perdidos, Parcerias, Faturação. **Fica por ler** e o aviso de email novo vai a quem vê essa caixa.
  - **Reclamações e perdidos vão para os módulos** (interruptores **"IA: reclamações que chegam a outras caixas vão para as Reclamações"**, ligado, e **"IA: objetos perdidos que chegam às caixas vão para os Perdidos e Achados"**, desligado por omissão): a IA vê a queixa ou o objeto esquecido mesmo **dentro de outro pedido** (ex.: "quero mudar a data… e da última vez o carro veio sujo"), numa **resposta** ou num **reencaminhamento** do backoffice. Abre a reclamação / o perdido (ou junta o email ao que já está aberto do mesmo cliente, da mesma conversa ou da mesma reserva) e a conversa vai para a caixa **Reclamações** / **Perdidos**, **por ler**. Com certeza média o caso nasce **"Por confirmar (IA)"** — ver a ajuda das Reclamações. Uma conversa nunca dá dois casos e **nunca se responde ao cliente**.
  - **Críticas e ocorrências** (interruptor **"IA: críticas e ocorrências por email vão para a caixa delas e ficam lidas"**, desligado por omissão): os avisos de avaliação (Google, Trustpilot, Tripadvisor) e os elogios vão para a caixa **Críticas** e ficam **lidos** — a crítica já entra sozinha nas Críticas, daqui não se cria nada. Os avisos de ocorrência da app Multipark ligam-se à ocorrência da app (ligação **Ocorrência**, abre a ocorrência), vão para a caixa **Ocorrências** e ficam **lidos**; um relato de ocorrência escrito por uma pessoa vai para as Ocorrências **por ler**.
  - **Lixo** (publicidade, newsletters, spam, respostas automáticas) fica onde chegou. O que a IA **não percebe** (pouca certeza) vai para o **info**, para alguém dividir à mão.
  - Se a IA **falhar**, nada se mexe: o email fica onde chegou, **por ler**, e é lido outra vez mais tarde (até 3 vezes). Nunca se perde.
  - Uma **resposta** numa conversa que já está numa caixa fica onde está — salvo se trouxer uma reclamação ou um perdido (aí vai para a caixa do caso). O email **pessoal** (O meu email) nunca é mexido.
  - O que chega a **reclamacoes@** e **perdidos@** abre sempre o caso (o pipeline dessas caixas); com o interruptor **"IA: não abrir caso para o lixo que chega à reclamacoes@ e perdidos@"** (desligado), só não abre quando a IA tem a certeza (90 %) de que é lixo.
  - Na conversa aparece **"Movido pela IA → caixa (motivo · certeza)"** (ou "A IA deixou em…" / "A IA não conseguiu ler — ficou em…"). Com várias leituras na mesma conversa, aparece a última que a mudou de caixa.
  - A IA **nunca responde** a ninguém. Um candidato a trabalhar que escreve pela 1.ª vez entra também nos **Leads de Extras** (ver essa ajuda).
  - **Os emails que já lá estão**: com o interruptor **"IA: rever os emails que já estão nas caixas"** (desligado por omissão), de 15 em 15 min a mesma triagem passa pelos emails dos últimos 30 dias ainda sem caso — as reclamações e os perdidos que lá estejam abrem o caso. Cada email é lido uma vez; não baralha as caixas de tema dos antigos; o que uma pessoa já mexeu fica como está.
  - Limiar de certeza e máximo de emails lidos por vez: Definições → Parâmetros → IA → **"IA a separar emails e WhatsApp: limiar e teto"** (0,7 e 10 por omissão). Certezas dos casos: **"IA: reclamações e perdidos vistos nas caixas — certezas"**. Dias e lote do varrimento: **"IA: rever os emails que já estão nas caixas — dias e lote"**.
  - **Testar a triagem** (super admin, Definições → Comunicação): corre uns 260 emails de exemplo, em três conjuntos, pelo modelo real e diz quantas reclamações e perdidos apanha (a meta é mais de 90 % em cada conjunto).
  - Um email só em HTML (sem texto simples) é lido pelo texto do HTML. A IA vê a mensagem nova primeiro e o citado como contexto — também quando a resposta vem **por baixo** da citação.
  - Os emails de **parceiros** (contactos das Parcerias) em nome de um cliente só abrem caso com o interruptor **"IA: reclamações e perdidos que um parceiro manda em nome de um cliente abrem o caso"** (desligado por omissão) — sempre "Por confirmar (IA)".
- **Mover para…** (na conversa) muda a caixa à mão e **corrige a IA**: na conversa passa a ler-se "corrigido à mão → caixa" (fica registado quem e quando). Depois disso a IA não volta a mexer nessa conversa (nem para abrir casos). Quem não vê a caixa nova deixa de ver a conversa.
- Responder numa caixa por tema sai pelo endereço por onde o cliente escreveu (ex.: info@). Mensagens novas escrevem-se nas caixas com endereço.

## Ligar, WhatsApp e email a partir das fichas (ficha do cliente, da reserva e do colaborador)
- **WhatsApp** abre a conversa desse número. Se ainda não houver, cria-a **sem enviar nada**: escreves no ecrã do WhatsApp (com um template, porque a janela de 24 h ainda não abriu). Criar uma conversa nova precisa de poder responder no WhatsApp; quem só vê abre as que já existem.
- **Ligar**: pelo telemóvel (abre o marcador ou a consola da central — os números de Portugal vão sem o +351) e, com as chamadas pelo WhatsApp ligadas, também **pelo WhatsApp** (abre a conversa e a chamada).
- **Email** abre **Nova mensagem** aqui na Comunicação já com o destinatário (cliente e reserva: a caixa **info**; colaborador: a caixa RH; se não puderes escrever nela, a primeira onde podes). Quem não tem a Comunicação usa o programa de email do aparelho.
- Com vários telefones ou emails na ficha, o botão mostra a lista para escolheres.

**Ligações**
- Cada email fica ligado automaticamente ao cliente, à reserva, à reclamação, ao perdido ou à ocorrência da app (com a confiança da ligação). A ligação a uma reclamação aberta usa o email ou a matrícula — **o nome sozinho nunca liga**. Em **Ligações** podes ligar ou desligar à mão.
- Na ficha do cliente, na reclamação, no perdido e na reserva há um separador **Comunicações** com os emails (e o WhatsApp) ligados. Emails de uma caixa ou cidade que não vês aparecem só como "Sem acesso ao conteúdo".

## Emails que criam casos (reclamacoes@, perdidos@, críticas…)
- Com **"Críticas: só cria crítica a partir de um aviso de avaliação"** (Definições → Automações, desligado por omissão), um email que entrou pela caixa Críticas sem ser um aviso de avaliação nem trazer estrelas não cria crítica: passa pela **triagem normal** e vai para a caixa do tema (ver a ajuda das Críticas).
- Se a criação do caso falhar (base de dados, ficheiros), o email fica marcado e o sistema **tenta de novo** sozinho de 15 em 15 min (até 5 vezes). A equipa recebe o aviso de email novo na mesma.
- O que continuar a falhar aparece em **Definições → Comunicação → Emails que não criaram o caso**, com **Tentar de novo** (admin).

**Caixas (super admin)**
- Uma caixa já não se apaga: **Desativar** tira-a das listas e da sincronização, e as conversas ficam guardadas (o super admin continua a vê-las). Para voltar: **Editar → Ativa**.

## O meu email (menu **Comunicação → O meu email**, ou **O meu email** na lista das caixas)
1. Carrega em **Ligar a minha conta Google** (também no Perfil). Só contas do Workspace da empresa.
2. Os teus emails aparecem em poucos minutos. Na caixa, vês tu e o **super admin**, que consegue consultar o email pessoal de todos — só em **O meu email → escolher a pessoa**; nunca aparece na caixa geral nem nas pesquisas — mas não envia em nome de ninguém. Os emails trocados com um cliente ficam também no separador **Comunicações** da ficha desse cliente, visíveis a quem tem acesso aos Clientes.
   - **Atualizar** diz se a leitura falhou (por exemplo "a ligação ao Google expirou"), em vez de "Sem emails novos".
3. **Desligar** revoga o acesso na Google.

**Segurança**
- As imagens de fora ficam bloqueadas até carregares em **Mostrar imagens** (evita pixels de rastreio). As **fotos coladas no corpo** do email (ex.: danos enviados do iPhone) também aparecem com **Mostrar imagens** e ficam na lista de anexos.
- Os anexos abrem a pedido; o conteúdo dos emails é limpo antes de ser mostrado.
- **Guardar no meu Drive**: do email do RH (recursos-humanos@) só os **currículos** (ficheiros com CV/currículo no nome) podem ir para o Drive pessoal; os outros documentos do RH ficam na app.
- As horas são sempre de Lisboa.
- **Retenção (arquivo):** emails com mais de 5 anos sem ligação a nenhum registo **não se apagam**. Deixam de aparecer nas listas, contagens e pesquisas, e ficam guardados no **Arquivo (+5 anos)**, que só o super admin vê, a pedido. Numa conversa com mensagens antigas arquivadas, o super admin tem **Mostrar arquivadas**. Uma mensagem nova, ou ligar a conversa a um cliente/caso, tira-a do arquivo. O Gmail fica sempre intacto.

**Quando a leitura falha**
- Caixas, lista, conversa, comunicações de um registo e a classificação mostram **"Não foi possível carregar…"** com **Tentar de novo**. Nunca "Não tens acesso", "Sem conversas" ou "liga a tua conta" por engano. No menu, o contador passa a **?**.

## Calendário (menu **Comunicação → Calendário**, em /calendario)

A tua agenda do Google Calendar dentro do dashboard, como no Google. É lida **no momento** da tua conta Google @multipark: só tu vês a tua agenda e o dashboard não guarda os teus eventos.
1. Na primeira vez, carrega em **Ligar a minha conta Google** (já pede o Calendário). Se a conta já estava ligada só para o email, carrega em **Ativar Calendário**. Se aparecer **Voltar a ligar**, a autorização expirou: liga outra vez.
2. Escolhe a vista em cima à direita: **Dia**, **Semana** (a de omissão) ou **Mês**. No telemóvel: **Dia** ou **Lista** (os próximos 7 dias). **‹** e **›** andam para trás e para a frente; **Hoje** volta a hoje; o mês pequeno à esquerda leva a qualquer dia. Carrega num dia para o ver sozinho (no mês, **+N mais** também).
3. Na semana e no dia, as horas vão das 00:00 às 24:00 e a página abre nas 07:00 (faz scroll para o resto). A linha vermelha é a hora atual. Os eventos de dia inteiro (e os de 24 horas ou mais) ficam na faixa de cima. Horas sempre de Lisboa.
4. **Que calendários aparecem:** o teu principal, os que tens visíveis no Google (por exemplo os partilhados por colegas) e o **Multipark** que o dashboard cria com os teus turnos, formação e prazos (marcado "dashboard"). À esquerda (no telemóvel em **Calendários**) há uma caixa por calendário para o mostrar ou esconder; a escolha fica guardada neste computador/telemóvel. Um evento privado de um calendário partilhado aparece só como **Ocupado**.
5. **Detalhes:** carrega no evento para veres a hora, o local (abre no mapa), a descrição e o calendário. Com videochamada, **Entrar** abre o Google Meet. **Abrir no Google Calendar** abre o evento no Google, para o editar ou apagar (aqui não se editam).
6. **Novo evento:** carrega em **Novo evento** (no telemóvel **Novo**) ou num espaço vazio da grelha (já vem com essa hora). Título, início e fim (ou **Dia inteiro**; mudar o início leva o fim atrás, com a mesma duração). Opcional: **Convidados** (emails separados por vírgulas, no máximo 20 — recebem o convite por email do Google), **Adicionar videochamada Google Meet**, **Local**, **Descrição** e **Repete** (todos os dias, todas as semanas no mesmo dia, todos os meses no mesmo dia ou todos os anos; termina numa data, após N vezes ou nunca — nos meses sem esse dia, 29 a 31, não há evento). **Guardar** põe-no no teu calendário principal e aparece logo aqui; fica nos registos de atividade (sem os emails dos convidados).
7. **Quando não dá:** "**Não foi possível ler o calendário**" quer dizer que a Google não respondeu — não que a agenda está vazia; carrega em **Tentar de novo**. Se só um calendário partilhado falhar, aparece um aviso amarelo com o nome dele e os outros continuam à vista.
