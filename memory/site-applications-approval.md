# Candidaturas do site — aprovação (Leads de Extras → Candidaturas do site)

## Summary
O fluxo "Aprovar" das candidaturas do site multidriver ("Be a Driver"): o diálogo
(`client/src/components/CandidaturasSection.tsx`, renderizado no separador "Candidaturas do site" de
`ExtraLeadsPage`), a procedure `driverApplications.approve` (`server/routers.ts`) e
`approveApplication` (`server/webIntake.ts`). Aprovar = escolher a cidade (centro de custos), criar ou
ligar a ficha de extra pelo email, reativar uma ficha desativada só com confirmação e, opcionalmente,
mandar logo o pedido de disponibilidade por WhatsApp.

## Related
- `employee-city-derivation.md`: changelog 2026-09-17 com a origem do diálogo "aprovar = escolher a
  cidade" (`resolveApprovalCostCenter`, `planCostCenterAssignment`, ficha existente nunca é movida) e a
  derivação de cidade (`resolveCitiesForEmployeeIds`) que decide a cidade do template.
- `whatsapp-integration.md`: `sendBroadcast`, o registo por cidade `shared/driverTemplates.ts`
  (mensagem AVAILABILITY) e a regra de input `cityKey`/sem `city` no topo, tudo reutilizado aqui.
- `identity-by-email.md`: `findOrCreateExtraByEmail` (uma pessoa = um email) é o que a aprovação usa.

## Mapa
- UI: `CandidaturasSection` → `openApprove` (cidade pré-selecionada por `cityKeyFromText`) → diálogo →
  `driverApplications.approve`. `{ ok: false, needsConfirm }` → 2.º diálogo "Esta pessoa já teve ficha"
  → `confirmReactivate: true`.
- Servidor: `driverApplications.approve` (routers.ts ~5317–5380): `requireAccess(leads_extras, edit)`,
  `assertProjectAccess(projectId)`, `approveApplication`, `afterLeadChange()`, e o envio opcional.
- ⚠️ O input tem `projectId` no TOPO, por isso o middleware (`selectedCityAccess`) estreita o
  `projectScope` deste pedido à árvore da cidade escolhida. Leituras com `projectScope` feitas dentro
  da procedure (ex.: `listActiveEmployeesByIds`) só veem fichas dessa cidade.

## Changelog

### 2026-10-13 — Caixa "Enviar pedido de disponibilidade" no diálogo de aprovação
**Type**: feature (SEM migração, NÃO commitado, sobre `main` @ `94a0a6cb`)
**Scope**: `client/src/components/CandidaturasSection.tsx`, `server/routers.ts` (`driverApplications.approve`),
`server/applicationAvailabilityRequest.ts` (NOVO) + `.test.ts` (NOVO, 9 testes),
`shared/availabilityWeek.ts` (`currentWeekRangeLisbon`, `availabilityRangeError`, `availabilityRangeLabel`),
`server/extrasAutomation.ts` (`fmtWeek` delega no rótulo partilhado, mesmo texto),
`client/src/components/DateRangeNav.tsx` (prop opcional `granularities`),
`client/src/components/whatsapp/DriverCityPanel.tsx` (`renderPreview` exportada).
**What**:
- Caixa no diálogo (só para quem tem `whatsapp: edit`), DESLIGADA por defeito e reposta a cada abertura.
  Ligada: `DateRangeNav` só com Dia/Semana (+ "Livre" ao escrever datas), por defeito a semana de HOJE
  em Lisboa (segunda a domingo, `currentWeekRangeLisbon`). Pré-visualização do texto REAL do template
  da cidade escolhida (`whatsapp.templatePreview` + `renderPreview`), avisos para "cidade sem
  template", "template por aprovar na Meta" e "candidatura sem telemóvel válido".
- Input novo ANINHADO `availabilityRequest: { from, to }` (nunca `city` no topo). zod `superRefine` com
  `availabilityRangeError`, a MESMA regra do ecrã: dias válidos, início ≤ fim, os dois na mesma semana
  segunda–domingo. Com o pedido, `requireAccess(whatsapp, edit)` ANTES de aprovar.
- Ordem: aprova → `afterLeadChange` → `sendApplicationAvailabilityRequest` (NUNCA lança) →
  `logActivity` best-effort → devolve `{ ...aprovação, availabilityRequest: { sent, reason, city,
  weekLabel, broadcastId } | null }`. A UI mostra o toast da aprovação como antes e depois um 2.º toast:
  enviado, ou `toast.error` "Candidatura aprovada, mas o pedido de disponibilidade não foi enviado:
  <motivo>" (15 s). O pedido segue também pelo caminho da reativação.
- Envio = o MESMO `sendBroadcast` da Disponibilidades/pedido automático: `templateId:
  DEFAULT_WHATSAPP_TEMPLATE_ID` ("disponibilidade" → mensagem AVAILABILITY → `driver_availability`
  pt_PT em Lisboa/Faro, `disponibilidade_extras_porto` no Porto, pelo registo), `bodyParam2 =
  "semana de DD/MM a DD/MM"` (igual ao `fmtWeek` do automático), `weekStart = segunda do intervalo` (o
  link do formulário abre essa semana), `blockRecentSameTemplate: true` (D32), `sendKey =
  apv<id>:<from>:<to>` (repetir retoma em vez de duplicar).
- Verificações antes de enviar, cada uma com motivo legível: intervalo; cidade (a derivada da ficha tem
  de ser a escolhida, porque uma ficha existente noutra cidade não é movida e então não se envia); a cidade tem
  AVAILABILITY; a ficha é extra ativo visível (`listActiveEmployeesByIds`, mesma leitura do broadcast);
  telemóvel normalizável. STOP / "Não enviar WhatsApp" / sem WhatsApp / 24 h vêm do próprio `sendBroadcast`.
**Why**: pedido do Jorge: o extra recebe o pedido de disponibilidade assim que é aprovado, sem ir à
página Disponibilidades.
**Decisões**:
- Caixa desligada por defeito: é uma mensagem a uma pessoa real; a página Disponibilidades também
  exige ação explícita (confirmar).
- Um pedido = UMA semana de disponibilidade (inteira ou parte). A disponibilidade guarda-se por semana
  (segunda) e o token do formulário é por semana; um intervalo de 2 semanas abriria só a 1.ª no link.
  Mês/Ano não aparecem no seletor.
- Semana por defeito = a ATUAL (pedido explícito). A página Disponibilidades abre na PRÓXIMA
  (`weekHints.next`); a definição de semana (segunda a domingo, dias de Lisboa) é a mesma.
- Não se escreve em `availability_request_log` (só o job automático o faz); o envio manual da página
  também não. O "último contacto" vê o envio por `whatsapp_messages`.
**Gates**: `tsc --noEmit` EXIT 0 (com `NODE_OPTIONS=--max-old-space-size=8192`); suite completa
369 ficheiros / 5379 testes passam, 0 falhas; 9 testes novos. NÃO testado num browser nem contra a Meta.
**Follow-ups**:
- Testar ponta a ponta com um número INTERNO (aprovar uma candidatura de teste com a caixa ligada).
- Se o Jorge quiser intervalos de várias semanas, isso precisa de um pedido por semana (N envios) ou
  de outro template. Não está feito.
