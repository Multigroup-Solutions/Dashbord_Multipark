---
modulo: marketing
titulo: Google Business Profile (perfis Google: desempenho, horários, publicações)
rotas: /marketing/web
palavras: google business, google business profile, business profile, gbp, google my business, perfil google, perfis google, maps, google maps, impressões, chamadas, direções, pedidos de direções, cliques no site, pesquisas, horário, horários especiais, feriados, publicações, novidades, ofertas, eventos, quota 0, pedir acesso, api do business profile, testar, performance api
---
# Google Business Profile (perfis Google: desempenho, horários, publicações)

Em **Marketing → Web & SEO → Google Business** vês o desempenho dos perfis Google de cada parque (Lisboa, Porto, Faro; Multipark, Redpark, Skypark, Airpark, Multibags, Multidriver) e, se geres o Marketing (super admin), mudas horários e publicas novidades. As críticas continuam em **Críticas** (ler, responder e publicar a resposta no Google).

**O que há no separador**
- **KPIs** do período com a variação face ao período anterior ou ao ano passado: impressões (Pesquisa + Maps), chamadas, pedidos de direções, cliques no site (e conversas/marcações, se houver), média das críticas, críticas novas, taxa de resposta e tempo de resposta (mediana).
- **Gráficos** por dia: impressões (Pesquisa vs Maps) e chamadas/direções/site. Os últimos 2–3 dias ainda acertam (a Google atualiza com atraso).
- **Perfis**: uma linha por perfil com os números, as críticas (média, n.º, taxa de resposta, sem resposta) e o **estado** — verificado, sem controlo (suspenso/por verificar), fechado, **alterado pela Google** ou com **edições pendentes**.
- **Críticas por semana** (volume e média) e **pesquisas** que mostraram os perfis (por mês completo; a Google esconde as pequenas: "< 15").
- Filtros por **cidade** e **perfil**. Em **Negócio** há o cartão "chamadas e direções vs reservas por cidade" (indicador, não atribuição).

**Horários** (ícone do calendário na linha do perfil)
1. O horário é lido na hora do Google.
2. Liga "Alterar o horário normal" para mudar os dias (Aberto com intervalos, 24 horas ou Fechado). Um intervalo como 22:00–02:00 fecha depois da meia-noite.
3. **Horários especiais** (feriados, fechos): adiciona o dia, marca Fechado ou indica as horas. Só esses dias mudam — os outros horários especiais de cada perfil ficam.
4. Em "Aplicar a" escolhe vários perfis (Todos, Lisboa, Porto, Faro ou um a um) para aplicar de uma vez.
5. **Aplicar no Google…** pede confirmação. O resultado vem por perfil (✓/✗ com o motivo). Fica no registo de atividade.

**Publicações** (ícone do megafone)
- Vês as publicações do perfil e podes apagá-las (com confirmação).
- Nova publicação: **Novidade**, **Oferta** ou **Evento**, texto (até 1500 caracteres), botão opcional (**Reservar**, **Encomendar**, **Saber mais** com endereço https; **Ligar** usa o telefone do perfil), imagem opcional (endereço https de uma imagem). Ofertas e eventos precisam de título e datas.
- **Rascunho IA**: escreve o tema e a IA (lite) propõe o texto — fica no editor, nada é publicado sem carregares em Publicar. Respeita o interruptor "IA: rascunho de publicações Google Business" e o orçamento.
- Podes publicar em vários perfis de uma vez. A Google revê cada publicação antes de a mostrar.
- Perguntas & Respostas não existem aqui: a Google descontinuou essa API.

**Alertas** (1×/dia depois da recolha; limiares em **Configurar**)
- "Críticas Google: alertas" (vai a quem gere as Críticas da cidade do perfil): média de estrelas dos últimos 7 dias 0,5★ abaixo da dos 90 dias anteriores (com pelo menos 3 críticas) e críticas sem resposta há mais de 48 h.
- "Alertas Google Business" (Marketing): impressões ou chamadas da semana 30% abaixo da anterior (com base mínima), perfil sem controlo/suspenso, fechado, alterado pela Google ou com edições pendentes.

**Configurar** (super admin): cidade e marca de cada perfil (por omissão vêm do parque associado nas Críticas, da morada ou do título — "Automático"), desligar perfis que não interessam, recolha diária, pesquisas mensais, histórico da 1.ª recolha (180 dias) e limiares dos alertas.

## Ligar e pôr a funcionar (dono / super admin)

A recolha usa a mesma ligação das Críticas (OAuth com a permissão `business.manage`). Para tudo funcionar são precisos **quatro passos no Google** — e o mais importante é o 1.

**1. Pedir acesso à API do Business Profile (obrigatório — sem isto a quota é 0)**
A Google começa todos os projetos com **0 pedidos por minuto** nas APIs do Business Profile. Enquanto não aprovar, cada pedido falha com "quota" (429) e o Google Cloud mostra **100% de erros** na "My Business Account Management API" — é exatamente o sintoma de quando o "Testar" falha.
1. Descobre o **n.º do projeto** Google Cloud das credenciais OAuth: o "Testar" mostra-o ("projeto n.º …"); também é o número antes do hífen do ID do cliente OAuth (`123456789012-….apps.googleusercontent.com`). Atenção: se o `GOOGLE_BUSINESS_CLIENT_ID` não estiver definido, a app usa o cliente do **Google Ads** — o pedido tem de ser para **esse** projeto.
2. Abre o formulário **https://support.google.com/business/contact/api_default** e escolhe **"Application for Basic API Access"**.
3. Indica o n.º do projeto, o email da conta que gere os perfis (Proprietária/Gestora em business.google.com), o site (multipark.pt) e a utilização: "gestão interna dos perfis dos nossos parques (críticas, horários, publicações e estatísticas)".
4. A Google responde por email (normalmente em poucos dias). Depois da aprovação a quota passa a **300 pedidos por minuto** (vê em Google Cloud → APIs e serviços → "My Business Account Management API" → Quotas: deixa de estar a 0).

**2. Ativar as APIs no mesmo projeto** (Google Cloud → APIs e serviços → Biblioteca)
- **My Business Account Management API** — lista as contas.
- **My Business Business Information API** — lista os perfis, horários e estado.
- **Business Profile Performance API** — impressões, chamadas, direções, cliques e pesquisas.
- **Google My Business API** (v4) — críticas, resposta às críticas e publicações. Esta só aparece na Biblioteca **depois** da aprovação do passo 1.

**3. Ligar a conta Google certa**
Em **Críticas → Ligar Google Business Profile** entra com a conta que é **Proprietária ou Gestora** dos perfis dos parques (a mesma que vês em business.google.com → "Perfis"). Se os perfis estão num **grupo de empresas**, a conta tem de ter acesso ao grupo. Aceita todas as permissões.

**4. Testar**
Em **Integrações → Google Business Profile → Testar** (ou "Testar APIs" no separador Google Business) cada API é testada por ordem e aparece ✓/✗ com a causa:
- "quota 0 …" → falta o passo 1 (ou ainda não foi aprovado).
- "… não está ativa no projeto …" → falta ativar essa API (passo 2; o link leva direto à página certa).
- "não inclui business.manage" / "autorização inválida" / "invalid_grant" → volta a ligar (passo 3).
- "não gere nenhum perfil" / "nenhum perfil nas contas" → ligaste uma conta Google errada (passo 3).
- "acesso recusado … Proprietária ou Gestora" → a conta ligada não tem permissão nesse perfil.

Depois do Testar ficar todo com ✓, carrega em **Atualizar agora** (ou espera pelo cron de 10 em 10 minutos): a 1.ª recolha traz ~6 meses de desempenho; depois relê só os últimos 5 dias, 1×/dia.

**Variáveis no Vercel** (já existentes): `GOOGLE_BUSINESS_CLIENT_ID` e `GOOGLE_BUSINESS_CLIENT_SECRET` (se faltarem usa-se o cliente do Google Ads), `INTEGRATIONS_ENCRYPTION_KEY` (cifra do token). Nada de novo é preciso para o Google Business.
