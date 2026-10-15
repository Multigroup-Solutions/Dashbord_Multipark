# Mapa do repositório (retrato de 15 out 2026 — o código manda)

Raiz: `C:\Users\jorge\Dashbord_Multipark\Dashbord_Multipark`. Caminhos relativos à raiz. Antes de confiar num número (última migração, nº de interruptores), confirma no `origin/main`.

**Índice:** 1. Menu e páginas · 2. Módulos de acesso · 3. Routers tRPC · 4. BD (MySQL, Multipark, migrações) · 5. Crons · 6. Interruptores e definições · 7. IA · 8. Ajuda · 9. Notificações · 10. Integrações · 11. MCP do repositório · 12. Design · 13. Comandos · 14. Docs úteis

---

## 1. Menu e páginas

**Fontes:**
- O menu está em `client/src/components/DashboardLayout.tsx`: `topLevelItems`, `menuGroups` e `hubGroups` (o grupo "Dashboards" do hub junta-se aos grupos do menu).
- As rotas estão em `client/src/App.tsx` (wouter, a primeira que bate ganha).
- `canSeeItem` usa `module`, `anyOf` e `beyondOwn`. `ownLabel` dá o rótulo "A minha …" a quem só vê o que é seu.
- Os ids do hub servem a rota `/modulos?g=<id>` (`ModulesPage.tsx`).
- A ajuda liga-se pelo `pagina:` e pelas `rotas:` do front matter de `docs/ajuda/*.md`.

| Grupo | Rota | Página (`client/src/pages/`) | Módulo (menu) | Ajuda (`docs/ajuda/`, `pagina`) |
|---|---|---|---|---|
| topo | /dashboards | DashboardsPage.tsx | dashboards | dashboards.md (`dashboards`) |
| Dashboards (hub) | /financeiro | FinanceiroDashboard.tsx | financeiro | dashboards.md |
| | /operacoes-dashboard | OperacoesDashboard.tsx | dashboards | dashboards.md |
| | /pessoas-dashboard | PessoasDashboard.tsx | dashboards | dashboards.md |
| | /suporte-dashboard | SuporteDashboard.tsx | dashboards | dashboards.md |
| | /marketing | MarketingPage.tsx | marketing | marketing.md |
| Financeiro | /despesas | ExpensesPage.tsx | despesas | despesas.md |
| | /faturacao | InvoicesPage.tsx | faturacao | faturacao.md |
| | /caixa | CaixaPage.tsx | anyOf caixa, faturacao | caixa.md |
| | /parcerias | PartnershipsPage.tsx | parcerias | parcerias.md |
| | /projetos | ProjectsPage.tsx | projetos | projetos.md |
| | /marketing (+ /google-ads, /canais, /orcamentos, /web) | MarketingPage.tsx | marketing | marketing.md, web-analytics.md (`marketing.web`), google-business.md (`marketing.google-business`) |
| Pessoas | /rh | HRPage.tsx | anyOf rh, ficha ("A minha ficha") | rh-ponto.md (`rh`) |
| | /extras-leads | ExtraLeadsPage.tsx | leads_extras | leads-extras.md |
| | /formacao | TrainingPage.tsx | formacao | formacao.md |
| | /formacao/conhecimento | KnowledgeBasePage.tsx | definicoes | pesquisa-e-conhecimento.md (`conhecimento`) |
| | /avaliacao | AvaliacaoPage.tsx | anyOf avaliacao, avaliacao_operacional | avaliacao.md |
| | /pessoas/condutores-agentes | CondutoresAgentesPage.tsx | condutores_agentes | condutores-agentes.md |
| Operações | /operacoes | OperacoesPage.tsx | reservas_operacoes | reservas-do-dia.md (`operacoes`), operacoes-listas.md (`operacoes.listas`) |
| | /servicos | ServicesPage.tsx | servicos | servicos.md |
| | /operacional | OperationalPage.tsx | anyOf atividade_diaria, historico_diario, radio, passagem_resumo_dia | atividade-diaria.md (`operacional`), radio.md |
| | /tarefas | TasksPage.tsx | tarefas | tarefas.md |
| | /extras-dia | ExtrasDiaPage.tsx (+ `pages/extrasDia/`) | extras_dia | extras-dia.md |
| | /passagem-turno | ShiftHandoverPage.tsx | passagem_turno | passagem-turno.md |
| | /disponibilidade | DisponibilidadePage.tsx | anyOf disponibilidade, disponibilidade_extras | disponibilidade.md |
| Suporte | /clientes (+ /:id, /rever, /parceiros/:id, /parques/:id) | CrmClientsPage, CrmClientPage, CrmReviewPage, CrmPartnerPage, CrmParkPage | clientes | clientes.md |
| | /contactos | ContactsPage.tsx | contactos | contactos.md |
| | /reclamacoes | ComplaintsPage.tsx | reclamacoes | reclamacoes.md |
| | /criticas | GoogleReviewsPage.tsx | criticas | criticas.md |
| | /ocorrencias | IncidentsPage.tsx | ocorrencias (beyondOwn) | ocorrencias.md |
| | /perdidos-achados (+ /:section/:sub?) | LostFoundPage.tsx (+ `pages/lostFound/`) | perdidos | perdidos.md |
| Comunicação | /comunicacao | ComunicacaoPage.tsx | comunicacao | comunicacao.md, email-aliases.md (`comunicacao.aliases`) |
| | /comunicacao/meu-email | ComunicacaoPage (personal) | anyOf ficha | comunicacao.md |
| | /drive (link externo GOOGLE_DRIVE_URL) | DrivePage.tsx | anyOf ficha | drive.md |
| | /whatsapp | WhatsAppInboxPage.tsx | whatsapp | whatsapp.md, whatsapp-chamadas.md (`whatsapp.chamadas`) |
| | /central | CentralPage.tsx | central | central.md |
| | /calendario | CalendarioPage.tsx | anyOf ficha | comunicacao.md (rota listada) |
| | /tarefas | (repetida) | tarefas | tarefas.md |
| Sistema | /utilizadores (+ /rh/utilizadores) | UsersPage.tsx | utilizadores | permissoes.md (rota listada) |
| | /permissoes | PermissionsPage.tsx (+ `pages/permissions/`) | permissoes | permissoes.md |
| | /api-keys | ApiKeysPage.tsx | api_keys | api-keys.md |
| | /integracoes (+ /google-ads) | IntegrationsHubPage, IntegrationsGoogleAdsPage | integracoes | integracoes.md, integracoes-google-ads.md |
| | /logs | LogsPage.tsx | logs | logs.md |
| | /definicoes | DefinicoesPage.tsx | definicoes | definicoes.md, agendador.md (`definicoes.agendador`), ia-no-dashboard.md (`definicoes.ia`), google-tempo-real.md |

**Rotas fora do menu.** O módulo, quando não vem do menu, deduzi-o do front matter da ajuda:
- `/` → Home.
- `/dashboard` → DashboardPage.
- `/rh/dashboard` → RhDashboardPage.
- `/rh/fins-de-semana` → FinsDeSemanaPage.
- `/ferias` → FeriasPage (interruptor FERIAS_MAPA; ajuda rh-ponto.md).
- `/projetos/custos` → ProjectCostsDashboard.
- `/faturacao/diagnose` → BillingDiagnosePage.
- `/anual` → AnnualPage (módulo `anual`; ajuda faturacao.md).
- `/parcerias/tipo/:typeId` → PartnerTypePage.
- `/reserva/:ref?` → BookingFilePage (ficha-reserva.md, `reserva`).
- `/modulos` → ModulesPage; `/perfil` → ProfilePage (perfil.md; ambas pessoais, ver `shared/routeAccess.ts`).
- `/multis/falhas` → MultisFalhasPage (só admin/super_admin; multis.md).
- `/convite/:token` → InvitePage; `/pda/registar` → PdaRegisterPage.

**Redirecionamentos:**
- `/despesas/dashboard` → `?tab=resumo`
- `/radio` → `/operacional?tab=radio`
- `/parcerias/inferir` → `/parcerias`
- `/multipark/inspect` → `/reserva`
- `/multipark/sync` → `/definicoes?tab=estado`
- `/multipark/:section?` → `/operacoes?tab=…`
- `/avaliacao-operacional` → `/avaliacao?tab=dia`
- `/marketing-dashboard` → `/marketing`

**Páginas sem rota em `App.tsx`:** ComponentShowcase, ExpenseDashboard, MarketingGoogleAdsPage, RadioPage, ScheduleReviewPage, ProjectsParkCoverageCard.

**Ficheiros de ajuda sem item de menu próprio:** entrada.md (`dashboards.entrada`, rotas `/` e `/modulos`), multis.md, perfil.md, pesquisa-e-conhecimento.md, ia-no-dashboard.md, google-tempo-real.md.

---

## 2. Módulos de acesso

**`shared/access.ts`** é a fonte única para o servidor e para o cliente.
- `ROLES`: user, extra, condutor, team_leader, supervisor, frontoffice, backoffice, admin, super_admin.
- `ROLE_RANK`: 0, 1, 2, 3, 4, 5, 5, 6, 7 (frontoffice = backoffice).
- `NATIONAL_ROLES` = frontoffice, backoffice, admin, super_admin. Os restantes são papéis de cidade.
- `Access` (alcance): none, own, below_city, city, national. `Action`: view, edit, export, manage.
- Na `MATRIX_SPEC` a notação é `"alcance:letras"`, com v/e/x/m.
- **Módulos (`ModuleId`):**
  - Pessoal/Pessoas: ficha, formacao, disponibilidade, avaliacao, avaliacao_operacional, condutores_agentes, rh, rh_salarios, leads_extras.
  - Operações: servicos, historico_diario, pdas, tarefas, reservas_operacoes, atividade_diaria, radio, extras_dia, passagem_turno, passagem_resumo_dia, disponibilidade_extras, whatsapp.
  - Suporte: clientes, contactos, comunicacao, central, reclamacoes, criticas, ocorrencias, perdidos.
  - Financeiro: despesas, parcerias, projetos, marketing, financeiro, anual, faturacao, caixa.
  - Dashboards: dashboards.
  - Sistema: utilizadores, permissoes, sincronizacao, integracoes, definicoes, logs, api_keys, manutencao.
- **Só super_admin:** marketing, logs, anual, faturacao, caixa, api_keys, manutencao. Admin e super_admin: dashboards, financeiro, projetos, definicoes, integracoes, rh_salarios.
- **Funções:**
  - `can(user, module, action="view")`, `grantFor` (override ativo ou papel), `roleGrantFor`, `effectiveGrants`, `scopeFor`, `seesBeyondOwn`, `activeOverride`.
  - `assignableRoles`, `canManageUserRole`, `canGrantPermissionsTo`, `canTouchPermission`, `canSeeFinanceTotalsFor`.
  - `ROLE_ONLY_MODULES` = `["logs"]`. Chave dos overrides: `module.<id>`.
- A tabela legível está em `docs/permissoes.md`, gerada por `pnpm tsx scripts/gen-permissoes-doc.ts`; há um teste que a verifica.

**`server/_core/access.ts`:**
- `requireAccess(user, module, action, {allowOwn})` devolve o alcance ou lança FORBIDDEN.
- Também: `canAccess`, `withOverrides`, `isOwnOnly`, `userIdsAtOrBelowInCity`, `employeeBelowCondition`.

**`server/_core/accessContext.ts`:** `accessRequest` (AsyncLocalStorage com as permissões do pedido), `moduleForPath`, `adjustCityScope`, `allCitiesFrom`.

**Guardas comuns:**
- `server/routerGuards.ts`:
  - `requireRole` só serve para limiares finos dentro de um módulo; a porta de cada módulo é `requireAccess`.
  - Também: `isPermissionDenied`, `canSeeFinanceTotals`, `requireFinanceTotals`, `resolveDeactivationOrThrow`.
- `server/rhGuards.ts`:
  - `rhViewer`, `rhEmployeeRef(OrThrow)`, `employeeAccountRole`.
  - `assertEmployeeWriteScope`, `assertOwnOrScopedEmployee`, `assertCanViewDocuments`, `assertCanViewTimeRecords`, `assertCanUploadDocuments`, `assertCanManageEmployee`.
  - `requireNationalRhManage` (`NATIONAL_ONLY_MESSAGE`), `assertAgentHoldersInScope`, `employeeIdOfRecord`.
  - As regras puras estão em `server/rhAccess.ts`.
- `server/cityScope.ts`:
  - `cityScope` é um AsyncLocalStorage preenchido pelo middleware.
  - `projectScope(column)` devolve `1=1` (todas), `IN (...)` ou `1=0`.
  - Também: `scopedProjectIds`, `cityNameScope` (lisboa/lisbon, porto/oporto), `scopedCityNamesLive` (leituras ao vivo da BD da Multipark), `bookingHistoryScope`, `employeeScope`, `userScope`, `partnerScope`, `requireGlobalCityAccess`, `assertProjectAccess`, `assertEmployeeAccess`, `pdaScope`, `zelloPdaScope`, `gpsRowOwnScope`, `gpsRowScope`.
- `server/cityAccess.ts`:
  - Tipo `CityAccess { all, cityIds, projectIds, cityNames, missingCostCenter … }`.
  - `MISSING_COST_CENTRE_MESSAGE`.
  - Também: `isPersonalAccessPath`, `blockedSelfPathKind`, `ownRecordEmployeeId`, `hasForeignCityFilter`, `scopeCityQuery`, `applyCityPermissions`, `selectedCityAccess`, `resolveCityAccess`, `applyRoleScope`, `loadCityAccess(Parts)`.
- `server/cityScopeGuards.ts`: `assertScopedOperation(path, type, input)`.
- **`missingCostCenter`:** no `requireUser` (`server/_core/trpc.ts`), quem não tem centro de custos só abre a própria ficha, com cidades vazias. No cliente, `NO_COST_CENTER_ROUTES` em `shared/routeAccess.ts` e `NoCityNotice` em `client/src/components/OwnAccessNotice.tsx`.

---

## 3. Routers tRPC

`appRouter` está em `server/routers.ts` (7351 linhas). Prefixos e onde estão:

| Prefixo | Ficheiro | Nota |
|---|---|---|
| system | server/_core/systemRouter.ts | sistema |
| admin, auth (+ `loginProcedures` de server/loginRouter.ts), users, projects | routers.ts inline | entrada, código, utilizadores, projetos |
| tasks | server/tasksRouter.ts | Tarefas |
| mail, googleAccount | server/mail/router.ts | caixas Gmail; ligar a conta Google |
| googleCalendar | server/google/router.ts | Tarefas/Calendário Google (sync pessoal) |
| googleDrive | server/google/driveRouter.ts | Drive/Docs/Sheets |
| contacts | server/contactsRouter.ts | pesquisa unificada, diretório |
| bookingFile | server/bookingFileRouter.ts | ficha da reserva ao vivo (BD Multipark) |
| cashCheck | server/cashCheckRouter.ts | conferência de caixa "era/é" |
| assistant | server/assistant/router.ts | Multis |
| search | server/globalSearchRouter.ts | Ctrl+K |
| knowledge | server/knowledge/router.ts | Base de conhecimento |
| settings | server/settingsRouter.ts | Definições (crons, interruptores, definições, segurança, uso da IA) |
| central | server/centralRouter.ts | Central Vodafone (só super admin) |
| evaluation | server/evaluationRouter.ts | Avaliação (motor único) |
| aiOps | server/aiOps/router.ts | briefing, anomalias, leads |
| commsRouting | server/commsRoutingRouter.ts | o que a IA moveu entre caixas |
| categories, logs, permissions | inline | |
| expenses | server/expensesRouter.ts | Despesas (regras em expenseScope.ts) |
| rh | server/rhRouter.ts | fichas, ponto, férias; sub `rh.leaves` (leavesRouter.ts), `rh.docsRequest` (rhDocsRequestRouter.ts), `rh.weekends` (rhWeekendsRouter.ts) |
| accountLink | server/accountLinkRouter.ts | "Liga a tua conta" |
| marketing | inline | + `marketing.web` (server/webAnalytics/router.ts), `marketing.gbp` (server/integrations/googleBusiness/profileRouter.ts) |
| operational | server/operationalRouter.ts | PDAs, ponto, Zello |
| terminal | server/terminalRouter.ts | terminal pelo perfil |
| pontoModes | server/pontoModesRouter.ts | modo do ponto |
| integrations | inline | `.googleAds`, `.meta`, `.googleBusiness`, `.hub` (server/integrations/…/router.ts, hubRouter.ts) |
| apiKeys | server/apiKeysRouter.ts | API Keys |
| complaints, notifications, reviews, lostFound, incidents, performance, services, invoices, shiftHandover, partnerships, annual, multipark | inline | |
| training | server/trainingRouter.ts | + `training.tutor` (trainingTutorRouter.ts) |
| extrasDia | inline | + `extrasDiaShiftProcedures` (extrasDiaShiftRouter.ts), `timesProbeProcedures` (sondaTemposRouter.ts) |
| extrasAvailability | inline | + `availabilityPatternProcedures` (availabilityPatternRouter.ts) |
| driverApplications, identityLinks, extraLeads, crm, clients | inline | |
| whatsapp | inline | + `whatsapp.calls` (server/whatsappCallsRouter.ts) |

Há ainda routers locais de autenticação dos streams em `server/centralRing.ts` e `server/whatsappCallStream.ts`.

**Base em `server/_core/trpc.ts` (158 linhas):**
- `publicProcedure` = `t.procedure.use(storageLinks)`.
- `protectedProcedure` = `requireUser` + `storageLinks`. O `requireUser` faz, por esta ordem:
  - bloqueio de login (`loginBlock.ts`);
  - overrides (`getUserModuleOverrides`);
  - `loadCityAccess`;
  - regra `missingCostCenter`;
  - recusa de filtro de outra cidade e `scopeCityQuery`;
  - `cityScope.run(...)`;
  - `assertScopedOperation`.
- `adminProcedure`: papel admin ou superior.
- **`adminOnly` e `superOnly` não estão no trpc.ts.** São locais de cada router:
  - `settingsRouter.ts`: `adminOnly = protectedProcedure.use(requireAccess "definicoes" view)`, mais `requireSuperAdmin` e `requireAdminRole`.
  - `centralRouter.ts`: `superOnly` como middleware.
  - Como funções `(u) =>`: `contactsRouter.ts`, `google/router.ts`, `google/driveRouter.ts`, `mail/router.ts`.
- **Middleware `storageLinks`:**
  - À entrada, `canonicalStorageUrlsDeep` repõe os URLs canónicos.
  - À saída, `signStorageUrlsDeep` assina os URLs com `makeViewerSigner` (`server/storageSign.ts`, `server/fileRoute.ts`).
  - **Gancho da cache:** numa mutation com utilizador, se `mutationClearsSlowCalls(path, input)` for verdadeiro, chama `forgetSlowCallsOf(userId)` (`server/assistant/slowCallCache.ts`, plano MPV F4).

---

## 4. BD

**`drizzle/schema.ts` (MySQL, 5231 linhas, 230 `mysqlTable`), por domínio:**
- **Contas e acessos:** users, user_permissions, login_codes, invite_tokens, api_keys, oauth_states, account_link_requests, personal_devices, web_push_subscriptions, activity_logs, removed_records.
- **Definições e crons:** app_settings, app_settings_audit, cron_runs, cron_job_state, app_notifications, app_notification_maintenance.
- **RH e ponto:** employees, employee_documents, employee_docs_requests, employee_notes, employee_leaves, employee_salary_history, employee_penalties, employee_bank_change_requests, employee_ponto_modes, ponto_alerts, ponto_mode_acks, time_records, terminal_sessions, terminal_handover_requests, schedules, schedule_overrides, payroll_runs, payroll_run_lines, payslip_history, rh_attachment_reads, driver_applications, project_employees, projects.
- **Avaliação:** performance_evaluations, employee_day_metrics, employee_metric_adjustments, employee_metric_disputes, evaluation_accidents, evaluation_explanations.
- **Extras:** extras_dia_assignments, extras_dia_schedules, extras_dia_notifications, extras_dia_alerts, extras_day_notes, extras_availability, extras_availability_pattern, availability_form_tokens, extra_rates, extra_leads, extra_lead_sources, extra_lead_scores, ops_pressure_days.
- **Operações e GPS:** pdas, pda_checkins, daily_driver_history, gps_alerts, speed_alerts, speed_limits, speed_violations, ops_presence_alerts, service_times, services, vehicles, vehicle_movements, shift_handovers, shift_handover_reminders, radio_transcriptions, tasks, task_assignees, task_templates, task_comments.
- **Reservas (cópia financeira e webhook):** multipark_bookings, multipark_booking_extras, multipark_booking_history, booking_history, multipark_daily_snapshots, multipark_sync_logs, multipark_sync_coverage, multipark_sync_lock, multipark_reconciliation, multipark_sync_alerts, multipark_agents, multipark_db_cursors.
- **Financeiro:** expenses, expense_categories, expense_payments, expense_budgets, expense_events, recurring_expenses, finance_accounts, finance_import_batches, invoices, annual_reports, partnerships, partnership_invoices, partnership_transactions, partner_aliases, marketing_expenses.
- **Suporte:** complaints, complaint_messages, complaint_photos, complaint_drivers_on_duty, complaint_penalty_config, complaint_mail_intake, incidents, lost_found_items, lost_found_messages, lost_found_photos, lost_found_attached_drivers, lost_found_matches, google_reviews, review_auto_publish, faqs.
- **Comunicação:** mail_mailboxes, mail_accounts, mail_threads, mail_messages, mail_send_requests, mail_auto_sends, mail_links, inbound_emails, comms_ai_routing, whatsapp_conversations, whatsapp_messages, whatsapp_quick_replies, whatsapp_pending_statuses, whatsapp_broadcasts, whatsapp_calls, whatsapp_call_permissions.
- **Google:** google_user_accounts, google_sync_state, google_task_links, google_calendar_events, google_shared_calendars, google_watch_channels, google_sync_pending, google_meetings, google_directory_people, google_directory_state, google_contacts_state, google_user_contacts, google_pushed_contacts, google_drive_links, google_drive_folders, google_drive_mirror, google_doc_templates, google_drive_state.
- **CRM:** crm_contacts, crm_clients, crm_client_emails, crm_client_phones, crm_client_vehicles, crm_client_external_ids, crm_booking_links, crm_client_relations, crm_merge_suggestions, crm_merge_events, crm_saved_filters, crm_blocked_identifiers, crm_removed_items, crm_pro_accounts, crm_pro_parks, crm_pro_ledger, crm_partner_links.
- **Marketing:** campaigns, campaign_daily_stats, internal_campaigns, internal_campaign_keys, internal_campaign_costs, ad_accounts, ad_campaigns, ad_daily_metrics, ad_conversion_action_metrics, ad_campaign_links, google_ads_clicks, google_ads_click_days, marketing_budgets, integration_connections, integration_alert_state, integration_sync_runs, web_ga_daily, web_ga_dims, web_sc_daily, web_sc_dims, web_pagespeed_runs, web_pagespeed_audits, web_crux_records, web_analytics_state, gbp_daily_metrics, gbp_search_keywords.
- **Formação:** training_categories, training_manuals, training_videos, training_paths, training_path_items, training_assignments, training_progress, training_attempt_sessions, training_quiz_ai_questions, training_promotions, training_certificates, quiz_attempts, quiz_questions, career_exams, career_exam_questions, career_exam_attempts, training_tutor_messages, training_tutor_questions.
- **IA:** ai_usage_log, ai_budget_alerts, ai_rate_limits, ai_context_caches, ai_suggestions, ai_chat_conversations, ai_chat_messages, assistant_memories, assistant_feedback, ops_briefings, ops_anomalies, ai_weekly_reports, kb_documents, kb_chunks, kb_sync_state.
- **Tabelas que só existem nas migrações (SQL cru, sem schema.ts):**
  - cash_cases, cash_case_events, cash_counts, cash_count_log, cash_count_expenses, cash_confirm_* (days, decisions, events, files, file_removals, justifications, stripe_checks), cash_day_reviews, cash_day_review_log, cash_external_runs, cash_live_snapshots, cash_mb_days, cash_mb_receipts, cash_monthly_receipts, cash_sweep_state, cash_viva_imports, cash_viva_txns, cash_agent_perms;
  - central_accounts, central_calls, central_requests, multipark_webhook_jobs, multipark_webhook_snapshots, ops_pressure_stats, partner_city_presence, radio_evidence, service_extra_done, service_task_retries, whatsapp_request_answers, google_business_locations, google_business_review_pending, extras_dia_assignments_removed.

**BD da Multipark (Postgres, só leitura): `server/multiparkDb/`**
- `client.ts`:
  - env `DATABASE_URL_MULTIPARK`; pool de 2 ligações; ligação 5 s; instrução 15 s (máximo 40 s);
  - `multiparkDbQuery`, `getMultiparkDb`, `testMultiparkDbConnection`, `redactSecrets`, `sslFromUrl`, `MultiparkDbError`.
- **`assertReadOnlySql(sql)`** (linha 168), pura:
  - só aceita SELECT, WITH, SHOW ou EXPLAIN (EXPLAIN ANALYZE não), e uma só instrução;
  - recusa palavras de escrita, DDL ou bloqueio, `\`, `$$`, `/*!`, `--` sem espaço, `FOR UPDATE/SHARE` e `INTO`.
- Defesa em três camadas: guarda de SQL, sessão `READ ONLY` e `BEGIN READ ONLY`, com ROLLBACK sempre.
- **Leitores, por tema:**
  - Reservas e operações: bookingFile, bookingSearch, dayBookings, opsLists, opsCounts, movements, historyLive, activityLive, shiftState, extrasBookings, serviceRows, serviceExtras, pressure, sondaTempos, radioActions.
  - Caixa: cashCheck, cashDay, cashConfirm, cashExternal, cashSweep.
  - Parceiros e Pro: partners, partnerships, partnershipsPro, partnerBilling, partnerClose, partnerPresence, pro.
  - CRM, marketing e finanças: crmLive, marketingBookings, marketplaceSql, financeAgg.
  - Agentes: agentRegistry, agentCities, activeAgentsExport(+Routes).
  - Preço inicial: initialBookingPrice(+Remote, +Routes), priceExportEnvelope.
  - Diagnóstico e esquema: probe, diff, profile, schemaDoc, queries, read.
  - Outros: parkZonesSuggest, terminalZonesSuggest, perfPartnerCharges, perfReturnFlights.
- Documentação: `docs/multipark-db/` (README, schema.md gerado, mapeamento, plano-duas-bd).

**Migrações: `server/migrations/index.ts`**
- `SCHEMA_MIGRATIONS` lista pares `[id, carregador]` por ordem crescente; `ensureRecentSchema` aplica-as no arranque.
- Cada `migration_NNNN.ts` exporta `MIGRATION_NNNN_STATEMENTS` e `IDEMPOTENT_ERROR_CODES_NNNN`.
- No fim há passos de dados à parte: 0410, 0545, 0675, 0680.
- As migrações 0044–0049 são só à mão (`MANUAL_ONLY` no teste; `scripts/run-migration.ts`).
- `server/migrations/index.test.ts` verifica:
  - ids de 4 algarismos, sem repetir, por ordem;
  - a primeira é 0050;
  - todos os ficheiros estão registados.
- **Última: `0830`** (as anteriores são 0820, 0825; antes saltou de 0715 para 0820).
- **Regra de 5 em 5:** não está no código. Está escrita em `.claude/agents/multipark-dashboard-specialist.md` (linha 17) e em `.claude/skills/especialista-dashboard-2026/references/processo.md` §8: ver o último número no origin/main e nos ramos abertos antes de escolher. O histórico tem exceções (0058–0101 seguidos, 0123, 0138, 0376).

---

## 5. Crons

- **`server/cronSchedule.ts`** (parte pura):
  - `TICK_JOBS` com `key`, `runName`, `label`, `cadence` (interval/daily/weekly/monthly, hora de Lisboa), `priority`, `minMs` e `maxMs`;
  - `effectiveTickJobs`: o mail-sync passa a 1440 min com o push do Gmail saudável;
  - `isDue`, `lisbonParts`;
  - constantes: `TICK_BUDGET_MS` 50 s, `MAX_ATTEMPTS` 3, `RETRY_AFTER_MS` 30 min, `MONTHLY_CATCHUP_DAYS` 6, `ZELLO_SAMEDAY_WINDOW` 23:15–23:55.
- **`server/cronScheduler.ts`**: `JOB_RUNNERS` (as mesmas chaves que `TICK_JOBS`), lease em `cron_job_state`, retoma pelo cursor, linha em `cron_runs`, resposta 202 com `waitUntil`; `?wait=1` espera pelo relatório.
- **`server/cronJobs.ts`**: as funções `*Cron`, partilhadas pelo tick e pelos endpoints manuais (por exemplo `dailyOpsCron`, `mailSyncCron`, `googleAdsCron`).
- **`shared/appSettings.ts` `CRON_JOBS`**: `name`, `label`, `intervalMinutes`, `workflow` para o Estado do sistema. Inclui também `tick` (cron-job.org, 5 min), `knowledge-sync` (manual) e `google-business` (manual, em pausa). Há ainda `cronHealth`, `staleThresholdMinutes`, `CRON_MIN_STALE_MINUTES` 30, `RETIRED_CRON_AFTER_DAYS` 7, `CRON_SKIP_PROBLEM_DAYS` 2.
- **Endpoints** (Bearer `CRON_SECRET`, `server/cronAuth.ts`):
  - Principal: `GET /api/cron/tick` em `server/_core/api-entry.ts`, chamado de 5 em 5 min pelo cron-job.org. `.github/workflows/cron-tick.yml` só o chama à mão.
  - Manuais em `server/_core/api-entry.ts`: multipark-deliveries, multipark-db-{schema, probe, diff, profile}, identity-sweep, crm-sync, crm-pro-sync, crm-suggestions, services-tasks, cash-{sweep, close, external}, extras-pressure, service-times, daily-ops, zello-sameday, rh-docs-{weekly, request}, evaluation-recompute, extras-auto, ops-briefing, ops-anomaly-retries, extras-schedule, extras-reminders, reviews-5star, ai-comms.
  - Noutros ficheiros: mail-sync (`server/mail/routes.ts`); google-sync e knowledge-sync (`server/google/routes.ts`); google-ads (`server/integrations/googleAds/routes.ts`); meta-ads (`server/integrations/meta/routes.ts`); web-analytics; google-business (`server/integrations/googleBusiness/routes.ts`).
  - O registo de corridas é `cronRunRecorder` em `app.use("/api/cron")`.
- **`docs/ajuda/agendador.md`**: configurar o cron-job.org, "O que corre e quando", o cartão "Agendador" e as corridas manuais.

**Trabalhos do tick (cadência, hora de Lisboa):**

| A cada… | Trabalhos |
|---|---|
| 5 min | mail-sync (1440 min com push saudável), ops-presence, terminal-watch, gps-resplit-backfill (só a pedido do super admin) |
| 15 min | ai-comms, mail-backfill; extras-schedule e extras-reminders (só 08–23 h) |
| 30 min | reviews-5star (08–23 h), crm-pro-sync |
| 60 min | multipark-deliveries, google-pending, extras-auto, identity-sweep, cash-confirm-recheck, google-ads-clicks |
| 180 min | cash-sweep |
| 240 min | google-sync |

| Hora | Trabalhos diários (Lisboa) |
|---|---|
| 03:40 | google-watch-renew |
| 04:00 | crm-sync |
| 04:30 | daily-ops; evaluation-recompute (depois do daily-ops; recurso às 06:00) |
| 04:45 | extras-pressure |
| 05:15 | crm-suggestions; crm-auto-merge (depois do crm-suggestions; recurso às 06:00) |
| 05:30 | service-times (depois do daily-ops; recurso às 07:00) |
| 05:40 | partner-mp-sync |
| 05:45 | google-ads, meta-ads |
| 06:15 | cash-close |
| 06:40 | partner-close |
| 07:00 | cash-external |
| 07:30 | ops-briefing |
| 09:00 | ops-anomaly-retries, web-analytics |
| 18:00 | services-tasks, services-tomorrow |
| 23:15–23:55 | zello-sameday |

Semanais e mensais:
- À segunda: rh-docs-weekly (04:45), kb-faq-weekly (09:30), rh-docs-request (10:00).
- Ao domingo: google-ads-recent (06:15).
- Ao dia 2 de cada mês, às 05:45: google-ads-monthly, meta-ads-monthly.

---

## 6. Interruptores e definições

**`AUTOMATION_FLAGS`** (`shared/appSettings.ts`, linha 1230; 104 interruptores). Legenda: **OFF** = `defaultEnabled:false` (sem marca = ligado por omissão); **SA** = `superAdminOnly`.
- **Extras:** EXTRAS_AUTOMATION; EXTRAS_AVAILABILITY_AUTO_REPLY (segue EXTRAS_AUTOMATION); EXTRAS_REMINDERS OFF; EXTRAS_SCHEDULE_ALERTS OFF; EXTRAS_COMPLETE_BEFORE_CONFIRM OFF; EXTRAS_ASK_CITY OFF; EXTRAS_DOCS_REQUEST OFF; TRAINING_BLOCKS_ESCALA OFF.
- **Leads, avisos e emails:** LEAD_REMINDERS; LEAD_AUTO_REPLY OFF; MARKETING_WEEKLY; COMPLAINT_CLIENT_REPLY_NOTIFY OFF; ACCOUNT_LINK_EMAIL_CODE OFF; RH_BANK_CHANGE_NOTIFY OFF; TASK_ASSIGNED_NOTIFY OFF; NOTIFY_CRITICAL_MANDATORY OFF; INTEGRATION_DISCONNECT_NOTIFY OFF.
- **WhatsApp e email:** WHATSAPP_SLA_NOTIFY; WHATSAPP_CALLS OFF; WA_TRIAGE_SKIP_STAFF OFF (grupo ia); MAIL_PUSH OFF.
- **Google Business e críticas:** GBP_PUSH; GBP_WINDSOR_SYNC OFF; GBP_WINDSOR_REPLY OFF; REVIEW_AUTO_PUBLISH_5STAR OFF SA; REVIEWS_EMAIL_STRICT OFF; REVIEWS_DEDUP OFF.
- **RH, ponto e entrada:** RH_FALTAS_HORARIO OFF SA; FERIAS_MAPA OFF SA e FERIAS_AVISOS OFF SA (as constantes estão em `shared/leaves.ts`); FINS_DE_SEMANA OFF SA; FINS_DE_SEMANA_AVISO OFF SA; PONTO_TERMINAL OFF; PONTO_MODOS OFF SA; ENTRAR_COM_CODIGO OFF SA; GOOGLE_NOS_PDAS SA; ZELLO_PDA_NAMES OFF.
- **Operações:** GPS_SPEED_ALERTS OFF; TASKS_AUTOMATION; TASKS_AUTO_OVERDUE; CASE_REMINDERS; COMPLAINT_AUTO_ACK; HANDOVER_EMAIL; HANDOVER_REMINDERS; TRAINING_REMINDERS; KB_FAQ_WEEKLY OFF; OPS_BRIEFING; WEEKLY_REPORTS; OPS_ANOMALIES; OPS_PRESENCE_ALERTS OFF; OPS_PRESENCE_WHATSAPP OFF; SERVICE_TASKS_TOMORROW_ALERT OFF; SERVICE_TIMES OFF SA.
- **CRM e parceiros:** CRM_AUTO_MERGE SA (ligado); AGENT_EMAIL_AUTOLINK; PARTNER_MP_SYNC OFF; PARTNER_CLOSE_ALERTS OFF.
- **Caixa:** CASH_STRIPE_CHECK, CASH_VIVA_CHECK e CASH_INVOICEXPRESS_CHECK, todos OFF SA.
- **Central:** CENTRAL_SUGAR OFF SA; CENTRAL_RING OFF SA.
- **Marketing:** GOOGLE_ADS_CLICK_SYNC.
- **IA** (`group:"ia"`; AI_ENABLED desliga tudo de uma vez):
  - Ligados: AI_ENABLED, AI_EXPENSE_OCR, AI_REVIEW_DRAFTS, AI_RADIO, AI_HANDOVER_SUMMARY, AI_WHATSAPP_ASSIST, AI_QUIZ, AI_QUIZ_LIVE, AI_KB_FAQ, AI_TRAINING_TUTOR, AI_COMPLAINT_TRIAGE, AI_REVIEW_AUTO_DRAFTS, AI_WHATSAPP_TRIAGE, AI_LOST_FOUND_MATCH, AI_ASSISTANT, AI_ASSISTANT_MEMORY, AI_OPS_BRIEFING, AI_WEEKLY_REPORTS, AI_ANOMALY_EXPLAIN, AI_AVAILABILITY_CLASSIFY, AI_LEAD_SCORING, AI_EVALUATION_EXPLAIN, AI_HANDOVER_REPEATS, AI_MAIL_ROUTING, AI_MAIL_COMPLAINTS, AI_MAIL_DRAFT, AI_GBP_POSTS, AI_PAGESPEED_EXPLAIN, AI_WEB_INSIGHT, AI_KNOWLEDGE, AI_TASKS_FROM_TEXT.
  - OFF: AI_CRM_IDENTITY, AI_ASSISTANT_SMART, AI_HR_AUTOFILL, AI_HR_EMAIL_ATTACHMENTS, AI_MAIL_LOST_FOUND, AI_MAIL_PARTNER_CASES, AI_MAIL_NOTICES, AI_MAIL_BACKFILL, AI_MAIL_ALIAS_FILTER.
  - OFF SA: MPV.

**`SETTINGS`** (`shared/appSettings.ts`, linha 445; `SettingDef` com `key`, `group`, `schema`, `defaultValue`, `wiring` live/store, `writeSchema`). Grupos (`SettingGroup`) e chaves principais:
- **financeiro:** finance.vat, finance.tsu.
- **sla:** sla.incidentHours, sla.lostFoundDays, sla.mailHours, sync.webhookStaleHours.
- **emails:** emails.handoverCc, mail.retentionYears, mail.backfillDays, mail.systemSender, mail.brandDomains, mail.aliasDomains, google.sharedCalendars, google.contacts, google.drive.
- **disponibilidade:** availability.assigneeEmail.
- **ia:** ai.monthlyBudgetEur, ai.featureTiers, ai.thinkingLevels, ai.assistantLimits, ai.assistantPilot, ai.assistantSmartLimits, ai.assistantSmartBudget, ai.commsRouting, ai.mailComplaints, ai.mailBackfill, ai.priceOverridesEur, ai.trainingTutorLimits, KNOWLEDGE_SETTING_KEY.
- **extras:** extras.crewRules, extras.timesSince, extras.timesPercentile, extras.useMeasuredTimes, extras.pairPickups, extras.tightUsesQueue, extras.autoProposeAt, extras.autoProposeDaysAhead, extras.autoConfirm, extras.autoConfirmAt, extras.manualEditAtConfirm, extras.reminderRecipients, extras.meetingPoints, ponto.terminalAirports, rh.docsRequestTemplates.
- **operacao:** zello.gpsExcludedUsers, speed rule, operations.excludedParks, operations.parkZones, operations.garageRoles, serviceTimes.* (targetMinutes, pickupT2TargetMinutes, since, gpsSince, useCalls, inBriefing, gpsGate), multipark.agentUrl, rh.suspendAfterDays, rh.missingCityAssignee, ops.presencePhones, ops.presenceEscalateMinutes, ops.presenceTemplate, login.codeDelivery.
- **servicos:** SERVICE_TASKS_SETTING_KEY.
- **marketing:** web analytics, GBP.
- **pessoas:** pesos do ranking, avaliação fechada até, quem fecha a avaliação, no-show skip, HR people, leaves view all, aprovações de férias, dias de férias por ano.
- **notificacoes:** notifications.routing.
- Lista só para super admin: `SUPER_ADMIN_SETTING_KEYS` (linha 1147) e `settingSuperAdminOnly`.

**Como se leem:**
- **`isFeatureEnabled(name, {defaultEnabled, env, overrides})`** (`server/_core/featureFlags.ts:45`). Precedência: sobreposição na BD (`app_settings`, chave `flag.<NOME>`, cache de 30 s, `ensureFeatureFlagOverrides`) → variável de ambiente (`parseSwitch`: off/false/0/no/não…) → omissão.
  - Atenção: a omissão do `isFeatureEnabled` é `true`. Os interruptores desligados por omissão têm de passar `defaultEnabled: automationFlagDefault(name)` ou `false`.
- **`automationFlagDefault(name)`** (`shared/appSettings.ts:1396`): o `defaultEnabled` do catálogo, ou `true`. Há também `automationFlagFollows`, `automationFlagSuperAdminOnly`, `normalizeFlagEnv`, `flagSettingKey`.
- Wrappers locais: `flagOn` (`server/scheduleOverrides.ts`), `scheduleFlagOn` (`extrasSchedule.ts`), `reviewFlagOn` (`reviewCleanup.ts`), `windsorFlagOn`, `cashFlags` (`cashExternal.ts`), `googleOnPdasFlag` (`pdaSession.ts`).
- **`getSetting(key)`** (`server/appSettings.ts:87`): valor gravado e validado, ou `null`, e nunca lança. Também: `getSettingFresh`, `setSetting` (auditoria e conflito de `expectedUpdatedAt`), `listSettings`, `listAutomationFlags`, `loadFeatureFlagOverrides`.

---

## 7. IA

**`server/_core/ai/`** (README.md próprio; documentação do dono em `docs/ia.md`):
- `run.ts` — `runAi`, a única porta. Por ordem: interruptores (AI_ENABLED + o da funcionalidade) → fornecedor → orçamento mensal → modelo do nível → pedido com prazo e retries → registo. Aceita `schema` zod, `history`, `tools` (`maxRounds` até 4) e `cacheSystem`.
- `client.ts` — fornecedores: `gemini` (AI Studio `GEMINI_API_KEY` ou Vertex) e `legacy`. Escolha: `AI_PROVIDER_<FUNC>` → `AI_PROVIDER` → automático.
- `models.ts` — nível → modelo: `AI_MODEL_LITE` (omissão), `AI_MODEL_FAST`, `AI_MODEL_SMART`.
- `usage.ts` — `ai_usage_log` (só metadados) e orçamento mensal.
- `pricing.ts` — tabela de preços Gemini em USD/1M tokens, convertida para €; sobreposições em `ai.priceOverridesEur`.
- `embed.ts` — embeddings (base de conhecimento; AI_ENABLED + AI_KNOWLEDGE).
- `pii.ts` — troca email, telefone, IBAN, NIF e matrícula por marcadores (`[EMAIL_1]`…).
- `contextCache.ts` — cache de contexto do Gemini (~10 % do preço; tabela `ai_context_caches`).
- Outros: `features.ts` (nível efetivo e interruptores), `errors.ts` (`userMessage`), `rateLimit.ts` (`ai_rate_limits`), `stt.ts` (rádio; Whisper só com `OPENAI_API_KEY`), `reviewReply.ts`, `jsonSchema.ts`, `trpcError.ts`, `status.ts`, `prompts/*.ts` (assistant, comms, crmIdentity, handover, hrAttachment, hrDocument, invoice, mail, ops, quiz, radio, reviewReply, trainingAi, trainingTutor, whatsapp, common).
- `chat/engine.ts` — `runChatTurn`: pergunta → interruptor → limite → histórico → ajuda → `runAi` com ferramentas → guardar.
- `chat/tools.ts` — registo de ferramentas (function calling), independente do canal.
- Também: `chat/history.ts`, `chat/retrieval.ts` (ajuda por palavras-chave, sem IA), `chat/store.ts` (`ai_chat_*`, canal staff/public).

**`shared/aiFeatures.ts`:**
- `AiTier` = lite, fast, smart. Regra do dono: tudo em lite por omissão. O nível muda-se em `ai.featureTiers` ou com `AI_TIER_<FUNC>`.
- `AiThinkingLevel`: minimal, low, medium, high, default.
- Outras peças: `essential` (continua a funcionar entre 100 % e 150 % do orçamento) e `ownBudget` / `AI_OWN_BUDGET_FEATURES`.
- Funcionalidades (40; todas lite salvo indicação):
  - expense_ocr (essencial, tal como o healthcheck), review_reply, radio_transcription, radio_summary, handover_summary, whatsapp_summary, whatsapp_reply, hr_autofill;
  - quiz_generation e quiz_live (ambas fast);
  - kb_faq, training_search, training_tutor, complaint_triage, review_auto_draft, review_auto_publish, whatsapp_triage, mail_routing, lost_found_match, crm_identity;
  - assistant; assistant_smart (smart, teto próprio); assistant_eval (teto próprio); healthcheck (essencial);
  - ops_briefing, weekly_report, anomaly_explain, availability_classify, lead_summary, lead_first_contact, evaluation_explain, handover_repeats, tasks_from_text, mail_reply, web_insight, gbp_post_draft, pagespeed_explain, knowledge_embed, knowledge_extract, hr_email_attachments.

**Assistente (Multis), `server/assistant/`:**
- `service.ts` — liga o núcleo do chat à app: ajuda, ferramentas com as permissões da pessoa, limites e registo em `activity_logs`.
- `tools.ts` — ferramentas só de leitura que embrulham procedimentos tRPC via `ctx.call` (`createCaller` como a própria pessoa); `MPV_STAFF_TOOLS`.
- `mpv.ts` — modo MPV (interruptor MPV + `ai.assistantPilot`): sistema estável com regras e índice da árvore (até 6 000 tokens).
- `mpvDataTools.ts` — ferramentas de dados do piloto (só leitura, sem IA).
- `helpTools.ts` — `ajuda_abrir(id)` e pesquisa lexical (`searchHelpSections`).
- `helpSearch.ts` — pesquisa semântica: lexical top 40 ∪ FULLTEXT top 40 dos `kb_chunks`.
- `rulesTool.ts` — `regras_em_vigor(modulo)`, a partir de `rulesDocs.generated.ts` e da lista branca.
- `slowCallCache.ts` — prazo próprio, uma só leitura por chave e cache curta; `forgetSlowCallsOf` e `mutationClearsSlowCalls`.
- `multisEval.ts` — motor do eval: conjunto A em `server/fixtures/multisEval/`, conjunto B em `multisEvalSetB.ts`; versões v1-lite, mpv-lite e mpv-argon. Há ainda `multisEvalDraft.ts`.
- `pilotStats.ts` — cartão "Multis piloto" (Definições → Estado).
- Também: `memory.ts` (`assistant_memories`), `feedback.ts` (👍/👎, `/multis/falhas`), `knowledgeTree.ts`, `toolArgs.ts`, `router.ts`.
- Gerados: `helpDocs.generated.ts`, `knowledgeTree.generated.ts`, `rulesDocs.generated.ts`, `knowledgeTreeIds.json`.

**Ficheiros partilhados:**
- `shared/multisProfiles.ts` — por página (e separador): o papel do Multis, as perguntas sugeridas e as ferramentas preferidas.
- `shared/multisPage.ts` — separador e registo abertos (`useMultisPage({tab, entity})`).
- `shared/helpTree.ts` — árvore Grupo → Página → Secção; `HELP_GROUPS`; `HELP_INDEX_MAX_TOKENS` 6000.
- `shared/helpRuleValues.ts` — marcadores `{{regra:…}}`.
- `shared/rulesInForce.ts` — frases por módulo, com marcadores.
- `shared/rulesLiveWhitelist.ts` — lista branca dos valores vivos.
- Também: `shared/helpIdAliases.ts`, `shared/assistant.ts` (perguntas sugeridas) e `shared/multisEval.ts` (parte pura do eval).

**Scripts de eval:** `scripts/eval-multis.ts`, `scripts/eval-complaint-triage.ts`, `scripts/eval-whatsapp-triage.ts`, `scripts/eval-mail-triage.ts`. Corpora em `server/fixtures/*Corpus.ts`, `mailTriageBlind.ts` e `mailTriageHoldout.ts`. Há ainda `scripts/export-multis-eval-draft.ts`.

---

## 8. Ajuda

**`docs/ajuda/` (49 ficheiros):** agendador, api-keys, atividade-diaria, avaliacao, caixa, central, clientes, comunicacao, condutores-agentes, contactos, criticas, dashboards, definicoes, despesas, disponibilidade, drive, email-aliases, entrada, extras-dia, faturacao, ficha-reserva, formacao, google-business, google-tempo-real, ia-no-dashboard, integracoes-google-ads, integracoes, leads-extras, logs, marketing, multis, ocorrencias, operacoes-listas, parcerias, passagem-turno, perdidos, perfil, permissoes, pesquisa-e-conhecimento, projetos, radio, reclamacoes, reservas-do-dia, rh-ponto (70 KB), servicos, tarefas, web-analytics, whatsapp-chamadas, whatsapp (todos `.md`).

**Geradores:**
- `scripts/gen-ajuda.ts` (`pnpm tsx scripts/gen-ajuda.ts`) lê os `.md` e gera:
  - `server/assistant/helpDocs.generated.ts` (`HELP_FILES`);
  - `server/assistant/knowledgeTree.generated.ts` (árvore e índice; `KNOWLEDGE_INDEX_LEVEL`);
  - `server/assistant/rulesDocs.generated.ts` (chama `writeRulesDocs` de `gen-regras.ts`);
  - `server/assistant/knowledgeTreeIds.json` (só cresce).
  - Se um id desaparecer sem alias em `shared/helpIdAliases.ts` (`HELP_ID_ALIASES`, hoje vazio), o gerador dá erro. Num conflito de merge nos gerados, não se junta à mão: fica-se com um dos lados e corre-se o gerador outra vez.
- `scripts/gen-regras.ts` gera o `rulesDocs.generated.ts` a partir de `shared/rulesInForce.ts` e `shared/helpRuleValues.ts`.
- `scripts/gen-notificacoes-doc.ts` gera `docs/notificacoes.md`; `scripts/gen-permissoes-doc.ts` gera `docs/permissoes.md`.
- `scripts/measure-help-tree.ts` mede a árvore.
- Outro gerado: `docs/multipark-db/schema.md` (`scripts/multipark-db-schema.ts`).

**Regras da F1** (`shared/helpTree.ts` e testes em `server/helpTree.test.ts` e `server/assistant/assistant.test.ts`):
- **Front matter:**
  - `grupo:` tem de ser um dos HELP_GROUPS: Dashboards, Financeiro, Pessoas, Operações, Suporte, Comunicação, Sistema.
  - `pagina:` é um id estável `[a-z0-9-]` com no máximo um `.` (`pai.topico`), único.
  - `separadores: id=Título da secção, …`: cada separador aponta para uma secção que existe, sem repetir.
  - Mantêm-se `modulo`, `titulo`, `rotas` e `palavras` (do v1).
- **Regra das secções:** só abrem secção `##`, `###` e linhas que são só negrito (`**Título**`, com ou sem `:`). O texto antes da primeira secção é a secção "inicio". Id da secção: `<ficheiro>#<slug>`, com `-2`, `-3` quando o título se repete.
- **Marcadores `{{regra:chave}}`:** são trocados pelo valor do código. Um marcador desconhecido ou mal escrito é erro. Quando o marcador é o valor por omissão de uma definição, a ajuda tem de dizer "por omissão" ou "em uso" a 120 caracteres (`SETTING_NOTE_WINDOW`), senão `HelpRuleMarkerError`.
- **Teto de 5 000 caracteres:** cada separador do código (`TabsTrigger value=` nas páginas) tem de ter secção própria com no máximo 5 000 caracteres, sem dois separadores na mesma secção. Fora dos separadores, só 7 secções conhecidas passam dos 5 000 (agendador, comunicacao, disponibilidade, extras-dia, ficha-reserva, marketing, rh-ponto); o teste falha se aparecer outra.

---

## 9. Notificações

- **`server/notify.ts`** é a camada única (sino e email): `notify({kind, projectId|city, targetUserId?, title, body, link, entity})`.
  - Destinatários: ativos + papel ou override do módulo + cidade + tipo não silenciado.
  - Deduplica por pessoa × tipo × registo (30 min por omissão) e nunca lança.
  - Um teste impede que outro código escreva em `app_notifications`.
  - Também: `notifyWith`, `listNotifications`, `unreadCount`, `markNotificationRead`, `markAllNotificationsRead`, `receivableKinds`, `forcedMandatoryKinds`.
- **`shared/notificationRouting.ts`:**
  - `NOTIFICATION_KIND_DEFS` (tipo → módulo, papéis, cidade, pessoal/obrigatório, canais in_app/email);
  - `NOTIFY_CITIES` lisbon/porto/faro; `NOTIFICATION_ROUTING_SETTING_KEY` = `notifications.routing`; `HOME_CITY_ROLES`;
  - `CRITICAL_ALERTS_MANDATORY_FLAG` = NOTIFY_CRITICAL_MANDATORY; `LEGACY_KIND_MAP`; `resolveRecipients`, `parseRouting`.
  - Texto por tipo em `shared/notificationRoutingDoc.ts`; documento gerado em `docs/notificacoes.md`.
- **Tipos, por grupo:**
  - **suporte:** complaint_new, complaint_sla, complaint_triage, complaint_client_reply, google_reviews_alert, review_auto_publish, incident_critical, incident_sla, lost_found_new, lost_found_sla, mail_new, mail_assigned.
  - **operacoes:** whatsapp_sla, whatsapp_undelivered, whatsapp_missed_call, service_tasks_tomorrow, extras_gap, extras_schedule_reply, extras_reminder, extras_schedule_alert, handover, handover_missing, speed_alert, gps_alert, ops_presence, login_code, pda_device, terminal, driver_daily_report, anomaly_bookings, task, task_assigned, task_overdue_city.
  - **pessoas:** rh_docs_missing, rh_bank_change, leave_to_approve, my_leave, my_docs_missing, my_doc_rejected, my_schedule_override, driver_application, account_link_request, employee_comeback, lead_replied, leads_waiting, training_overdue, training_promotion, my_training, evaluation_dispute, my_evaluation.
  - **financeiro:** expense_due, expense_overdue, anomaly_expenses, payroll_ready, cash_case_alert, partner_close_alert, cash_daily_digest, cash_confirm_alert, cash_confirm_refused, cash_confirm_alert_email.
  - **marketing:** marketing_alert, google_business_alert, web_analytics_alert.
  - **sistema:** integration_alert, cron_stale, google_account_reauth, login_security, login_conflict, sync_alert, ai_budget.
- Push do browser: `server/webPush.ts` (VAPID; `scripts/generate-vapid-keys.ts`).

---

## 10. Integrações

O estado de todas aparece em `server/integrationsStatus.ts` (ids: database, gmail, gmail_send, google_account, google_login, google_sync, google_contacts, google_drive, google_ads, meta_ads, google_business, google_analytics, search_console, pagespeed, crux, whatsapp, whatsapp_webhook, whatsapp_calls, zello, multipark_db, multipark_webhook, llm, storage, knowledge_base, cron). O hub é `server/integrations/hubRouter.ts`.

- **WhatsApp (Meta Cloud API):**
  - Ficheiros: `server/whatsapp.ts` (cliente Graph), `whatsappWebhook.ts` (`/api/whatsapp/webhook`, antes do `express.json`), whatsappInbound, whatsappInbox(+Ops), whatsappStore, whatsappTriage(+Eval), whatsappBroadcast, whatsappTemplateMeta, whatsappFailurePolicy, whatsappCaseProposal, whatsappWebhookForward, whatsappCalls*, whatsappCallStream, whatsappCallsRouter, `server/integrations/whatsappConnection.ts`. Env `WHATSAPP_TOKEN`.
  - Interruptores: WHATSAPP_SLA_NOTIFY, WHATSAPP_CALLS (OFF), AI_WHATSAPP_ASSIST, AI_WHATSAPP_TRIAGE, WA_TRIAGE_SKIP_STAFF (OFF), OPS_PRESENCE_WHATSAPP (OFF), LEAD_AUTO_REPLY (OFF), EXTRAS_AVAILABILITY_AUTO_REPLY.
- **Email / Gmail:**
  - Ficheiros: `server/mail/` (gmailApi, sync, inbox, compose, sendRequests, autoSends, autolink, parse, sanitize, store, service, systemMail — todos os emails da app saem pela API do Gmail, sem SMTP —, routes, router), mais `mailNotices.ts`, `mailReadCache.ts`, `mailTriageEval.ts`, `complaintMailIntake.ts`, `commsRouting.ts`, `commsAiSweep.ts`.
  - Interruptores: MAIL_PUSH (OFF; `GMAIL_PUSH_TOPIC`), AI_MAIL_ROUTING, AI_MAIL_COMPLAINTS, AI_MAIL_DRAFT, AI_MAIL_LOST_FOUND, AI_MAIL_PARTNER_CASES, AI_MAIL_NOTICES, AI_MAIL_BACKFILL, AI_MAIL_ALIAS_FILTER (estes cinco últimos OFF).
  - Definições: mail.*, emails.handoverCc.
- **Google Business / Windsor:**
  - Ficheiros: `server/integrations/googleBusiness/` (client, config, oauth, insights, insightsQueries, insightsStore, manage, service, sourceRead, diagnostics, domain, windsor, router, profileRouter, routes; cron manual `/api/cron/google-business`, em pausa) e `docs/google-business-profile.md`.
  - Interruptores: GBP_PUSH, GBP_WINDSOR_SYNC (OFF), GBP_WINDSOR_REPLY (OFF), AI_GBP_POSTS, REVIEW_AUTO_PUBLISH_5STAR (OFF SA).
- **Zello / GPS:**
  - Ficheiros: `server/zello.ts` (sessão), `zelloGps.ts` (regras dos pontos; env `ZELLO_API_KEY`, `ZELLO_NETWORK`, `ZELLO_USERNAME`, `ZELLO_PASSWORD`, `ZELLO_LOCATIONS_MAX`), `radioZello.ts`, `pdaZelloName.ts`, `driverTrack.ts`, `shiftGps.ts`, `speedAlerts.ts`, `speedRule.ts`, `gpsResplitBackfill.ts`, `jobs/dailyDriverCollection.ts`, `terminalWatch.ts`; `docs/google-maps-gps.md`.
  - Interruptores: GPS_SPEED_ALERTS (OFF), ZELLO_PDA_NAMES (OFF), OPS_PRESENCE_ALERTS (OFF), PONTO_TERMINAL (OFF), AI_RADIO. Definição: zello.gpsExcludedUsers.
- **Stripe, Viva e InvoiceExpress (só leitura, caixa fase 4):**
  - Ficheiros: `server/external/stripe.ts`, `server/external/vivaWallet.ts`, `server/external/invoiceExpress.ts`, `server/cashExternal.ts` (`cashFlags`), `server/multiparkDb/cashExternal.ts`; cron `cash-external`.
  - Interruptores: CASH_STRIPE_CHECK, CASH_VIVA_CHECK, CASH_INVOICEXPRESS_CHECK (todos OFF SA).
- **Google Drive:**
  - Ficheiros: `server/google/driveApi.ts`, `driveService.ts`, `driveAccess.ts`, `driveFolders.ts`, `driveJobs.ts`, `sheetsExport.ts`, `driveRouter.ts`, `shared/drive.ts`; base de conhecimento em `server/knowledge/drive.ts` e `driveChanges.ts`.
  - **Não tem interruptor próprio.** É controlado pela definição `google.drive` (grupo emails, só super admin). A base de conhecimento usa AI_KNOWLEDGE.
- **Vercel:**
  - **Não há integração com a API da Vercel.** É só a plataforma: `vercel.json` (`api/index.js`, `maxDuration` 60, região fra1), `server/_core/api-entry.ts` (`waitUntil`/`getDeadline` de `@vercel/functions`), `server/storage.ts` (`@vercel/blob` como alternativa ao S3: S3 → Blob → disco local) e o build `build:api`.
  - Sem interruptor.
- **Outras:**
  - Google Ads (`server/integrations/googleAds/`; GOOGLE_ADS_CLICK_SYNC) e Meta Ads (`server/integrations/meta/`).
  - Web & SEO (`server/webAnalytics/`; AI_WEB_INSIGHT, AI_PAGESPEED_EXPLAIN).
  - Google Tarefas/Calendário/Contactos (`server/google/*`).
  - Central Vodafone (`centralRouter.ts`, centralRing, centralXsi, centralSugar; CENTRAL_RING, CENTRAL_SUGAR).
  - Webhook Multipark (`server/multiparkWebhook.ts`, `bookingDeliveryQueue.ts`).

---

## 11. MCP do repositório

- **`mcp-server/index.mjs`** (stdio, sem dependências; env `MULTIPARK_API_KEY` e `MULTIPARK_API_URL`, por omissão `https://dashbord-multipark.vercel.app/api/v1`). Ferramentas:
  - Reservas e parques: list_parks, dashboard_summary, list_bookings, booking_stats, get_booking.
  - Reclamações: list_complaints, complaint_stats, get_complaint, create_complaint, update_complaint, add_complaint_message, delete_complaint.
  - Campanhas e críticas: list_campaigns, get_campaign_daily, list_reviews, create_review.
  - Pessoas e veículos: list_vehicles, list_employees.
  - Caixa: cash_counts, cash_count_detail, cash_cases, cash_case_detail.
  - Operações e parceiros: drivers_daily, partners_billing, partners_close, shift_handovers.
  - Marketing e web: marketing_stats, marketing_channels, marketing_brands, marketing_campaign_roas, web_overview, web_list.
  - Procedimentos genéricos: dashboard_procedures, dashboard_query, dashboard_actions, dashboard_action.
  - Ver também `mcp-server/README.md`.
- **`server/mcpProceduresApi.ts`** — o MCP pessoal corre os procedimentos tRPC como quem criou a chave (mesmas permissões e cidades):
  - `GET /procedures?search=` e `POST /procedures/call` (só queries; capacidade `owner:read`);
  - `GET /procedures/actions` e `POST /procedures/action` (capacidade `owner:write`; `confirmExternal`);
  - `DENY`: `apiKeys.*`, tudo o que tenha "token" e `cashCheck.confirmFileUrl`; `MAX_RESULT_BYTES` 4 MB.
- **`MCP_ACTIONS`, por área** ("(ext)" = sai para fora da empresa e pede `confirmExternal`):
  - Reclamações: create, update, addMessage, attachDriver, detachDriver, archive, unarchive, convertToLostFound, sendEmailToClient (ext).
  - Perdidos: create, update, addMessage, attachDriver, detachDriver, setDriverAccountability, decideMatch, archive, unarchive, convertToComplaint, sendEmailToClient (ext).
  - Críticas: create, update, setPark, generateResponse, approveResponse, convertToComplaint, publishReply (ext).
  - Ocorrências: create, update, addNote, convertToComplaint, convertToLostFound.
  - Avaliação: evaluation.adjust, voidAdjustment, disputes.resolve, setExplanationHidden; lostFound.reviewDriverPoints; incidents.confirmAccident, voidAccident, confirmDriver.
  - Clientes: crm.merge, split, dismissSuggestion, undismissSuggestion, update, relation.
  - Utilizadores: identityLinks.* (9 operações).
  - Faltas: rh.penalties.review, reviewMany. Ponto: rh.timeRecords.review.
  - Tarefas: create, update, setStatus, addComment.
- REST `/api/v1`: `server/mcpApi.ts`, `mcpReportsApi.ts`, `mcpMarketingApi.ts`, `externalApi.ts`. Capacidades em `shared/apiKeyCapabilities.ts`: complaints:write, owner:read, owner:write, reports:cash, reports:marketing, reports:ops, site:intake, mais os grupos admin, device e pii.

---

## 12. Design

- **Base:** shadcn "new-york" (`components.json`: CSS em `client/src/index.css`, baseColor neutral, cssVariables) com Tailwind v4 (`@import "tailwindcss"`, `@theme inline`). **Não há `tailwind.config.*`**: os tokens estão todos em `client/src/index.css` (341 linhas).
- **Tokens (modo claro), "Multipark — Navy #0E2957 + Royal Blue #0055D2":**
  - background #f0f4ff, foreground #0c1f3f, card #fff, primary #0055d2, secondary/accent #e1ecff, accent-foreground #0046ad;
  - muted-foreground #475569 (por WCAG AA), border #e2e8f0, destructive #dc2626;
  - chart-1..5: #0055d2, #16a34a, #7c5cfc, #f59e0b, #06b6d4; `--radius` 0.625rem.
  - Há modo `.dark` (fundo #081226, cartão #0c1f3f).
  - Letras: Poppins nos títulos (`--font-display`) e Open Sans no corpo.
  - Item ativo da sidebar: azul cheio com texto branco.
  - Pesquisas e filtros: fundo branco com borda azul (inputs "Pesquisar…", `type=search`, `.mp-filter`).
  - Paletas próprias: `.times-viz` (fila, trânsito, cliente) e `.perf-viz`.
- **Componentes base (`client/src/components/ui/`):** accordion, alert, alert-dialog, aspect-ratio, avatar, badge, breadcrumb, button, button-group, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, empty, field, form, hover-card, input, input-group, input-otp, item, kbd, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, searchable-select, select, separator, sheet, sidebar, skeleton, slider, sonner, spinner, switch, table, tabs, textarea, toggle, toggle-group, tooltip.
- **Botões (`button.tsx`):** no modo claro todos são brancos com borda azul (`default`, `outline`, `secondary`). Azul cheio só na variante `selected`. Existem também destructive, ghost e link.
- **Padrões das páginas:**
  - Card: `bg-card rounded-xl border py-6 shadow-sm`; nas páginas é comum `p-3 gap-1 min-w-0`, `py-0 gap-0 min-w-0` ou `p-4`.
  - KPI: `KPICard.tsx` (ícone 11–12 com fundo, delta verde/vermelho) e `StatValue.tsx` (número que se ajusta à largura, `cqi`).
  - Tabelas: na maioria `<table className="w-full text-sm">` (cru, 71 ficheiros), com `useTableSort`/`Th` de `SortableTable.tsx` e `STICKY_FIRST_COL` (`components/finance/layoutClasses.ts`, 16 ficheiros) para o telemóvel. O `ui/table.tsx` usa-se em 9 ficheiros.
  - Separadores: `TABS_SCROLL`.
  - Estados: `QueryErrorNote.tsx` (erro não é vazio; 108 ficheiros) e `SettingsCardError.tsx`.
  - Filtros: `DashboardFilterBar.tsx`, `QuickRangeBar.tsx`, `DateRangeNav.tsx`, `CityMultiSelect.tsx`.
  - Vista: `ViewToggle.tsx` (Cartões/Lista).
  - Gráficos: `CHART_PALETTE` e `CHART_TOOLTIP_STYLE` em `client/src/lib/financeFormat.ts`.
  - Outros: `ModuleCard.tsx` (launcher do `/modulos`) e `usePersistedState` (19 ficheiros).
- **Guia de design:** não há um guia real do design system Multipark. `src/guidelines/Guidelines.md` e `figma/ATS Resume Analyzer Dashboard/src/guidelines/Guidelines.md` são o modelo vazio do Figma ("Add your own guidelines here"). A pasta `src/` na raiz é um projeto antigo, à parte do `client/`. As referências ao design system estão só em comentários de `index.css`, `DashboardLayout.tsx` (hub "Dashboard Multipark v2" do Claude Design), `ui/tabs.tsx`, `financeFormat.ts` e `layoutClasses.ts`.

---

## 13. Comandos do package.json

| Script | Comando |
|---|---|
| dev | `tsx watch server/_core/index.ts` |
| build | `vite build && esbuild server/_core/index.ts … --outdir=dist` |
| build:api | `esbuild server/_core/api-entry.ts … --outfile=api/index.js` (a função da Vercel) |
| start | `NODE_ENV=production node dist/index.js` |
| check | `tsc --noEmit` |
| test | `vitest run` (`vitest.config.ts`) |
| format | `prettier --write .` |
| db:push | `drizzle-kit generate && drizzle-kit migrate` |
| export:initial-booking-price / export:active-agents | scripts da BD da Multipark |

- **Não há script `gen`.** Os geradores correm-se à mão: `pnpm tsx scripts/gen-ajuda.ts`, `gen-regras.ts`, `gen-notificacoes-doc.ts`, `gen-permissoes-doc.ts`, `multipark-db-schema.ts`, `eval-*.ts`, `run-migration.ts`.
- A Vercel faz o build com `pnpm run build && pnpm run build:api`.
- CI em `.github/workflows/ci.yml`; os outros workflows são de corrida manual.

---

## 14. Docs úteis

**`docs/`:**
- `ia.md` (566 linhas) — a IA para o dono: configuração, modelos, custos, RGPD.
- `ia-inventario.md` — inventário da IA página a página (3 e 8 out 2026).
- `permissoes.md` — gerado: matriz de acessos v2.
- `notificacoes.md` — gerado: quem recebe o quê.
- `limpeza-variaveis.md` — variáveis de ambiente depois da limpeza de 27 set.
- `google-business-profile.md` — aprovação e quota da API GBP.
- `google-maps-gps.md` — mapa do Ao Vivo (Maps JS API).
- `CIDADES-E-FICHA-2026-09-15.md` e `porto-acessos-2026-09-15.md` — cidades e centro de custos.
- `implementacao-formacao-2026-09-10.md` e `implementacao-reservas-2026-09-10.md` — primeiros blocos.
- `auditoria/caixa-furos.md`, `auditoria/caixa-precos.md` (auditorias da caixa) e `auditoria/pdas-identidade.md` (ficha, Zello, agentes).
- `crm/plano-crm.md` (CRM 360°); `crm/desenho-crm.md` e `crm/desenho-pc-2026-09-27.md` são rascunhos com o mesmo título.
- `multipark-db/README.md` (BD Multipark como fonte), `mapeamento.md`, `plano-duas-bd.md`, `schema.md` (gerado, 81 tabelas), `initial-booking-price.md`, `active-agents-export.md`.

**`docs/plans/`:**
- `2026-10-07-extras-tarefas-research.md` — pesquisa com ficheiro:linha para 9 pedidos.
- `2026-10-07-extras-tarefas-design.md` — o desenho desses 9 pedidos.
- `2026-10-13-confirmacao-caixa-plano.md` — confirmação da caixa reserva a reserva (v5).
- `2026-10-15-multis-ia-plano.md` — plano "MPV" (Multis por página, v4 aprovado com 96).

**Na raiz:** `PROJECT.md`, `README.md`, `multipark_api_docs.md`, `multipark_api_docs2.md`, `todo.md`, `todo2.md` e várias análises soltas (`hierarchy-analysis*.md`, `swap-analysis*.md`, `zello-*.md`, `email_analysis.md`, `feedback_notes.md`).
