---
modulo: integracoes
titulo: Integrações → Google Ads e Meta Ads
rotas: /integracoes/google-ads
palavras: google ads, meta ads, facebook ads, ligar google ads, desligar google ads, religar, reautorização, revogar, contas publicitárias, selecionar contas, recolha, recolha inicial, 37 meses, últimos 35 dias, conversões atrasadas, chave de cifra, INTEGRATIONS_ENCRYPTION_KEY, invalid_client, invalid_grant, recolha parcial, recolha saltada, cliques, gclid, click_view, ler cliques agora, dias em falta, último dia lido, 0 reservas ligadas, campanhas sem reservas ligadas
---
# Integrações → Google Ads e Meta Ads

Aqui liga-se o Google Ads, escolhem-se as contas a recolher e vê-se o histórico das recolhas. Os números aparecem no **Marketing**. Nada aqui altera campanhas ou orçamentos.

**Quem faz o quê**
- **Ligar, voltar a autorizar e desligar o Google Ads**: só o **super admin**. O retorno da Google tem de chegar à mesma sessão que carregou em "Ligar" (senão a ligação é recusada).
- **Escolher contas, marca/cidade e a recolha inicial**: quem gere as Integrações.
- **Recolha diária / 35 dias / mensal à mão**: quem pode editar as Integrações.

**Contas**
- O interruptor diz se a conta é **recolhida**. Desligar uma conta pára as recolhas dela; o gasto **já recolhido continua a contar** no Marketing (foi dinheiro gasto).
- Mudar o interruptor ou a marca/cidade fica registado nos Logs (antes → depois). Mudar a marca/cidade de uma campanha (Marketing → Anúncios) também.

**Recolhas automáticas**
- **Diária** (a partir das 05:45): última semana.
- **Domingo** (a partir das 06:15): **últimos 35 dias** — a Google continua a acertar conversões semanas depois do clique; esta recolha apanha esses acertos.
- **Mensal** (dia 2): o mês anterior fechado.
- Cada recolha corre em partes curtas. Se não acabar dentro do tempo, fica **parcial** e continua na chamada seguinte (não fica a meio para sempre).
- Se outra recolha ainda estiver a correr, esta fica **para a próxima volta** — já não conta como feita.

**Recolha inicial (37 meses)**: pede de novo todo o histórico e substitui o que está guardado. Pede confirmação e só quem gere as Integrações a vê.

**Cliques (gclid → campanha)** (no cartão **Recolha**; Jorge, 8 out 2026 — as campanhas davam 0 reservas ligadas):
- Com o auto-tagging, o link da reserva só traz o **gclid**. O Google Ads sabe de que campanha é cada clique (relatório *click_view*); a app lê-o **de hora a hora** e guarda-o numa tabela de apoio, para ligar essas reservas à campanha no Marketing.
- Em cada volta: **hoje e ontem** de todas as contas recolhidas e, aos poucos, os **dias em falta** (até 10 por conta e por volta, do mais recente para trás). A Google só guarda **90 dias** de cliques — mais para trás não há.
- O cartão mostra o **último dia lido**, os **dias em falta** (dos últimos 89 até ontem, com o mais antigo), quantos cliques estão guardados e a última leitura. A primeira vez faltam todos; ficam em dia ao fim de umas horas.
- **Ler cliques agora**: faz já uma volta (quem pode editar as Integrações). Só lê do Google Ads; nada é alterado lá.
- Interruptor em **Definições → Automações → "Google Ads: ligar reservas à campanha pelo clique (gclid)"** — **ligado** por omissão. Desligado: deixa de ler cliques novos — as reservas com cliques já lidos continuam ligadas; as outras só pelo ID da campanha no link.
- Uma conta sem acesso aos cliques (erro 403) é saltada nessa volta e aparece o aviso; as outras seguem.

**Desligar**: revoga a autorização na Google e pára as recolhas; os dados já recolhidos ficam. Se a Google não responder, desliga na mesma e avisa para tirares o acesso em myaccount.google.com → Segurança.

**Estados**
- **Reautorização necessária**: a Google deixou de aceitar a autorização (ou o token guardado já não se consegue abrir porque a chave de cifra mudou). Carrega em "Voltar a autorizar".
- **Erro com invalid_client**: o GOOGLE_ADS_CLIENT_ID/SECRET no servidor está errado — religar não resolve; corrige as variáveis na Vercel.
- **Estado desconhecido**: a página não conseguiu ler o estado; aparece "Tentar de novo" (nunca fica verde por engano).
- **Chave de cifra**: ao definir a `INTEGRATIONS_ENCRYPTION_KEY` depois de já haver ligações, os tokens antigos continuam a abrir (chave antiga) e passam para a nova sozinhos.

**Conversões**: o "ROAS Google (reportado)" e as conversões da Google no Marketing são **só do Google Ads** (antes misturavam a Meta). "Conversões (Google + Meta)" junta as duas plataformas (cada uma também aparece à parte).

**Meta Ads**: configura-se com variáveis no servidor (META_ACCESS_TOKEN, META_AD_ACCOUNT_IDS). As contas aparecem depois da primeira recolha.
