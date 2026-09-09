# Google Ads — integração direta (fase 1: pronta para ligar)

Origem: "Plano de automatização do Google Ads na Dashboard Multipark" (Jorge,
9 set 2026). Decisão: fazer JÁ tudo o que não depende das credenciais da
Google; o que precisa da autorização do Jorge fica a um clique.

## O que está feito (branch `feat/google-ads-fase1`)
- **`server/integrations/googleAds/`**
  - `config.ts` — envs `GOOGLE_ADS_CLIENT_ID/SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`,
    `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (MCC, opcional), `GOOGLE_ADS_REDIRECT_URI`
    (opcional), `GOOGLE_ADS_API_VERSION` (default v21); `INTEGRATIONS_ENCRYPTION_KEY`.
  - `oauth.ts` — consentimento (scope `adwords`, offline, prompt=consent),
    estado anti-CSRF de uso único em BD (`oauth_states`, 10 min), troca do
    código no servidor, refresh token **cifrado AES-256-GCM** em
    `integration_connections`, renovação automática, preservação do refresh
    token quando a Google não devolve outro, `invalid_grant` → `reauth_required`.
  - `client.ts` — REST `googleAds:searchStream` (só leitura), headers
    developer-token + login-customer-id, retry 429/5xx com espera progressiva.
  - `gaql.ts` — consultas: contas (customer_client), métricas diárias por
    campanha (cost_micros, impressions, clicks, conversions, conversions_value,
    all_conversions, budget), conversões por ação.
  - `sync.ts` — `runGoogleAdsSync({kind})`: hourly (7 dias, hoje provisório),
    nightly (90 dias), monthly (resto dos 37 meses), initial/manual (tudo);
    `GET_LOCK` (sem sobreposição); uma conta de cada vez (uma falha não pára as
    outras); **retomável** (cursor em `integration_sync_runs`, `deadlineAt` 45 s
    → `done:false`, a chamada seguinte continua); **valida antes de substituir**
    (resposta vazia num intervalo com dados → mantém e avisa; erro → não grava
    zeros); registo sem credenciais.
  - `adMetrics.ts` — **fonte única**: por DIA, API prevalece; senão legado
    (`campaign_daily_stats`) identificado; nunca soma os dois; `coverage`
    (dias API/legado/em falta, último dia completo, última recolha, stale);
    `budgetEstimate` à parte (indicador, nunca gasto); campanhas sem marca.
  - `marketingStats.ts` — indicadores do plano (secção 3): gasto importado,
    reservas reais por **data de criação** sem canceladas, atribuídas
    (`adAttribution='google_paid'`) vs sem atribuição, conversões Google à
    parte, custo/reserva atribuída, ROAS atribuído ≠ ROAS Google, custo
    publicitário/reserva total (global). `backfillBookingAttribution`.
  - `attribution.ts` — regra LOCAL: `gclid`/`gbraid`/`wbraid` ou
    `utm_source=google`+medium pago → `google_paid`; ID da campanha de
    `campaignid` (ValueTrack) ou `utm_campaign` numérico; resto `unknown`
    (nunca inventar). Aplicada no enrichment das reservas
    (`multiparkBookingSync`) e no backfill.
  - `routes.ts` — `/api/integrations/google-ads/oauth/start` (admin com
    sessão), `…/oauth/callback`, `/api/cron/google-ads?kind=…` (Bearer CRON_SECRET).
  - `router.ts` — tRPC `integrations.googleAds.*` (status, contas, campanhas
    → marca/cidade, sync.run/runs, disconnect, backfillAttribution).
- **Migração 0063** (boot): `integration_connections`, `oauth_states`,
  `ad_accounts`, `ad_campaigns`, `ad_daily_metrics` (UNIQUE fornecedor+conta+
  campanha+dia+origem; micros; conversões DECIMAL), `ad_conversion_action_metrics`,
  `integration_sync_runs`; `multipark_bookings` + gclid/gbraid/wbraid/utm_*/
  adCampaignExternalId/adAttribution; `campaign_daily_stats.conversions` → DECIMAL.
- **UI**: `/integracoes/google-ads` (Sistema → Integrações): estado, envs em
  falta, endereço de retorno a registar, ligar/desligar, contas (selecionar +
  marca/cidade), recolha manual, execuções com avisos, atribuição das reservas.
  Marketing: banner de estado (última recolha, último dia completo, cobertura,
  origem), gasto = custo importado, orçamento como indicador separado,
  reservas totais/atribuídas/sem atribuição, ROAS atribuído vs Google, datas
  de Lisboa (o `toISOString()` dava o dia 31 do mês anterior), "mês até hoje".
- Testes: `googleAds.test.ts` (10).

## O que o Jorge tem de fazer (guia do plano, secção 5)
1. Conta gestora + IDs das contas; developer token (Centro da API) com nível
   Explorer/Basic (Test Account Access não lê contas reais).
2. Projeto Google Cloud PRÓPRIO → ativar Google Ads API → consentimento
   (scope adwords; External → **In production**, senão o refresh token expira
   em 7 dias) → cliente OAuth Web com redirect URI EXATO:
   `https://dashboard.multipark.pt/api/integrations/google-ads/oauth/callback`.
3. Envs no Vercel: `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`,
   `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (se MCC),
   `INTEGRATIONS_ENCRYPTION_KEY` (`openssl rand -base64 32`), `CRON_SECRET`.
4. Integrações → Google Ads → "Ligar" → escolher contas → marca/cidade →
   "Inicial (37 meses)" (repete enquanto disser parcial) → confirmar 2 ciclos
   horários no cron.

## Fase E (depois de validar com dados reais) — NÃO feito
- Desligar entrada por CSV/email e `importGoogleAdsReport` (distribui totais
  por dias e deriva valor de conversão do custo; sem cliente que o chame).
- Retirar match de campanhas por substring (`campaignReportIngest`), remover
  `getMarketingDashboardStats` antiga (já não é chamada), unificar
  `MarketingDashboard.tsx` (página duplicada) com a fonte única.
- Anual: `getAnnualBreakdown` antigo somava ads 2×; o motor financeiro já os
  exclui (`quality.marketingExcluded`). Confirmar que a fatura Google entra só
  pelas Despesas.
- Testes de `campaignReportIngest.parseCampaignCsv`.
