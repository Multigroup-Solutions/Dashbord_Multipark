# SECURITY — Barnie / Multipark

Procedimentos e notas de segurança.

---

## 1. Rotação de secrets (urgente)

O ficheiro `.env` local contém credenciais em claro. `.env` está no `.gitignore`
e **não** está no histórico git, mas por precaução rodar tudo:

### 1.1. Checklist de rotação

- [ ] **Google OAuth** — Revogar e gerar novo `GOOGLE_CLIENT_SECRET` em
  https://console.cloud.google.com (projeto Multipark) → Credentials → OAuth
  Client → "Reset secret".
- [ ] **LLM (`LLM_API_KEY`)** — Se é chave Anthropic, revogar em
  https://console.anthropic.com → API Keys. Gerar nova.
- [ ] **JWT_SECRET** — Gerar novo segredo ≥ 32 chars:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
  Nota: ao rodar, todas as sessões ativas ficam inválidas (utilizadores
  voltam a fazer login).
- [ ] **Base de dados** — Trocar password em Railway → Database → Settings →
  Reset password. Atualizar `DATABASE_URL`.
- [ ] **MultiPark API keys (`mp_live_*`)** — Revogar as 11 chaves no painel
  MultiPark e gerar novas.
- [ ] **Zello** — Trocar password do utilizador Zello (`ZELLO_PASSWORD`).
- [ ] **AWS S3** — Se `AWS_ACCESS_KEY_ID` estiver em uso, rodar em IAM → Users
  → Security credentials → Make inactive / Delete.
- [ ] **SMTP** — Trocar `SMTP_PASS` (app-password da conta noreply@).
- [ ] **Google Maps API key** — Em Google Cloud Console, criar nova, restringir
  por HTTP referrer + IP, e depois desativar a antiga.

### 1.2. Onde guardar os novos secrets

Em produção (Railway): `railway vars set NOME=valor`.
Em dev local: só `.env`, nunca commitar.
Em CI: GitHub Secrets ou equivalente.

Recomendado: adicionar **Secrets Manager** (Railway Secrets, AWS Secrets
Manager, HashiCorp Vault) em vez de envs planas.

---

## 2. Novas variáveis de ambiente introduzidas

```env
# Sessão — tempo de vida em dias (default 30)
SESSION_MAX_DAYS=30

# Dev login — necessário para ativar /api/dev-login (nunca em produção)
# Gera com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
DEV_LOGIN_TOKEN=

# CORS — origin(s) permitido(s), separados por vírgula. Se omitido, apenas
# same-origin é aceite.
FRONTEND_URL=https://barnie.multipark.pt
```

---

## 3. Hardening aplicado nesta ronda

### OAuth (`server/_core/oauth.ts`)

- Gera `state` aleatório de 32 bytes em `/api/oauth/login`, guarda em cookie
  httpOnly/Lax/Secure com TTL 10 min.
- Valida `state` no callback com comparação em tempo constante.
- Limpa a cookie de state após validação (sucesso ou erro).
- Dev login agora exige `DEV_LOGIN_TOKEN` + `NODE_ENV != production`.
- Token recebido via query `?token=` ou header `X-Dev-Login-Token`.

### Cookies (`server/_core/cookies.ts`, `oauth.ts`)

- `app_session_id` agora usa `SameSite=Strict` quando o pedido é HTTPS
  (Lax em dev local HTTP).
- Expiração de sessão 1 ano → 30 dias (`SESSION_MAX_DAYS`).

### Upload (`server/_core/index.ts`)

- Exige utilizador autenticado (401 caso contrário).
- Whitelist MIME: jpg, png, webp, gif, heic/heif, pdf.
- Validação por magic bytes para detetar Content-Type spoofing.
- Nome do ficheiro gerado com `crypto.randomUUID()` + extensão derivada do
  MIME (nome do cliente é totalmente ignorado).
- Rate limit: 30 req/min por IP.

### Rate limiting (`server/_core/security.ts`)

- In-memory, por IP, com cleanup periódico.
- `/api/oauth/*` e `/api/dev-login`: 20 req / 15 min.
- `/api/upload`: 30 req / min.
- `/api/external`: 300 req / min.
- Emite headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`,
  e `Retry-After` em 429.
- Para múltiplas instâncias: trocar por Redis / Upstash.

### CORS (`server/_core/security.ts`)

- Whitelist controlada por `FRONTEND_URL` (pode ter múltiplos origins,
  separados por vírgula).
- Same-origin é sempre permitido.
- Pre-flight OPTIONS responde 204.

### SQL injection (`server/db.ts`)

- Todas as 8 ocorrências de `sql.raw(ids.join(","))` substituídas por
  `inArray(coluna, ids)`.
- LIKE queries com input de utilizador passam agora por `sanitizeLike()`
  que escapa `%`, `_` e `\`.

---

## 4. Ainda por endurecer

- **RBAC unificado** — ainda há mistura de `adminProcedure` estático com
  `requireRole()` com hierarquia em `server/routers.ts`. Definir um único
  middleware `requireMinRole("admin")` e aplicar em todos os endpoints
  sensíveis. Auditar com testes.
- **Error handling tRPC** — ~250 procedures sem try/catch. Adicionar
  wrapper que converte erros genéricos em `TRPCError` e loga stack.
- **Transações DB** — operações multi-step (create + log + dependências)
  precisam de `db.transaction(...)`.
- **Idempotência em jobs cron** — `multiparkBookingSync` e
  `dailyDriverCollection` precisam de lock (`SELECT ... FOR UPDATE` ou
  Redis lock) para não duplicar registos em runs paralelos.
- **Timeouts em integrações** — `fetch` para Multipark/Zello/LLM sem
  `AbortSignal.timeout(...)`. Adicionar 15s default.
- **PKCE** — boa prática em OAuth com SPAs. Implementar `code_challenge` /
  `code_verifier`.
- **Logger estruturado** — substituir `console.error` por `pino` com
  redaction de tokens/PII.

---

## 5. Resumo do que mudou em código nesta ronda

```
server/_core/cookies.ts   — SameSite=strict em prod
server/_core/oauth.ts     — state, dev-login token, expiração 30 dias
server/_core/security.ts  — NOVO: CORS + rate limiter + MIME guard + magic bytes
server/_core/context.ts   — exportar getUserFromRequest para REST endpoints
server/_core/index.ts     — CORS global, rate limits, upload endurecido
server/db.ts              — sanitizeLike() + 8 inArray() + 10+ LIKE sanitizados
```

Data: 2026-04-23.
