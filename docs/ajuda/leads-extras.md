---
modulo: leads_extras
titulo: Leads de Extras (leads, candidaturas do site e recrutamento)
rotas: /extras-leads
palavras: lixo, por tratar, prontas, pronta, repor, desfazer, não é candidatura, mailer-daemon, delivery status, cartões, lista, ver em cartões, ver em lista, foto, leads, lead, leads de extras, candidaturas, candidatura, candidaturas do site, be a driver, aprovar candidatura, rejeitar candidatura, recrutamento, recursos-humanos@, emails de recrutamento, seja motorista, convidar, funil, arquivar lead, arquivados, repor lead, reativar ficha, lembrete automático, stop
---
# Leads de Extras

**Cartões ou Lista** (botão no topo da lista de leads e das candidaturas): vês as pessoas em **cartões com foto** ou numa **lista** compacta — no telemóvel e no PC. A escolha fica guardada neste aparelho, para esta página.

Tudo o que é recrutar extras está junto, no menu **Leads de Extras**, em três separadores:

**Leads**
- Contactos que ainda não são extras (do site, de email ou criados à mão). Convida-os por WhatsApp com o template "Seja motorista" e acompanha quem responde.
- Seleciona vários na tabela para mudar o estado ou a cidade de uma vez, ou para enviar o WhatsApp em lote.
- **Anexos do email lidos pela IA** (com o interruptor **"IA: anexos dos emails do RH (CV)"** ligado em Definições → Automações; desligado por omissão): os anexos dos emails de candidatura (CV em PDF, imagem ou Word .docx, documentos) são lidos uma vez. No candidato ficam **só os campos vazios**: NIF, n.º do BI/CC, n.º da carta, a cidade **só quando é certa**, telefone/email (outros contactos vão para as notas). Abre o candidato (**Editar**) para ver **"Lido pela IA"**: o **resumo do CV** para quem entrevista e cada anexo (lido, não lido e porquê, ou falhou).
- **NIF e números dos documentos só o RH vê** (front office, back office, administrador). Ao converter em extra passam para a ficha, só se lá estiverem vazios.
- Enviar a dois leads ou mais pede primeiro **"Confirmar envio a N"**. Quem recebeu o mesmo template nas últimas 24 h (à mão ou no lembrete automático) fica de fora, com "já recebeu (24 h)".
- O **Funil** mostra os leads das últimas 12 semanas, por origem e por cidade.
- A faixa **Atenção** mostra os novos sem contacto há mais de 24 h e os contactados sem resposta há mais de 3 dias. Há também um resumo diário no sino, por cidade.
- Com **Lembretes das leads de extras** ligado (Definições → Automações), os contactados sem resposta recebem 1 lembrete automático. Com **Resposta automática às leads** ligado (vem desligado), quem responde recebe o link da candidatura.
- Quem responde **STOP** (ou "parar") deixa de receber mensagens.
- **Converter** um lead cria (ou liga) a ficha de extra na cidade que escolheres:
  - se a pessoa já tem ficha ativa, o lead liga-se a ela;
  - se já teve ficha **desativada**, aparece o motivo da saída e só se reativa se confirmares;
  - quem saiu por **roubo** ou **despedimento** não se reativa a partir de um lead (fala com o RH);
  - uma ficha que foi **junta a outra** passa para a ficha que ficou;
  - uma ficha de outra cidade não se mexe daqui.
- **Arquivar** (o ícone da caixa) tira o lead da lista, do funil, dos envios e dos lembretes. Nada se apaga: no botão **Arquivados** vês os arquivados e podes **Repor**. Se a pessoa voltar a candidatar-se, o lead sai sozinho do arquivo.
- A lista mostra os 500 leads mais recentes; quando chega a isso aparece um aviso.

**Candidaturas do site** (formulário "Be a Driver")
- O número ao lado do separador é o das candidaturas novas.
- **Aprovar** pede a cidade (centro de custo) e cria ou liga a ficha de extra. Se a pessoa já teve ficha desativada, aparece o motivo e só se reativa com confirmação (a mesma regra do Converter). Duas pessoas a aprovar a mesma candidatura ao mesmo tempo já não criam duas fichas.
- **Rejeitar** fecha a candidatura e põe o lead da mesma pessoa em "Sem interesse". E ao contrário: marcar um lead como **Sem interesse** (um a um ou em lote) rejeita a candidatura do site da mesma pessoa, menos se já estiver aprovada.
- Uma candidatura aprovada já não muda de estado. Para tirar a pessoa, desativa a ficha no RH.
- A cidade escrita na candidatura também se reconhece pela terra (ex.: "Corroios" é Lisboa, "Gaia" é Porto, "Albufeira" é Faro). Só vês e mexes nas candidaturas das tuas cidades.
- **Pronta** tira a candidatura das Novas sem a aprovar nem rejeitar (quando já a viste ou já falaste com a pessoa). **Repor** devolve-a às Novas.
- Cada mudança (Pronta, Rejeitar, Repor) mostra **Desfazer** durante uns segundos. Depois disso usa **Repor**.
- O filtro em cima mostra Novas, Prontas (vistas), Aprovadas, Rejeitadas ou Todas.

**Recrutamento (email)**
- Os emails que chegam à **recursos-humanos@**: abre, lê os anexos, escreve notas (ficam registadas) e responde. A resposta sai sempre da recursos-humanos@.
- Três separadores: **Por tratar**, **Prontas** e **Lixo**, cada um com o número.
  - **Pronta** tira o email de Por tratar. **Responder** também o marca como pronto sozinho.
  - **Lixo** é para o que não é candidatura.
  - **Repor** devolve o email a Por tratar.
  - Cada ação mostra **Desfazer** durante uns segundos. Nada se apaga e fica registado quem mudou e quando.
- O que claramente **não é candidatura** vai sozinho para o Lixo, com a etiqueta "não é candidatura":
  - avisos de entrega (*Delivery Status Notification*, *mailer-daemon*);
  - respostas automáticas e remetentes "no-reply";
  - respostas ao pedido de disponibilidade;
  - newsletters, faturas e alertas de segurança.
- Um email cujo assunto fala de candidatura, CV, vaga, motorista ou condutor nunca vai para o lixo sozinho. Na dúvida, fica em Por tratar.
- O **link de registo** (cria a conta do candidato) só aparece a quem gere utilizadores.
- **Sincronizar emails** vai buscar os novos já (só aparece a quem tem a permissão de sincronização). As candidaturas e os emails também entram nos Leads sozinhos, de hora a hora.

Se uma lista não carregar aparece um aviso a vermelho com **Tentar de novo** (não quer dizer que esteja vazia).

Antes as candidaturas estavam na **Disponibilidade** e o recrutamento no separador do **RH**; agora estão só aqui. Um link antigo para `/extras-leads?tab=candidaturas` ou `?tab=recrutamento` abre o separador certo.
