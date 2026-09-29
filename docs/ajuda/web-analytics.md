---
modulo: marketing
titulo: Web & SEO (Google Analytics 4, Search Console, PageSpeed)
rotas: /marketing/web
palavras: web, seo, crux, chrome ux report, dados reais, visitantes reais, o que corrigir primeiro, oportunidades, lighthouse, google analytics, analytics, ga4, search console, pesquisa google, orgânico, cliques, impressões, posição, pesquisas, sessões, utilizadores, páginas de entrada, canais, pagespeed, velocidade, lcp, cls, inp, conta de serviço, service account, leitor, propriedade, conversão web
---
# Web & SEO (Google Analytics 4, Search Console, PageSpeed)

Em **Marketing → Web & SEO** vês o tráfego dos sites (Google Analytics 4), a pesquisa orgânica do Google (Search Console) e a velocidade das páginas principais (PageSpeed), ao lado das reservas. Só super admin (quem vê o Marketing). São só totais por dia — nenhum dado de pessoas.

**O que há no separador**
- **KPIs** do período escolhido com a variação face ao **período anterior** ou ao **mesmo período do ano passado** (seta e percentagem; na posição média, descer é bom).
- **Tráfego**: sessões por dia (com a linha da comparação), canais, dispositivos, funil de reserva (eventos GA4), páginas de entrada e países/cidades.
- **Pesquisa Google**: cliques e posição por dia, pesquisas (com a variação de posição) e **páginas a perder cliques**. A Search Console chega com 2–3 dias de atraso.
- **Velocidade**: última medição PageSpeed de cada página (móvel e computador, dados de **laboratório**), com verde (bom), âmbar (a melhorar) e vermelho (fraco), e o histórico da pontuação. Por baixo:
  - **O que corrigir primeiro**: as oportunidades do Lighthouse da última medição da página escolhida, ordenadas pelo tempo que poupam (e KB); botão **Explicar** (IA lite, PT-PT, só com os títulos e poupanças — interruptor "IA: explicar o que corrigir na PageSpeed").
  - **Visitantes reais (Chrome UX Report)**: p75 dos últimos 28 dias de LCP, INP, CLS, FCP e TTFB de quem visitou com o Chrome, por site (origem) e por página, telemóvel e computador, com a barra bom/a melhorar/fraco e a evolução semanal. Sites/páginas com poucas visitas não têm dados reais (é normal).
- **Google Business**: desempenho dos perfis Google, horários e publicações (ver a ajuda "Google Business Profile").
- **Negócio**: reservas feitas no site ÷ sessões (conversão web → reserva), receita por sessão e gasto em anúncios por sessão. É um indicador, não atribuição.
- **O que mudou esta semana**: resumo curto (IA lite, se estiver ligada; senão texto automático) gerado à segunda-feira.
- Filtro por **marca** no topo; tabelas grandes com páginas (Anterior/Seguinte) e pesquisa.

**Alertas** (sino e email, notificação "Alertas Web & SEO", 1×/dia): sessões de ontem 30% abaixo da média dos 7 dias anteriores, cliques do Google da semana 30% abaixo da anterior, pesquisas do top 20 a perder mais de 3 posições, PageSpeed móvel abaixo de 50 e **dados reais** (CrUX) de uma página-chave acima de LCP 2,5 s, INP 200 ms ou CLS 0,1 (se a página não tiver dados próprios, conta o site todo). Os limiares mudam-se nas Definições.

## Configurar (super admin)

**1. Google Cloud** (projeto da conta de serviço que a app já usa — a do Gmail/Drive)
1. Abre console.cloud.google.com → **APIs e serviços → Biblioteca**.
2. Ativa **Google Analytics Data API**, **Google Search Console API**, **PageSpeed Insights API** e **Chrome UX Report API**.
3. Em **Credenciais → Criar credenciais → Chave de API**, restringe-a à **PageSpeed Insights API** e à **Chrome UX Report API** e põe-a no Vercel como `GOOGLE_PAGESPEED_API_KEY`. Sem chave a PageSpeed funciona com quota baixa, mas os **dados reais (CrUX) precisam da chave** (em alternativa, uma chave só para a CrUX em `GOOGLE_CRUX_API_KEY`).

**2. Copiar o email da conta de serviço**
Em **Definições → Integrações → Web & SEO** aparece o email da conta de serviço (termina em `.iam.gserviceaccount.com`) com um botão para copiar.

**3. Dar acesso no Google Analytics 4** (em cada propriedade)
1. Abre analytics.google.com e escolhe a propriedade.
2. **Administração** (roda dentada) → **Propriedade** → **Gestão de acesso à propriedade**.
3. Carrega em **+** → **Adicionar utilizadores**.
4. Cola o email da conta de serviço, escolhe a função **Leitor**, tira o visto de "Notificar por email" e carrega em **Adicionar**.
5. Copia o **ID da propriedade** (Administração → Detalhes da propriedade; só números, ex.: 123456789).

**4. Dar acesso na Search Console** (em cada propriedade)
1. Abre search.google.com/search-console e escolhe a propriedade.
2. **Definições** → **Utilizadores e autorizações** → **Adicionar utilizador**.
3. Cola o email da conta de serviço, autorização **Restrito** (chega) e **Adicionar**. Tens de ser **proprietário** da propriedade para adicionar utilizadores.
4. Anota o nome da propriedade tal como aparece: `sc-domain:multipark.pt` (domínio) ou `https://www.multipark.pt/` (prefixo de URL).

**5. Preencher as Definições** (Definições → Integrações → Web & SEO)
1. Adiciona cada propriedade GA4 (ID, nome, marca) e cada propriedade da Search Console (nome exato, marca).
2. Confere as páginas da PageSpeed (por omissão as páginas iniciais multipark.pt e multipark.app — junta as páginas de reserva de cada marca, até 40). Para juntar muitas de uma vez usa **Colar várias páginas** (uma por linha, `URL | nome` opcional; a marca é adivinhada pelo domínio). "Chave" = página-chave (entra nos alertas dos dados reais). O interruptor **Dados reais (Chrome UX Report)** consulta 1×/semana as mesmas páginas e os respetivos sites.
3. Escolhe a **hora da atualização diária** (Lisboa; 09:00 por omissão), o histórico da 1.ª recolha (90 dias por omissão), os **eventos do funil** (ex.: `begin_checkout`, `purchase`) e os limiares dos alertas.
4. Liga **Recolha diária** e carrega em **Guardar**.
5. Carrega em **Testar acesso**: diz, para cada propriedade, se a conta de serviço a consegue ler. As que falham mostram o email a adicionar.
6. **Recolher agora** começa já (o histórico de 90 dias leva algumas corridas; o agendador continua sozinho 1×/dia, a partir das 09h ou da hora escolhida, se for mais tarde).

Também há **Testar** para "Google Analytics 4", "Search Console", "PageSpeed Insights" e "Chrome UX Report" no hub de **Integrações**.

**Problemas comuns**
- "Sem acesso" / 403: a conta de serviço não foi adicionada à propriedade (passo 3 ou 4), foi adicionada à propriedade errada, ou a API não está ativa no Google Cloud (passo 1).
- Search Console "não é utilizadora": o nome da propriedade tem de ser igual ao da Search Console (com `sc-domain:` ou com `/` no fim).
- PageSpeed sem resultados: sem chave a quota é baixa — volta a tentar no dia seguinte ou define `GOOGLE_PAGESPEED_API_KEY`.
- Dados reais vazios: "sem visitas Chrome suficientes" é normal em páginas pouco visitadas (vê a linha do site todo). "Chrome UX Report API não está ativa" → ativa-a no projeto da chave; "chave restrita" → junta a Chrome UX Report API às restrições da chave.
- Delegação (opcional): se preferires não adicionar a conta de serviço, indica uma conta do Workspace em "Conta a impersonar" e autoriza a conta de serviço no Admin Google com os âmbitos `https://www.googleapis.com/auth/analytics.readonly` e `https://www.googleapis.com/auth/webmasters.readonly`; essa conta tem de ter acesso às propriedades.
