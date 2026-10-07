---
modulo: comunicacao
titulo: Comunicação (email)
rotas: /comunicacao, /comunicacao/meu-email
palavras: caixas de email, caixa inicial, estrela, como no gmail, ligar, telefonar, enviar email, enviar whatsapp, ficha do cliente, ficha da reserva, ficha do colaborador, email, emails, gmail, caixas por tema, mover para, separar pela ia, faturação, parcerias, alterações, serviços extra, arquivo, arquivadas, retenção, emails antigos, sem confirmação, enviar outra vez, duplicado, desativar caixa, caso por criar, emails que não criaram o caso, fotos no email, por classificar, alias, etiqueta, caixa, caixas, info@, comercial@, admin@, reclamacoes@, perdidos@, responder, reencaminhar, enviar como, alias, assinatura, conta google, ligar conta, o meu email, ligações, anexos, mostrar imagens, rascunho ia, automáticos, mostrar automáticos, nova reserva, notificações de reserva, disponibilidade, pedidos de disponibilidade, lembrete, recursos-humanos@, extras, comunicações automáticas, escala
---
# Comunicação (email)

Os emails das caixas partilhadas da empresa e o teu próprio email @multipark, dentro do dashboard. Todo o email entra e sai pela API do Gmail; cada email é separado pelo alias a que foi enviado (tabela em Definições → Comunicação — ver a ajuda "Email por alias").

**Caixas de email** (menu **Comunicação → Caixas de email**)
1. As caixas ficam à esquerda, **umas por baixo das outras, como no Gmail**: carregas numa e a lista muda logo ao lado, sem sair da página. Cada caixa mostra quantos emails tem **por ler**. Só vês as caixas do teu módulo; algumas (ex.: admin@) são só para a administração.
   - **O meu email** está na mesma lista (em **Pessoal**), por baixo das caixas da empresa.
   - As caixas que são **tuas** (o endereço está em teu nome ou da tua função) têm o ícone de pessoa.
   - **Caixa inicial**: carrega na **estrela ★** ao lado de uma caixa e é essa que abre quando entras. Sem estrela, abre a primeira que é tua (ou a primeira da lista). Cada pessoa tem a sua.
   - Aqui só há email. O WhatsApp tem a entrada dele: **Comunicação → WhatsApp**.
   - No telemóvel, a caixa escolhe-se na lista do topo.
   - **Trabalha sempre daqui:** o que envias pelo dashboard fica registado na conversa e ligado ao cliente — também do **O meu email** (uma mensagem nova para um cliente fica no separador **Comunicações** da ficha dele).
2. Filtra por estado (Aberta, Pendente, Resolvida), responsável, marca, **Por responder** ou **Não lidas**, e pesquisa por assunto, nome ou email.
3. Abre a conversa: **Responder**, **Responder a todos** ou **Reencaminhar**. O email sai pelo endereço (alias) a que o cliente escreveu, com a assinatura da marca. Se o alias não estiver configurado como "Enviar email como" no Gmail, aparece um erro a explicar o que falta.
   - Carregar duas vezes em **Enviar**, ou carregar outra vez depois de um erro, **nunca manda dois emails** ao cliente.
   - Se o Gmail não responder (rede, prazo), o editor diz **"O Gmail não confirmou o envio — pode ter chegado ao cliente"**. Vê na pasta Enviados (ou espera uns minutos) antes de usar **Confirmei que não saiu — enviar outra vez**.
   - Uma **mensagem nova** numa caixa por cidade fica na cidade do alias (ou na tua) e já ligada ao cliente.
   - Os anexos têm de ser carregados por ti nesse editor.
4. **Rascunho IA** põe uma sugestão no editor — revê sempre antes de enviar. Nada é enviado sozinho.
5. Atribui um **Responsável** e muda o estado. A lista de responsáveis só mostra quem pode responder nessa caixa **e** vê a cidade da conversa. Um email novo do cliente reabre uma conversa resolvida.
6. **Por classificar** (só admin e super admin): emails que chegaram por um endereço fora da tabela de aliases (ex.: em Bcc). Abre e carrega em **Atribuir à caixa** — ver a ajuda "Email por alias".
7. **Notificações automáticas de reserva** (os emails "Nova Reserva" que o sistema Multipark manda para a caixa "Reservas (geral)", ~4000 por mês): ficam guardadas, mas **escondidas** nas listas. Carrega em **Mostrar automáticos** para as ver (aparecem com a etiqueta "Automático"). A **pesquisa** encontra-as sempre. Não contam como por ler nem geram avisos.
8. **Emails que a aplicação envia sozinha** (pedidos e lembretes de disponibilidade aos extras — "Disponibilidade — semana de…", "Lembrete: ainda não indicaste a tua disponibilidade" —, avisos de escala, turnos cancelados, lembretes de formação, notificações e relatórios): também ficam **escondidos** como automáticos, mesmo quando saem por recursos-humanos@. Não aparecem como conversas abertas, não contam como por ler, por responder nem abertas, e não ficam para atribuir. **Se a pessoa responder**, a conversa passa a normal e aparece na caixa (quem respondeu foi uma pessoa). Os envios a um extra ficam na ficha dele: **Recursos Humanos → abre o colaborador → Comunicações automáticas** (data, tipo, assunto e estado *Enviado*/*Respondido*; o assunto abre a conversa). Os que já estavam na caixa antes desta mudança foram limpos uma vez, automaticamente.

**Caixas por tema**
- As caixas são as mesmas do WhatsApp: além das que já havia (Reclamações, Perdidos, Críticas, Ocorrências, RH, Info, Comercial…) há **Alterações**, **Cancelamentos**, **Serviços extra**, **Parcerias** e **Faturação** — caixas "por tema", sem endereço próprio. Os pedidos para **cancelar** uma reserva (ou o reembolso de uma cancelada) vão para **Cancelamentos**; mudar datas, horas, voo ou matrícula fica em **Alterações**.
- Os emails novos que chegam ao **info@** (caixa geral) vão para a caixa do tema pela **IA** — com **"IA: separar os emails pelas caixas"** ligado em Definições → Automações (desligado por omissão). A conversa mostra **"veio de Info (IA)"**. A IA não cria reclamações nem perdidos sozinha — só move.
- **Mover para…** (na conversa) muda a caixa à mão; depois disso a IA não volta a mexer. Quem não vê a caixa nova deixa de ver a conversa.
- Responder numa caixa por tema sai pelo endereço por onde o cliente escreveu (ex.: info@). Mensagens novas escrevem-se nas caixas com endereço.

**Ligar, WhatsApp e email a partir das fichas** (ficha do cliente, da reserva e do colaborador)
- **WhatsApp** abre a conversa desse número. Se ainda não houver, cria-a **sem enviar nada**: escreves no ecrã do WhatsApp (com um template, porque a janela de 24 h ainda não abriu). Criar uma conversa nova precisa de poder responder no WhatsApp; quem só vê abre as que já existem.
- **Ligar**: pelo telemóvel (abre o marcador) e, com as chamadas pelo WhatsApp ligadas, também **pelo WhatsApp** (abre a conversa e a chamada).
- **Email** abre **Nova mensagem** aqui na Comunicação já com o destinatário (cliente e reserva: a caixa **info**; colaborador: a caixa RH; se não puderes escrever nela, a primeira onde podes). Quem não tem a Comunicação usa o programa de email do aparelho.
- Com vários telefones ou emails na ficha, o botão mostra a lista para escolheres.

**Ligações**
- Cada email fica ligado automaticamente ao cliente, à reserva, à reclamação ou ao perdido (com a confiança da ligação). A ligação a uma reclamação aberta usa o email ou a matrícula — **o nome sozinho nunca liga**. Em **Ligações** podes ligar ou desligar à mão.
- Na ficha do cliente, na reclamação, no perdido e na reserva há um separador **Comunicações** com os emails (e o WhatsApp) ligados. Emails de uma caixa ou cidade que não vês aparecem só como "Sem acesso ao conteúdo".

**Emails que criam casos** (reclamacoes@, perdidos@, críticas…)
- Se a criação do caso falhar (base de dados, ficheiros), o email fica marcado e o sistema **tenta de novo** sozinho (até 5 vezes). A equipa recebe o aviso de email novo na mesma.
- O que continuar a falhar aparece em **Definições → Comunicação → Emails que não criaram o caso**, com **Tentar de novo** (admin).

**Caixas (super admin)**
- Uma caixa já não se apaga: **Desativar** tira-a das listas e da sincronização, e as conversas ficam guardadas (o super admin continua a vê-las). Para voltar: **Editar → Ativa**.

**O meu email** (menu **Comunicação → O meu email**, ou **O meu email** na lista das caixas)
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
