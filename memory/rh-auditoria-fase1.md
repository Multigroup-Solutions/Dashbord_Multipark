# RH — auditoria set/2026 e o que foi implementado (feat/rh-fase1)

Origem: documento do Jorge "Recursos Humanos — auditoria e melhorias" (set 2026).
Objetivo: ordenados calculados a partir de turnos reais e fiáveis, permissões de
dados pessoais, faltas validadas por humanos, fecho mensal imutável.

## Motor de ordenados (`server/payroll/`)
- `shifts.ts` — emparelha check-in/out em turnos (`pairShifts`), divide cada
  turno minuto a minuto em normal / noturno (22h–07h Lisboa) / fim-de-semana
  (`splitShiftHours`; fim-de-semana > noite > normal). `countableShifts` só
  conta turnos FECHADOS com `reviewStatus` ok/approved.
- `compute.ts` — `computeEmployeeMonth` puro: dias de contrato no mês
  (admissão/saída), licença sem vencimento reduz base e provisões, turnos
  suspeitos/abertos NÃO pagam (aparecem em `suspiciousHours`/`openShifts`),
  horas esperadas vêm do horário (`expectedHoursFromSchedule`) senão 176,
  extra sem taxa para o nível → 0 + aviso. `PAYROLL_PARAMS` (TSU 11 %, IRS
  15 % assumido, "estimativa").
- `payrollData.ts` — `computePayrollForMonth(year, month, {projectId})` lê
  colaboradores com contrato a sobrepor o mês, registos ±1 dia, taxas,
  histórico salarial (snapshot do mês), licenças, horários. Filtro de centro
  = filtro global da app.
- Testes: `server/payroll/payroll.test.ts` (14) e `server/rhRules.test.ts` (8).

## Ponto (`time_records.reviewStatus`)
- ok | suspicious | approved | rejected. Check-out com corte às 12h ou fora do
  raio nasce `suspicious`. Só admin aprova (com horas corrigidas) ou rejeita —
  `rh.timeRecords.review`; lista `rh.timeRecords.suspicious`.
- Check-in/out atómicos: `insertTimeRecordAtomic` (transação + `SELECT … FOR
  UPDATE` na linha do colaborador) evita duplicados por duplo clique.
- Backfill 0064: notas com `[SUSPEITO]` → `suspicious`.

## Faltas e bloqueios
- `employee_penalties.status` pending | confirmed | dismissed. O cron
  `daily-ops` chama `detectExtraDiaNoShows(ontem)` que cria **pendentes**
  (UNIQUE employeeId+reason+relatedId → sem duplicados). Só depois de
  "Confirmar falta" (Dashboard RH, supervisor+) contam pontos; ≥3 confirmados
  bloqueia.
- `employees.blockedByDocs / blockedByPenalties / blockedManually` substituem
  a interpretação da string `loginBlockedReason`. `recomputeLoginBlocked` OR's.
  Desbloquear limpa os três (ação humana).
- Documentos: `applyDocsCompliance` marca aviso/`blockedByDocs`; o bloqueio
  automático por docs está SUSPENSO (`enforceBlock=false`) até haver processo
  de aviso — hoje só marca.

## Fecho mensal (`payroll_runs` + `payroll_run_lines`)
- draft → approved (super_admin) → paid (super_admin, `paymentRef`); qualquer
  estado → void. Cada run guarda snapshot JSON por pessoa (imutável; "Refazer"
  cria nova versão). UI: faixa no separador Ordenados.
- Dashboard RH: "Pago (fechos)" = soma de runs `paid`; "Apurado lookback" =
  estimativa viva. Os valores ao vivo são ESTIMATIVA, não ordenado.

## Permissões e dados pessoais (`server/rhAccess.ts`)
- `RhViewer` (role, employeeId, scopeProjectIds). Colaborador vê só a própria
  ficha; supervisor vê a sua cidade; admin+ tudo. `sanitizeEmployee` retira
  NIF/NIB/morada/nascimento/nacionalidade/salário para quem não é admin+.
- Documentos pessoais deixaram de expor URL pública: `rh.documents.url` gera
  URL assinada temporária e regista `view` no activity log.
- CSVs de RH usam `shared/csv.ts` (aspas, quebras, prefixo `'` em fórmulas).

## Disponibilidade por email
- `server/availabilityReply.ts` classifica sim/não/ambíguo (condicional antes
  de negação). Só "sim" limpo marca; resto vira tarefa de RH com veredicto.

## Migração
- `migration_0064.ts` (idempotente, corre no boot). 0063 está reservada ao
  branch Google Ads.

## Ainda por fazer (fases seguintes do documento)
- Bloqueio automático por documentos (com aviso prévio de X dias).
- IRS real por escalão/dependentes (hoje 15 % fixo, rotulado estimativa).
- Recibo de vencimento oficial / exportação para contabilidade.
- Ecrã de correção manual de ponto (hoje só aprovar/rejeitar com horas).
- Passar `TimeRecordsTab`/PDA a usar `rh.timeRecords.suspicious` como fila.
