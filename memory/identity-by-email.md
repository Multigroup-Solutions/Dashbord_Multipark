# Identidade por EMAIL — login, ingestão do site e extras duplicados

## Summary
Regra transversal do sistema: **uma pessoa = um email**. Este ficheiro documenta
como essa identidade é resolvida (login Google ↔ conta criada pelo backoffice ↔
ficha de colaborador ↔ submissões do website multidriver), o módulo canónico
`server/identity.ts`, a mensagem única de recusa de acesso, a normalização de
telefones e a ferramenta de cura de extras duplicados. Nasceu de três bugs
reportados pelo Jorge em 2026-07-31 (login/ativação, duplicado do multidriver,
página de extras vazia + telefones "inválidos").

## Related
- `whatsapp-integration.md` — `normalizePhoneE164` nasceu aí (Fase 0) e é aqui
  que ganha tolerância a texto livre; o broadcast e a tabela de extras da
  `ExtrasDiaPage` são os consumidores. Migrações 0045/0047 continuam por aplicar.
- `employee-city-derivation.md` — **2026-08-04**: a mesma tabela do
  `AvailabilitySection` ganhou filtro por cidade; a cidade é DERIVADA
  (projeto → candidatura do site → morada) porque `employees` não tem coluna de
  cidade. A Decisão 1 ("a todos" = conjunto visível) continua a valer e agora o
  envio por EMAIL também manda a lista explícita do que está visível.
- `sync-runners-topology.md` — os dois entrypoints (Railway `index.ts` e Vercel
  `api-entry.ts`) montam ambos o OAuth e o `/api/v1`; qualquer alteração ao
  login vale para os dois.

## Mapa da identidade (ler antes de tocar em qualquer procura por email)
- `users` — conta de LOGIN. `openId` unique. Duas origens:
  `google_<sub>` (OAuth) ou `manual_<ts>_<rand>` (criada pelo backoffice em
  `createManualUser`, à espera do 1º login).
- `employees` — ficha de colaborador. Pode existir SEM conta (`userId` null) e a
  coluna `email` é OPCIONAL (o import CSV de extras não a exige — `extrasImport.ts`).
- Ligação: `employees.userId → users.id`.
- **Consequência**: procurar só numa das tabelas conclui erradamente que a
  pessoa não existe. Toda a procura por email passa por `server/identity.ts`.
- Comparação SEMPRE `LOWER(TRIM(...))` dos dois lados — a collation da coluna
  não é garantia e há dados legados com espaços/maiúsculas.

## Módulo canónico — `server/identity.ts`
- `findUserByEmail` — conta de login (ativa > id mais baixo).
- `findEmployeeByEmail` — ficha por `employees.email` **OU** pela conta ligada
  (`employees.userId → users.email`). Ordem: ativo > extra > id mais baixo.
- `findOrCreateExtraByEmail` — resolve e SÓ cria quando o email é mesmo
  desconhecido; a ficha nova nasce ligada à conta de login existente e faz
  backfill de email/telefone/`userId` em falta (nunca substitui o que o
  backoffice já preencheu). Devolve `matchedBy: employee_email | linked_user | created`.
- `adoptPlaceholderAccountByEmail` — o 1º login Google **adota** a conta
  `manual_...` com o mesmo email (preserva role/departamento). Se já existirem
  as DUAS linhas (estado partido herdado), transfere role/estado para a linha
  Google e desativa a manual (`loginMethod = merged_into_<id>`), porque o
  `openId` é UNIQUE e não pode ser duplicado. Nunca rouba um `openId` Google ativo.
- `shared/email.ts` — `normalizeEmail` / `sameEmail` / `isPlausibleEmail`.
  `webIntake.normalizeEmail` passou a ser um re-export.

## Porta de acesso (uma só) — `shared/const.ts: ACCESS_DENIED_MSG`
- **Uma mensagem para todos os casos** (desconhecido, desativado, modo fechado).
  Motivo duplo: não confundir quem liga a pedir ajuda e não revelar a estranhos
  se um email existe. NUNCA duplicar o texto — importar a constante.
- Pontos de aplicação:
  - callback OAuth → `denyAccess()` limpa a cookie e redireciona para
    `/?auth=denied`.
  - `sdk.authenticateRequest` → 403 com a mesma mensagem se `isActive !== 1`
    (uma desativação corta o acesso imediatamente, mesmo com cookie de 30 dias).
  - `createContext` marca `accessDenied` e `auth.me` limpa a cookie morta e
    devolve FORBIDDEN com a mesma mensagem.
  - `Home.tsx` (banner) e `DashboardLayout` (ecrã "Sem acesso", SEM botão de
    entrar) mostram a constante tal e qual.
- **Env opcional `RESTRICT_LOGIN_TO_REGISTERED=true`** (default OFF, comportamento
  histórico preservado): recusa quem não tenha conta criada pelo backoffice em
  vez de auto-criar um utilizador com role `user`.

## Telefone — `shared/phone.ts`
- A limpeza passou a ser AGRESSIVA (descarta tudo o que não seja dígito ou `+`),
  a inferência de indicativo mantém-se conservadora. Passam agora:
  `912345678 (pessoal)`, `tlm 912 345 678`, `912345678 / 913000000` (usa o
  primeiro válido, também com `,` `;` `|` e "ou"/"e"), invisíveis de copy-paste,
  traços unicode, `0912345678`. Continuam a dar `null`: 8 dígitos, `11912345678`,
  `abc`, `+351abc`.
- Novos: `isValidPhone`, `normalizePhoneForStorage` (E.164 se der, senão o texto
  limpo — nunca deita fora o que a pessoa escreveu; corta a 32 = varchar da coluna).
- **Normalização à ENTRADA** em `upsertDriverApplication` e em toda a criação de
  extras por email.
- **Fonte de verdade única**: `getWeekOverview` devolve `phoneE164` calculado no
  SERVIDOR; a UI já não recalcula (evita divergir do que o envio faz).

## Página de extras (`ExtrasDiaPage` → `AvailabilitySection`)
- A tabela lista TODOS os extras ativos (era `extras.filter(availableDays > 0)`,
  daí aparecer vazia). Checkbox "Mostrar só quem marcou disponibilidade" para o
  comportamento antigo; mudar o filtro limpa a seleção.
- `getWeekOverview` acrescenta quem SUBMETEU disponibilidade nessa semana mesmo
  sem função "extra" (ex.: um `driver` que preencheu o formulário) — antes a
  submissão entrava na BD e ficava invisível.
- `sendBroadcast` vai buscar à ficha os `employeeIds` que não estão na lista de
  extras ativos (só ATIVOS), senão desapareciam do envio em silêncio.
- Cabeçalho mostra `N extras ativos · N responderam · N com número válido`.
  Badge distingue "sem número" de "número não reconhecido" (com o valor no title).
- **Decisão 1 do Jorge mantida**: "a todos" = o conjunto MOSTRADO na tabela. Como
  a tabela passou a mostrar todos os ativos, "a todos" volta a ser todos os ativos.

## Cura de duplicados — `server/mergeDuplicateExtras.ts`
- `planMerge` (PURA, testada) + `mergeDuplicateExtras({apply})`.
- **DRY-RUN por defeito.** Só funde perdedores marcados como auto-criados pelo
  site (existe `activity_logs.action = 'employee_autocreate'` para o id). Nunca
  funde duas fichas humanas.
- BLOQUEIA (reporta, não escreve) se o duplicado já tiver escalas, picagens,
  faltas ou penalizações — decisão humana.
- Ao aplicar: move `extras_availability` (o duplicado ganha nos dias em colisão,
  por causa do UNIQUE(employeeId, day)), repõe `availability_form_tokens` e
  `whatsapp_conversations` (tolerante a tabela inexistente — 0045/0047 podem não
  estar aplicadas), COALESCE dos contactos em falta no sobrevivente, liga o
  `userId`, e **desativa** o duplicado (`isActive = 0`) — NUNCA apaga (há tabelas
  a referenciar `employeeId` sem FK).
- Como correr: `POST /api/v1/admin/merge-duplicate-extras` (X-API-Key, scope
  admin) com `{}` para simular e `{"apply": true}` para aplicar; ou tRPC
  `driverApplications.mergeDuplicates` (super_admin).

## Changelog

### 2026-07-31 — Identidade por email: login, ingestão multidriver e extras
**Type**: fix
**Scope**: `shared/email.ts` (novo), `shared/phone.ts`, `shared/const.ts`,
`server/identity.ts` (novo), `server/mergeDuplicateExtras.ts` (novo),
`server/identity.test.ts` (novo), `server/webIntake.ts`, `server/db.ts`,
`server/extrasAvailability.ts`, `server/whatsappBroadcast.ts`, `server/routers.ts`,
`server/mcpApi.ts`, `server/_core/{oauth,sdk,context}.ts`,
`client/src/pages/{Home,ExtrasDiaPage}.tsx`, `client/src/components/DashboardLayout.tsx`,
`.env.example`
**What**:
- **P1 (login/ativação)**: o callback OAuth passou a adotar por EMAIL a conta
  criada pelo backoffice (antes criava uma 2ª linha em `users` com role `user`,
  e a conta registada nunca era usada); `isActive` passou a ser verificado no
  login E em cada pedido; mensagem ÚNICA `ACCESS_DENIED_MSG` em todos os pontos;
  emails gravados/procurados normalizados; `createManualUser` recusa email
  repetido; `linkInviteToOAuthUser` deixou de rebentar no UNIQUE do `openId`.
- **P2 (duplicado do multidriver)**: `findOrCreateExtraByEmail` movido para
  `server/identity.ts` e alargado à conta de login e ao link `employees.userId`;
  a ficha nova nasce ligada; `upsertDriverApplication` procura case-insensitive.
- **P3 (página de extras + telefones)**: tabela mostra todos os extras ativos +
  quem respondeu sem ser extra; `phoneE164` vem do servidor; normalizador de
  telefone tolerante a texto livre; broadcast já não descarta alvos fora da
  lista de extras.
- Ferramenta de cura de duplicados (dry-run) + endpoint admin + procedure tRPC.
- 21 testes novos (`server/identity.test.ts`): email, telefone (casos reais que
  antes bloqueavam o envio), `isPlaceholderLogin`, `planMerge`.
**Why**: os três problemas tinham a mesma raiz — a identidade estava a ser
resolvida numa tabela de cada vez, sem forma canónica do email, e a UI escondia
o resultado. Ver secção "Mapa da identidade".
**Notes / gotchas**:
- **Sem migração nova.** Nada muda no schema.
- **Mudança de comportamento a comunicar**: utilizadores com `isActive = 0`
  perdem o acesso imediatamente (antes entravam na mesma). Confirmar a lista de
  desativados antes do deploy.
- O duplicado JÁ criado em produção **não é curado pelo deploy** — é preciso
  correr a fusão (dry-run primeiro). O login de contas duplicadas, esse, é
  curado automaticamente no próximo login (merge no `adoptPlaceholderAccountByEmail`).
- `RESTRICT_LOGIN_TO_REGISTERED` fica OFF: ligar só por decisão do Jorge.
- **Gates**: `pnpm run check` (tsc) LIMPO. Testes 243/250 — as 7 falhas são
  PRÉ-EXISTENTES e de ambiente (sem `DATABASE_URL`: `users.create`; sem chaves:
  `zello` ×2, `multipark` ×3; drift do cookie: `auth.logout`, já documentado).
- Não fixado: extras importados por CSV continuam a poder entrar sem email (o
  `extrasImport.ts` não o exige) — enquanto assim for, a única âncora de
  identidade dessas fichas é o `userId`. Candidato a tornar obrigatório.
- Sem commits git (por instrução).
