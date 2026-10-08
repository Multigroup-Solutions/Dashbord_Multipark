---
modulo: whatsapp
titulo: WhatsApp
rotas: /whatsapp
palavras: whatsapp, movido pela ia, geral, conversa nova, parar promoções, criar reclamação, criar perdido, proposta de caso, aceite, enviado, entregue, lido, confirmar envio, 24 horas, quem é, nome do cliente, crm, histórico, caixas, caixa, tema, mover, recursos humanos, alterações, serviços extra, parcerias, faturação, mensagem, mensagens, conversa, conversas, não lidas, responder, template, modelo, janela de 24h, respostas rápidas, responsável, atribuir, resolvida, pendente, stop, sugerir resposta, sem confirmação, duplicada, enviar outra vez, cidade, cidade do template, lisboa, porto, turno confirmado, preciso de alterar, arquivar, ficheiro, documento, imagem, pesquisa
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
1. Menu **Comunicação → WhatsApp** (o WhatsApp tem a página dele; as **Caixas de email** são só de email). Filtra por estado, responsável, **Não lidas** ou só conversas com alerta; pesquisa por nome, número ou texto (tecla `/`).
2. A lista mostra as **300 conversas mais recentes**; a pesquisa procura também nas mais antigas.
3. Abre a conversa e escreve a resposta. No computador, **Enter** envia e **Shift+Enter** muda de linha; **no telemóvel, Enter muda de linha** e só o botão verde envia. Há **Respostas rápidas** para textos frequentes.
4. **Janela de 24 h**: só podes escrever texto livre até 24 h depois da última mensagem do contacto. Com a janela fechada, usa **Enviar template**; o texto livre só volta quando o contacto responder.
5. **Sugerir resposta com IA** põe uma sugestão na caixa de texto — revê sempre antes de enviar. A IA nunca envia.

**Estado de cada mensagem enviada** (o ícone ao lado da hora; passa o rato para ver o nome)
- 🕓 **A enviar** → ✓ esbatido **Aceite** (a Meta aceitou o pedido, mas ainda não avisou que saiu) → ✓ **Enviado** → ✓✓ **Entregue** → ✓✓ azul **Lido**. Ou ✗ **Falhou**.
- "Aceite" não é "Enviado": se ficar muito tempo em Aceite, a Meta ainda não confirmou que a mensagem saiu.

**Mensagem "sem confirmação"**
- Se a Meta não responder ao envio (rede, prazo), a mensagem fica com ⚠ **"Sem confirmação da Meta: pode ter chegado ao cliente"**. Não aparece como falhada porque pode ter saído.
- Confirma com o cliente (ou espera pela resposta dele) antes de escrever outra vez — assim não recebe a mesma mensagem duas vezes.
- Carregar duas vezes em Enviar, ou a rede cair a meio, nunca manda a mesma mensagem duas vezes.

**Templates por cidade (motoristas extra)**
- Recrutamento, morada e regras, aviso de trabalho, turno confirmado e pedido de disponibilidade têm uma versão por cidade (Lisboa e Porto). Ao enviar (aqui, em Disponibilidade ou em Leads de Extras) escolhes a **Cidade do template**.
- Por defeito vem a cidade do motorista (ou do turno, ou do lead); sem ela, a tua. Se nenhuma existir tens de escolher: nunca se assume Lisboa.
- Num envio a várias pessoas, **Cidade de cada motorista** separa por cidade e mostra quantos vão em cada uma. Quem não tem cidade só segue depois de lhe escolheres uma.
- A pré-visualização mostra o texto final de cada cidade (morada, telefone, valor à hora). Uma cidade aparece **indisponível** enquanto o template dela não estiver aprovado na Meta.
- Quando um extra confirma o aviso de trabalho, recebe sozinho o **turno confirmado** da cidade do turno. Se carregar em **Preciso de alterar**, o turno fica **alteração pedida** na Escala e a equipa é avisada.

**Respostas automáticas (sem uma pessoa)**
- Confirmação do **STOP** / **INICIAR** (sempre).
- Resposta a pedidos de disponibilidade dos extras ("Obrigado, fica confirmado") e o Sim/Não do aviso de turno — só com **"Extras: resposta automática no WhatsApp"** ligado (Definições → Automações). Sem valor próprio segue a **Automação dos extras**. Desligado: a resposta fica na caixa para uma pessoa.
- **Aviso de conversas por responder** (sino, de hora a hora): interruptor **"WhatsApp: aviso de conversas por responder"** nas Definições → Automações. Desligado, a caixa continua a mostrar os atrasos; só não avisa.
- Link da candidatura a um lead que responde — só com a **resposta automática aos leads** ligada (Definições → Automações; desligada por omissão).

**Caixas por tema**
- Cada conversa fica numa caixa: **Recursos Humanos**, **Reservas**, **Alterações**, **Cancelamentos**, **Serviços extra**, **Reclamações**, **Perdidos e Achados**, **Parcerias**, **Faturação**… ou **Geral** (ainda por separar). São as mesmas caixas do email.
- Colaboradores e candidatos vão sozinhos para **Recursos Humanos**.
- **Conversa nova** (a 1.ª mensagem tem menos de 48 h e ainda não tem caixa): a **IA** usa a triagem (intenção) — sem uma segunda leitura — e põe-na na caixa do tema; o que não percebe fica na **Geral**. Interruptor **"IA: separar emails e WhatsApp pelas caixas"** (ligado por omissão; precisa também da triagem por IA).
- **Conversa que já tem caixa** (ou antiga): fica onde está — a IA não a volta a mudar.
- Na conversa aparece **"Movido pela IA → caixa (motivo · certeza)"**. Se estiver errado, muda a caixa no seletor: fica "corrigido à mão".
- Alguém a pedir trabalho pela 1.ª vez entra também nos **Leads de Extras** (lead com o telefone e o nome do perfil). A IA nunca responde.
- Escolhe **Todas as caixas** ou uma caixa no topo da lista. Na conversa, o seletor da caixa **move-a** — e a IA deixa de a mudar.
- Só vês as caixas do teu módulo (ex.: RH, Reclamações) e, como sempre, a tua cidade e as conversas sem cidade.

**Organizar**
- Estados: **Aberta** (precisa de atenção), **Pendente** (à espera de algo), **Resolvida**. Se o contacto voltar a escrever, reabre.
- **Responsável**: uma pessoa ou um **grupo de cidade** (**Grupo Lisboa**, **Grupo Porto**, **Grupo Faro**). As pessoas da lista são só quem pode responder no WhatsApp **e** vê a cidade dessa conversa. Atribuída a um grupo, os avisos de atraso vão à equipa dessa cidade e quem responder primeiro fica com ela. Quem responde a uma conversa sem responsável também fica com ela.
- **Marcar como não lida** para retomar mais tarde.
- Liga a conversa a uma reserva ou cliente no painel lateral. Com a Multipark em baixo, o painel diz "indisponível" (não "nenhuma reserva").
- Contactos que pediram STOP ficam marcados "Não quer mensagens". O aviso diz de onde veio: **pediu STOP**, **carregou em «Parar promoções»** (o botão das promoções da Multipark, ou escrito) ou **parou as promoções no WhatsApp** (na própria app). Os três valem o mesmo: nada de templates nem envios em massa. Volta com **INICIAR** (ou "Retomar promoções" na app).
- **Partilhado com o site da Multipark** (be-multipark): quem carrega em «Parar promoções» numa mensagem da Multipark também fica bloqueado aqui. O STOP escrito aqui e o "Parar promoções" da app chegam também ao site da Multipark (o dashboard reencaminha-lhe os eventos), que trata do lado dele.

**A triagem propõe o caso**
- Quando a triagem por IA acha que a conversa de um cliente é uma **reclamação** ou um **perdido/achado**, aparece por cima das mensagens: "A triagem acha que isto é uma reclamação" com **Criar reclamação** (ou **Criar perdido**) e **Não é**.
- Nada é criado sozinho. **Criar** abre o caso com o nome, o telefone, o email e a reserva ligados à conversa e com as últimas mensagens do cliente; depois liga a reserva e avisa a equipa, como um caso criado à mão. Fica o link **Abrir** na conversa.
- Um caso por conversa. **Não é** faz a proposta desaparecer desta conversa.
- **Criar** precisa de poder editar Reclamações (ou Perdidos e Achados); **Não é**, de poder responder no WhatsApp.

**Ficheiros e localizações recebidos**
- Imagens, áudios, vídeos e documentos ficam guardados até 16 MB. Se não for possível guardar, a mensagem diz porquê ("demasiado grande", "a descarregar") — pede ao contacto para reenviar ou mandar por email.
- Uma localização partilhada aparece com o nome/morada e o link para o mapa; um contacto partilhado com o nome e o número.
- Não há grupos do WhatsApp: cada conversa é com uma pessoa.

**Envios em massa (Extras-Dia, leads)**
- Só com templates aprovados. Quem pediu STOP nunca recebe.
- Se o envio for cortado a meio (rede, prazo) e carregares outra vez no **mesmo** diálogo, **retoma**: quem já recebeu não recebe outra vez. Depois de um envio completo, o botão fica "Enviado".
- Uma tabela filtrada sem ninguém não envia a toda a gente — dá "Nenhum destinatário".
- **Confirmar**: a duas pessoas ou mais, o botão pede primeiro **"Confirmar envio a N"**, com o template e quantas pessoas. **Voltar** cancela.
- **O mesmo template não volta ao mesmo número antes de 24 h**: quem já o recebeu (de outra difusão ou de um envio automático) fica de fora, com "já recebeu (24 h)". Um envio que falhou de certeza não conta. O envio de teste não tem este limite. Os envios automáticos do Extras-Dia (aviso de escala, disponibilidade, morada e regras) têm as suas próprias regras e podem reenviar (ex.: a escala mudou); o lembrete automático aos leads respeita as 24 h.
- Na contagem da difusão, "enviados" quer dizer **aceites pela Meta**. Se a Meta disser depois que falhou (ex.: número sem WhatsApp), a contagem da difusão corrige-se e o aviso de escala dessa pessoa passa a "falhou".
- Templates com cabeçalho de imagem, vídeo, documento ou texto com variável são recusados antes de enviar (a Meta recusava cada destinatário).

**Respostas rápidas**
- **Por cidade**: cada cidade vê as suas e as **nacionais**. Cada pessoa só cria e edita as da(s) sua(s) cidade(s). As nacionais só as muda quem vê todas as cidades.
- Na gestão, cada resposta mostra a cidade (ou "Nacional"). **Arquivar** (sai do menu de toda a gente, não se apaga): admin.

**Quando a leitura falha**
- Lista, conversa, contexto e respostas rápidas mostram **"Não foi possível carregar…"** com **Tentar de novo**, nunca "Ainda sem conversas" ou "janela fechada".

**Chamadas de voz**
- Os clientes podem ligar para o WhatsApp da empresa e a chamada toca no dashboard (**Atender** / **Recusar**); na conversa há o botão **Ligar** para devolver chamadas. Ver a ajuda "WhatsApp — Chamadas de voz".
