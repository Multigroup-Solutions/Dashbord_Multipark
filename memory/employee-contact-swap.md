# Troca `phone` ↔ `nif` nas fichas de colaborador (`employees`)

## Summary
Ferramenta de cura de dados (script + módulo puro testado) para fichas onde o
telemóvel foi escrito no campo do NIF e/ou o NIF no campo do telefone. Pedido
do Jorge (2026-09-09): "utilizadores com NIF a começar por 9, ou telefone que
não começa por +351 nem por 9 → trocar os dois campos". **A tabela `users` NÃO
tem NIF nem telefone** — esses campos vivem em `employees` (`phone` varchar(32),
`nif` varchar(20)); é essa a tabela alvo. `driver_applications` tem o mesmo par
de colunas e a mesma origem de erro (site multidriver) mas **não** é tocada.

## Related
- `identity-by-email.md` — o normalizador `shared/phone.ts`
  (`normalizePhoneE164`) é reutilizado aqui para classificar valores; a fusão
  de duplicados (`mergeDuplicateExtras.ts`) é o padrão que este script copia
  (plano PURO testado + dry-run por defeito + `activity_logs` com `userId = 0`).
- `whatsapp-integration.md` — o broadcast só envia para `phone` em E.164; um
  telemóvel preso na coluna `nif` era invisível ao WhatsApp. Depois da troca
  entra automaticamente na lista "com número válido".

## Ficheiros
- `server/employeeContactSwap.ts` — `classifyContactValue`, `isValidNifChecksum`,
  `planContactSwap` (PURA) e `applyContactSwap` (transação).
- `server/employeeContactSwap.test.ts` — 21 testes (classificação, plano,
  apply com db falso: ordem dos parâmetros do UPDATE, stale, payload do log).
- `scripts/swap-employee-phone-nif.ts` — CLI. **DRY-RUN por defeito.**

## Como correr (raiz do dashboard)
```
./node_modules/.bin/tsx scripts/swap-employee-phone-nif.ts                 # simula
./node_modules/.bin/tsx scripts/swap-employee-phone-nif.ts --apply         # escreve
```
Opções: `--only-active` (por defeito vai a TODAS as fichas, ativas e inativas),
`--ids 12,34`, `--report x.json` (em `--apply` sem `--report` grava sempre um
backup JSON no temp do sistema e imprime o caminho), `--show-ok`.
⚠️ O `.env` do dashboard tem `DATABASE_URL` de PLACEHOLDER (`@host:3306`) —
o URL real vive no Railway/Vercel. Exportar `DATABASE_URL=...` na shell antes
de correr (o dotenv NÃO sobrepõe variáveis já definidas).

## Regras de decisão (ver banner de `server/employeeContactSwap.ts`)
Classificação por coluna: `empty` | `phone` (+351 explícito, `351`+9, `00351`,
9 dígitos a começar por 9, `0`+9) | `intl` (`+`/`00` de outro país) | `nif`
(9 dígitos, 1.º dígito 1–8, **checksum mod-11 válido**) | `other`.
- **swap** quando pelo menos UM lado é verificado do tipo da outra coluna e o
  outro lado não é válido onde está:
  - nif∈{phone,intl} E phone∈{nif,other,empty} → `swap`, ou `swap-nif-unverified`
    se `phone` tinha lixo (vai tal e qual para `nif`, `carryOver`: NFKC+trim+corte a 20);
  - phone=nif E nif∈{other,empty} → `swap`, ou `swap-phone-unverified` (lixo
    vai tal e qual para `phone`, corte a 32).
  Verificados gravam-se normalizados: telefone E.164, NIF só dígitos.
- **review** (reportado, nunca escrito — a troca não resolveria nada):
  `both-phones`, `same-value` (mesmo número nos dois campos), `both-nifs`,
  `phone-unrecognized` (lixo em `phone` SEM telemóvel verificado em `nif`).
- Desvios DELIBERADOS da regra literal: telefone estrangeiro no `phone` fica
  (é telefone); um 9xxxxxxxx no `nif` é tratado como telemóvel mesmo que passe o
  checksum de NIF (9x = entidade não residente, não é de um colaborador) — o
  relatório assinala com `detail`.
- Escrita: uma transação; cada UPDATE guardado por `phone <=> lido AND nif <=>
  lido` (linha mudada entretanto → `stale`, não tocada); `activity_logs`
  `action='employee_contact_swap'`, `entity='employees'`, `details` =
  `{before, after, kinds}` → trilho de rollback. Sem migração.

## Changelog
### 2026-09-09 — Script de troca phone ↔ nif
**Type**: feature (data-fix tool)
**Scope**: `server/employeeContactSwap.ts` (novo), `server/employeeContactSwap.test.ts`
(novo), `scripts/swap-employee-phone-nif.ts` (novo)
**What**:
- Planeador puro + apply transacional + CLI dry-run/apply, ver acima.
- Verificado: 20/20 testes; `tsc --noEmit` do projeto limpo; script + teste
  type-checkados com as opções do projeto; validação de argumentos do CLI.
**Why**: fichas com telemóvel no NIF ficavam fora do broadcast WhatsApp e com
NIF inválido nos recibos; não há bug de mapeamento (`webIntake.ts` /
`extrasImport.ts` ligam bem os campos) — é erro de preenchimento.
**Notes**:
- Na máquina de dev não há `DATABASE_URL` real (`.env` é placeholder, MySQL
  local em 3306 recusa as credenciais do docker-compose) — o Jorge correu com
  o URL real exportado.
- `driver_applications.phone/nif` fica por curar — mesmo par, mesma origem;
  se o dry-run em `employees` mostrar volume, vale estender o script com
  `--table driver_applications` (o planeador é agnóstico da tabela).
- Débito: o script abre a sua própria pool (não passa por `getDb()` para não
  disparar `ensureRecentSchema`), padrão a repetir em scripts futuros.

### 2026-09-09 (b) — 1.ª aplicação em produção + regra relaxada
**Type**: decision + fix
**Scope**: `server/employeeContactSwap.ts`, `server/employeeContactSwap.test.ts`,
`scripts/swap-employee-phone-nif.ts`
**What**:
- **APLICADO em produção** pelo Jorge às 14:28Z: 376 fichas lidas, **302
  trocadas**, 0 stale, 60 ok, 14 em revisão (backup JSON no temp do Windows,
  `employee-contact-swap-2026-09-09T14-28-25-707Z.json`; `activity_logs`
  `employee_contact_swap` tem o antes/depois de cada uma).
- 13 das 14 revisões eram `phone-unrecognized` com telemóvel VÁLIDO em `nif`
  e lixo em `phone` (8/11 dígitos, 9 dígitos com checksum de NIF errado). O
  Jorge quer a regra literal: telefone válido em `nif` troca SEMPRE. Regra
  relaxada (ver "Regras de decisão"): o lado verificado manda; o valor não
  verificado muda de coluna tal e qual e a linha sai marcada `*-unverified`
  no relatório/CLI. `nif-unrecognized` deixou de existir (passou a troca).
- Testes 21/21; `tsc` do projeto e do script limpos.
**Why**: um valor inválido está igualmente errado em qualquer das colunas; o
telemóvel, esse, só serve (WhatsApp) na coluna `phone`.
**Notes**:
- ⚠️ **Falta correr outra vez** (`--apply`) para apanhar essas 13 fichas; a
  guarda otimista garante que as 302 já trocadas não são tocadas (agora estão
  `ok`). Ficam em revisão para sempre: id 46 (mesmo número nos dois campos —
  decidir se `nif` passa a null) e id 86 (`phone` 11 dígitos, `nif` texto).
- Os `*-unverified` deixam NIFs inválidos na coluna `nif` — lista para o
  backoffice confirmar com as pessoas (o `detail` do relatório diz porquê).

