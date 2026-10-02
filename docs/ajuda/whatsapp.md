---
modulo: whatsapp
titulo: WhatsApp
rotas: /whatsapp
palavras: whatsapp, quem é, nome do cliente, crm, histórico, caixas, caixa, tema, mover, recursos humanos, alterações, serviços extra, parcerias, faturação, mensagem, mensagens, conversa, conversas, não lidas, responder, template, modelo, janela de 24h, respostas rápidas, responsável, atribuir, resolvida, pendente, stop, sugerir resposta, sem confirmação, duplicada, enviar outra vez, cidade, arquivar, ficheiro, documento, imagem, pesquisa
---
# WhatsApp

Caixa de entrada partilhada das conversas de WhatsApp com colaboradores e clientes.

**Quem vê o quê**
- Cada pessoa vê as conversas das suas cidades: um colaborador pela cidade da ficha, um lead pela cidade do lead, um número solto pela cidade da reserva com esse telefone. Números **sem cidade** (sem ficha, lead nem reserva) são de **todos** os que têm o WhatsApp.
- Responder, atribuir e mudar o estado: team leader e acima.

**Começar uma conversa**
- Nas fichas do cliente, da reserva e do colaborador há o botão **WhatsApp**: abre a conversa desse número ou cria-a (sem enviar nada). A primeira mensagem é um **template** (ver **Janela de 24 h**).

**Quem é**
- O nome da conversa vem da ficha do colaborador, do candidato a extra ou do **cliente no CRM** (pelo número); só depois o nome do perfil do WhatsApp.
- Por baixo do número aparece uma linha **quem é**: "Colaborador · Condutor · Lisboa", "Candidato a extra · respondeu" ou "Cliente · 3 reservas (1 por vir) · última 12/09/2026" (carrega para abrir a ficha do cliente). Número sem nada: "Número sem ficha, candidatura nem cliente no CRM".

**Responder**
1. Menu **Comunicação → WhatsApp** (as mesmas conversas aparecem também em **Comunicação → Caixas (email e WhatsApp)**, junto dos emails da caixa). Filtra por estado, responsável, **Não lidas** ou só conversas com alerta; pesquisa por nome, número ou texto (tecla `/`).
2. A lista mostra as **300 conversas mais recentes**; a pesquisa procura também nas mais antigas.
3. Abre a conversa e escreve a resposta. No computador, **Enter** envia e **Shift+Enter** muda de linha; **no telemóvel, Enter muda de linha** e só o botão verde envia. Há **Respostas rápidas** para textos frequentes.
4. **Janela de 24 h**: só podes escrever texto livre até 24 h depois da última mensagem do contacto. Com a janela fechada, usa **Enviar template**; o texto livre só volta quando o contacto responder.
5. **Sugerir resposta com IA** põe uma sugestão na caixa de texto — revê sempre antes de enviar. A IA nunca envia.

**Mensagem "sem confirmação"**
- Se a Meta não responder ao envio (rede, prazo), a mensagem fica com ⚠ **"Sem confirmação da Meta: pode ter chegado ao cliente"**. Não aparece como falhada porque pode ter saído.
- Confirma com o cliente (ou espera pela resposta dele) antes de escrever outra vez — assim não recebe a mesma mensagem duas vezes.
- Carregar duas vezes em Enviar, ou a rede cair a meio, nunca manda a mesma mensagem duas vezes.

**Respostas automáticas (sem uma pessoa)**
- Confirmação do **STOP** / **INICIAR** (sempre).
- Resposta a pedidos de disponibilidade dos extras ("Obrigado, fica confirmado") — só com a automação dos extras ligada.
- Link da candidatura a um lead que responde — só com a **resposta automática aos leads** ligada (Definições → Automações; desligada por omissão).

**Caixas por tema**
- Cada conversa fica numa caixa: **Recursos Humanos**, **Reservas**, **Alterações**, **Serviços extra**, **Reclamações**, **Perdidos e Achados**, **Parcerias**, **Faturação**… ou **Geral** (ainda por separar). São as mesmas caixas do email.
- Colaboradores e candidatos vão sozinhos para **Recursos Humanos**. Os clientes vão para a caixa que a **IA** escolhe pela conversa (com a triagem por IA ligada).
- Escolhe **Todas as caixas** ou uma caixa no topo da lista. Na conversa, o seletor da caixa **move-a** — e a IA deixa de a mudar.
- Só vês as caixas do teu módulo (ex.: RH, Reclamações) e, como sempre, a tua cidade e as conversas sem cidade.

**Organizar**
- Estados: **Aberta** (precisa de atenção), **Pendente** (à espera de algo), **Resolvida**. Se o contacto voltar a escrever, reabre.
- **Responsável**: a lista só mostra quem pode responder no WhatsApp **e** vê a cidade dessa conversa. Quem responde a uma conversa sem responsável fica com ela.
- **Marcar como não lida** para retomar mais tarde.
- Liga a conversa a uma reserva ou cliente no painel lateral. Com a Multipark em baixo, o painel diz "indisponível" (não "nenhuma reserva").
- Contactos que pediram STOP ficam marcados "Não quer mensagens".

**Ficheiros e localizações recebidos**
- Imagens, áudios, vídeos e documentos ficam guardados até 16 MB. Se não for possível guardar, a mensagem diz porquê ("demasiado grande", "a descarregar") — pede ao contacto para reenviar ou mandar por email.
- Uma localização partilhada aparece com o nome/morada e o link para o mapa; um contacto partilhado com o nome e o número.
- Não há grupos do WhatsApp: cada conversa é com uma pessoa.

**Envios em massa (Extras-Dia, leads)**
- Só com templates aprovados. Quem pediu STOP nunca recebe.
- Se o envio for cortado a meio (rede, prazo) e carregares outra vez no **mesmo** diálogo, **retoma**: quem já recebeu não recebe outra vez. Depois de um envio completo, o botão fica "Enviado".
- Uma tabela filtrada sem ninguém não envia a toda a gente — dá "Nenhum destinatário".
- "Enviado" quer dizer **aceite pela Meta**. Se a Meta disser depois que falhou (ex.: número sem WhatsApp), a contagem da difusão corrige-se e o aviso de escala dessa pessoa passa a "falhou".
- Templates com cabeçalho de imagem, vídeo, documento ou texto com variável são recusados antes de enviar (a Meta recusava cada destinatário).

**Respostas rápidas**
- Servem a toda a empresa. Criar e editar: quem responde no WhatsApp. **Arquivar** (sai do menu de toda a gente, não se apaga): admin.

**Quando a leitura falha**
- Lista, conversa, contexto e respostas rápidas mostram **"Não foi possível carregar…"** com **Tentar de novo**, nunca "Ainda sem conversas" ou "janela fechada".

**Chamadas de voz**
- Os clientes podem ligar para o WhatsApp da empresa e a chamada toca no dashboard (**Atender** / **Recusar**); na conversa há o botão **Ligar** para devolver chamadas. Ver a ajuda "WhatsApp — Chamadas de voz".
