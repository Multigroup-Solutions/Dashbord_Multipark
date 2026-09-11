# Motivo da desativação — utilizadores e fichas de RH

## Summary
Desativar alguém deixou de ser um clique silencioso: os DOIS caminhos que
desativam uma pessoa (tabela de Utilizadores e ficha de RH) passam por um
**pop-up** que pede **motivo** (por defeito "Inatividade") e **notas**, os dois
opcionais, e gravam-nos na BD + no `activity_logs`. Pedido do Jorge em
2026-09-11 ("por defeito Inatividade; outros: está fora do país, trabalha mal,
roubou, Other em texto livre; as notas são uma textarea"). O vocabulário é
único e partilhado (cliente + servidor + testes) — a lista de motivos NUNCA é
escrita à mão numa página.

## Related
- `identity-by-email.md` — `users.isActive = 0` é a porta de acesso: o gate no
  login e em cada pedido devolve `ACCESS_DENIED_MSG`. É por isso que o pop-up
  avisa que "o acesso é bloqueado imediatamente" e que a desativação da ficha
  cascateia para a conta (`rh.setActive` → `toggleUserActive`).
- `rh-auditoria-fase1.md` — `server/rhAccess.ts` sanitiza a ficha por
  finalidade; o motivo/notas entraram na lista de campos SENSÍVEIS (a par de
  `loginBlockedReason`): quem só vê a lista operacional vê "Inativo", nunca o
  porquê. Não confundir com as flags de BLOQUEIO (`blockedByDocs`,
  `blockedByPenalties`, `blockedManually`) — bloquear ≠ desativar.

## Vocabulário — `shared/deactivationReasons.ts` (fonte ÚNICA)
- `DEACTIVATION_REASON_CODES` (tuplo `as const`, ordem do diálogo, o 1.º é o
  default) + `DEACTIVATION_REASON_LABELS` (Record → o TypeScript exige etiqueta
  a cada código) + `DEACTIVATION_REASONS` pronto para o `<Select>`.
- 15 motivos: `inatividade` (default), `fora_do_pais`, `trabalha_mal`,
  `roubou`, `faltas`, `comportamento`, `pedido_proprio`, `despedido`,
  `fim_contrato`, `ausencia_prolongada`, `documentos`, `mudanca_funcao`,
  `conta_duplicada`, `seguranca`, `outro`. Os 4 primeiros + `outro` foram
  pedidos pelo Jorge; os restantes foram propostos.
- **RULE**: a BD guarda o **CÓDIGO**, nunca a etiqueta (renomear uma etiqueta
  não reescreve o histórico). `deactivationReasonLabel()` é tolerante de
  propósito: um código desconhecido devolve-se tal e qual em vez de deixar a UI
  em branco.
- `resolveDeactivation()` = regra ÚNICA de validação (pura, lança `Error` com a
  mensagem em PT que chega ao utilizador). Sem motivo → `inatividade`; texto
  livre só sobrevive quando o motivo é `outro`; escolher "Outro" **exige**
  escrever qual (tudo o resto é opcional); limites 200 / 2000 iguais aos das
  colunas. `resolveDeactivationOrThrow` (routers.ts) converte em BAD_REQUEST.

## Persistência — migração **0071** (`users` E `employees`)
`deactivationReason` VARCHAR(48) · `deactivationReasonOther` VARCHAR(200) ·
`deactivationNotes` TEXT · `deactivatedAt` DATETIME · `deactivatedById` INT.
- As colunas existem nas DUAS tabelas porque há fichas sem conta (`userId` null)
  e a ficha tem de mostrar o motivo; `deactivationColumns()` (`server/db.ts`) é
  o único construtor destes campos, usado pelos dois caminhos.
- **RULE**: **reativar LIMPA** as 5 colunas — elas descrevem a desativação
  ACTUAL. O histórico completo (motivo + notas) fica em `activity_logs`
  (`details`: `Utilizador desativado — <motivo> · Notas: <...>`), que é o único
  sítio onde se vê a sequência de desativações.
- Idempotente no boot (`ensureRecentSchema`) e via
  `scripts/run-migration.ts 0071`. ⚠️ **por aplicar em produção**.

## Fluxo na UI
- `client/src/components/DeactivationDialog.tsx` — o pop-up partilhado
  (motivo → `<Select>`, texto livre só quando "Outro", notas → `<Textarea>` com
  contador, botão destrutivo). Reset a cada abertura: o motivo escolhido para
  uma pessoa não pode aparecer pré-selecionado na seguinte.
- `UsersPage` — o Switch do estado **já não desativa directamente**: OFF abre o
  diálogo, ON ativa logo (não há nada a perguntar). O switch é controlado por
  `u.isActive`, por isso não salta enquanto o diálogo está aberto. A célula
  Estado mostra o motivo actual em texto pequeno, com notas e data no tooltip.
- `HRPage` (`EmployeeDetail`) — "Desativar" trocou o `confirm()` nativo pelo
  mesmo diálogo; "Reativar" continua um `confirm()` simples. O motivo aparece ao
  lado do badge "Inativo".
- Ambos mandam `{ reason, reasonOther?, notes? }` para
  `users.toggleActive` / `rh.setActive` (campos opcionais → contrato
  retrocompatível com qualquer chamada antiga).

## Changelog
### 2026-09-11 — Pop-up de motivo + notas na desativação
**Type**: feature
**Scope**: `shared/deactivationReasons.ts` (novo),
`server/migrations/migration_0071.ts` (novo),
`client/src/components/DeactivationDialog.tsx` (novo),
`server/db.ts` (`deactivationColumns`, `toggleUserActive`, `updateUser`,
`ensureRecentSchema`), `server/routers.ts` (`users.toggleActive`,
`rh.setActive`, `resolveDeactivationOrThrow`), `server/rhAccess.ts`
(campos sensíveis), `drizzle/schema.ts` (users + employees),
`client/src/pages/UsersPage.tsx`, `client/src/pages/HRPage.tsx`,
`server/deactivationReasons.test.ts` (novo, 14 testes),
`server/users.test.ts` (+4 testes)
**What**
- Motivo (default "Inatividade") + notas, ambos opcionais, pedidos num pop-up
  nos dois caminhos de desativação; gravados em `users`/`employees` (0071) e
  resumidos no `activity_logs`.
- Vocabulário e validação num só módulo partilhado; a BD guarda o código.
- A desativação da ficha continua a cascatear para a conta — e agora o motivo
  vai com ela, para a ficha e o login contarem a mesma história.
- Motivo/notas entraram nos campos SENSÍVEIS de `rhAccess.ts`.
**Why**
Jorge, 2026-09-11: desativações sem motivo registado tornavam impossível saber
mais tarde porque é que alguém ficou fora (e distinguir "inatividade" de
"roubou"). O `confirm()` nativo da ficha de RH não permitia recolher nada.
**Notes**
- ⚠️ migração **0071 por aplicar** (auto-aplica no boot, ou
  `scripts/run-migration.ts 0071`); **nada deployado**.
- Reativar apaga o motivo à vista — quem quiser o histórico tem de ler
  `activity_logs`. Se vier a ser preciso um histórico navegável na UI, o sítio
  natural é uma tabela `deactivation_events` (não foi criada de propósito: o
  `activity_logs` já guarda tudo).
- `users.create` falha nos testes por falta de `DATABASE_URL` — **já falhava
  antes** desta alteração (baseline: 4 testes vermelhos + 1 erro tsc em
  `@vercel/functions`).
- Não tocado de propósito: `rh.delete` (que escreve "Colaborador desativado" no
  log mas apaga a ficha) e as flags de bloqueio por documentos/penalizações.
