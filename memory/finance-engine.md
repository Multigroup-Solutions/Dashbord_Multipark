# Motor financeiro único — Faturação + Anual (fase 1, set 2026)

Origem: documento do Jorge "Faturação Multipark — cálculos consistentes,
previsões e histórico fiável" (set 2026). Auditoria prévia confirmou que a
Faturação (`getBillingData`) e o Anual (`getAnnualBreakdown`) eram dois motores
com fórmulas diferentes. Decisão do Jorge (9 set): avançar com a fase 1 =
**motor único + paridade + correções em bloco + testes + comparação antes/depois
em meses fechados**. Fases 2–4 (tempo/previsão, permissões/detalhes,
indicadores/qualidade) ficam por fazer.

## Arquitetura (`server/finance/`)
- `rules.ts` — **regras puras**, sem BD: `FINANCE_PARAMS` (IVA 23%, TSU 23,75%,
  tarifas extras-dia, provisões 2/12) num só sítio; `computeMargin()` = **a
  fórmula** (receita s/IVA − despesas s/IVA − pessoal − TSU − equipa do dia −
  comissões); `salaryForPeriod()` (mês completo = salário mensal; parcial =
  proporcional aos dias DO PRÓPRIO mês; início/fim de contrato; histórico por
  mês); `isExtraEmployee()` (contractType OU position); `shiftHours()` (saída
  antecipada); `buildPartnerIndex()` (conflitos assinalados);
  `commissionFor()` (0% confirmado ≠ taxa em falta ≠ sem parceiro);
  `bucketKey()` (mesmo bucket para TODAS as séries). Testes: `rules.test.ts`.
- `engine.ts` — `computeFinance({from,to,projectId,granularity})`: lê tudo
  **ao dia**, aplica as regras, e cartões/gráfico/detalhes são somas dos MESMOS
  mapas diários (batem ao cêntimo por construção; o script de paridade
  verifica). Devolve também `quality` (conflitos de parceiros, campanhas sem
  parceiro, despesas/colaboradores sem centro, inativos sem fim de contrato,
  turnos de team leader ignorados, marketing excluído, meses com variável RH).
- `compat.ts` — `getBillingData`/`getAnnualBreakdown` com a FORMA antiga do
  payload (InvoicesPage/AnnualPage não mudaram de contrato); routers importam
  daqui. Anual: `monthlyRowsFromTimeseries()` + fusão do histórico importado
  (só meses sem nada real, `fromHistory`).
- `legacy.ts` — o código antigo, intacto, SÓ para `scripts/finance-parity.ts`.
  Apagar quando a fase 1 estiver validada em produção.

## Regras fixadas (antes divergiam)
| Tema | Faturação (antes) | Anual (antes) | Agora (ambos) |
|---|---|---|---|
| Receita realizada | CHECKED_OUT por saída | `status != CANCELLED` por saída (apanhava previstas) | CHECKED_OUT por saída |
| Comissões | custo | deduzidas à receita c/IVA | **custo** (nunca deduzidas) |
| Marketing | fora | ads + marketing_expenses somados às despesas (2×) | **fora** (já está nas despesas); `quality.marketingExcluded` |
| Despesas pendentes | somadas OUTRA vez em `totalCostsAll` | — | informação (dívida), não custo |
| Pessoal | `employees.monthlySalary` atual, só ativos, /30×dias (fev 28/30) | payroll (histórico, alimentação, 13.º/14.º) | histórico por mês, mês completo = mensal, contratos, inativos c/ vínculo, provisões, variável do ponto (h. extra/noturnas/FDS/alimentação) |
| Extras excluídos por | `contractType` | `position` | os dois |
| Equipa do dia | sem filtro de cidade, team leader 2×, saída antecipada ignorada | sem cidade, TL ok, saída ignorada | cidade do centro, só extras, `sentHomeHour` |
| Gráfico | custos ∝ receita diária, sem TSU, c/IVA | — | por dia de calendário, base líquida, com TSU; Σ = cartões |
| Custos sem centro | somem no filtro; "Sem projeto" no consolidado | — | "Por atribuir" no consolidado; nunca num filtro |
| Permissões | `requireFinanceTotals` | só `requireRole(admin)` | `requireFinanceTotals` também no Anual e no diagnóstico |

## Paridade (corrida 9 set 2026 contra a BD real, só leitura)
`ENV_FILE=../.env ./node_modules/.bin/tsx scripts/finance-parity.ts 2026-06 2026-07 2026-08 2026-09`
- **Receita/recolhidos/despesas/comissões: iguais.** (A diferença de +317 €/+1165 €
  em jun/ago ao correr num PC com fuso Lisboa é do LEGADO: `new Date(to+"T23:59:59")`
  é local→UTC e cortava o último dia às 22:59; em produção (UTC) não acontecia.
  O motor usa strings — independente do fuso. A BD guarda hora de Lisboa
  "wall-clock"; o MySQL está em UTC; `CONVERT_TZ` nomeado existe.)
- **Equipa do dia ↓** (jun −1458 €: 27 turnos de team leader que contavam 2×).
- **Pessoal ↑ ~6 k€/mês**: provisões 13.º/14.º (2/12 do base) + variável do
  ponto; junho deixa de ser 30/30 e julho 31/30.
- **Margem** jun 63,2k→58,7k; jul 64,6k→58,9k; ago 100,5k→94,9k. Anual: set
  92k→40k de receita (deixa de contar previstas), out–dez 0 (eram reservas
  futuras), maio +20k de lucro (marketing deixou de contar 2×).
- Gráfico = cartões: OK nos 4 meses.
- Qualidade: 1 conflito de parceiro (mesma chave em 2 parceiros), 1 inativo sem
  fim de contrato (excluído do pessoal — preencher `contractEnd`).

## Por fazer (fases seguintes)
2. Tempo: "realizado até hoje" com pessoal cortado ao mesmo dia; previsão por
   SAÍDA prevista + carros estacionados; exceção para saídas vencidas; acabar
   com o prolongamento de 30 dias (hoje só deixa de SOMAR ao realizado — o
   cartão diz "próximos 30 dias, fora do período").
3. Permissões/detalhes: salários por pessoa só no detalhe; cartões clicáveis
   com consultas paginadas no mesmo âmbito.
4. Indicadores e qualidade na UI (receita/custo por entrega, comparação
   equivalente, última sincronização, zero ≠ sem informação).
- `diagnoseBilling` (BillingDiagnosePage) continua com as suas próprias somas —
  é um diagnóstico cru; migrar para o motor na fase 4.
- Aviso no boot `[Schema ensure] ERR …` era porque o drizzle embrulha o erro
  (`err.cause.code`); corrigido em `ensureRecentSchema`.
