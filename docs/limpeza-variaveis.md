# Limpeza — variáveis de ambiente

27 set 2026, depois da limpeza final (ramo `claude/limpeza-final`): saíram o sync de reservas pela API (`multipark-sync`, `multipark-future`, reconciliação, "Reparar período", ferramentas MCP de sync), o `multipark-db-sync`, o interruptor `MULTIPARK_SOURCE` e a cópia do histórico de cada reserva.

Só **nomes** — nunca valores. Contagem feita com `grep` sobre `process.env.X` / `process.env["X"]` no código (`server/`, `client/src/`, `shared/`, `scripts/`, `mcp-server/`, `api/` sem o `api/index.js` gerado, `vite.config.ts`, `drizzle.config.ts`; sem testes), antes (origin/main) e depois da limpeza.

## Variáveis que deixaram de ser usadas

Podem ser apagadas do Vercel (e dos `.env` locais) quando este ramo estiver em produção.

| Variável | Para que servia |
|---|---|
| `CRON_BUDGET_MS` | prazo por omissão do sync recente/futuro pela API (`server/jobs/multiparkBookingSync.ts`) |
| `MULTIPARK_DB_INITIAL_DAYS` | dias da 1.ª carga do `multipark-db-sync` (`server/multiparkDb/dbSync.ts`) |
| `MULTIPARK_SOURCE` | interruptor "Reservas: ler da BD da Multipark" (lido por nome, `env[...]`, via o catálogo das automações — por isso não aparece na contagem literal) |

As tabelas `multipark_sync_logs`, `multipark_sync_coverage`, `multipark_sync_lock`, `multipark_reconciliation`, `multipark_db_cursors` e `multipark_booking_history` **ficam** (sem migrações destrutivas); só deixaram de ser escritas. Uma sobreposição `flag.MULTIPARK_SOURCE` que exista em `app_settings` é ignorada.

## Variáveis ainda referenciadas (`process.env.X`)

| Variável | Onde (1.º ficheiro; +N = mais ficheiros) |
|---|---|
| `APP_URL` | `server/aiOps/cron.ts` (+4) |
| `AVAILABILITY_FORM_TOKEN_SECRET` | `server/availabilityFormToken.ts` |
| `AVAILABILITY_FORM_URL` | `server/availabilityFormToken.ts` |
| `AWS_ACCESS_KEY` | `server/storage.ts` |
| `AWS_S3_ACCESS_KEY` | `server/storage.ts` |
| `AWS_S3_BUCKET_NAME` | `scripts/verify-s3-storage.ts` (+1) |
| `AWS_S3_REGION` | `scripts/verify-s3-storage.ts` (+1) |
| `AWS_S3_SECRET_ACCESS_KEY` | `server/storage.ts` |
| `AWS_SECRET_ACCESS_KEY` | `server/storage.ts` |
| `BLOB_READ_WRITE_TOKEN` | `scripts/verify-s3-storage.ts` (+1) |
| `CRON_SECRET` | `server/integrations/googleAds/routes.ts` (+2) |
| `DATABASE_URL` | `drizzle.config.ts` (+12) |
| `DATABASE_URL_MULTIPARK` | `server/extrasPressure.ts` |
| `DEV_LOGIN_TOKEN` | `server/_core/oauth.ts` |
| `DRIVER_APPLICATION_URL` | `server/extraLeadsSync.ts` |
| `ENV_FILE` | `scripts/payroll-parity.ts` |
| `GMAIL_PUSH_AUDIENCE` | `server/mail/routes.ts` |
| `GMAIL_PUSH_SERVICE_ACCOUNT` | `server/mail/routes.ts` |
| `GMAIL_PUSH_TOPIC` | `server/cronScheduler.ts` (+2) |
| `GOOGLE_ADS_CLIENT_ID` | `server/integrations/googleBusiness/config.ts` |
| `GOOGLE_ADS_CLIENT_SECRET` | `server/integrations/googleBusiness/config.ts` |
| `GOOGLE_BUSINESS_CLIENT_ID` | `server/integrations/googleBusiness/config.ts` |
| `GOOGLE_BUSINESS_CLIENT_SECRET` | `server/integrations/googleBusiness/config.ts` |
| `GOOGLE_BUSINESS_ORIGIN` | `server/integrations/googleBusiness/config.ts` |
| `GOOGLE_BUSINESS_PUSH_AUDIENCE` | `server/integrations/googleBusiness/config.ts` |
| `GOOGLE_BUSINESS_PUSH_EMAIL` | `server/integrations/googleBusiness/config.ts` |
| `GOOGLE_BUSINESS_SUBSCRIPTION` | `server/integrations/googleBusiness/config.ts` |
| `GOOGLE_CLIENT_ID` | `server/_core/oauth.ts` (+1) |
| `GOOGLE_CLIENT_SECRET` | `server/_core/oauth.ts` (+1) |
| `GOOGLE_CRUX_API_KEY` | `server/webAnalytics/router.ts` |
| `GOOGLE_PAGESPEED_API_KEY` | `server/webAnalytics/router.ts` (+1) |
| `HANDOVER_EMAIL_CC` | `server/shiftHandoverAutomation.ts` |
| `HTTPS_PROXY` | `scripts/qa-visual.ts` |
| `INTEGRATIONS_ENCRYPTION_KEY` | `server/integrations/googleAds/crypto.ts` |
| `JWT_SECRET` | `server/_core/env.ts` (+2) |
| `LLM_API_KEY` | `server/_core/llm.ts` |
| `LLM_API_URL` | `server/_core/llm.ts` (+1) |
| `LLM_MODEL` | `server/_core/llm.ts` |
| `MARKETING_WEEKLY` | `server/marketingWeekly.ts` |
| `MULTIPARK_API_KEY` | `mcp-server/index.mjs` (+1) |
| `MULTIPARK_API_URL` | `mcp-server/index.mjs` (+1) |
| `MULTIPARK_DB_SCHEMA_OUT` | `scripts/multipark-db-schema.ts` |
| `MULTIPARK_DB_SSL` | `server/multiparkDb/client.ts` |
| `MULTIPARK_FETCH_TIMEOUT_MS` | `server/multipark.ts` |
| `MULTIPARK_WEBHOOK_SECRET` | `server/multiparkWebhook.ts` |
| `NODE_ENV` | `server/_core/env.ts` (+4) |
| `OAUTH_SERVER_URL` | `server/_core/env.ts` |
| `OPENAI_API_KEY` | `server/_core/llm.ts` |
| `OPENAI_API_URL` | `server/_core/llm.ts` |
| `OPERATION_TZ` | `server/extrasDia.ts` |
| `OWNER_EMAIL` | `server/_core/notification.ts` |
| `OWNER_OPEN_ID` | `server/_core/env.ts` |
| `PORT` | `server/_core/index.ts` |
| `PUBLIC_APP_URL` | `server/aiOps/cron.ts` (+4) |
| `QA_APP_ID` | `scripts/qa-visual.ts` |
| `QA_BASE_URL` | `scripts/qa-visual.ts` |
| `QA_COOKIE` | `scripts/qa-visual.ts` |
| `QA_DARK` | `scripts/qa-visual.ts` |
| `QA_JWT_SECRET` | `scripts/qa-visual.ts` |
| `QA_MAX_HEIGHT` | `scripts/qa-visual.ts` |
| `QA_NAME` | `scripts/qa-visual.ts` |
| `QA_OPEN_ID` | `scripts/qa-visual.ts` |
| `QA_OUT` | `scripts/qa-visual.ts` |
| `QA_PAGES` | `scripts/qa-visual.ts` |
| `QA_SV` | `scripts/qa-visual.ts` |
| `QA_TAG` | `scripts/qa-visual.ts` |
| `QA_VIEWPORTS` | `scripts/qa-visual.ts` |
| `QA_WAIT_MS` | `scripts/qa-visual.ts` |
| `RESTRICT_LOGIN_TO_REGISTERED` | `server/_core/oauth.ts` |
| `S3_PUBLIC_BASE_URL` | `server/storage.ts` |
| `SESSION_MAX_DAYS` | `server/_core/oauth.ts` |
| `VERCEL` | `server/storage.ts` |
| `VITEST` | `server/_core/featureFlags.ts` |
| `VITE_APP_ID` | `server/_core/env.ts` |
| `WHATSAPP_API_VERSION` | `server/whatsappTemplateMeta.ts` |
| `WHATSAPP_APP_SECRET` | `server/whatsappWebhook.ts` |
| `WHATSAPP_CALL_PERMISSION_TEMPLATE` | `server/whatsappCallsRouter.ts` |
| `WHATSAPP_CALL_PERMISSION_TEMPLATE_LANG` | `server/whatsappCallsRouter.ts` |
| `WHATSAPP_PHONE_NUMBER_ID` | `server/extrasAutomation.ts` (+6) |
| `WHATSAPP_SLA_MINUTES` | `server/whatsappInboxOps.ts` |
| `WHATSAPP_SLA_NOTIFY` | `server/whatsappInboxOps.ts` — desde o lote 24a é um interruptor das Definições; a variável fica como camada de baixo (qualquer valor "desligado": off/false/0) |
| `WHATSAPP_TOKEN` | `server/extrasAutomation.ts` (+5) |
| `WHATSAPP_VERIFY_TOKEN` | `server/whatsappWebhook.ts` |
| `WHATSAPP_WABA_ID` | `server/whatsappTemplateMeta.ts` |
| `ZELLO_API_KEY` | `server/_core/env.ts` |
| `ZELLO_NETWORK` | `server/zello.ts` |
| `ZELLO_PASSWORD` | `server/zello.ts` |
| `ZELLO_USERNAME` | `server/zello.ts` |

## Lidas por nome (não aparecem como `process.env.X` literal)

- **Chaves da API Multipark por parque** (`process.env[park.envKey]`, `server/multipark.ts`) — continuam precisas para o detalhe das reservas do webhook (cópia financeira e CRM), junto com `MULTIPARK_API_KEY` (chave geral, via `server/_core/env.ts`): `MULTIPARK_API_KEY_LISBON_AIRPARK`, `MULTIPARK_API_KEY_LISBON_REDPARK`, `MULTIPARK_API_KEY_LISBON_SKYPARK`, `MULTIPARK_API_KEY_LISBON_TOP_PARKING`, `MULTIPARK_API_KEY_FARO_AIRPARK`, `MULTIPARK_API_KEY_FARO_REDPARK`, `MULTIPARK_API_KEY_FARO_SKYPARK`, `MULTIPARK_API_KEY_PORTO_AIRPARK`, `MULTIPARK_API_KEY_PORTO_REDPARK`, `MULTIPARK_API_KEY_PORTO_SKYPARK`, `MULTIPARK_API_KEY_PORTO_TOP_PARKING`, `MULTIPARK_API_KEY_LISBON_BOARDINGPARK`, `MULTIPARK_API_KEY_LISBON_PARKDIRECT`, `MULTIPARK_API_KEY_LISBON_PREMIUM_PARK`, `MULTIPARK_API_KEY_LISBON_READYPARK`, `MULTIPARK_API_KEY_LISBON_STOP_FLY_PARK`, `MULTIPARK_API_KEY_LISBON_TRAVELPARKING`, `MULTIPARK_API_KEY_LISBON_VIAGENSPARKING`, `MULTIPARK_API_KEY_FARO_BOARDINGPARK`, `MULTIPARK_API_KEY_FARO_PARKDIRECT`, `MULTIPARK_API_KEY_FARO_PREMIUM_PARK`, `MULTIPARK_API_KEY_FARO_READYPARK`, `MULTIPARK_API_KEY_FARO_STOP_FLY_PARK`, `MULTIPARK_API_KEY_FARO_TRAVELPARKING`, `MULTIPARK_API_KEY_FARO_VIAGENSPARKING`, `MULTIPARK_API_KEY_PORTO_BOARDINGPARK`, `MULTIPARK_API_KEY_PORTO_PARKDIRECT`, `MULTIPARK_API_KEY_PORTO_PREMIUM_PARK`, `MULTIPARK_API_KEY_PORTO_READYPARK`, `MULTIPARK_API_KEY_PORTO_STOP_FLY_PARK`, `MULTIPARK_API_KEY_PORTO_TRAVELPARKING`, `MULTIPARK_API_KEY_PORTO_VIAGENSPARKING`.
- **Interruptores das automações** (`env[f.name]`, `server/appSettings.ts`; a sobreposição nas Definições ganha): `EXTRAS_AUTOMATION`, `EXTRAS_AVAILABILITY_AUTO_REPLY`, `WHATSAPP_SLA_NOTIFY`, `LEAD_REMINDERS`, `LEAD_AUTO_REPLY`, `TASKS_AUTOMATION`, `CASE_REMINDERS`, `COMPLAINT_AUTO_ACK`, `HANDOVER_EMAIL`, `HANDOVER_REMINDERS`, `TRAINING_REMINDERS`, `TRAINING_BLOCKS_ESCALA`, `OPS_BRIEFING`, `WEEKLY_REPORTS`, `WHATSAPP_CALLS`, `MAIL_PUSH`, `OPS_ANOMALIES`, `AI_ENABLED`, `AI_EXPENSE_OCR`, `AI_REVIEW_DRAFTS`, `AI_RADIO`, `AI_HANDOVER_SUMMARY`, `AI_WHATSAPP_ASSIST`, `AI_QUIZ`, `AI_TRAINING_TUTOR`, `AI_COMPLAINT_TRIAGE`, `AI_REVIEW_AUTO_DRAFTS`, `AI_WHATSAPP_TRIAGE`, `AI_LOST_FOUND_MATCH`, `AI_ASSISTANT`, `AI_HR_AUTOFILL`, `AI_OPS_BRIEFING`, `AI_WEEKLY_REPORTS`, `AI_ANOMALY_EXPLAIN`, `AI_AVAILABILITY_CLASSIFY`, `AI_LEAD_SCORING`, `AI_EVALUATION_EXPLAIN`, `AI_HANDOVER_REPEATS`, `AI_MAIL_DRAFT`, `AI_GBP_POSTS`, `AI_PAGESPEED_EXPLAIN`, `AI_WEB_INSIGHT`, `AI_KNOWLEDGE`, `AI_TASKS_FROM_TEXT`.
- Outras lidas através de um objeto `env` passado por parâmetro ou de `server/_core/env.ts` (ex.: `DATABASE_URL_MULTIPARK`, chaves Google/Gemini) contam onde há um `process.env.X` literal; as listas `require` de `server/integrationsStatus.ts` mostram as que cada integração precisa.
