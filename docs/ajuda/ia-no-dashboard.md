---
modulo: ia
grupo: Sistema
pagina: definicoes.ia
titulo: Onde é que a IA trabalha no dashboard
rotas: /definicoes
palavras: teto do piloto, gasto do piloto, orçamento do piloto, uso da ia por dia, leituras repetidas, custo da ia, gasto da ia, só ue bloqueada, raciocínio da ia, resumir agora, resumo desatualizado, vertex ai, vertex ai na ue, gemini na ue, rgpd, ia na ue, só corre com a ia em vertex, quem pede o resumo ia, condutor não vê a explicação, onde corre a ia, onde está a ia, o que faz a ia, ia automática, ia sozinha, resumo da ia, resumos da ia, resumo ia, rascunho ia, rascunho com ia, gerar com ia, interruptores da ia, desligar a ia, ligar a ia, dados pessoais na ia, quem vê o resumo, inteligência artificial
---
# Onde é que a IA trabalha no dashboard

A IA **escreve textos e sugere**. Os números (reservas, extras, avaliação, pontuações) vêm sempre do sistema. Cada funcionalidade tem um interruptor em **Definições → Automações → Inteligência artificial** (só administradores).

**Só quando carregas no botão**
- **Despesas:** "Extrair com IA" lê a fatura e preenche o formulário. Quem grava és tu.
- **Passagem de turno → Despesas do turno:** ao tirar a foto do talão, a mesma IA das Despesas lê-o e preenche o cartão. Quem lança és tu.
- **Críticas:** "Gerar com IA" faz um rascunho. Publicar exige "Aprovar e publicar".
- **WhatsApp:** "Resumo da conversa (IA)" e "Sugerir resposta". A sugestão vai para a caixa de texto e nunca é enviada sozinha.
- **Comunicação (email):** "Rascunho IA" fica no editor.
- **Tarefas:** "Criar tarefas a partir de texto" (team leader para cima). Só cria depois de confirmares.
- **Leads de Extras:** "Resumo IA" e "Rascunho com IA", só para quem edita as leads. Enviar exige "Aprovar".
- **Passagem de turno:** "Resumir agora" refaz o resumo da passagem gravada.
- **Formação:** "Gerar perguntas (IA)" cria rascunhos por publicar. O **Tutor** responde no manual, no vídeo e no quiz.
  - **Quiz:** ao carregares em **Jogar**, a IA faz 10 perguntas novas a partir da base de conhecimento (sem IA, perguntas fixas). A resposta certa fica no servidor.
  - **Procurar formação:** a IA escolhe a formação certa no catálogo (sem IA, pesquisa por palavras).
  - **FAQs → Gerar agora** (quem gere a formação): 2 ou 3 documentos da base de conhecimento dão até 3 FAQs novas, publicadas e marcadas "IA".
- **Rádio:** "Transcrever".
- **Multis:** o chat em todas as páginas.

**Sozinha (automática)**
1. **Passagem de turno:** resumo para o turno seguinte **quando entregas** a passagem (a 1.ª vez que a guardas); à segunda-feira, o resumo da semana.
   - Se a alterares depois, a IA não volta a correr sozinha: aparece **resumo desatualizado** e carregas em **Resumir agora**.
2. **Briefing do dia** (Dashboard e Tarefas): um parágrafo por cidade a partir das 07:30, também por email às chefias.
3. **Alertas** em Operações, Despesas e Marketing: uma linha a explicar cada anomalia (feita uma vez por dia; se a IA falhar, tenta no máximo mais 2 vezes, com pelo menos 12 h de intervalo, em grupos mais pequenos e num trabalho à parte, a partir das 09:00 (depois dos briefings e relatórios), e depois o alerta fica só com a frase dos números). Condutores e extras veem o alerta, mas não a linha da IA. Nas Reservas ficam ao lado do Dashboard (no telemóvel, por cima). Carrega no título para os encolher. O **✕** tira um alerta da lista para toda a gente; nada se apaga, e em **Tirados** dá para o **Repor**.
4. **Avaliação:** a explicação aparece ao abrir. Só se refaz quando os números mudam.
5. **Críticas:** rascunho automático para as críticas novas (escritas nos últimos 14 dias; numa 1.ª importação de um perfil, só as desses 14 dias), que fica por aprovar.
6. **Reclamações:** sugestões de tipo, prioridade, SLA e reserva, com um rascunho de resposta.
   - Com confiança alta, preenche sozinha os campos vazios. Há sempre **Desfazer**.
7. **WhatsApp:** etiqueta a intenção e a urgência; uma conversa **nova** vai para a caixa do tema (a que já tem caixa fica onde está).
   - **Email:** a IA lê os emails das caixas partilhadas pelo sentido (não por palavras): as conversas novas vão para a caixa do tema, por ler; o que não percebe vai para o info. As **reclamações** (e, com o interruptor, os **perdidos**) que lá estejam — mesmo escondidas noutro pedido, numa resposta ou num reencaminhamento — abrem o caso no módulo (certeza média: "Por confirmar (IA)") e a conversa vai para a caixa do caso. Na conversa lê-se "Movido pela IA → caixa (motivo)". Para medir: Definições → Comunicação → **Testar a triagem** (super admin).
   - Alguém a candidatar-se pela 1.ª vez (email ou WhatsApp) entra nos **Leads de Extras** como lead (e candidatura, se houver email), com a nota "Entrou pela IA".
8. **Perdidos & Achados:** procura possíveis correspondências.
9. **Disponibilidade dos extras:** quando a resposta não é clara, a IA interpreta-a.
   - Com confiança alta, marca a disponibilidade e responde por WhatsApp.
   - Abaixo disso, cria uma tarefa para uma pessoa.
10. **Relatórios de segunda-feira:** por email (direção, marketing, operações e RH).
   - O de **operações** usa as contas dos dashboards, para o país todo. A semana é a de **segunda a domingo** (dias de 00h–24h de Lisboa) antes do envio, ao lado da anterior. As **entradas e saídas** são de **todos os parques** (nossos e todo o Marketplace, com as compras por pagar, sem as canceladas): batem com Operações → Recolhas e Entregas com esses 7 dias escolhidos.
   - As **reclamações** não contam as arquivadas nem as convertidas, e "fora do prazo" segue a regra do cartão Reclamações, à meia-noite de domingo para segunda (com o estado que cada reclamação tem quando o relatório é feito). As **ocorrências** são o total da página Ocorrências para esses 7 dias (sem os parques que a operação não faz).
   - Se a BD da Multipark não responder, o número vem **"—"** com uma nota que diz qual das semanas ficou por contar (nunca 0).
11. **Base de conhecimento:** sincroniza sozinha quando há alterações nas pastas do Drive.
12. **FAQs da formação** (se ligares o interruptor semanal): à segunda-feira, até 3 FAQs novas a partir da base de conhecimento, publicadas e marcadas "IA". Arquivar uma é dizer "esta não": não volta.

## Começam desligadas (só um administrador as liga)
- ler os documentos do RH para preencher a ficha (o IBAN fica sempre como pedido ao RH, exceto para quem o pode mudar na hora);
- ler os CV dos emails do RH;
  - estas duas mandam o ficheiro inteiro, por isso **só correm com a IA em Vertex AI na UE**. Sem isso não correm, mesmo ligadas. Em **Definições → Automações**, ao lado do interruptor, aparece "Só corre com a IA em Vertex AI na UE (hoje: …)". O sítio onde a IA está vê-se também no cartão **IA — custo do mês** ("Gemini (Vertex AI)" ou "Gemini");
- juntar fichas de clientes;
- as FAQs semanais da formação (o botão **Gerar agora** funciona na mesma).

**Dados pessoais**
- Nos textos, os emails, os telefones, o NIF, o IBAN e as matrículas são tapados antes de irem para a IA.
- Os ficheiros vão inteiros: faturas, áudio do rádio, documentos e CV do RH, e PDFs dos manuais. Os documentos e CV do RH só com a IA em Vertex AI na UE.

**Nunca, sem uma pessoa:** emails ou respostas a clientes e publicações no Google.

**Quanto a IA usa (administradores)**
- Em **Definições → Estado**, o cartão **IA — custo do mês** mostra o gasto por funcionalidade.
- Logo abaixo, **IA — uso por dia**: carrega em **Ver o uso por dia** e escolhe os dias (7 a 62) e, se quiseres, uma funcionalidade. Por dia vês as chamadas, os erros, as **bloqueadas** (orçamento ou "só UE" dos documentos do RH), os tokens, o custo e a hora da primeira e da última chamada (UTC).
- Por baixo, **Leituras repetidas**: a mesma coisa (por exemplo, a mesma crítica) lida pela IA mais de uma vez, as 100 com mais vezes. As conversas do Multis não contam.
- Na tabela do uso por dia vês também as respostas em que a IA **não conseguiu juntar tudo** (texto de recurso, contam como erro), as que tiveram de **acabar sem ferramentas** e as **cortadas por tamanho** (MAX_TOKENS).
- Só leitura: nada muda ao abrir. O raciocínio de cada funcionalidade muda-se em **Definições → Parâmetros → Raciocínio da IA por funcionalidade** (o "minimal" não vale no modelo smart).
- **"minimal" só com avaliação**: vem vazio (como sempre). O valor sugerido é `{"mail_routing": "minimal", "whatsapp_triage": "minimal", "complaint_triage": "minimal"}`, mas cada linha só se põe depois de a avaliação dessa funcionalidade passar com o "minimal" (email: `scripts/eval-mail-triage.ts --thinking minimal`; WhatsApp: `scripts/eval-whatsapp-triage.ts --compare`; reclamações: `scripts/eval-complaint-triage.ts --compare`). Desfazer = tirar a linha.

**Multis do piloto e o orçamento**
- O **Multis do piloto** (modelo smart) tem **teto próprio** em **Definições → Parâmetros → IA → Multis do piloto: teto de gasto** (omissão: 10 € por dia, 150 € por mês, 3 € por pessoa por dia; o dia é o de Lisboa; os três têm de ser maiores que 0). Ao chegar lá, a pessoa fica com o Multis de sempre, com a nota **Modo económico**.
- Esse gasto **não conta** para o **Orçamento mensal da IA** que pára as outras funcionalidades: o cartão **IA — custo do mês** mostra-o na lista (com "teto próprio"), mas a barra e o "Orçamento atingido" só contam o resto.
- A cache de contexto também custa (por hora guardada): aparece no registo da funcionalidade que a criou e, no cartão, à parte ("armazenamento da cache").
