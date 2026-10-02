---
modulo: comunicacao
titulo: Comunicação (email)
rotas: /comunicacao, /comunicacao/meu-email
palavras: email, emails, gmail, sem confirmação, enviar outra vez, duplicado, desativar caixa, caso por criar, emails que não criaram o caso, fotos no email, por classificar, alias, etiqueta, caixa, caixas, info@, comercial@, admin@, reclamacoes@, perdidos@, responder, reencaminhar, enviar como, alias, assinatura, conta google, ligar conta, o meu email, ligações, anexos, mostrar imagens, rascunho ia, automáticos, mostrar automáticos, nova reserva, notificações de reserva, disponibilidade, pedidos de disponibilidade, lembrete, recursos-humanos@, extras, comunicações automáticas, escala
---
# Comunicação (email)

Os emails das caixas partilhadas da empresa e o teu próprio email @multipark, dentro do dashboard. Todo o email entra e sai pela API do Gmail; cada email é separado pelo alias a que foi enviado (tabela em Definições → Comunicação — ver a ajuda "Email por alias").

**Caixas partilhadas** (menu **Comunicação → Caixas partilhadas**)
1. Escolhe a caixa (ex.: Reclamações, Info, Comercial). Só vês as caixas do teu módulo; algumas caixas (ex.: admin@) são só para a administração.
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

**Ligações**
- Cada email fica ligado automaticamente ao cliente, à reserva, à reclamação ou ao perdido (com a confiança da ligação). A ligação a uma reclamação aberta usa o email ou a matrícula — **o nome sozinho nunca liga**. Em **Ligações** podes ligar ou desligar à mão.
- Na ficha do cliente, na reclamação, no perdido e na reserva há um separador **Comunicações** com os emails (e o WhatsApp) ligados. Emails de uma caixa ou cidade que não vês aparecem só como "Sem acesso ao conteúdo".

**Emails que criam casos** (reclamacoes@, perdidos@, críticas…)
- Se a criação do caso falhar (base de dados, ficheiros), o email fica marcado e o sistema **tenta de novo** sozinho (até 5 vezes). A equipa recebe o aviso de email novo na mesma.
- O que continuar a falhar aparece em **Definições → Comunicação → Emails que não criaram o caso**, com **Tentar de novo** (admin).

**Caixas (super admin)**
- Uma caixa já não se apaga: **Desativar** tira-a das listas e da sincronização, e as conversas ficam guardadas (o super admin continua a vê-las). Para voltar: **Editar → Ativa**.

**O meu email** (menu **Comunicação → O meu email**)
1. Carrega em **Ligar a minha conta Google** (também no Perfil). Só contas do Workspace da empresa.
2. Os teus emails aparecem em poucos minutos. Na caixa, vês tu e o **super admin**, que consegue consultar o email pessoal de todos mas não enviar em nome de ninguém. Os emails trocados com um cliente ficam também no separador **Comunicações** da ficha desse cliente, visíveis a quem tem acesso aos Clientes.
   - **Atualizar** diz se a leitura falhou (por exemplo "a ligação ao Google expirou"), em vez de "Sem emails novos".
3. **Desligar** revoga o acesso na Google.

**Segurança**
- As imagens de fora ficam bloqueadas até carregares em **Mostrar imagens** (evita pixels de rastreio). As **fotos coladas no corpo** do email (ex.: danos enviados do iPhone) também aparecem com **Mostrar imagens** e ficam na lista de anexos.
- Os anexos abrem a pedido; o conteúdo dos emails é limpo antes de ser mostrado.
- As horas são sempre de Lisboa.
- **Retenção:** emails com mais de 5 anos sem ligação a nenhum registo saem da base do dashboard (o Gmail fica intacto).

**Quando a leitura falha**
- Caixas, lista, conversa, comunicações de um registo e a classificação mostram **"Não foi possível carregar…"** com **Tentar de novo**. Nunca "Não tens acesso", "Sem conversas" ou "liga a tua conta" por engano. No menu, o contador passa a **?**.
