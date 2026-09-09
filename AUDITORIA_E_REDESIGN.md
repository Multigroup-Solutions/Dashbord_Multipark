# Barnie — Auditoria + Redesign

Relatório compilado em 23/04/2026.

---

## 1. Redesign aplicado

Objetivo: aproximar o Barnie do look do **Multipark Agent** da foto enviada.

### Ficheiros alterados

| Ficheiro | Mudança |
|---|---|
| `client/src/index.css` | Nova paleta azul Multipark (`#1E5BFF`), fundo `#F6F8FE`, radius mais suave (0.75rem), dark-mode reescrito em hex legível |
| `client/src/components/ModuleCard.tsx` | Tile grande com borda azul, ícone centrado, label em caps + `(count)` / `(valor)` por baixo — estilo idêntico ao RECOLHAS (9) / CAIXA (220,00 €) |
| `client/src/pages/DashboardPage.tsx` | Reorganizado por secções (**Operacional / Backoffice / Pessoas / Gestão / Suporte & Qualidade / Financeiro**), tabs Menu/Resumo/Histórico |
| `client/src/components/DashboardLayout.tsx` | Sidebar com logo quadrado azul + `MULTIPARK` + badge `AGENTE`/`ADMIN`; topbar com "← Voltar", filtros Cidade / Estacionamentos / **filtros**, sino com contador, avatar com borda; fundo main usa `bg-background`; `localStorage` protegido com try/catch |
| `client/src/pages/Home.tsx` | Landing reformulada com logo Multipark e tiles azul-borda |

### O que continua por pintar (se quiseres avançar)

As 26 páginas internas (`HRPage`, `OperationalPage`, `ExpensesPage`, etc.) usam
`shadcn/ui`, por isso **já herdam** a nova paleta só por causa do CSS. O que
ainda convém afinar em cada uma:

- Trocar cores hardcoded (`#3B82F6`, `#6366F1`, etc.) pelas variáveis CSS
- Uniformizar tabelas e formulários para o mesmo radius/spacing
- Migrar KPIs locais para o novo `KPI` ou `ModuleCard`

---

## 2. Auditoria

### 2.1 Segurança — PRIORIDADE MÁXIMA

| # | Severidade | Onde | Problema | Fix |
|---|---|---|---|---|
| 1 | **CRÍTICO** | `.env` | Ficheiro local tem DB password, JWT secret, Google OAuth secret, `sk-ant-*`, 11 chaves `mp_live_*`, password Zello em claro | Rodar TUDO. Confirmar que `.env` está no `.gitignore` (está ✓). Mover para Railway Secrets / Vault. |
| 2 | **CRÍTICO** | `server/_core/oauth.ts:42-61` | OAuth sem `state` parameter → CSRF / open redirect | Gerar `state = crypto.randomUUID()`, guardar em cookie, validar no callback |
| 3 | **ALTO** | `server/_core/cookies.ts:24` | `SameSite="lax"` sempre — em prod devia ser `strict` | `sameSite: secure ? "strict" : "lax"` |
| 4 | **ALTO** | `server/_core/index.ts:54-65` | Upload sem whitelist MIME, sem validação magic bytes, nome com extensão do utilizador | Whitelist + `crypto.randomUUID()` + lib `file-type` |
| 5 | **ALTO** | `server/_core/trpc.ts:34` + `routers.ts` | RBAC inconsistente (`adminProcedure` estático vs `requireRole()` com hierarquia em alguns sítios) | Normalizar em middleware factory, deprecar `adminProcedure` |
| 6 | **ALTO** | `server/_core/oauth.ts:9-39` | `/api/dev-login` protegido só por `NODE_ENV !== "production"` — aceita qualquer visitante sem password | Exigir `DEV_LOGIN_TOKEN` por ENV, default OFF |
| 7 | **ALTO** | todos os endpoints públicos | Sem rate limiting (login, upload, LLM) — brute force + DoS + custo OpenAI/Anthropic | `express-rate-limit` por rota |
| 8 | Médio | Express app | Sem CORS explícito | `app.use(cors({ origin: FRONTEND_URL, credentials: true }))` |
| 9 | Médio | cookies | `expiresInMs = 1 ano` | Reduzir para 7–30 dias + refresh token |
| 10 | Médio | logs | `console.error` com objetos que podem conter tokens/PII | Logger estruturado (pino) + redaction |

### 2.2 Backend — `server/routers.ts` (3906 linhas)

| # | Severidade | Problema |
|---|---|---|
| 1 | **ALTO** | `sql.raw(Array.from(ids).join(","))` em ~8 sítios → **SQL injection**. Substituir por `inArray(coluna, ids)` do Drizzle |
| 2 | **ALTO** | LIKE com template string `'%' + name + '%'` sem sanitização |
| 3 | **ALTO** | ~250 procedures sem `try/catch` — erros genéricos em vez de `TRPCError` |
| 4 | **ALTO** | Operações multi-step (create + log + relacionados) **sem `db.transaction`** |
| 5 | **ALTO** | Jobs (`multiparkBookingSync`, `dailyDriverCollection`) sem lock nem idempotency key — duas execuções em paralelo duplicam registos |
| 6 | Médio | `z.string().default(...)` em `mimeType` e `role` — usar `z.enum` |
| 7 | Médio | `fetch` a APIs externas sem `AbortSignal.timeout(…)` → pode bloquear indefinidamente |
| 8 | Médio | Divisões sem guard (CTR/CPC quando impressions=0) |
| 9 | Médio | `routers.ts` 3906 linhas + `db.ts` 4179 linhas — partir em módulos (`routers/auth.ts`, `routers/projects.ts`, etc.) |

### 2.3 Frontend

| # | Severidade | Problema |
|---|---|---|
| 1 | ALTO | `HRPage.tsx` (1822 linhas), `OperationalPage.tsx` (1691 linhas) — partir em sub-componentes |
| 2 | ALTO | `any` disfarçado em `GlobalFiltersContext`, `ComplaintsPage` (props `KanbanView`), `ExpensesPage` |
| 3 | ALTO | `localStorage` sem try/catch *(já corrigido em `DashboardLayout.tsx`)* |
| 4 | ALTO | `AIChatBox.tsx` — `key={index}` em lista dinâmica |
| 5 | Médio | Lógica de prefill em `ExpensesPage:734-762` fora de `useEffect` — double-update |
| 6 | Médio | Imagens de faturas com `onClick` sem `role="button"`/`aria-label` |
| 7 | Médio | `refetchInterval` em 3 queries independentes em `OperationalPage` — risco de dessincronização |
| 8 | Médio | Formatação de datas sem timezone explícito |
| 9 | Médio | ~59 modais de formulário repetindo o mesmo padrão (state+validação+upload) — extrair `useFormWithValidation` |

### 2.4 Base de dados — `drizzle/schema.ts` (47 tabelas)

| # | Severidade | Problema |
|---|---|---|
| 1 | **ALTO** | **Zero** `references()` declaradas — nenhuma FK real. `relations.ts` está vazio. |
| 2 | **ALTO** | Índices em falta: `users.email`, `employees.nif`, `multipark_bookings.licensePlate`, `invoices.invoiceNumber`, `vehicles.plate`, `partnerships.campaignKey` |
| 3 | **ALTO** | Datas usadas em `WHERE`/`ORDER BY` sem índice: `tasks.dueDate`, `expenses.expenseDate`, `expenses.paymentDueDate`, `invoices.dueDate`, `bookingHistory.actionDate` |
| 4 | Médio | Valores monetários em `int()` — perde cêntimos. Usar `decimal(10,2)` em `expenses`, `invoices`, `annualReports`, `partnershipInvoices` |
| 5 | Médio | Soft-delete inconsistente (`isActive` em algumas, nada em outras — `expenses`, `invoices`, `partnerships`, `tasks`) |
| 6 | Médio | `status` sem índice em `complaints`, `incidents`, `google_reviews`, `services`, `invoices` — são queries frequentes |
| 7 | Médio | Migração `0023_*.sql` dropa/recria **todas as primary keys** — investigar razão, risco em produção |
| 8 | Baixo | Enums com valores mistos PT/EN (`incidentType`, `complaintType`) — uniformizar |

---

## 3. Plano sugerido (por ordem de prioridade)

### Esta semana (bloqueadores reais)

1. Rodar todos os secrets do `.env`
2. Fix SQL injection (`sql.raw` → `inArray`, LIKE sanitizado)
3. OAuth `state` + PKCE
4. Rate limiting em `/api/oauth/*`, `/api/upload`, endpoints LLM
5. Upload com whitelist MIME + UUID filename

### Próximas 2 semanas

6. Adicionar `try/catch` + `TRPCError` a todos os endpoints
7. `db.transaction(...)` em operações multi-step
8. Idempotency key nos jobs cron
9. Declarar FKs + índices no schema (nova migração)
10. Partir `routers.ts` e `db.ts` em módulos temáticos

### Qualidade de vida

11. Partir `HRPage`/`OperationalPage` em sub-componentes
12. Tipificar todos os `any` restantes
13. Extrair `useFormWithValidation` para os 59 modais repetidos
14. Logger estruturado (pino) com redaction de PII

---

## 4. Ficheiros úteis

- `PROJECT.md` — overview do projeto (referência)
- `client/src/index.css` — tokens de design
- `client/src/components/ModuleCard.tsx` — novo tile
- `client/src/pages/DashboardPage.tsx` — nova vista principal
