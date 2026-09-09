# Despesas — correções de base + circuito financeiro (plano faseado)

Origem: documento do Jorge "Despesas Multipark — correções e controlo financeiro
completo" (set 2026). Objetivo final: saber **quanto foi gasto, aprovado, falta
pagar/reembolsar, o que está reconciliado e onde o orçamento estoura**.

Decisão do Jorge (9 set 2026): fazer JÁ a secção 2 (correções) e deixar a
estrutura preparada para o resto; **a caixa/reconciliação já existe noutra app**
(Supabase `multipark-caixa` + Comparador de Pagamentos) — aqui só se IMPORTA e
cruza, não se reconstrói.

## Fase 1 — FEITA (branch `feat/despesas-fase1-correcoes`)

### Bugs confirmados no código e corrigidos
| Bug (documento) | Onde estava | Correção |
|---|---|---|
| Filtro de cidade excluía marcas/projetos filhos (Lisboa ⊅ Redpark Lisboa) | `getExpenses` `eq(projectId)`; `summary` SQL cru | `resolveProjectIds` (já existia p/ faturação, agora exportado) em `expenseWhereFor` — lista, Excel, comparação |
| Editar uma despesa PAGA reescrevia `paidAt` = agora | `update`: `if status==='paid' paidAt=new Date()` | só ao PASSAR a paga (ou `paidAt` explícito, AAAA-MM-DD); editar descrição não mexe |
| Lista somava canceladas, comparação não; Excel perdia o último dia (`< 00:00`) | KPIs no cliente; `exportExcel` `new Date(endDate)` | `shared/expenseTotals.ts` (regra única) + `shared/expensePeriods.dayBounds` (fim = 23:59:59) |
| Comparação sem permissões (qualquer frontoffice via totais da empresa); Excel sem `requireRole` | `summary`, `exportExcel` | `server/expenseScope.ts`: visibilidade única; `canSeeAggregates` p/ totais |
| Substituição de fatura apagava o ficheiro ANTES do UPDATE | `update` | grava primeiro, apaga depois (best-effort) |
| URLs públicas dos comprovativos | cliente abria `invoiceImageUrl` | `expenses.documentUrl` → `storagePresignGet` (S3 GET assinado 10 min) com a permissão do detalhe |
| PDF metido num `<img>` no detalhe | `ExpenseDetailSheet` | `<iframe>` para PDF + botão "abrir noutro separador" |
| Recorrentes geradas ao abrir a página; select+insert sem UNIQUE | `useEffect` + `generateMonth` | `server/expenseRecurring.ts` (GET_LOCK + `recurringPeriod` UNIQUE), corre no **cron daily-ops** (⚠️ o comentário antigo dizia que o cron já o fazia — NÃO fazia) + botão manual no diálogo |
| Pesquisa ≥3 chars alargava sozinha ao histórico | cliente | switch explícito "Todo o histórico" |
| Coluna "Pagamento" ordenava por vencimento mas mostrava o método | tabela | coluna "Vencimento" (data, método por baixo) |
| Botões-ícone sem nome | tabela | `aria-label`/`title` em todos |
| 0 € mostrado enquanto carrega / em erro | KPIs, comparação | "—" a carregar, cartão de erro com "Tentar de novo" |
| Não dava para LIMPAR campos opcionais ao editar | `update` zod sem `nullable` | `null` = limpar (fornecedor, descrição, notas, vencimento, categoria, comprador…) |

**Falsos no código** (do documento): `byId` JÁ aplicava as permissões da lista;
"Água"/"Telecomunicações" estão em UTF-8 correto no código — se aparecem
corrompidas é dado gravado na BD/charset da ligação (`drizzle(DATABASE_URL)` sem
`charset`), corrige-se com UPDATE + `?charset=utf8mb4` na URL.

### Regra única de âmbito — `server/expenseScope.ts`
`resolveExpenseVisibility(user)`: admin/super_admin → tudo (deny
`finance.view_totals` → só as suas); supervisor → as suas + centro de custos da
ficha de RH **com descendentes**; backoffice/team_leader → as suas (antes: lista
vazia — UI continua "só input" mas a API é coerente com o detalhe);
frontoffice/extra → nada. `expenseConditions(filters, vis)` gera o WHERE;
`canSeeExpense(vis,row)` decide detalhe/documento/histórico. Testes:
`server/expenseScope.test.ts` (16).

### Validação e datas
`shared/expenseAmount.parseExpenseAmount` (cliente + servidor): "1.234,56 €" →
"1234.56"; positivo; ≤2 casas (nunca arredonda). Datas são DIAS de calendário
(`shared/expensePeriods`): gravam-se "AAAA-MM-DD 00:00:00", filtram-se
`[dia 00:00:00, dia 23:59:59]`; `lisbonToday()` para "hoje".
`comparePeriods()`: por defeito mês-até-hoje vs. mesmos dias do mês anterior.

### Migração 0062 (`server/migrations/migration_0062.ts`, corre no boot)
- `expenses` + `supplierNif`, `documentNumber`, `paidBy` (company|employee),
  `approvalStatus` (**legacy** por defeito = anterior ao circuito; nunca se
  inventa aprovação), `submittedAt/approvedAt/approvedById/returnReason`,
  `recurringPeriod` + UNIQUE(modelo, período); índices data/projeto/estado.
- Tabelas NOVAS (vazias, prontas): `finance_accounts` (banco/cartão/caixa,
  `externalRef` = id na app da caixa), `expense_payments` (parciais, reembolsos,
  estornos `reversalOfId`, `source`+`externalRef` UNIQUE = reimportar nunca
  duplica), `expense_budgets` (mês × centro × categoria), `expense_events`
  (histórico — JÁ EM USO: create/update/paid/document/delete),
  `finance_import_batches` (lotes idempotentes por `fileHash`).
- ⚠️ o UNIQUE das recorrentes falha (warning) se já houver duplicados
  históricos: limpar à mão; o GET_LOCK protege entretanto.

### Já em uso desta fase (além das correções)
- NIF e nº de documento: a IA preenche os campos (antes iam para as notas);
  `expenses.checkDuplicate` avisa (não bloqueia) — mesmo nº doc do mesmo
  fornecedor, ou o mesmo ficheiro. Nunca por valor+data.
- "Pago por": empresa/colaborador (default: colaborador se há comprador) — base
  dos reembolsos.
- Histórico no detalhe (`expenses.events`).
- Regra do circuito já implementada mas inerte: alteração financeira numa
  despesa `approved` → volta a `submitted` (hoje tudo é `legacy`).

## Fases seguintes (estrutura pronta, UI por fazer)
1. **Aprovações** — `approvalStatus` draft→submitted→approved|returned;
   procedimentos `submit/approve/return` (não a edição genérica); quem submete
   ou é beneficiário não aprova; admin+ aprova. Separador "Aprovações".
2. **Pagamentos e reembolsos** — `expense_payments`: N pagamentos por despesa,
   saldo = amount − Σ pagamentos não estornados; impedir liquidar acima do saldo
   (transação); reembolso ao colaborador (`paidBy=employee`) liquida a
   obrigação sem criar despesa; estorno = linha nova com `reversalOfId`
   (super_admin + motivo). `expenses.status` passa a derivado (pending/partial/
   paid) — manter coluna por compatibilidade até migrar a UI.
3. **Importação da caixa (app externa)** — `finance_import_batches` +
   `expense_payments.source='caixa_import'`. Contrato mínimo por linha:
   `externalRef` (id único na caixa), `paidOn`, `amount`, `method`, `account`
   (→ `finance_accounts.externalRef`), `reference`/descrição, e opcionalmente
   `documentNumber`/`supplierNif` para sugerir correspondência. Importar NÃO
   cria despesas: movimentos sem correspondência ficam numa fila de revisão
   (tabela a criar: `finance_unmatched` ou coluna `expenseId NULL` em
   `expense_payments`). A reconciliação bancária fica na app da caixa.
4. **Orçamentos** — `expense_budgets` por mês/centro/categoria, alertas 80%/100%
   sem bloqueio; comparar com despesas aprovadas pelo mês da despesa; agregar
   pelos centros sem somar subtotais (usar `resolveProjectIds`).
5. **Migração histórica** — despesas antigas pagas → uma linha
   `expense_payments` `source='legacy'` com `paidOn = paidAt` (conta NULL =
   "por confirmar"); pendentes ficam `approvalStatus='legacy'` em revisão.

## Pendentes de infra / decisões
- **S3 privado para `invoices/`**: hoje o bucket é público por policy
  (`scripts/provision-s3-bucket.ps1`). O código já só usa URLs assinadas para
  ler faturas; falta a policy negar GET anónimo ao prefixo `invoices/`.
- Charset: confirmar `utf8mb4` na ligação MySQL e corrigir categorias
  corrompidas na BD (não é código).
- `/api/file/<key>` referido em `client/src/lib/fileHref.ts` **não existe** no
  servidor — as despesas deixaram de precisar dele; outros módulos que o usem
  continuam com links mortos para URLs relativas antigas.
- Testes que falham na suite sem `.env`: multipark/zello (chaves), users.create
  e auth.logout (BD) — pré-existentes, não relacionados.
