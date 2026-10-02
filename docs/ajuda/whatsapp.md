---
modulo: whatsapp
titulo: WhatsApp
rotas: /whatsapp
palavras: whatsapp, mensagem, mensagens, conversa, conversas, não lidas, responder, template, modelo, janela de 24h, respostas rápidas, responsável, atribuir, resolvida, pendente, stop, sugerir resposta, sem confirmação, duplicada, enviar outra vez, cidade, arquivar, ficheiro, documento, imagem, pesquisa
---
# WhatsApp

Caixa de entrada partilhada das conversas de WhatsApp com colaboradores e clientes.

**Quem vê o quê**
- Cada pessoa vê as conversas das suas cidades: um colaborador pela cidade da ficha, um lead pela cidade do lead, um número solto pela cidade da reserva com esse telefone. Números sem ficha, lead nem reserva só os vê quem vê todas as cidades.
- Responder, atribuir e mudar o estado: team leader e acima.

**Responder**
1. Menu **Operações → WhatsApp**. Filtra por estado, responsável, **Não lidas** ou só conversas com alerta; pesquisa por nome, número ou texto (tecla `/`).
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
- Link da candidatura a um lead que responde — só com a resposta automática aos leads ligada.

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
