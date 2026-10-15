---
modulo: criticas
titulo: Críticas Google
rotas: /criticas
palavras: limpeza, não é crítica, repetida, crítica repetida, duplicada, crítica duplicada, desfazer limpeza, resumo de críticas, lixo, marca, sem parque nem marca, mudar parque, escolher parque, quadrado por parque, críticas, criticas, reviews, avaliações, google, estrelas, responder, resposta, publicar, aprovar, rascunho, ia, já publiquei, desfazer, dispensar, reabrir, reclamação, converter, por responder, respondidas, parque, sem parque, csv, sincronizar gmail, windsor
---
# Críticas Google

As avaliações do Google de todos os parques, juntas e separadas por parque, com a resposta preparada aqui.

**De onde vêm**
- **Pela API do Google** (perfis ligados em Integrações): ficam no parque escolhido para o perfil e a resposta publica-se daqui.
- **Pela Windsor** (quando a conta Google não está ligada diretamente): os mesmos perfis e avaliações chegam pela Windsor e entram aqui da mesma maneira (1–3★ → Reclamação). Interruptor **Críticas: importar do Google Business pela Windsor** (Definições → Automações; vem desligado). A 1.ª vez traz até 3 anos; depois os últimos 60 dias.
- **Por email** (criticas@): o parque vem do título do perfil Google no email. Sem correspondência exata não se adivinha o parque (ver **Parque, marca ou lixo**).
- Entram **sozinhas** por estes caminhos: no topo já não há "Sincronizar Gmail" nem "Importar Review" (não faziam nada).
- Os **avisos de avaliação que chegam a outras caixas** (info@, reservas@…) e os elogios de clientes por email **não criam** críticas aqui (já entram pelos caminhos acima). Com o interruptor **"IA: críticas e ocorrências por email vão para a caixa delas e ficam lidas"** (desligado por omissão) vão para a caixa **Críticas** da Comunicação e ficam **lidos**. Uma opinião negativa de um cliente que quer resposta é tratada como **reclamação**.

**Parque, marca ou lixo** (já não há "Sem parque")
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
- A IA só prepara rascunhos; **publica sempre uma pessoa**. Guardar um texto é rascunho, não conta como respondida.
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

**Separadores**: **Dashboard** e **Reviews**. Os antigos **Condutores** e **Agentes** passaram para **Pessoas → Condutores e agentes**. A ligação à conta Google (Google Business Profile) passou para **Integrações**.

**Quando a leitura falha**
- Lista, números, parques e crítica mostram **"Não foi possível carregar…"** com **Tentar de novo**, nunca "sem avaliações" ou "sem dados".

**Emails que não são críticas e críticas repetidas** (interruptores em **Definições → Automações**, desligados por omissão)
- **Críticas: só cria crítica a partir de um aviso de avaliação**: um email que chega pelas Críticas (inclui o que a reservas@ apanha) só vira crítica se for o aviso da Google/Trustpilot/Tripadvisor ou trouxer as estrelas. Candidaturas, respostas de clientes e alertas seguem para a **triagem normal da Comunicação** (vão para a caixa do tema) — nunca ficam ignorados.
- **Críticas: juntar a mesma crítica que chega duas vezes**: lê também o assunto do email (nome e perfil), os emails-resumo ("recebeu 3 novas críticas") nunca viram crítica, e a mesma crítica (mesmo parque, mesmas estrelas, mesmo 1.º nome, o mesmo texto com 20 ou mais letras, até 48 h) fica **repetida** da primeira. Sem texto nunca se junta sozinha ("Excelente serviço" de duas pessoas fica como duas). Na Windsor, a que bate pelas estrelas e pelo texto fica **por conciliar** (uma pessoa escolhe).
- Nada se apaga: as marcadas saem da lista, dos números e dos rascunhos automáticos. Na crítica aparece **Não é crítica** ou **Repetida de #…**.

**Limpeza** (separador, admin e super admin) — para as que já existem; nunca corre sozinha
1. Escolhe **Emails que não são críticas** ou **Críticas repetidas**.
2. Vês **Vão ser marcadas** e **Batem na regra mas ficam** (com o porquê: tem reclamação, já respondida, ou desfeita à mão).
3. **Marcar…** aplica (pede confirmação). Nas "não é crítica", o rascunho da IA é guardado à parte.
4. Em **Marcadas**, **Desfazer** (uma) ou **Desfazer todas** volta a pô-las nas listas (o rascunho guardado também volta). A que desfazes não volta a ser proposta.

**Quem pode**
- Condutores e extras **não veem** as Críticas — nem as em que estão envolvidos. Só a partir de team leader.
- Responder, aprovar, dispensar, converter e importar: team leader e acima, nas suas cidades.
- **CSV** (leva emails dos clientes): só quem pode exportar.
