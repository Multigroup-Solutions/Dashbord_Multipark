# Check-in de PDA e Passagem de turno (formulários operacionais)

## Summary
Dois formulários dos team leaders na área operacional: o **check-in de PDA**
(`OperationalPage.tsx` → `CheckinDialog`, procedure
`operational.pdas.checkins.checkin`, tabela `pda_checkins`) e a **passagem de
turno** (`ShiftHandoverPage.tsx`, router `shiftHandover`, tabela
`shift_handovers` criada preguiçosamente em `db.ts`). Este ficheiro nasceu com
o pedido do Jorge de 2026-09-09 (pesquisa de funcionário + foto obrigatória no
check-in; fardamento com tamanhos na passagem de turno).

## Related
- `profile-photo-upload.md` — o outro caminho de fotos da app (`rh.uploadPhoto`);
  o check-in de PDA usa `POST /api/upload` com redimensionamento a 1600px, pelo
  mesmo motivo (teto ~4.5 MB do body no Vercel).
- `whatsapp-integration.md` — a migração **0065** é partilhada (media WhatsApp +
  `clothingItems`); ver a regra de migrações lá.
- `storage-backends-s3.md` — onde as fotos de PDA ficam guardadas.

## Check-in de PDA — regras
- **Funcionário obrigatório** (desde 2026-08-06) e agora **foto de entrada
  obrigatória** (2026-09-09): zod `photoEntryUrl: z.string().trim().min(1)` no
  servidor; na UI o botão "Registar Check-in" só ativa com `photoEntryUrl`, e o
  botão da câmara passa a dizer "Repetir Foto" quando já há uma. O check-OUT
  continua com foto opcional (não foi pedido).
- **Seletor de funcionário = `SearchableSelect`** (`ui/searchable-select.tsx`,
  combobox cmdk já usado no RH/Zello/Achados). Opções memoizadas de `rh.list`
  (`e.employee.id` / `fullName`). Pesquisa por nome; sem alteração de servidor.

## Passagem de turno — fardamento com tamanhos
- **Vocabulário partilhado `shared/clothing.ts`**: tipos `colete | polar |
  casaco | gorro`, tamanhos `XS…XXL | Único`, `ClothingItem {type,size,qty}`,
  `parseClothingItems` (tolerante), `normalizeClothingItems` (soma linhas
  repetidas, ordena), `summarizeClothingItems` ("2 coletes S, 2 casacos M, 3
  casacos L"). Tetos: 30 linhas, 999 por linha. Testes em
  `server/clothingItems.test.ts` (7).
- **Persistência**: coluna nova `shift_handovers.clothingItems` (TEXT, JSON)
  — migração 0065 (`ALTER … ADD COLUMN`, `ER_NO_SUCH_TABLE` idempotente porque
  a tabela nasce em `ensureShiftHandoverTable`, que também ganhou a coluna).
  `saveShiftHandover` grava `JSON.stringify` (o `esc` corta a 2000 chars; 30
  linhas ficam muito abaixo); `listShiftHandovers` devolve já parseado.
- **`uniformsCount` NÃO foi removida.** O input "Número de fardas" saiu do
  formulário, mas o valor dos registos antigos é carregado para o estado e
  devolvido intacto ao gravar (senão o `ON DUPLICATE KEY UPDATE` punha NULL). O
  formulário mostra "Registo antigo: N farda(s)" quando edita um desses sem
  peças novas; o histórico mostra o resumo das peças ou, em registos antigos,
  "N farda(s)".
- **UI**: secção "Fardamento" depois de "PDAs carregados a 100%": linhas
  Peça / Tamanho / Qtd. / remover, botão "Adicionar peça", resumo em texto por
  baixo; quantidade inválida marca a linha a vermelho e bloqueia o "Guardar".
  Linhas repetidas (mesmo tipo+tamanho) são somadas no servidor.

## Changelog

### 2026-10-07 — Login a partir do QR do PDA falhava (Google access_denied + 400 "pedido expirou")
**Type**: fix
**Scope**: `server/_core/oauthState.ts` (NOVO, puro), `server/_core/oauth.ts`, `shared/loginReturn.ts` (`googlePromptFor`),
`client/src/pages/PdaRegisterPage.tsx`, testes `server/_core/oauthState.test.ts` (NOVO) + `server/sistema25c.test.ts`.
**Diagnóstico (logs Vercel prod, projeto `dashbord-multipark`)**: `[OAuth] Google devolveu erro: access_denied` e
`[OAuth] State inválido { hasSaved:false }`. O QR é lido por uma app de leitura que abre o link no browser DELA; a Google
acaba noutro browser → os cookies `app_oauth_state`/`app_oauth_next` ficam no primeiro → 400 e o destino perde-se.
O login também forçava `consent` (ecrã com Cancelar em cada login) + `access_type=offline` (refresh token nunca usado).
**What**:
- `state` ASSINADO (HMAC JWT_SECRET, 10 min) com o destino (`?next=`, validado por `safeReturnPath`); o callback aceita-o
  SEM cookie; com cookie tem de bater certo (`checkCallbackState`). Redirect final = destino do state, senão o do cookie.
- `googlePromptFor`: PDA → `select_account`, resto → sem prompt; sai `access_type=offline`.
- `PdaRegisterPage` pede sempre login de PDA (`pda=1`, D61) e limpa o QR pendente ao registar.
- Páginas de erro com link "Tentar de novo" (mesmo destino, href escapado); `access_denied` explica cancelado / conta sem acesso.
**Trade-off**: sem cookie perde-se a ligação state↔browser (login CSRF teórico com um callback fresco < 10 min). Aceite para
o caso do PDA; reverter = exigir o cookie em `checkCallbackState`.

### 2026-09-09 — Pesquisa + foto obrigatória no check-in; fardamento com tamanhos
**Type**: feature
**Scope**: `client/src/pages/OperationalPage.tsx` (CheckinDialog),
`client/src/pages/ShiftHandoverPage.tsx` (form + histórico + `ClothingEditor`),
`server/routers.ts` (checkin zod; shiftHandover.save zod + normalização),
`server/db.ts` (CREATE + save + list), `shared/clothing.ts` (novo),
`server/clothingItems.test.ts` (novo), `server/migrations/migration_0065.ts`
(partilhada com o WhatsApp)
**What**: ver as secções acima.
**Why**: pedido do Jorge (2026-09-09): "no check-in de PDAs deve dar para
pesquisar por funcionário e a foto deve ser obrigatória"; "na passagem de
turno tirar o input das fardas e permitir coletes/polares/casacos/gorros com
quantidades e tamanhos".
**Notes**:
- Cirúrgico: nenhum outro campo/procedure foi tocado; check-out inalterado.
- Gates: `tsc --noEmit` limpo, `vite build` OK, suite 7 falhas pré-existentes
  de ambiente (as mesmas de sempre).
- **Commit `1198eee` em `origin/updates-rafael`** (2026-09-09). Migração 0065 **NÃO foi corrida à mão** (sem `DATABASE_URL` real na máquina) — corre sozinha no boot do próximo deploy; para aplicar antes: `DATABASE_URL=... ./node_modules/.bin/tsx scripts/run-migration.ts 0065` (runner novo, idempotente).
