# Extras · Documentos · Tarefas — desenho (9 pedidos, 2026-10-07)

Pesquisa com file:line de tudo: `docs/plans/2026-10-07-extras-tarefas-research.md` (ler primeiro).
Base: `main` @ `e5f11958`. Convenções: matriz `shared/access.ts` + `server/rhAccess.ts`; migrações runtime
`server/migrations/migration_NNNN.ts` registadas no fim de `server/migrations/index.ts` + espelho em
`drizzle/schema.ts`; regras puras em `shared/` testadas a partir de `server/**/*.test.ts` (vitest); LF; "apagar" = arquivar.

## Decisões do Jorge (2026-10-07)
- Carta < 3 anos → **etiqueta + aviso ao escalar** (não bloqueia).
- Notas internas dos extras → **team leader e acima**, no âmbito (cidade) de cada um; o próprio extra **nunca** vê.
- Candidaturas de condutores → **criam tarefa automática** (uma por candidatura) e são filtráveis.
- "Avisar este turno" → **só confirmados, com pré-visualização** (propostas por confirmar aparecem assinaladas, não recebem).

## Decisões por defeito (coordenador)
- Documentos antigos → backfill `validated` (não inundar o RH). Um documento `pending` conta como entregue para o bloqueio de login; "Documentos completos" passa a distinguir "N por validar".
- Notas do dia → por **cidade + data de calendário** (dia de trabalho), com hora opcional.
- Estados de reserva no filtro → os **9 estados Multipark** tal como em `shared/reservasDoDia.ts` (sem agrupar).
- "Gerar hoje" → quem tem `tarefas:manage` (supervisor na sua cidade, front/back office, admin+, overrides), limitado ao seu âmbito. Team leaders não.
- Cidade no "Novo lead" → **obrigatória**; só utilizadores nacionais podem escolher "Sem cidade".
- Disponibilidade (pedido 7) → **opção B, semântica de calendário em todo o lado**: o que o extra marca num dia é esse dia de calendário (como a grelha já mostra). O dia operacional D (03h D → 03h D+1) = horas [3,24) das linhas de D + horas [0,3) das linhas de D+1 (deslocadas +24). Uma linha que atravessa a meia-noite (to < from, ex. 18h–03h) continua em D+1 até `to`. Uma única função partilhada por grelha/filtro, escala automática e candidatos.

## Frentes de implementação (worktrees paralelos; migrações reservadas)
| Frente | Pedidos | Migrações | Ramo |
|---|---|---|---|
| A — RH | 1 carta, 2 documentos, 3 notas internas dos extras | 0530, 0535 | `feat/extras-rh-docs` |
| B — Extras dia | 4 notas do dia (Pressão), 7 indicador de pessoal, 8 avisar este turno | 0540 | `feat/extras-dia-escala` |
| C — Tarefas + Leads | 5 filtros + tarefas de candidatura, 6 gerar hoje, 9 cidade no novo lead | 0545 | `feat/tarefas-filtros-leads` |

### A — RH
1. **Carta:** `employees.drivingLicenseIssuedAt DATE`, `drivingLicenseValidatedAt DATETIME`, `drivingLicenseValidatedById INT`. Regra pura `shared/drivingLicence.ts` → `validated` ("Carta validada": validada pelo RH **e** ≥ 3 anos completos, calendário de Lisboa, 29/02 tratado) · `pending` ("Carta pendente de validação": documento/data sem validação) · `under_3y` ("Carta < 3 anos") · `missing` ("Sem carta"). `rh.validateDrivingLicence({employeeId, issuedAt})` (RH no âmbito, nunca a própria ficha, log). Etiquetas no cabeçalho da ficha, cartões, lista (+ filtro), PersonPicker do Extras-dia; aviso (não bloqueio) ao escalar um `under_3y`/`pending`. Ler "Data de Emissão da Carta" do payload das candidaturas quando vier (o site multidriver será atualizado à parte) e passar para lead/extra. Corrigir `leadScoring` (lê o número da carta como anos).
2. **Documentos:** `employee_documents.status ENUM(pending,validated,rejected) DEFAULT pending`, `validatedById/At`, `rejectedReason`, `archivedAt/ById`, índice. Backfill existentes → `validated`. Próprio utilizador: submete a 1ª vez (fica "Pendente de validação"), pode substituir enquanto pendente ou depois de recusado, **nunca depois de validado**. Upload do RH na ficha de outro → `validated`. Substituir = arquivar. `rh.documents.validate/reject` (RH, nunca a própria ficha, log, sino ao próprio na recusa). Badges por documento, "N por validar" na lista + filtro "Documentos por validar", `BlockedOwnDocuments` mostra o estado.
3. **Notas internas:** tabela `employee_notes` (corpo, tipo general/performance/conduct/praise, `workDate` e `assignmentId` opcionais, autor, arquivo). Ler/escrever: team leader+ no âmbito, nunca o próprio. Editar/arquivar: autor até 24 h ou admin RH. Separador "Notas internas" na ficha; atalho a partir da linha da escala no Extras-dia (pré-preenche dia + linha). Nunca devolvidas em procedimentos que o extra chama.

### B — Extras dia
4. **Notas do dia:** tabela `extras_day_notes` (cidade, `workDate`, hora opcional, corpo, autor, arquivo). Separador Pressão: seletor de dia (por defeito o dia alvo da página) + cartão "Notas do dia DD/MM" (várias notas, autor + hora, adicionar/arquivar). Ao selecionar uma célula da grelha, o detalhe mostra também as notas das últimas datas com esse dia da semana (e essa hora, se tiver). Contador de notas no separador Dia.
7. **Indicador de pessoal:** semântica de calendário única (ver acima) em `shared/` partilhada por `availabilityWindow`, `extrasSchedule` (escala automática) e candidatos; teste de propriedade "filtro e escala concordam". Indicador por hora: "precisas N (além do TL) · escalados M · disponíveis por escalar K"; aviso distingue "Faltam escalar 2 às 02h (há 2 disponíveis: Ana, Rui)" de "Falta gente às 02h (ninguém disponível)". Slots do site que acabam à 01h deixam de aparecer como "Noite 15h–03h" (mostrar horas reais). Testes de regressão do exemplo (2 pessoas até às 03h cobrem as 02h).
8. **Avisar este turno:** `extrasDia.notifyPreview` (sem efeitos) + `extrasDia.notify({…, channels})`. Janela de confirmação: por pessoa, o texto exato com o seu dia e horas (início → fim/saída antecipada), cidade, ponto de encontro; canais WhatsApp (template `aviso_trabalho`) e **email** "Aviso de trabalho — sexta 26/09, 18h–03h" (email de trabalho ou pessoal, respeita `noAutoEmail`); quem é ignorado e porquê; propostas por confirmar assinaladas e não enviadas. Idempotente por linha/versão/canal (segundo clique não reenvia; linha alterada reenvia). Email funciona mesmo sem WhatsApp configurado. Log de atividade.

### C — Tarefas + Leads
5. **Filtros "As minhas tarefas" (e quadro/lista):** origem, estado da tarefa, prioridade, prazo (atrasadas/hoje/amanhã/esta semana/sem data), **estado da reserva** (9 estados Multipark com as cores de `reservasDoDia`), responsável, cidade, pesquisa; no servidor, combináveis, guardados por utilizador, "Limpar filtros", contadores, versão móvel. `tasks.bookingRef` (0545) preenchido pelas tarefas de serviço + backfill a partir de `sourceKey`, JOIN a `multipark_bookings`. Chip do estado da reserva na tarefa. **Tarefas de candidatura:** nova origem `lead` ("Candidatura de condutor"), uma por candidatura nova, atribuída ao responsável do lead ou supervisor(es) da cidade, fecha sozinha ao converter/recusar/arquivar; idempotente.
6. **Gerar hoje:** predicado partilhado `canGenerateChecklists(user)` = `tarefas:manage` (com overrides) no cliente e servidor; remover `requireRole(admin)`; gerar só os modelos do âmbito do utilizador (sem cidade → só nacionais); log; idempotente.
9. **Cidade no Novo lead:** select "Cidade *" também na criação (cidades do utilizador; pré-selecionada se só tiver uma; "Sem cidade" só para nacionais); `extraLeads.create` aceita `projectId` validado com `assertLeadCity`; o diálogo de converter em extra pré-preenche a cidade do lead.

## Qualidade
Regras puras testadas (fronteiras, matriz de permissões, idempotência), `pnpm check` limpo, `vite build` limpo, vitest sem novas falhas (falhas antigas que precisam de BD: users, project-costs, multipark, zello, documents, auth.logout). Atualizar `docs/ajuda/*.md` e regenerar `server/assistant/helpDocs.generated.ts` (`scripts/gen-ajuda.ts`). UI PT-PT, shadcn, consistente com o resto da dashboard.
