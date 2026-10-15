---
modulo: criticas
grupo: Suporte
pagina: criticas
titulo: Críticas Google
separadores: dashboard=Dashboard, list=Reviews, cleanup=Limpeza
rotas: /criticas
palavras: 5 estrelas, cinco estrelas, resposta automática, responder sozinho, publicar sozinho, cancelar resposta automática, retomar, 6 horas, limpeza, não é crítica, repetida, crítica repetida, duplicada, crítica duplicada, desfazer limpeza, resumo de críticas, lixo, marca, sem parque nem marca, mudar parque, escolher parque, quadrado por parque, críticas, criticas, reviews, avaliações, google, estrelas, responder, resposta, publicar, aprovar, rascunho, ia, já publiquei, desfazer, dispensar, reabrir, reclamação, converter, por responder, respondidas, parque, sem parque, csv, sincronizar gmail, windsor
---
# Críticas Google

As avaliações do Google de todos os parques, juntas e separadas por parque, com a resposta preparada aqui.

**De onde vêm**
- **Pela API do Google** (perfis ligados em Integrações): ficam no parque escolhido para o perfil e a resposta publica-se daqui.
- **Pela Windsor** (quando a conta Google não está ligada diretamente): os mesmos perfis e avaliações chegam pela Windsor e entram aqui da mesma maneira (1–3★ → Reclamação). Interruptor **Críticas: importar do Google Business pela Windsor** (Definições → Automações; vem desligado). A 1.ª vez traz até 3 anos; depois os últimos 60 dias.
- **Por email** (criticas@): o parque vem do título do perfil Google no email. Sem correspondência exata não se adivinha o parque (ver **Parque, marca ou lixo**).
- Entram **sozinhas** por estes caminhos: no topo já não há "Sincronizar Gmail" nem "Importar Review" (não faziam nada).
- Os **avisos de avaliação que chegam a outras caixas** (info@, reservas@…) e os elogios de clientes por email **não criam** críticas aqui (já entram pelos caminhos acima). Com o interruptor **"IA: críticas e ocorrências por email vão para a caixa delas e ficam lidas"** (desligado por omissão) vão para a caixa **Críticas** da Comunicação e ficam **lidos**. Uma opinião negativa de um cliente que quer resposta é tratada como **reclamação**.

## Parque, marca ou lixo (já não há "Sem parque")
- Cada crítica fica no **parque** dela.
- Sem parque, procura-se a **marca** no nome do perfil Google e, se não estiver lá, no texto da crítica. Fica no grupo **"<Marca> (marca)"**.
- Sem parque nem marca vai para o **Lixo**: um separador à parte, no fim. Não conta nas "por responder" nem na média. Não se apaga e continua a poder ser aberta.
- Para corrigir, abre a crítica e escolhe o **Parque** certo (ou a marca). Fica registado quem mudou. Só para quem pode editar as Críticas, e só nas suas cidades.

**Dashboard**
- Um **quadrado por parque** com a média, as estrelas, o n.º de avaliações, as por responder e as reclamações. O lixo aparece só numa nota por baixo.

**Reviews**
- Um separador por parque. Abre no primeiro parque. **Todas** fica no fim e o **Lixo** à direita.
- As por responder têm uma barra **azul** à esquerda (já não amarela).

**Responder (respondida = publicada)**
- A IA só prepara rascunhos; **publica sempre uma pessoa** (a única exceção são as respostas automáticas às 5★, com o interruptor delas ligado — ver "Respostas automáticas às 5★"). Guardar um texto é rascunho, não conta como respondida.
- O rascunho **automático** só é feito para críticas **escritas nos últimos 14 dias** (conta a data da crítica, não a do dia em que entrou no dashboard). Na **1.ª importação** de um perfil (o histórico todo de uma vez) as críticas antigas nunca têm rascunho automático; as dos últimos 14 dias têm. Nas críticas que chegam por email conta a data do email. Para uma crítica antiga, abre-a e carrega em **Gerar com IA** (ou **Regenerar**).
- **Ligada ao Google**: **Aprovar e publicar** (pede confirmação; fica visível para todos). Sai pela Google quando a conta está ligada; senão pela Windsor, com o interruptor **Críticas: publicar respostas no Google pela Windsor** ligado (vem desligado). Sem nenhum dos dois, o aviso diz o que falta — publica no perfil Google e marca **Já publiquei no Google**.
- **Veio por email**: **Aprovar** (o texto está bom) → publica-o no perfil Google → **Já publiquei no Google**. Se marcaste por engano, **Desfazer** (o texto fica).
- Depois de marcada como publicada, o texto fica como foi enviado: para o mudar, primeiro **Desfazer**.
- Se o cliente mudar o texto ou as estrelas no Google, o rascunho volta a "por aprovar" (não é apagado; **Regenerar** faz outro).

**Reclamações**
- **Criar Reclamação** (até 3★): prazo de 24 h e responsável na Reclamação. Não volta atrás e nunca abre duas reclamações para a mesma crítica.
- Uma crítica convertida trata-se na Reclamação (**Ver Reclamação**); a resposta pública continua a ser aqui.

**Dispensar**
- **Dispensar** tira-a de "por responder" (pede confirmação); **Reabrir** devolve-a.

**Números**
- **Respondidas** = publicadas no Google. **Por responder** inclui os rascunhos por publicar. Convertidas, dispensadas e as do lixo não contam como por responder.
- A média e as percentagens de positivas/negativas contam só as críticas com estrelas.
- "tudo respondido" só aparece sem filtro de estado.

**Separadores**: **Dashboard**, **Reviews** e **Limpeza** (admin). Os antigos **Condutores** e **Agentes** passaram para **Pessoas → Condutores e agentes**. A ligação à conta Google (Google Business Profile) passou para **Integrações**.

**Quando a leitura falha**
- Lista, números, parques e crítica mostram **"Não foi possível carregar…"** com **Tentar de novo**, nunca "sem avaliações" ou "sem dados".

## Emails que não são críticas e críticas repetidas
- Dois interruptores em **Definições → Automações**, desligados por omissão.
- **Críticas: só cria crítica a partir de um aviso de avaliação**: um email que chega pelas Críticas (inclui o que a reservas@ apanha) só vira crítica se for o aviso da Google/Trustpilot/Tripadvisor ou trouxer as estrelas. Candidaturas, respostas de clientes e alertas seguem para a **triagem normal da Comunicação** (vão para a caixa do tema) — nunca ficam ignorados.
- **Críticas: juntar a mesma crítica que chega duas vezes**: lê também o assunto do email (nome e perfil); os emails-resumo da Google ("recebeu 3 novas críticas") nunca viram crítica. A mesma crítica (mesmo parque, mesmas estrelas, mesmo avaliador, o mesmo texto com 20 ou mais letras, até 48 h) fica **repetida** da primeira.
  - O texto é só o que está entre o nome/estrelas e o botão **Responder** do email; sem isso conta como sem texto.
  - Sem texto (só estrelas) nunca se junta sozinha.
  - Avaliador: com nome e apelido dos dois lados tem de ser o nome completo igual ("João Silva" ≠ "João Pereira"); com uma só palavra num dos lados chega o 1.º nome.
  - Um texto que aparece em críticas de pessoas diferentes ("Excelente serviço, recomendo") nunca junta.
  - Na Windsor, a que bate pelas estrelas e pelo texto fica **por conciliar** (uma pessoa escolhe; as marcadas não aparecem como candidatas).
- Nada se apaga: as marcadas saem da lista, dos números e dos rascunhos automáticos. Na crítica aparece **Não é crítica** ou **Repetida de #…**. A conversa do email repetido liga-se à crítica original.
- Antes de ligar o "juntar": conferir com amostras reais dos dois emails da Google (por fazer).

## Respostas automáticas às 5★
- Interruptor **Críticas 5★: publicar a resposta sozinho (6 h depois)** em Definições → Automações: {{regra:reviews.autoPublishFlag}} por omissão, e só o super admin o liga. Desligado, nada muda: a IA só prepara e publica sempre uma pessoa.
- Ligado, só entram as críticas que cumprem **tudo**:
  - **5★** e **ligadas ao Google** (vieram pela API ou pela Windsor; as de email nunca);
  - escritas nos últimos {{regra:reviews.autoDraftMaxAgeDays}} dias (as antigas respondem-se à mão);
  - **sem reclamação**, **sem resposta**, não dispensadas, não marcadas como "não é crítica" nem "repetida";
  - o texto **sem links, emails, telefones, insultos** nem nada que pareça uma instrução (ex.: "ignora as instruções…").
- Só se preparam respostas com um **canal para publicar** (Google ligada ou Windsor com o interruptor da resposta) e com a **IA dos rascunhos automáticos** ligada; se faltar um deles, o topo das Críticas diz o que falta.
- A IA barata escreve a resposta (o texto da crítica é tratado como dado, nunca como ordem) e a resposta tem de passar: entre {{regra:reviews.replyMinChars}} e {{regra:reviews.replyMaxChars}} caracteres, sem números, links, emails, telefones, matrículas nem marcadores `[…]`, e na **língua da crítica**. Se não passar, não sai (fica o motivo).
- A resposta fica **{{regra:reviews.autoPublishDelayHours}} h à vista** na crítica, no cartão **Resposta automática (5★)**, com **Cancelar** (team leader e acima, nas suas cidades). Cancelar não apaga nada: a crítica fica por responder e pode responder-se à mão.
- **Antes de publicar**, a crítica é lida outra vez **no Google** (ou na Windsor): só sai se continuar com **5★**, com o **mesmo texto** e **sem resposta** (por exemplo, dada diretamente no perfil). Se o texto da crítica mudar (cá) depois de a resposta ter sido preparada, também não sai. Se não der para ler, não sai e tenta mais tarde ({{regra:reviews.autoPublishMaxAttempts}} vezes ao todo). Só grava se a crítica continuar sem resposta cá (nunca por cima de uma resposta de uma pessoa). Fica publicada com o **utilizador do sistema** — o 1.º super admin da lista de utilizadores — e no registo de atividade ("review_auto_publish"). Antes de enviar fica marcado que vai sair. Uma resposta que fique presa em "a publicar" (a volta foi cortada) é relida no Google 15 min depois: sem resposta, volta à espera; com a resposta que enviámos, fica publicada; com outra, não sai. Se uma pessoa responder cá no mesmo instante em que a automática sai, cá fica a da pessoa (nunca se grava por cima) e o super admin é avisado para ver qual ficou no Google.
- **Limites**: no máximo {{regra:reviews.autoPublishMaxPerProfileDay}} por perfil Google em 24 h. Ao fim de {{regra:reviews.autoPublishMaxFailures}} falhas seguidas **pára sozinho** e avisa (sino e email ao supervisor e ao back office); no topo das Críticas aparece o aviso e o admin carrega em **Retomar**. Uma resposta à espera há mais de {{regra:reviews.autoPublishExpireHours}} h depois da hora (interruptor desligado ou agendador parado) já não sai.
- **Desligar o interruptor** pára as que estão à espera; as já publicadas **não se despublicam**.
- **Depois de publicar**: uma vez por dia, durante {{regra:reviews.autoPublishVerifyDays}} dias, vê-se a classificação de cá (a sincronização atualiza-a) e, se continuar 5★, a crítica é lida outra vez no Google (na Windsor, do dia antes da crítica até hoje, para apanhar as editadas). Se descer das 5★, sai um aviso para ver se é preciso responder de novo ou abrir uma reclamação; se não der para a ler {{regra:reviews.verifyFailDays}} dias seguidos, também.
- Publica pela Google ligada diretamente ou, sem ela, pela Windsor com o interruptor **Críticas: publicar respostas no Google pela Windsor** ligado (vem desligado). Sem nenhum dos dois, as respostas ficam à espera e não saem.

## Limpeza
- Separador para admin e super admin, para as que já existem; nunca corre sozinha. Só vê as críticas das suas cidades.
1. Escolhe **Emails que não são críticas** ou **Críticas repetidas**.
2. Vês **Vão ser marcadas** e **Batem na regra mas ficam** (com o porquê: tem reclamação, já respondida, remetente desconhecido ou desfeita à mão).
3. **Marcar…** aplica (pede confirmação). Nas "não é crítica", o rascunho da IA é guardado à parte.
4. Em **Marcadas**, **Desfazer** (uma) ou **Desfazer todas** volta a pô-las nas listas (o rascunho e a aprovação guardados também voltam). A que desfazes não volta a ser proposta. Quem desfez fica no registo de atividade.

**Quem pode**
- Condutores e extras **não veem** as Críticas — nem as em que estão envolvidos. Só a partir de team leader.
- Responder, aprovar, dispensar, converter e importar: team leader e acima, nas suas cidades.
- **CSV** (leva emails dos clientes): só quem pode exportar.
