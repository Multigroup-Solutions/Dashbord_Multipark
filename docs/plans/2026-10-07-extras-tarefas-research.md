# Extras / Tarefas: research for 9 requests (2026-10-07)

Research only: no code was changed. Repo state: `main` at `e5f11958` (clean, in sync with `origin/main`).
All references are `file:line` on that commit.

---

## 0. Repo conventions (read first)

| Topic | What the repo does |
|---|---|
| Stack | `client/` Vite + React + wouter + tRPC client; UI is **shadcn/ui** ("new-york", `components.json`, 54 components in `client/src/components/ui`), lucide icons, `sonner` toasts. `server/` Express + tRPC (`server/routers.ts` 6.7k lines plus split routers such as `server/tasksRouter.ts` and `server/rhRouter.ts`). Drizzle ORM on **MySQL** (`drizzle.config.ts:11`). `shared/` holds PURE rules imported by both sides (`@shared/*`). |
| Permissions | One matrix in `shared/access.ts` (`MATRIX_SPEC`, e.g. `tarefas` at `shared/access.ts:171`, `extras_dia` :184, `rh` :192, `leads_extras` :202, `disponibilidade_extras` :219). Notation is `"scope:actions"`, with v=view, e=edit, x=export, m=manage. Scopes are own / below_city / city / national. Role rank is `ROLE_RANK` (`shared/access.ts:44`): user0 extra1 condutor2 team_leader3 supervisor4 frontoffice5 backoffice5 admin6 super_admin7. On the server, `requireAccess(user, module, action, {allowOwn})` (`server/_core/access.ts:29`) applies the per-user overrides (`withOverrides`) and throws `FORBIDDEN "Acesso não autorizado."`. On the client, `can(user, module, action)` (`shared/access.ts:398`). Fine-grained RH rules live in `server/rhAccess.ts` (pure, e.g. `canEditPersonal`, `canDeleteDocument`, `isRhAdmin`) plus `server/rhGuards.ts` (asserts). City scope comes from `server/cityScope.ts` (`assertProjectAccess`, `scopedProjectIds`). |
| Migrations | Runtime "ensure" migrations: `server/migrations/migration_NNNN.ts` exports `MIGRATION_NNNN_STATEMENTS` + `IDEMPOTENT_ERROR_CODES_NNNN`. Each one is registered **at the end** of `SCHEMA_MIGRATIONS` in `server/migrations/index.ts` (the order is tested). `getDb()` runs them once per process (`server/db.ts:99-100`). The latest is **0525** (`server/migrations/index.ts:160`) and recent numbers step by 5, so the **next free number is 0530** (re-check before merging because parallel branches take numbers). Every table/column is mirrored in `drizzle/schema.ts`. Style is `CREATE TABLE IF NOT EXISTS … DEFAULT CHARSET=utf8mb4` with `ER_TABLE_EXISTS_ERROR` / `ER_DUP_FIELDNAME` / `ER_DUP_KEYNAME` as the idempotent codes (example: `server/migrations/migration_0500.ts`). "Delete" means **archive** (`archivedAt/archivedById`, migration 0376) and nothing is hard-deleted. |
| Audit | `logActivity({userId, action, entity, entityId, details, source})` (`server/db.ts:766`) writes `activity_logs` (`drizzle/schema.ts:4`) with masking (`shared/logMask`). |
| Internal notes / threads already in the repo | `complaint_messages(isInternal)` (`drizzle/schema.ts:426`), `lost_found_messages(isInternal default 1)` (:1264), `task_comments` (:2065), `inbound_emails.notes` (recruitment emails, single text, :2378), `extra_leads.notes` (single varchar 512, :2677), `driver_applications.notes` (single varchar 512, :653), `shift_handovers.notes` (one per day/shift/city, ~:1008). There is no notes table on employees/extras. |
| Tests | vitest, `server/**/*.test.ts` only (`vitest.config.ts`); client code is not tested directly, so pure rules go in `shared/` and get tested from `server/`. There are 274 test files. Known pre-existing failures need a live DB: `users`, `project-costs`, `multipark`, `zello`, `documents`, `auth.logout`. `pnpm check` = `tsc --noEmit`. |
| Help docs | `docs/ajuda/*.md` are compiled into `server/assistant/helpDocs.generated.ts` by `scripts/gen-ajuda.ts`, and tests compare the generated file. Relevant pages: `docs/ajuda/extras-dia.md`, `leads-extras.md`, `rh-ponto.md`, `tarefas.md`. |
| Line endings | **LF**. `.gitattributes` = `* text=auto eol=lf` ("os testes comparam ficheiros gerados") and `core.autocrlf=true`. Sampled files have 0 CR. Edit with Edit/Write and do not introduce CRLF. |
| Copy | PT-PT UI strings; comments tag the request ("Jorge, 7 out 2026: …"). |

---

## 1. Driving-licence flag on extras

> "deve existir uma flag nos extras, deve haver 'carta pendente de validação' e 'carta validada'. Carta validada é quando o condutor tem carta há mais de 3 anos"

### What exists
- **Employee model** `employees` (`drizzle/schema.ts:549-612`) has `drivingLicenseNumber VARCHAR(32)` (migration 0460, `server/migrations/migration_0460.ts:31`) and nothing else about the licence: **no issue date, expiry, category or validation**. `position` enum includes `extra` (:574).
- **Documents** `employee_documents` (`drizzle/schema.ts:537-547`) has `docType` enum including `driving_license`, `fileUrl/fileKey`, `uploadedById` and `createdAt`. There is **no status/validation column**.
- `driving_license` is mandatory in the checklist (`server/db.ts:1533-1541`, `server/rhRouter.ts:955`), and missing docs warn and then block login (`server/rhService.ts:51-96`, `applyDocsCompliance`).
- Leads: `extra_leads.drivingLicenseNumber` (`drizzle/schema.ts:2703`). Candidaturas (`driver_applications`, :635) only keep `drivingExperience` (free text "Mais de 3 anos" is about driving *experience*, not licence age) plus the raw `payload`.
- **Website (multidriver) already collects the licence issue date but does not send it.** The form field `licenseIssueDate` is mandatory (`../multidriver/app/[lang]/be-a-driver/components/step2-legal-licensing.tsx:137`). It goes to the Google Sheet (`../multidriver/app/api/(submissions)/submitDriverApplication/route.ts:170`) but the dashboard payload only carries `"Carta de Condução"` (number), `"Validade da Carta"` (expiry) and `"País da Carta"` (`route.ts:236-239`). The local clone is at `e3a26d4` (2026-09-17).
- **Related bug.** The lead score "Anos de carta" (`server/aiOps/leadScoring.ts:89-91,171`) uses `pickPayload(payload, /licen|carta|driving.?licen/i)`, which returns the **first** matching key, `"Carta de Condução"` (the licence **number**). `licenceYearsFrom` → `parseYears` (`leadScoring.ts:45-51,136-141`) then takes the first number in the licence number as "years", or a 4-digit fragment as a year. The score is therefore wrong today.
- AI autofill of uploaded documents (`server/documentAutofill.ts`, switch `AI_HR_AUTOFILL`, off by default) extracts `documentNumber/expiryDate` (`:18-27`, prompt `server/_core/ai/prompts/hrDocument.ts:12`), with **no issue date**. For `driving_license` it only fills NIF/birthDate/nationality/address (`:84-104`).
- UI badges today: the RH detail header shows position + Ativo/Inativo (`client/src/pages/HRPage.tsx:1438-1441`). Cards and list show position + `N{extraLevel}` (`HRPage.tsx:2495-2498`, `2589-2591`) and a docs column "Completos / N em falta" (`HRPage.tsx:2597-2601`, from `rh.documents.allStatus`, `server/rhRouter.ts:951`). Documents tab: `DocumentsTab` (`HRPage.tsx:488-700`). Extras-Dia person picker: `client/src/pages/extrasDia/PersonPicker.tsx`.

### Missing
The issue date, the validation act (who validated, when), the "≥ 3 years" rule and the badge.

### Recommendation
- **Schema (migration 0530, with item 2):**
  - `employees`: `drivingLicenseIssuedAt DATE NULL`, `drivingLicenseValidatedAt DATETIME NULL`, `drivingLicenseValidatedById INT NULL`.
  - Optional on `extra_leads`/`driver_applications`: `drivingLicenseIssuedAt DATE NULL`, carried over on convert/approve (`server/extrasAutomation.ts:1092-1101` `leadIdentityPatch`; `approveApplication` in `server/webIntake.ts`).
- **Pure rule** in `shared/` (e.g. `shared/drivingLicence.ts`): `licenceStatus({ issuedAt, validatedAt, docStatus }, todayLisbon)` returns `"validated"` (RH validated + licence ≥ 3 full years, Lisbon calendar, 29 Feb handled), `"pending"` ("Carta pendente de validação": doc uploaded or date known but not validated yet), `"under_3y"` and `"missing"`. Label map: "Carta validada", "Carta pendente de validação", "Carta < 3 anos", "Sem carta".
- **Server:**
  - Add `drivingLicenseIssuedAt` to `PERSONAL_FIELDS` (`server/rhAccess.ts:292`) and to `rh.update` input (`server/rhRouter.ts:549` area).
  - New `rh.validateDrivingLicence({employeeId, issuedAt})` guarded by `isRhFor`/`canManageEmployee` (never the person's own ficha; `rhAccess.ts:121`). It sets `validatedAt/ById`, marks the `driving_license` documents as validated (item 2) and calls `logActivity(action "driving_licence_validate")`.
  - Return the computed `licenceStatus` in `rh.list/byId` and in Extras-Dia candidates (`server/extrasDia.ts:1050-1090` `listDriverCandidates`).
- **Inputs for the date:**
  - (a) multidriver: add `"Data de Emissão da Carta": driverData.licenseIssueDate` to the payload (`route.ts` ~236). Other repo, so deploy the dashboard first.
  - (b) RH types it when validating.
  - (c) optional: extend the AI prompt with `issueDate`.
  - Fix `leadScoring` to read the issue-date key explicitly and never the number.
- **UI:** a badge next to the position badge in the RH header, cards and list (green "Carta validada", amber "Carta pendente de validação", grey "< 3 anos"). A filter chip in the Extras tab. A badge in the Extras-Dia PersonPicker. In `DocumentsTab`, a "Validar carta" button with a date field on the `driving_license` category.
- **Tests:** `licenceStatus` boundaries (exactly 3 years, 3y−1d, leap day, missing date, pending doc). The permission rule (own ficha can't validate; TL can't; supervisor in city can). `leadScoring` no longer parses the licence number.
- **Decisions needed:** what happens below 3 years (block from escala, warn only, or just a label)? Is the RH validation required, or is "≥ 3 years by the date" enough?

---

## 2. Self-submitted documents: submit once, no replace after validation, "pendente de validação"

> "Os utilizadores devem conseguir submeter os seus documentos a 1a vez, não os devem conseguir editar/substituir depois de validados. Quando submetem os documentos deve ficar flagged com 'pendente de validação'"

### Who the "utilizadores" are / where they upload
- Extras/condutores **with a dashboard login** upload on their **own ficha**: RH → (own) ficha → Documentos tab (`client/src/pages/HRPage.tsx:488-700`, `DocumentsTab`) and Perfil → "A minha ficha". When login is blocked for missing docs, they use the block screen `client/src/components/BlockedOwnDocuments.tsx:37-67` (calls `rh.documents.checklist` + `rh.documents.uploadBatch`). Matrix: `ficha: own:ve` for everyone (`shared/access.ts` `MATRIX_SPEC.ficha`).
- The self-uploadable types are `SELF_UPLOAD_DOC_TYPES = id_card, residence_permit, driving_license, nib_proof, address_proof, photo, other` (`server/rhAccess.ts:234-240`; client copy `HRPage.tsx:493`). Contract, annexes, term and insurance are RH-only.
- The website "Be a Driver" uploads licence/ID/CV, but those stay as **URLs inside `driver_applications.payload`** ("Carta (frente)" etc., `../multidriver/.../route.ts:256-260`). They are never copied into `employee_documents`. The public availability form (`server/availabilityForm.ts`) has no documents.

### Endpoints and rules today
- `rh.documents.list/url/upload/uploadBatch/checklist/allStatus/delete` are at `server/rhRouter.ts:833-985`. `upload` is at :861-897 and `uploadBatch` at :899-943 (≤10 files of ≈10 MB, `DOC_MAX_BASE64_CHARS` :22). Both run `assertCanUploadDocuments` + `assertSelfUploadDocType`, store the file to S3 (`employees/{id}/docs/...`), insert a row (`server/db.ts:1515`), log, and optionally run the AI autofill.
- **Replacement is possible today.** `canDeleteDocument` (`server/rhAccess.ts:252-256`) lets the uploader delete their own file (`uploadedById === v.id && canEditPersonal`, and the own ficha is always `canEditPersonal`, :107-109). Uploading again is always allowed because there is no per-type uniqueness. The client mirrors this (`HRPage.tsx:495`, delete button :683-687). Nobody validates; there is **no status field**.
- Compliance (`server/rhService.ts:51-96`) counts a type as present if any row exists.

### Recommendation
- **Schema (0530):** `employee_documents` gains:
  - `status ENUM('pending','validated','rejected') NOT NULL DEFAULT 'pending'`
  - `validatedById INT NULL`, `validatedAt DATETIME NULL`
  - `rejectedReason VARCHAR(300) NULL`
  - `archivedAt TIMESTAMP NULL`, `archivedById INT NULL` (replace = archive, never delete, in line with 0376)
  - index `(employeeId, docType, status)`
  
  **Backfill decision:** existing rows to `validated` (legacy, avoids flooding RH) or `validated` when uploaded by RH and `pending` when self-uploaded (`uploadedById = employees.userId`).
- **Pure rules** in `server/rhAccess.ts` (tested like the others):
  - `docUploadError(v, e, docType, existingStatuses)`: own and not RH → allowed only if there is no `validated` row of that type (first submission; or after `rejected`). Otherwise "Documento já validado — pede ao RH para o substituir."
  - `canDeleteDocument`: own → only while `pending`. RH (`isRhFor`/`canEditContract`) → always, and it archives.
  - `initialStatusFor(v, e)`: own upload → `pending`. RH upload on someone else's ficha → `validated` (decision) or `pending`.
- **Server:** enforce the rules in `upload`/`uploadBatch`/`delete` (`rhRouter.ts:861-985`). Add `rh.documents.validate({id})` and `rh.documents.reject({id, reason})` for RH roles, never on the own ficha. They log `employee_document_validate/reject` and notify the person (bell, optional email) on reject. When a `driving_license` is validated, item 1 asks for the issue date.
  - List and checklist return `status`. `allStatus` returns `pendingCount` per employee.
  - Compliance: decide whether `pending` counts as present for the login block. Recommendation: yes (don't block), but "Documentos completos" requires validated.
- **UI:**
  - On each document tile (`HRPage.tsx:668-689`), a status badge ("Pendente de validação" amber, "Validado" green, "Recusado" red + reason). Hide "Carregar"/delete for the own user when that type is validated.
  - Validate/Reject buttons for RH.
  - In the list/cards a "N por validar" badge, plus an RH queue filter "Documentos por validar".
  - `BlockedOwnDocuments` shows "Enviado — pendente de validação".
- **Notification (optional):** a bell to RH of the city when a self-upload arrives, through the existing notify routing (`shared/notificationRouting.ts`), behind a switch.
- **Tests:** rule matrix (own pending / own after validated / own after rejected / RH / TL / other city); `server/documents.test.ts` needs a DB, so put the new tests in a new pure test file.
- **Decision:** must the very first submission be per type (one file set) or per file? Proposal: per type, as multi-page (front/back) uploads arrive in one batch.

---

## 3. Internal notes on extras

> "Os extras devem ter notas internas (ex. este extra trabalhou mal no dia ...)"

### What exists
- No notes on `employees`. Only `deactivationNotes` (`drizzle/schema.ts:609`). Penalties (`employee_penalties`, :693) are a formal points system (3 points block) and are not free notes.
- Patterns to reuse:
  - thread-of-messages tables `complaint_messages` (:426), `lost_found_messages` (:1264) and `task_comments` (:2065);
  - the archive pattern (0376);
  - the per-ficha RH permissions in `server/rhAccess.ts`;
  - the UI pattern for internal notes `client/src/components/CaseMessageList.tsx:45` ("Nota interna" badge) and `RecruitmentSection.tsx:294`.
- Assignment rows have their own `notes VARCHAR(255)` (`extras_dia_assignments.notes`, `drizzle/schema.ts:924`), which the auto-fill overwrites ("preenchido automaticamente…", `server/extrasAutomation.ts:651`). That is not a place for evaluations.

### Recommendation
- **Schema (0535):** `employee_notes`
  - `id INT PK`, `employeeId INT NOT NULL`, `body TEXT NOT NULL`
  - `kind VARCHAR(16) DEFAULT 'general'` (`general | performance | conduct | praise`)
  - `workDate VARCHAR(10) NULL` ("trabalhou mal no dia …"), `assignmentId INT NULL` (link to the escala row), `city VARCHAR(16) NULL`
  - `authorId INT NOT NULL`, `createdAt`, `editedAt NULL`, `archivedAt NULL`, `archivedById NULL`
  - index `(employeeId, createdAt)`
- **Permissions** (new pure functions in `server/rhAccess.ts`):
  - `canViewInternalNotes(v, e)`: **never the person themselves** (`!isOwn`, even though `ficha` is `own:ve`); team_leader+ in managed scope, national roles, admin+. Same scope as `canViewEmployee` minus own.
  - `canWriteInternalNotes` = the same.
  - Edit/archive: author within 24 h, or `isRhAdmin`.
  - Notes must never be returned in any procedure the extra can call (`rh.byId` own, `extrasAvailability.myWeek`).
- **Server:** `rh.notes.list({employeeId})`, `rh.notes.add({employeeId, body, kind, workDate?, assignmentId?})`, `rh.notes.archive({id})`. Each logs (`logActivity` entity `employee_notes`) and masks nothing, since notes are free text; recommend a UI hint not to write health data (RGPD).
- **UI:**
  - In the RH detail, a new tab "Notas internas" (Tabs at `HRPage.tsx:1856-1858`) with a list + add form, kind chips and dates.
  - In Extras-Dia, a note icon with count on `AssignmentRow` (`client/src/pages/ExtrasDiaPage.tsx:1280`), with a quick add pre-filled with `workDate=targetDate` and `assignmentId`.
  - In `PersonPicker`, a warning dot for recent negative notes (last 30 days).
- **Tests:** permission matrix (own never sees, TL only below in city, supervisor city, backoffice national) and the archive rules.

---

## 4. Notes per work day in "Extras dia" → "Pressão"

> "Deve dar para escrever notas internas no dia de trabalho na pagina 'Extras dias' -> 'Pressão'. Ao selecionar o dia, aparece a info e deve dar para guardar varias notas para esse dia"

### What exists
- Page: `client/src/pages/ExtrasDiaPage.tsx:194-…`. The tabs "Dia | Pressão" are at :287-294 (persisted `extrasdia.tab`). "Data base" uses `UniDateNav` (:270-277), and the schedule shown is for `targetDate = baseDate + 1`.
- Pressão tab: `client/src/pages/extrasDia/PressureTab.tsx`. It is a **weekday × hour** heat-map of historical stats (`extrasDia.pressure`, `server/routers.ts:5076-5091` → `server/extrasPressure.ts`, table `ops_pressure_stats`; rules in `shared/extrasPressure.ts`). Clicking a cell (`PressureTab.tsx:205-221`) shows the detail panel (`:244-254`, `detail()` :94-112): loads, deliveries, percentiles, crew. **It is not tied to a calendar date** and has nothing about notes.
- There is no day-notes table. Closest is `shift_handovers` (one row per day/shift/city with a single `notes`, `drizzle/schema.ts:~1000`).

### Recommendation
- **Schema (0540):** `extras_day_notes`
  - `id`, `city VARCHAR(16) NOT NULL` (lisbon|porto|faro, like `extras_dia_assignments.city`), `workDate VARCHAR(10) NOT NULL`
  - `hour TINYINT NULL` (operational 3–26, optional "às 02h…"), `body TEXT NOT NULL`
  - `authorId`, `createdAt`, `editedAt`, `archivedAt`, `archivedById`
  - index `(city, workDate)`
- **Server** (`extrasDia` router, `server/routers.ts:4747`): `dayNotes.list({city, from, to})` (view `extras_dia:view` + `assertCityInScope`), `dayNotes.add({city, workDate, hour?, body})` (`extras_dia:edit`), `dayNotes.archive({id})` (author or admin+). Log each one.
- **UI:**
  - In the Pressão tab add a "Dia" selector defaulting to the page's `targetDate`, and a "Notas do dia DD/MM" card (list + textarea + "Guardar", several notes per day, author + time).
  - When a cell is selected, the detail panel also lists notes from the **last N dates with that weekday** (and that hour if set), so the stats get context ("sexta 03/10: 2 extras faltaram").
  - Also show the day's notes count in the "Dia" tab header.
- **Decision:** are notes per **calendar date** (recommended: "dia de trabalho") or per **weekday×hour** pattern (what the Pressão grid shows)? Are notes per city or global?
- **Tests:** pure helper `notesForCell(notes, weekday, hour)` (operational hours 24–26 belong to the previous weekday, same rule as `tightHoursForDay`, `shared/extrasPressure.ts:338-349`), plus permission/scope.

---

## 5. "As minhas tarefas": good filters (reservation status like Multipark, driver applications, …)

> "Nas tarefas 'as minhas tarefas' deve estar filtrado por estado da reserva (quando é reserva ser parecido com os estados da multipark), candidaturas de condutores, etc. Tudo que de para filtrar bem"

### What exists
- **Model** `tasks` (`drizzle/schema.ts:2012-2041`):
  - `taskStatus` = backlog/todo/in_progress/review/done (labels `shared/taskRules.ts:15-21`), `taskPriority`, `dueDate/dueHasTime`, `projectId`.
  - Origin columns `sourceModule/sourceId/sourceKey` (0091).
  - `serviceSourceKey` generated unique (0325), `templateId/Date/Shift`, `archivedAt`.
  - Assignees in `task_assignees` (:2005); comments in `task_comments`.
- **Sources** `TASK_SOURCE_MODULES` (`shared/taskRules.ts:186-190`): manual, availability, complaint, incident, lost_found, template, google_tasks, service, rh. The real creators are:
  - `manual` (`server/tasksRouter.ts:245-256,310-320`);
  - `availability` (`server/tasksService.ts:460-470`);
  - `template` (checklists, `tasksService.ts:593-608`);
  - `service`, i.e. booking extra services, one task per `BookingExtraService` line with `sourceKey = "svc:<bookingId>:<lineId>"` (`server/serviceTasks.ts:1-27,313-316`). They are auto-closed when the booking is CANCELLED or the service is done (`shared/serviceTasks.ts:221-287`);
  - `rh` (fichas sem cidade, `server/employeeCityFix.ts:163`);
  - `google_tasks` (`server/google/syncStore.ts:186`).
  
  complaint/incident/lost_found have link + auto-close rules (`shared/taskRules.ts:207-215`) but no creator in the current code. **No task is created for driver applications/leads** (lead SLA is a bell summary, `server/extrasAutomation.ts:1414-1480`).
- **Booking link:** only through `sourceKey` (`svc:<bookingId>:…`), parsed by `taskSourceLink` (`shared/taskRules.ts:193-205`). The booking status is not stored on the task. The local booking copy `multipark_bookings` (`externalId`, `status`, `drizzle/schema.ts:~1342-1367`) is refreshed by the Multipark webhook (`server/multiparkWebhook.ts:150-163`).
- **Multipark booking statuses** (single source): `BOOKING_STATUSES` / `BOOKING_STATUS_LABELS` / `BOOKING_STATUS_COLORS` in `shared/reservasDoDia.ts:21-52`: PENDING "Pendente", BOOKED "Reservada", CHECKING_IN "A dar entrada", CHECKED_IN "Estacionada", MOVING "Em movimento", PENDING_CHECKOUT "A preparar saída", CHECKING_OUT "A entregar", CHECKED_OUT "Entregue", CANCELLED "Cancelada".
- **Existing filters:**
  - server `listInput` (`server/tasksRouter.ts:146-153`) has projectId, assigneeId, status, mine, showOld, focusId; `baseConds` is at `server/tasksService.ts:124-131`;
  - client (`client/src/pages/TasksPage.tsx:170-330`) has view modes mine/kanban/list/templates, cost-centre select, free-text search (title/description/assignee, client-side), "Mostrar antigas". **The client does not use the status filter. There are no origin, booking-status, priority, overdue or date filters.**

### Recommendation
- **Filters (server-side, combinable with AND):**
  - `sources[]` (TASK_SOURCE_LABELS, plus "Candidatura de condutor" if added)
  - `taskStatuses[]`, `priority[]`
  - `due` (overdue / today / tomorrow / this week / no date)
  - `bookingStatuses[]` (only meaningful for `service` and, later, complaint/lost_found tasks with a booking)
  - `projectId`, `assigneeId`, `q`

  Put the filter state machine in `shared/taskFilters.ts` (pure, tested) and persist it per user with `useViewPref`/`usePersistedState`.
- **Booking status:**
  - Option A (no schema): `listTasks` LEFT JOINs `multipark_bookings mb ON mb.externalId = SUBSTRING_INDEX(SUBSTRING_INDEX(tasks.sourceKey, ':', 2), ':', -1)` when `sourceModule='service'`, returning `bookingStatus` and filtering on it.
  - Option B (cleaner/indexable): migration 0545 adds a `tasks.bookingRef VARCHAR(128) NULL` (or a generated column from `sourceKey`) + index, filled by `serviceTasks` on create, then JOIN on it.
  
  Show the Multipark status chip with `BOOKING_STATUS_COLORS` next to the source chip in `TaskSourceChip` (`TasksPage.tsx:150-166`).
- **Driver applications as tasks (if wanted):** new source `lead` with `sourceKey "lead:<leadId>"`. The lead automation (`runLeadAutomation`) creates one task per new candidatura (assigned per city to the lead owner/supervisor) and auto-closes it on converted/declined/archived (extend `SOURCE_RESOLVED_STATUSES`). The filter then works on "Candidaturas".
- **UI:** a filter bar (chips/selects, shadcn `Select`/`Popover` + `Checkbox`) above both "As minhas" and the board, with counters per chip, "Limpar filtros", and a mobile-friendly sheet.
- **Tests:** `shared/taskFilters` (each filter, combinations, booking status only for service tasks, unknown status label fallback via `statusLabel`); SQL builder for the JOIN (pure part).
- **Decisions:** should candidaturas become tasks (and assigned to whom)? Which booking statuses should be grouped ("Por recolher / No parque / Entregue / Cancelada" vs the raw 9)?

---

## 6. "Gerar hoje" in Tarefas → Checklists: "acesso negado" for some users

> "Botão 'gerar hoje' tambem nas 'tarefas' na parte de checklist, aparece acesso negado para alguns users e nao o conseguem usar"

### Where it is
- The button is in `client/src/components/TaskTemplatesPanel.tsx:66-71` (`canGenerate &&`). It is rendered by `TasksPage.tsx:592` with `canGenerate={isAdmin}`, where `isAdmin = ["super_admin","admin"].includes(user.role)` (`TasksPage.tsx:177`, raw role, ignores per-user overrides).
- The Checklists tab itself is shown with `canTemplates = can(user, "tarefas", "manage")` (`TasksPage.tsx:178,524-529`).
- Server procedure `tasks.templates.generateNow` (`server/tasksRouter.ts:519-524`) requires `requireAccess(ctx.user, "tarefas", "manage")` **and** `requireRole(ctx.user.role, "admin")` (raw role, :55-57). It calls `generateTemplateTasks(new Date())` (`server/tasksService.ts:554-619`, idempotent, all cities; the hourly cron calls the same thing).
- Matrix `tarefas` (`shared/access.ts:171-174`): extra/condutor `own:ve`, team_leader `below_city:ve`, **supervisor `city:vem`**, **frontoffice/backoffice `national:vem`**, admin/super_admin `national:vem`.

### Root cause
**Client/server permission mismatch.** Supervisors, front office and back office have `tarefas: manage`, so they see the Checklists tab and can create/edit/archive checklists. The server's `generateNow` adds a second, stricter gate, raw role ≥ admin. Until commit `16031068` (P3 lote 18a, #232, 2 Oct 2026) the button was shown to everyone in the Checklists tab (verified with `git show 16031068^:client/src/components/TaskTemplatesPanel.tsx:58`), so those users clicked it and got the server's `FORBIDDEN "Acesso não autorizado."`, which is the "acesso negado". Since 18a the button is hidden from them, so they simply "não o conseguem usar". Either way the cause is the extra `requireRole(…,"admin")`. The raw-role check also ignores per-user access overrides, unlike everything else in Tarefas (`withOverrides`, comment at `server/tasksRouter.ts:5-7`).

### Recommended permission model
- Whoever can **manage checklists** (`tarefas:manage`: supervisor in their city, front/back office national, admin+, or anyone given it by override) can "Gerar hoje", **limited to their scope**.
- Server:
  - drop `requireRole(…,"admin")`;
  - keep `requireAccess(user,"tarefas","manage")`;
  - pass the caller's city scope into `generateTemplateTasks(now, { projectIds: scopedProjectIds() })` so a city-scoped supervisor only generates templates whose `cityProjectId` is in scope (templates without a city only for national users), exactly like `templates.list` filters with `assertProjectAccess` (`tasksRouter.ts:460-467`);
  - log `logActivity("task_templates_generate_now", details: date, created/skipped/failed)`;
  - keep it idempotent, since the unique occurrence key is already there.
- Client: `canGenerate = canTemplates` (one shared predicate, e.g. `canGenerateChecklists(user)` in `shared/taskRules.ts`, used on both sides).
- Optional: team leaders could get a "Gerar hoje" limited to templates of their city/shift if the product wants it (today TL is `below_city:ve`, no manage).
- **Tests:** predicate matrix (supervisor/front/back/admin yes, TL/extra no, override manage yes) and the scope filter in the generator (pure part: `templateOccurrencesFor` + a new `inScope` filter).
- Same smell elsewhere: `tasks.checkNotifications` (`tasksRouter.ts:434-440`) also uses raw `requireRole(admin)` with an `isAdmin` client gate (`TasksPage.tsx:569`). It is consistent today, but it ignores overrides.

---

## 7. Staffing-need indicator inconsistency (02h need vs people until 03h)

> "corrigir inconsistencia no indicador de necessidade de pessoal - por exemplo aparece que precisamos de 2 pessoas para as 2h no entanto ja temos 2 pessoas que marcaram até as 3h da manhã. ou seja nao deveria aparecer aviso e aparece"

### How need and coverage are computed
- **Need per hour.** `getExtrasDiaForecast(baseDate, city)` (`server/extrasDia.ts:1108-1360`) builds `hourly[0..26]` (`FORECAST_HOURS = 27`, :55). The operational day is 03h→03h:
  - bookings of D+1 at 3–23h go to hours 3–23;
  - D+2 at 0–2h go to **24–26**;
  - D+1 at 0–2h are discarded (they belong to the previous day) (:1160-1177).
  
  `driversNeeded` = **extras beyond the team leader** (`extrasNeededFor`, `shared/extrasSchedule.ts:57-69`, "people − 1").
- **Assignments** are stored in extended hours. `startHour 3..26`, `endHour 4..27` (27 = 03h next day) (`server/routers.ts:4842-4846`). The UI end-hour select offers 0..27 labelled "03h+1" for 27 (`ExtrasDiaPage.tsx:143-160`).
- **Warnings shown:**
  - (a) Team card "Faltam condutores em N hora(s) deste turno … `02h+1: precisas 2, tens X`" (`ExtrasDiaPage.tsx:833,860-861,955-966`) from `extrasDia.coverage` (`server/routers.ts:5002-5008`) → `coverageReport` (`server/extrasAutomation.ts:662-674`) → `coverageGaps(needed, drivers)` (`:112-121`): `have = assignments with startHour <= h < (sentHomeHour ?? endHour)`, **TL excluded**, proposals included.
  - (b) "Escala automática → Falta de gente: faltam 2 condutores entre 02h–03h" (`ExtrasDiaPage.tsx:713-731`) from `getScheduleOverview` (`server/extrasSchedule.ts:864-876`) → `remainingNeed` + `summarizeGaps` (`shared/extrasSchedule.ts:427-433,525-544`). Same counting rule.

### What is NOT the bug
With escalados stored as `endHour = 27`, hour 26 (02h–03h) **is** counted (`26 < 27`). Two drivers until 03h against a need of 2 at 02h gives no gap. The hour arithmetic, the D+1/D+2 mapping, invalidation after edits (`ExtrasDiaPage.tsx:791-839`) and `addDaysIso` (UTC-noon based, `server/extrasAutomation.ts:55-59`) are all consistent.

### Root causes found (the warning is "right" by its own rule, but inconsistent with what the user sees)
1. **Availability "until 03h" is read with two different day conventions.**
   - The scheduler converts availability with `availabilityWindow` (`shared/extrasSchedule.ts:226-247`): any hour < 3 means **the next night** (`fromHour < 3 → +24`), and the window is clamped to 3–27.
   - The Disponibilidade grid/filter (`shared/availabilityWindow.ts:49-102`, `matchesAvailabilityWindow`) uses **calendar** semantics: 0–3h on day X is the early morning of X, which is operationally X−1's night.
   
   Concrete effects:
   - "Terça 00h–03h" counts for the planner reading the grid as Monday night, but the scheduler plans it for Tuesday-night/Wednesday 00–03.
   - "02h–10h" becomes `{from: 26, to: 27}`: only 1 hour, next night (from 2 → 26, to 10 ≤ 26 → 34 → clamp 27).
   
   People who "marcaram até às 3h" in the grid are therefore **not candidates** for that night's 02h. The proposal leaves 02h uncovered and both warnings fire. Existing tests encode the scheduler side (`server/extrasSchedule.test.ts:124-131`, `22→2 = 22–26`) and the filter side (`server/availabilityWindow.test.ts:113-120`, "2h–10h" on Monday counts for Monday 2–10). Nothing checks that the two agree.
2. **Website night slots end at 01h but are shown as "Noite".** `SLOT_RANGES` "15H-01H"/"18H-01H" (`server/webIntake.ts:427-435`) are stored as `night=true, toHour=1` (`mapWebsiteDay`, :479-509). The grid shows the moon icon (the app labels Noite as "15h–03h", `client/src/components/AvailabilityDayFields.tsx:75`), but the scheduler uses the exact hours (to 25). Those people can never cover 01h–03h even though they look like "Noite".
3. **The warning counts only escalados, and never the TL.** "tens X" ignores people who are available but not (yet) scheduled. The proposal is only computed at the cron time or on "Proposta automática", so availability marked later never changes the warning. If one of the "2 pessoas" is the team leader, `have` is 1 (`coverageGaps` filters `!isTeamLeader`), while the text "precisas 2, tens 1" never says "além do TL" (only the table header tooltip does, `ExtrasDiaPage.tsx:422`).

(Which of 1–3 hit the user's example can only be confirmed with the concrete date and city. See the open questions.)

### Fix
- **One operational-day convention for availability**, in one shared module.
  - **Option A (recommended):** the availability form/grid for a day edits the operational day 03h→03h, with selectors 03…26 labelled "00h (+1)". A night ending at 3h is then always marked on the starting day, and `availabilityWindow` keeps its rule.
  - **Option B:** `loadScheduleCandidates`/`listDriverCandidates` also read **day D+1 rows with hours < 3** as part of day D's night (shifted −24), and `availabilityWindow` stops treating "< 3" on the same row as "next night".
  
  Either way, make `shared/availabilityWindow.ts` and `shared/extrasSchedule.ts` share one `windowsForOperationalDay(days, date)` and add a property test that the filter and the scheduler agree on every (day, from, to). A data backfill for existing rows with `fromHour < 3` needs a decision.
- **Website slots:** decide whether "15H-01H" really means 01h (and drop the moon icon when hours are explicit), or move the website to "15H-03H" (multidriver repo, wire contract with `SLOT_RANGES`, keep the legacy keys).
- **Indicator:** per hour show "precisas N (além do TL) · escalados M · disponíveis por escalar K". Rephrase the banner to "Faltam escalar 2 às 02h (há 2 disponíveis: Ana, Rui)" vs "Falta gente às 02h (ninguém disponível)", using `availabilityWindow` over the candidates. Offer a one-click "Preencher" for the gap.
- **Tests:**
  - regression `coverageGaps([..26:2], [{3..27},{20..27}]) → []`;
  - `sentHomeHour` at 26 → gap;
  - TL not counted, with a label;
  - availability "Ter 00h–03h" covers Monday's 24–26 (with the chosen option);
  - "02h–10h" never collapses to `{26,27}`;
  - filter/scheduler agreement;
  - `mapWebsiteDay("18H-01H")` window ends at 25 and is labelled accordingly.

---

## 8. "Avisar este turno" should send the "aviso de trabalho" with the right day/hours

> "na pagina 'extras dia', ao clicar em 'avisar este turno' deve enviar email template 'aviso de trabalho' ja com o dia e hora configurado nessa janela de trabalho. Assim ao inves de ser preciso ir à disponibilidade e enviar o template aos extras, so envia quando o utilizador clicar e envia com as infos certas e com a disponibilidade de cada extra"

### What exists
- **Button** in `client/src/pages/ExtrasDiaPage.tsx:931-939` (TeamSection) calls `extrasDia.notify({date, city, shift})` (`ExtrasDiaPage.tsx:846-855`). It is disabled for past days or when the shift has no rows (it counts proposals too).
- **Server** `extrasDia.notify` (`server/routers.ts:5038-5056`, `extras_dia:edit`, refuses past days) calls `notifyAssignments(date, {city, shift})` (`server/extrasAutomation.ts:436-594`):
  - **WhatsApp only**; it throws if `WHATSAPP_TOKEN` is missing;
  - only `status='confirmed'` rows with `employeeId`;
  - only extras (`extraIdsAmong`; employees are logged as `NOT_EXTRA_NO_NOTICE`);
  - one message per person with `{{2}} = scheduleMessageText({date, city, spans, meetingPoint})` (`shared/extrasSchedule.ts:182-193`, e.g. "sexta 26/09, das 18h às 03h · Lisboa · ponto de encontro: …");
  - first ever shift: also `morada_e_regras`.
  
  **Idempotency** comes from `extras_dia_notifications` unique `(assignmentId, version, kind, channel)` (`drizzle/schema.ts:963-983`), claim/finish at `server/extrasSchedule.ts:519-566` (retry ≤ 3, stale 'sending' after 15 min), plus legacy `extras_dia_notices` (yes/no answers). It ends with a `logActivity`.
- **The template "aviso de trabalho"** is a **WhatsApp (Meta) template**, catalog `shared/whatsappTemplate.ts:152-163` (id `aviso_trabalho`, name `SHIFT_NOTICE_TEMPLATE_NAME`, `{{2}}` = "Dia"). There is **no email template system**: emails are composed in code.
- **The schedule email exists but is not wired to this button.** `sendScheduleEmails` (`server/extrasSchedule.ts:595-660`, subject "Escala Multipark — …", body "Estás escalado(a): …") is only sent by "Confirmar escala"/cron via `sendScheduleNotifications` (:662-690). It has no shift filter. It uses `employees.email` only, although the schema comment says extras use the **personal** email as primary (`drizzle/schema.ts:551-556`), so extras without a work email are skipped as "sem email na ficha".
- **The manual path the user wants to avoid** is Disponibilidade (`AvailabilitySection`, `ExtrasDiaPage.tsx:1772-…`): pick extras, choose the WhatsApp template "Aviso de trabalho" and **type the day by hand** in `{{2}}` (`ExtrasDiaPage.tsx:2085-2135`, `whatsapp.sendBroadcast`). Email there is only the availability *request* (`extrasAvailability.sendRequest`, `server/routers.ts:5204-5245`, `shared/availabilityMessages.ts:35-…`).
- **Email transport:** `server/mail/systemMail.ts` `sendEmail` (Gmail API, service account; `isEmailSendConfigured`). Each send can carry `auto: {kind, employeeId}` for the "Comunicação" log.

### Recommendation
- **Server:** extend `extrasDia.notify` input with `channels: ("whatsapp"|"email")[]` (default both) and `dryRun?: boolean`. Route it through one function `notifyShift(date, city, shift, channels, userId)` that:
  - selects rows exactly like now (confirmed, extras, shift);
  - for each person builds **their own** text from their row(s): day, hours `startHour–(sentHomeHour ?? endHour)`, city, meeting point. Optionally it adds their declared availability (`availabilityWindow`), e.g. "(disseste que podias das 18h às 03h)", if that is what "com a disponibilidade de cada extra" means;
  - WhatsApp: the existing `notifyAssignments` path (template `aviso_trabalho`);
  - email: `sendScheduleEmails` with a new `shift` filter, subject "Aviso de trabalho — sexta 26/09, 18h–03h", and the same text. The address is `employees.email || employees.personalEmail` (fix). Respect `noAutoEmail`;
  - idempotency: reuse `claimNotification(…,"scheduled",channel)`. A second click sends nothing new; a changed row (version bump) resends;
  - audit: `extras_dia_notifications` rows + one `logActivity("extras_shift_notify", details: date/city/shift/sent/failed per channel)`.
- **Preview query** `extrasDia.notifyPreview({date, city, shift})` (no side effects) returns per person: name, text, channels available (phone ok / email ok / STOP / "não enviar email"), already notified for this version, and proposal-not-confirmed rows.
- **UI:** "Avisar este turno" opens a confirm dialog (same D32 "Confirmar" pattern as the WhatsApp broadcast, `ExtrasDiaPage.tsx:2116-2120`). It shows the table of recipients with their exact message, channel toggles (WhatsApp/Email) and a count of who is skipped and why. "Enviar" then gives a result per person. The `NoticeBadge` on each row (`ExtrasDiaPage.tsx:1270`) also shows the email state.
- **Tests:** pure `shiftNoticeText` (hours across midnight "das 22h às 03h", sent-home, two spans in one day), channel selection (personal email fallback, noAutoEmail, STOP), idempotency (`pendingScheduleNotifications` per channel and version), and the shift filter.
- **Decisions:**
  - Should the button also **confirm** proposed rows ("Confirmar e avisar"), or keep "only confirmed"?
  - Is email always on, or a toggle?
  - Does "com a disponibilidade de cada extra" mean the scheduled hours of each person (already per person) or quoting their declared availability?

---

## 9. City in the "Novo lead" modal

> "mais um update: deve dar para por aqui a cidade em que vai estar o extra"

### What exists
- **Modal** `client/src/pages/ExtraLeadsPage.tsx:883-936` (title "Novo lead", helper "Nome obrigatório; telemóvel ou email, pelo menos um…", fields Nome*, Telemóvel, Email, Notas). A **"Cidade" select already exists but only when editing** (`{editing && (` at `ExtraLeadsPage.tsx:908-924`). Draft type `LeadDraft{…, city}` (:101-103), city options `cityProjects` = `projects.list` filtered to `level === "city"` (already limited to the user's cities) (:157-164). `submitDraft` sends `projectId` only on update (:313-321).
- **Create procedure** `extraLeads.create` (`server/routers.ts:5668-5685`, `leads_extras:edit`) accepts **no `projectId`**. `createExtraLead` (`server/extraLeads.ts:225-253`) forces `projectId: currentDefaultCityId()`, which is the creator's city, or `null` for national users ("visível a todos") (:241-242).
- **Model:** `extra_leads.projectId INT NULL` (migration 0077, `drizzle/schema.ts:2697-2698`) means the city cost centre; NULL = visible to all. Validation `assertLeadCity` (`server/extraLeads.ts:188-198`) requires a `level='city'` node in the caller's scope; it is used by `update` and `bulkUpdate`.
- **How city is represented for extras:** `employees.projectId` = cost centre (city or a descendant). Without a city an extra can't log in nor be scheduled (`noCityScheduleMessage`, `server/routers.ts:4876-4881`; `resolveEmployeeCities`). Approving a Be-a-Driver application **requires** a city (`driverApplications.approve` input `projectId` required + `assertProjectAccess`, `server/routers.ts:5302-5313`). Converting a lead also requires it (`ExtraLeadsPage.tsx:1037-1056` "Centro de Custos (cidade) *", `convertLeadToExtra(leadId, projectId)` `server/extrasAutomation.ts:1105-…`).
- **Carry-over today:**
  - application → lead: `projectId = cityProjectIdFromText(app.city)` (`server/extraLeadsSync.ts:208`); merges use `COALESCE(extra_leads.projectId, …)` (:447).
  - lead → employee: the convert dialog **does not pre-fill the lead's city**. `openConvert` only pre-selects when the user has exactly one city (`ExtraLeadsPage.tsx:166-169`).

### Recommendation
- **Client:** show the Cidade select in **create** too (remove the `editing &&` guard), pre-selected with the user's city when they have only one, and send `projectId` in `create.mutate`. **Make it required ("Cidade *")** with the same rule as approve/convert. The only exception is national users, who may pick "Sem cidade" (consistent with the server rule that only national users can have NULL). Update the helper text: "Nome e cidade obrigatórios; telemóvel ou email, pelo menos um…".
- **Server:** `extraLeads.create` input `projectId: z.number().int().positive().nullable().optional()`. In `createExtraLead`, `projectId = input.projectId !== undefined ? (await assertLeadCity(input.projectId), input.projectId) : currentDefaultCityId()`. Reject NULL for city-scoped users (`assertLeadCity(null)` already throws via `assertProjectAccess(null)` for scoped users). Log the city in the `extra_lead_create` details.
- **Carry-over:** in `openConvert` pre-select `l.projectId` when present (still editable), so lead → extra keeps the city into `employees.projectId`. The scoring and the SLA summaries per city (`server/extrasAutomation.ts:1466-…`) and the funnel "cidade" column improve automatically.
- **Tests:** create with a city out of scope → error; national user with NULL → ok; scoped user without a city → defaults to their city, or an error if required; convert pre-fill (pure helper `defaultConvertCity(lead, cityProjects)`).
- **Decision:** required for everyone, or optional for national roles? Recommendation: required in the UI, with the server accepting NULL only for national users.

---

## Proposed migration numbering (verify before merging)
- **0530**: `employee_documents` status/validation/archive columns + `employees.drivingLicenseIssuedAt/ValidatedAt/ValidatedById` (items 1+2).
- **0535**: `employee_notes` (item 3).
- **0540**: `extras_day_notes` (item 4).
- **0545** (optional): `tasks.bookingRef` + index (item 5, option B).
- Items 6, 7, 8 and 9 need no schema change.

## Open questions (product decisions)
1. Licence < 3 years: block from escala, warn, or label only? Is RH validation required on top of "≥ 3 years"?
2. Legacy documents: backfill as validated or pending? Does a `pending` doc count toward the mandatory checklist / login block?
3. Who may read the extras' internal notes: TL of the city or only supervisor+? (The extra never.)
4. Day notes: per calendar date (recommended) or per weekday×hour? Per city?
5. Should candidaturas create tasks, and who are they assigned to? How should the 9 Multipark statuses be grouped in the filter?
6. Should "Gerar hoje" also be available to team leaders (limited to their city/shift)?
7. Item 7: send the concrete date/city of the example to confirm which cause hit. Pick option A (operational-day form) or B (scheduler reads D+1 early hours). Should the website night slot end at 01h or 03h?
8. Item 8: should "Avisar este turno" confirm proposals? Is email always on? What does "disponibilidade de cada extra" mean in the message?
9. Item 9: city required for everyone, or optional for national users?
