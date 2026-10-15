# Regras do projeto (o como; o onde está em `mapa.md`)

## Índice
1. Stack · 2. Dados e BD · 3. Migrações · 4. Permissões e cidades · 5. Interruptores e definições · 6. Crons · 7. Notificações · 8. Ajuda (árvore) · 9. Design Multipark · 10. Texto, datas e cidades · 11. Testes e validação · 12. Produção e ferramentas · 13. Receitas (o que tocar em cada tipo de mudança)

## 1. Stack
- Cliente: React + Vite (wouter, shadcn new-york, Tailwind v4) em `client/`. Servidor: Express + tRPC v11 em `server/`, função única na Vercel (`api/index.js`, `maxDuration` 60 s, região fra1). Partilhado/puro em `shared/` (testável).
- BD nossa: MySQL via Drizzle (`drizzle/schema.ts`). BD da Multipark: Postgres **só de leitura** (`server/multiparkDb/*`).
- Regras de negócio puras em `shared/` (ou funções `PURA` documentadas) e testadas; o servidor só as liga à BD.
- Um router por área (`server/*Router.ts`); `server/routers.ts` é o `appRouter` (grande — acrescenta ao router da área, não ao ficheiro grande, quando houver um).

## 2. Dados e BD
- **Nada se apaga** em dados de negócio. Marcar (com cópia de segurança para desfazer), desativar, `deletedAt`. Ações destrutivas em lote: sempre **pré-visualizar → aplicar → desfazer**, só por ação humana, com permissão no servidor e registo em `activity_logs`.
- Reservas: ler a BD da Multipark ao vivo; cópia local (`multipark_bookings`) só como recurso ou histórico < 2 mar 2026. Nunca apagar o webhook nem a cópia.
- Escritas concorrentes: UPDATE condicional (compare-and-set), `INSERT IGNORE` em chave única para "uma vez por dia/cidade", reservas com validade. Cron + botão podem correr ao mesmo tempo; várias instâncias da Vercel também.
- Leituras pesadas: prazos (`/*+ MAX_EXECUTION_TIME(n) */` na MySQL; `statement_timeout` na Multipark), `LIMIT`, índices; nunca varrer tabelas grandes por pedido.
- Dados pessoais: mínimo necessário; exportações sem nomes de clientes nem matrículas salvo necessidade; RGPD documentado.

## 3. Migrações
- `server/migrations/migration_NNNN.ts` exporta `MIGRATION_NNNN_STATEMENTS` e `IDEMPOTENT_ERROR_CODES_NNNN` (ex.: `ER_DUP_FIELDNAME`, `ER_DUP_KEYNAME`, `ER_TABLE_EXISTS_ERROR`); só acrescenta (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`); regista **no fim** de `SCHEMA_MIGRATIONS` (`server/migrations/index.ts`); espelha em `drizzle/schema.ts` (colunas e índices).
- Número: o seguinte livre (de 5 em 5) **no `origin/main` e nos ramos abertos** — várias sessões trabalham em paralelo e colidem.
- Uma migração já publicada não se edita para mudar colunas: faz uma nova com `ALTER` idempotente (uma BD de preview pode já ter a versão antiga).
- O código novo tem de aguentar a coluna ainda não existir durante o deploy (ex.: apanhar `ER_BAD_FIELD_ERROR` e cair no comportamento antigo) quando faz sentido.

## 4. Permissões e cidades
- A porta de cada módulo é `requireAccess(ctx.user, "<modulo>", "<acao>")` (`server/_core/access.ts`) — `can()` no cliente para mostrar/esconder, mas **o servidor decide**. Matriz em `shared/access.ts` (`MATRIX_SPEC`); `docs/permissoes.md` é gerado (`pnpm tsx scripts/gen-permissoes-doc.ts`) e testado.
- Cidades: `projectScope(coluna)` / `cityScope` (preenchidos pelo `requireUser`); quem não tem centro de custos (`missingCostCenter`) só vê o próprio — o centro de custos é obrigatório mesmo para admin. Valida a cidade pedida contra as da pessoa antes de ler.
- Prefixo tRPC novo → entrada em `PATH_MODULE` (`server/_core/accessContext.ts`), que decide o alcance de cidade do pedido; operações por id (editar/apagar um registo) → `assertScopedOperation` (`server/cityScopeGuards.ts`). Sem estas duas peças um router novo é uma fuga de cidade.
- Totais globais por cidade que a pessoa não pode ver aparecem como "Indisponível", nunca como 0.
- Totais financeiros: `canSeeFinanceTotalsFor` / `requireFinanceTotals`; esconder € e taxas a quem não os vê, também em ferramentas e exportações.
- `requireRole` só para limiares finos dentro de um módulo. Mudanças de quem vê o quê seguem as decisões do Jorge (`decisoes.md`) e atualizam o gerado das permissões.
- Ações via MCP (`server/mcpProceduresApi.ts`): correm como quem criou a chave; ações externas pedem `confirmExternal`.

## 5. Interruptores e definições
- Interruptor novo: em `AUTOMATION_FLAGS` (`shared/appSettings.ts`) com `defaultEnabled: false` se escreve/avisa/publica, `superAdminOnly` se for sensível, `group` certo. Correções de leitura/texto reversíveis podem entrar sem interruptor.
- **Armadilha**: `isFeatureEnabled(name, …)` tem omissão `true`. Passa SEMPRE `{ defaultEnabled: automationFlagDefault(name) }` (ou o wrapper da área) — senão um interruptor "desligado" fica ligado.
- Definição nova: `def({ key, group, label, description, schema, defaultValue, wiring })` em `SETTINGS`; ler com `getSetting(key)` (valida e cai na omissão; nunca lança). Valores sensíveis em `SUPER_ADMIN_SETTING_KEYS`. Na descrição e na ajuda, diz que é "por omissão".
- Mudança de comportamento para todos: só com decisão do Jorge; enquanto não houver, a omissão da definição nova = comportamento de hoje.

## 6. Crons
Trabalho novo — onde registar:
1. `TICK_JOBS` em `server/cronSchedule.ts` (cadência em hora de Lisboa, `priority`, `minMs`/`maxMs` dentro do `TICK_BUDGET_MS` 50 s);
2. `JOB_RUNNERS` em `server/cronScheduler.ts` (mesma chave);
3. `CRON_JOBS` em `shared/appSettings.ts` com `name` = `runName` e `intervalMinutes` = cadência (Estado do sistema);
   — estes 3 o teste apanha (`server/cronScheduler.test.ts`, `server/agendadorArrumar.test.ts`);
4. a função `*Cron` em `server/cronJobs.ts`;
5. `docs/ajuda/agendador.md` ("O que corre e quando");
6. endpoint manual `/api/cron/<nome>` em `server/_core/api-entry.ts` (Bearer `CRON_SECRET`) — só se fizer sentido correr à mão (14 dos trabalhos não têm).
   — os pontos 4–6 não têm teste geral: acrescenta tu um (ex.: `server/mpvF7Extras.test.ts`).
- Idempotente; retoma por cursor; prazo próprio; nunca envia duas vezes (reserva por compare-and-set). Testes com relógio simulado, incluindo o domingo da mudança de hora (último domingo de outubro e março).

## 7. Notificações
- Só por `notify()` (`server/notify.ts`); um teste impede escrever em `app_notifications` por outro lado. Tipo novo (nome ≤ 32 caracteres, `app_notifications.kind` é VARCHAR(32)) em `NOTIFICATION_KIND_DEFS` (`shared/notificationRouting.ts`) com módulo, papéis, cidade, canais; texto em `shared/notificationRoutingDoc.ts`; regenera `docs/notificacoes.md` (`pnpm tsx scripts/gen-notificacoes-doc.ts`).
- Avisos novos atrás de interruptor desligado; se não houver destinatários na cidade, recurso aos admins; dedupe; nunca falhar em silêncio.

## 8. Ajuda (árvore de conhecimento)
- `docs/ajuda/*.md` com front matter: `grupo` (Dashboards, Financeiro, Pessoas, Operações, Suporte, Comunicação, Sistema), `pagina` (id estável), `separadores: id=Título` (cada `TabsTrigger value=` da página tem a sua secção, ≤ 5 000 car.), `modulo`, `titulo`, `rotas`, `palavras`.
- Secções: só `##`, `###` ou linhas só em negrito. Ids `<ficheiro>#<slug>` em `server/assistant/knowledgeTreeIds.json` (só cresce); se um id desaparecer, alias em `shared/helpIdAliases.ts`.
- Números das regras via `{{regra:chave}}` (`shared/helpRuleValues.ts`); valores de definições com "por omissão" a ≤ 120 car. Nunca escrever à mão um número que está no código.
- Regras em vigor do Multis: `shared/rulesInForce.ts` (frases com a origem `ficheiro:constante`) e lista branca `shared/rulesLiveWhitelist.ts`.
- Separador novo numa página com Multis → também em `MULTIS_PAGE_TABS` (`shared/multisPage.ts`).
- **A ajuda tem de dizer o que o código FAZ** (é a maior fonte de notas baixas do auditor). Confere cada frase contra o código.
- Depois de mexer: `npx tsx scripts/gen-ajuda.ts` (gera também as regras). Em conflito de merge nos gerados: aceita um lado e regenera.
- Prefere acrescentar secções aos ficheiros existentes; ficheiro novo só quando é uma página nova (e então entra na lista do teste do assistente).

## 9. Design Multipark
- Tokens em `client/src/index.css` (Navy #0E2957 + Royal Blue #0055D2; fundo #f0f4ff; Poppins nos títulos, Open Sans no corpo; modo escuro). Não inventar cores — usar as variáveis.
- Botões brancos com borda azul (azul cheio só `selected`); pesquisas e filtros com fundo branco e borda azul.
- Reutilizar: `components/ui/*`, `KPICard`, `StatValue`, `SortableTable` (`useTableSort`/`Th`), `STICKY_FIRST_COL`, `TABS_SCROLL`, `QueryErrorNote` (erro ≠ vazio), `DashboardFilterBar`, `QuickRangeBar`, `DateRangeNav`, `CityMultiSelect`, `ViewToggle`, `CHART_PALETTE`/`CHART_TOOLTIP_STYLE`, `usePersistedState`.
- Telemóvel: tabelas com 1.ª coluna fixa, evita larguras mínimas fixas (há um teste em `server/pessoasFiltros.test.ts`); separadores com scroll.
- Textos de ecrã em PT-PT simples, sem jargão; "Sem acesso"/estado vazio/erro distintos.

## 10. Texto, datas e cidades
- Comparar nomes/emails só com `shared/textKey.ts` (`matchKey`, `matchWords`, `searchText`) — sem acentos, sem maiúsculas.
- Horas e dias em **Lisboa** (`lisbonParts`, `Intl` com `Europe/Lisbon`); o dia operacional vai das 03h às 03h; cuidado com a mudança de hora (25 out 2026).
- Cidades: lisbon/porto/faro (aliases lisboa/oporto em `cityNameScope`).
- Datas vindas da BD em texto ("AAAA-MM-DD HH:MM:SS"): não usar `new Date(...)` diretamente (falha no Safari) — converter explicitamente.

## 11. Testes e validação
- Antes de cada push: `pnpm check` · `npx vitest run` (completo) · `pnpm build:api` + `node -e "import('./api/index.js')"` + `git checkout -- api/index.js` · geradores se aplicável.
- Testes sem rede: `fetch` global falso/bloqueado; IA com fornecedores falsos; BD com `createFakeDb` (`server/_core/ai/testUtils.ts`) ou dependências injetadas.
- Os testes correm em **UTC** (`vitest.config.ts` fixa `TZ=UTC`, como a produção); datas lidas da BD em texto → `parseDbDate` (UTC), nunca `new Date(texto)`.
- Para provar que algo existente não mudou: teste de equivalência ou hash (ex.: v1 do Multis).
- Testes de texto/linha (ex.: `ui24g.test.ts` com números de linha) podem precisar de ajuste legítimo — o auditor confirma que não esconde regressão.

## 12. Produção e ferramentas
- **Ver produção sem pedido do Jorge** (só leituras sem dados pessoais): MCP `Agente_Multipark` → `dashboard_query` **apenas** em `settings.values.list` (gravado vs omissão: `isSet`/`value`), `settings.aiUsage*`, `settings.aiPilotStats`, `settings.scheduler`, `extrasDia.schedule`. Tudo o resto (reservas, clientes, RH, caixa) só a pedido dele nessa conversa. `dashboard_action` e as ferramentas `create_*`/`update_*`/`delete_*` do MCP: nunca por iniciativa própria; mesmo a pedido, mostra o resumo e espera o sim. (O MCP corre como o Jorge, super admin.)
- Logs: Vercel MCP `get_runtime_logs` (projeto `prj_ccvzHCH8edMfjELxjbi4M9FzxlIv`, team `team_lYkibOdgNjvjOVfHUg46s926`).
- Ler a BD de produção diretamente (scripts READ ONLY): só a pedido do Jorge nessa conversa.
- Deploy = merge para `main` (Vercel). Variáveis de ambiente: o Jorge muda na Vercel (nunca peças os valores).
- GitHub: `gh` (repo `Multigroup-Solutions/Dashbord_Multipark`).
- MCP antigo `multipark-dashboard`: não mexer nem sugerir remover.

## 13. Receitas (o que tocar em cada tipo de mudança)
**Página nova**
- Rota em `client/src/App.tsx` + item em `DashboardLayout.tsx` (`menuGroups`, `module`/`anyOf`).
- Módulo em `shared/access.ts` (`MATRIX_SPEC`) → `pnpm tsx scripts/gen-permissoes-doc.ts`; `shared/routeAccess.ts` se for pessoal / sem centro de custos; `PATH_MODULE` para o prefixo tRPC.
- Ajuda nova `docs/ajuda/<pagina>.md` (front matter completo) e acrescenta-a à lista em `server/assistant/assistant.test.ts`; perfil do Multis em `shared/multisProfiles.ts`.

**Separador novo**
- Secção própria na ajuda (≤ 5 000 car.) + linha em `separadores:` + valor em `MULTIS_PAGE_TABS` (`shared/multisPage.ts`) + `useMultisPage` na página.

**Procedimento tRPC novo**
- `requireAccess` (módulo/ação) + `projectScope`/validação da cidade + `assertScopedOperation` se for por id + `requireFinanceTotals` se mostrar €.
- Se for uma ação que o MCP pessoal deve poder fazer: `MCP_ACTIONS` em `server/mcpProceduresApi.ts` (ações externas com `confirmExternal`); se for sensível, garante que cai no `DENY`.
- Mutation que muda dados lidos pelo Multis → limpa a cache por omissão; se for técnica (heartbeat, marcar como lido), avalia a lista em `server/assistant/slowCallCache.ts` e o teste `mpvF4CacheList.test.ts`.

**Ferramenta do Multis**
- Só leitura, sem IA, como quem pergunta (`ctx.call`); entra em `MPV_STAFF_TOOLS` (o v1 não muda — testes de hash).
- Campos `pii` declarados (colaboradores `[NOME_n]`, clientes `firstName`, texto livre `redactPii`), redigir antes de cortar, `fitToolResult`, prazo de leitura lenta.
- `needs` nas perguntas sugeridas; fixtures em `server/fixtures/multisEval/` para o eval.

**Funcionalidade de IA nova**
- Entrada em `AI_FEATURES` (`shared/aiFeatures.ts`) com nível lite e `flag` própria **desligada** em `AUTOMATION_FLAGS` (grupo `ia`); `runAi({ feature })`; PII redigida; teste com fornecedor falso; linha em `docs/ia.md` e `docs/ia-inventario.md`.

**Tipo de notificação novo**
- `NOTIFICATION_KIND_DEFS` (nome ≤ 32 car.) + texto em `notificationRoutingDoc.ts` + `pnpm tsx scripts/gen-notificacoes-doc.ts`; interruptor desligado se for novo aviso.

**Cron novo** → §6. **Migração** → §3. **Interruptor/definição** → §5.
