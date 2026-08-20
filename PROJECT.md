# Barnie — Dashboard Multipark

Backoffice/ERP completo para operações de estacionamento Multipark.

**Stack:** React 19 + Vite 7 + TailwindCSS v4 + Shadcn/ui + Express + tRPC + Drizzle ORM + MySQL
**Deploy:** Railway (Dockerfile)
**Idioma UI:** Português (PT-PT)

---

## Estrutura de Pastas

```
barnie/
├── client/
│   ├── public/
│   └── src/
│       ├── pages/               (26 páginas)
│       ├── components/
│       │   ├── ui/              (50+ componentes shadcn/ui)
│       │   ├── AIChatBox.tsx
│       │   ├── DashboardLayout.tsx
│       │   ├── Map.tsx
│       │   └── ErrorBoundary.tsx
│       ├── contexts/
│       │   └── ThemeContext.tsx
│       ├── hooks/
│       │   ├── useAuth.ts
│       │   ├── useMobile.tsx
│       │   ├── useComposition.ts
│       │   └── usePersistFn.ts
│       ├── lib/
│       │   ├── trpc.ts
│       │   └── utils.ts
│       ├── App.tsx
│       ├── main.tsx
│       └── const.ts
├── server/
│   ├── _core/
│   │   ├── index.ts              (Express server entry)
│   │   ├── context.ts            (tRPC context)
│   │   ├── trpc.ts               (tRPC setup)
│   │   ├── oauth.ts              (Google OAuth)
│   │   ├── cookies.ts
│   │   ├── sdk.ts
│   │   ├── llm.ts                (OpenAI integration)
│   │   ├── imageGeneration.ts
│   │   ├── voiceTranscription.ts
│   │   ├── notification.ts       (Nodemailer)
│   │   ├── dataApi.ts
│   │   ├── map.ts
│   │   ├── systemRouter.ts
│   │   ├── vite.ts
│   │   └── env.ts
│   ├── jobs/
│   │   ├── multiparkBookingSync.ts    (cron 15 min)
│   │   └── dailyDriverCollection.ts   (cron diário 2h)
│   ├── routers.ts               (3800+ linhas — endpoints API)
│   ├── db.ts                    (queries Drizzle)
│   ├── storage.ts               (AWS S3 + filesystem local)
│   ├── multipark.ts             (cliente API MultiPark)
│   ├── zello.ts                 (API Zello GPS/Rádio)
│   ├── externalApi.ts
│   ├── payrollPdf.ts
│   ├── payslipPdf.ts
│   └── *.test.ts                (14 ficheiros de teste)
├── shared/
│   ├── const.ts
│   ├── types.ts
│   └── _core/errors.ts
├── drizzle/
│   ├── schema.ts                (47 tabelas)
│   ├── relations.ts
│   ├── 0000–0027_*.sql          (migrações)
│   └── meta/
├── uploads/                     (storage local dev)
├── .env / .env.example
├── package.json
├── drizzle.config.ts
├── vite.config.ts
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
└── railway.json
```

---

## Páginas / Módulos

### Financeiro
| Página | Ficheiro | Descrição |
|--------|----------|-----------|
| Despesas | `ExpensesPage.tsx` | Gestão de despesas com OCR de faturas |
| Dashboard Despesas | `ExpenseDashboard.tsx` | Análise e relatórios de despesas |
| Faturas | `InvoicesPage.tsx` | Geração e tracking de faturas |
| Relatório Anual | `AnnualPage.tsx` | Resumos financeiros anuais |
| Custos Projeto | `ProjectCostsDashboard.tsx` | Orçamento por projeto |

### Pessoas (RH)
| Página | Ficheiro | Descrição |
|--------|----------|-----------|
| Recursos Humanos | `HRPage.tsx` | Funcionários, horários, documentos, ponto |

### Operações
| Página | Ficheiro | Descrição |
|--------|----------|-----------|
| Operacional | `OperationalPage.tsx` | Frota, movimentos, velocidade, PDAs, GPS |
| Serviços | `ServicesPage.tsx` | Lavagem, carregamento, valet |
| MultiPark | `MultiparkPage.tsx` | Reservas, entradas, saídas, cancelamentos |

### Marketing
| Página | Ficheiro | Descrição |
|--------|----------|-----------|
| Marketing | `MarketingPage.tsx` | Campanhas, stats diários, despesas marketing |

### Suporte
| Página | Ficheiro | Descrição |
|--------|----------|-----------|
| Reclamações | `ComplaintsPage.tsx` | Kanban de tickets (novo→análise→aguarda→resolvido→fechado) |
| Google Reviews | `GoogleReviewsPage.tsx` | Reviews com resposta AI |
| Perdidos e Achados | `LostFoundPage.tsx` | Tracking de objetos perdidos |
| Ocorrências | `IncidentsPage.tsx` | Relatórios de incidentes |
| Formação | `TrainingPage.tsx` | Vídeos, manuais, FAQs, quizzes, exames |

### Performance
| Página | Ficheiro | Descrição |
|--------|----------|-----------|
| Performance | `PerformancePage.tsx` | Avaliações semanais de condutores |

### Sistema
| Página | Ficheiro | Descrição |
|--------|----------|-----------|
| Utilizadores | `UsersPage.tsx` | Gestão de utilizadores e roles |
| Projetos | `ProjectsPage.tsx` | Hierarquia Grupo→Cidade→Marca→Projeto |
| Tarefas | `TasksPage.tsx` | Kanban (backlog/todo/in_progress/review/done) |
| Chaves API | `ApiKeysPage.tsx` | Gestão de API keys |
| Logs | `LogsPage.tsx` | Histórico de atividade |
| Parcerias | `PartnershipsPage.tsx` | Parceiros e faturação |

---

## API — Routers tRPC

### `auth`
- `me` — Utilizador atual
- `logout` — Terminar sessão

### `users`
- `list`, `getById`, `create`, `update`, `updateRole`, `toggleActive`
- `sendInvite`, `getInvites`, `acceptInvite`, `completeInvite`

### `projects`
- `list`, `getById`, `create`, `update`, `delete`, `move`
- `getEmployees`, `assignEmployee`, `removeEmployee`
- `costs` — Custos por ano/mês

### `tasks`
- `list`, `getById`, `stats`, `getAssignees`
- `create`, `update`, `delete`
- `checkNotifications` — Alertas de tarefas atrasadas

### `categories`
- `list`, `create`, `seed`

### `expenses`
- `list`, `getById`, `stats`, `create`, `update`, `delete`
- `upcoming`, `overdue`
- `extractFromImage` — OCR de faturas com IA

### `logs`
- `list` — Activity logs

### `rh` (Recursos Humanos)
- **Funcionários:** `list`, `getById`, `create`, `update`, `delete`
- **Documentos:** `getDocuments`, `createDocument`, `createBatch`, `delete`, `getChecklist`, `getAllStatus`
- **Horários:** `getSchedules`, `upsertSchedule`
- **Ponto:** `getRecords`, `create`, `getMonthly`
- **Taxas Extra:** `list`, `seed`, `update`
- **Stats:** `getStats`

### `marketing`
- **Campanhas:** `list`, `getById`, `create`, `update`, `delete`
- **Stats:** `getCampaignStats`, `getDailyStats`, `importDailyStats`, `deleteDailyStat`
- **Despesas Marketing:** `list`, `create`, `update`, `delete`
- **Dashboard:** `getDashboardStats`, `getBookingRevenueByProject`

### `operational`
- **Viaturas:** `list`, `getById`, `create`, `update`, `delete`
- **Movimentos:** `list`, `create`
- **Velocidade:** `limits.list/create/update/delete`, `violations.list/acknowledge`
- **Zello:** `getUsers`, `getChannels`, `getLocations`, `getUserHistory`, `getUserLocation`
- **Histórico Condutor:** `getByDate`, `getByUser`, `getRange`, `getStats`
- **PDAs:** `list`, `create`, `update`, `delete`, `getById`
- **PDA Checkins:** `create`, `checkout`, `getActive`, `getByDate`, `getByPda`
- **Alertas GPS:** `list`, `create`, `acknowledge`, `getStats`

### `apiKeys`
- `list`, `create`, `toggle`, `delete`

### `complaints` (Reclamações)
- `searchBooking`, `fetchBookingDetails`
- `list`, `getById`, `create`, `update`, `delete`
- `addMessage`, `uploadPhoto`, `deletePhoto`
- `stats`, `vehicleHistory`

### `reviews` (Google Reviews)
- `list`, `getById`, `create`, `update`
- `stats`, `searchClientHistory`

### `training` (Formação)
- **Categorias:** `list`, `create`, `delete`
- **Vídeos:** `list`, `create`, `delete`
- **Manuais:** `list`, `create`, `update`, `delete`
- **FAQs:** `list`, `create`, `update`, `delete`
- **Quiz:** `getQuestions`, `createQuestion`, `deleteQuestion`, `saveAttempt`, `getRanking`
- **Exames Carreira:** `list`, `create`, `deleteExam`, `getQuestions`, `createQuestion`, `saveAttempt`, `getAttempts`

### `lostFound` (Perdidos e Achados)
- `list`, `getById`, `create`, `update`, `delete`
- `getPhotos`, `addPhoto`, `getMessages`, `addMessage`
- `getDriverRanking`
- **Histórico Reservas:** `importBookingHistory`, `bookingHistory`, `bookingHistoryDriverStats`, `bookingHistoryCrossRef`

### `incidents` (Ocorrências)
- `list`, `getById`, `create`, `update`, `delete`
- `getStats`, `getByEmployee`

### `performance`
- `list`, `create`, `update`, `delete`, `generateWeekly`

### `services`
- `list`, `create`, `update`, `delete`, `getStats`

### `invoices`
- `list`, `getById`, `create`, `update`, `delete`, `getStats`

### `partnerships`
- `list`, `getById`, `create`, `update`, `delete`
- **Transações:** `list`, `create`
- **Faturas Parceiro:** `list`, `create`, `update`, `delete`, `markOverdue`
- `getDashboardStats`

### `annual`
- `list`, `create`, `update`, `delete`, `generateSummary`

### `multipark`
- `testConnection`, `checkAvailability`, `listParks`
- `syncLogs`, `kpis`, `snapshots`, `importExcel`
- `localBookingsByAction` — Reservas por ação (creation/checkin/checkout/cancelation)

---

## Base de Dados — 47 Tabelas

### Core
| Tabela | Descrição |
|--------|-----------|
| `users` | Utilizadores (openId, role, email, loginMethod) |
| `projects` | Hierarquia Grupo→Cidade→Marca→Projeto (level + parentId) |
| `project_employees` | Associação funcionário↔projeto |
| `activity_logs` | Audit trail |
| `invite_tokens` | Tokens de convite (24h) |
| `api_keys` | Chaves API |

### RH / Funcionários
| Tabela | Descrição |
|--------|-----------|
| `employees` | Dados completos (cargo, salário, docs) |
| `employee_documents` | Ficheiros (BI, carta, contrato, seguro — 11 tipos) |
| `schedules` | Horários semanais |
| `time_records` | Check-in/out com fotos |
| `extra_rates` | Taxas horárias por nível |

### Financeiro
| Tabela | Descrição |
|--------|-----------|
| `expenses` | Despesas com OCR |
| `expense_categories` | Categorias personalizáveis |
| `invoices` | Faturas |
| `annual_reports` | Resumos financeiros mensais |
| `partnerships` | Parceiros |
| `partnership_transactions` | Pagamentos parceiros |
| `partnership_invoices` | Faturação parceiros |
| `project_costs` | Orçamento por projeto |

### Tarefas
| Tabela | Descrição |
|--------|-----------|
| `tasks` | Kanban (status, prioridade, dueDate) |
| `task_assignees` | Múltiplos responsáveis por tarefa |
| `performance_evaluations` | Avaliações semanais |

### Marketing
| Tabela | Descrição |
|--------|-----------|
| `campaigns` | Google Ads, Meta, Instagram |
| `campaign_daily_stats` | Stats diários (gasto, impressões, conversões) |
| `marketing_expenses` | Despesas de marketing |

### Operacional / Frota
| Tabela | Descrição |
|--------|-----------|
| `vehicles` | Viaturas (matrícula, marca, modelo, estado) |
| `vehicle_movements` | Check-out/in de viaturas |
| `speed_alerts` | Alertas de velocidade (legacy) |
| `speed_limits` | Limites configuráveis |
| `speed_violations` | Infrações via Zello |
| `gps_alerts` | Alertas GPS/offline |
| `daily_driver_history` | Métricas diárias condutor (km, horas, bateria) |
| `pdas` | Dispositivos móveis |
| `pda_checkins` | Check-in/out de PDAs |
| `radio_transcriptions` | Transcrições rádio Zello |

### Suporte
| Tabela | Descrição |
|--------|-----------|
| `complaints` | Reclamações (tipo, estado, prioridade, SLA) |
| `complaint_messages` | Mensagens internas/externas |
| `complaint_photos` | Fotos anexadas |
| `incidents` | Ocorrências operacionais |
| `google_reviews` | Reviews Google |
| `lost_found_items` | Objetos perdidos |
| `lost_found_messages` | Mensagens tracking |
| `lost_found_photos` | Fotos de objetos |

### MultiPark
| Tabela | Descrição |
|--------|-----------|
| `multipark_bookings` | Reservas sincronizadas (cada 15 min) |
| `multipark_daily_snapshots` | KPIs diários agregados |
| `multipark_sync_logs` | Logs de sincronização |
| `booking_history` | Histórico de alterações em reservas |

### Formação
| Tabela | Descrição |
|--------|-----------|
| `training_categories` | Categorias de formação |
| `training_videos` | Biblioteca de vídeos |
| `training_manuals` | Manuais PDF/texto |
| `faqs` | Base de conhecimento |
| `career_exams` | Exames de certificação |
| `career_exam_questions` | Perguntas dos exames |
| `career_exam_attempts` | Resultados de exames |
| `quiz_questions` | Quizzes de treino |
| `quiz_attempts` | Resultados de quizzes |

### Serviços
| Tabela | Descrição |
|--------|-----------|
| `services` | Lavagem, carregamento, valet |

---

## Hierarquia de Projetos

```
Grupo (group)
  └── Cidade (city)
      └── Marca (brand)
          └── Projeto (project) ← Unidade operacional
```

Exemplo:
```
Multipark Group
  ├── Lisboa
  │   ├── Airpark
  │   │   └── Airpark Lisboa
  │   ├── Redpark
  │   │   └── Redpark Lisboa
  │   └── Top-Parking
  │       └── Top-Parking Lisboa
  ├── Porto
  │   ├── Airpark
  │   │   └── Airpark Porto
  │   └── Redpark
  │       └── Redpark Porto
  └── Faro
      ├── Airpark
      │   └── Airpark Faro
      ├── Redpark
      │   └── Redpark Faro
      └── Skypark
          └── Skypark Faro
```

---

## Autenticação

1. **Login** → Redireciona para Google OAuth (`/api/oauth/login`)
2. **Callback** → Google redireciona para `/api/oauth/callback?code=...`
3. **Token Exchange** → Troca code por access token
4. **User Info** → Obtém openId = `google_{sub}`
5. **Upsert** → Cria/atualiza user na DB
6. **Sessão** → JWT no cookie `app_session_id` (1 ano)
7. **Dev Mode** → `/api/dev-login` bypass OAuth

### Roles (hierarquia)
```
super_admin (7) > admin (6) > supervisor (5) > team_leader (4) >
backoffice (3) > frontoffice (2) > extra (1) > user (0)
```

---

## Jobs (Cron)

### multiparkBookingSync.ts
- **Frequência:** Cada 15 minutos
- **Ações:** creation, checkin, checkout, cancelation
- **Range:** Últimos 2 dias
- **Processo:** Fetch API MultiPark → mapeia parkName→projectId → upsert `multipark_bookings`

### dailyDriverCollection.ts
- **Frequência:** Diário às 2h (Europe/Lisbon)
- **Dados:** Histórico GPS Zello do dia anterior
- **Calcula por condutor:** km total, horas trabalhadas/paradas, velocidade média/máx, violações, bateria
- **Output:** GeoJSON route → S3, registo `daily_driver_history`

---

## Integrações Externas

| Serviço | Uso | Config |
|---------|-----|--------|
| **Google OAuth** | Autenticação | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **MultiPark API** | Sync reservas | `MULTIPARK_API_KEY`, `MULTIPARK_API_URL` |
| **Zello Work** | GPS/Rádio frota | `ZELLO_API_KEY`, `ZELLO_USERNAME`, `ZELLO_PASSWORD` |
| **OpenAI (compat.)** | IA respostas, OCR | `LLM_API_URL`, `LLM_API_KEY`, `LLM_MODEL` |
| **AWS S3** | Storage ficheiros | `AWS_S3_REGION`, `AWS_S3_BUCKET_NAME`, `AWS_S3_ACCESS_KEY`, `AWS_S3_SECRET_ACCESS_KEY` |
| **Nodemailer SMTP** | Emails/notificações | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` |
| **Google Maps** | Mapas GPS | `VITE_GOOGLE_MAPS_API_KEY` |

---

## Variáveis de Ambiente

```env
# Server
NODE_ENV=production
PORT=3000

# Database
DATABASE_URL=mysql://user:pass@host:3306/barnie

# Auth (Google OAuth)
JWT_SECRET=min-32-chars-secret
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
OWNER_OPEN_ID=google_123456789
OWNER_EMAIL=admin@multipark.pt

# Frontend
VITE_APP_ID=barnie
VITE_GOOGLE_MAPS_API_KEY=AIza...

# AWS S3 (credenciais com prefixo AWS_S3_ — o Vercel reserva AWS_ACCESS_KEY /
# AWS_SECRET_ACCESS_KEY; ver server/storage.ts e .env.example)
AWS_S3_REGION=eu-west-1
AWS_S3_BUCKET_NAME=dashboard-multipark-bucket
AWS_S3_ACCESS_KEY=AKIA...
AWS_S3_SECRET_ACCESS_KEY=xxx

# LLM (OpenAI-compatible)
LLM_API_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@multipark.pt
SMTP_PASS=app-password
SMTP_FROM=noreply@multipark.pt

# MultiPark
MULTIPARK_API_KEY=xxx
MULTIPARK_API_URL=https://api.multipark.pt/api/v1/bookings-api

# Zello
ZELLO_API_KEY=xxx
ZELLO_USERNAME=admin
ZELLO_PASSWORD=xxx
ZELLO_NETWORK=multipark

# Google Maps (backend)
GOOGLE_MAPS_API_KEY=AIza...
```

---

## Storage

**Modo dual:**
- **Produção:** AWS S3 com URLs assinadas (7 dias)
- **Dev/Fallback:** `./uploads/` local

**Subpastas:**
- `driver-history/` — GeoJSON rotas
- `employees/` — Fotos, documentos
- `invoices/` — PDFs gerados
- `training/` — Materiais de formação
- `complaints/` — Fotos reclamações

**Upload:** `POST /api/upload` (multer, 16 MB limit)

---

## Dependências Principais

| Pacote | Versão | Uso |
|--------|--------|-----|
| react | 19.2.1 | UI framework |
| vite | 7.1.7 | Build tool |
| tailwindcss | 4.1.14 | CSS |
| @trpc/server | 11.6.0 | API type-safe |
| drizzle-orm | 0.44.5 | ORM |
| mysql2 | 3.15.0 | Driver MySQL |
| express | 4.21.2 | HTTP server |
| zod | 4.1.12 | Validação |
| recharts | 2.15.2 | Gráficos |
| lucide-react | 0.453.0 | Ícones |
| xlsx | 0.18.5 | Excel parsing |
| pdfkit | 0.17.2 | Geração PDF |
| @aws-sdk/client-s3 | 3.693.0 | Storage |
| nodemailer | 6.9.16 | Email |
| axios | 1.12.0 | HTTP client |
| wouter | 3.3.5 | Client routing |
| framer-motion | 12.23.22 | Animações |
| jose | 6.1.0 | JWT |

---

## Testes

14 ficheiros de teste com Vitest:
- `auth.logout.test.ts`, `documents.test.ts`, `expenses.test.ts`
- `gmail-sync.test.ts`, `google-ads-import.test.ts`, `invites.test.ts`
- `multipark.test.ts`, `operational.test.ts`, `payroll.test.ts`
- `payslip.test.ts`, `project-costs.test.ts`, `self-edit.test.ts`
- `users.test.ts`, `zello.test.ts`

```bash
npm run test
```

---

## Comandos

```bash
npm run dev          # Dev server (Vite + Express)
npm run build        # Build produção
npm run start        # Servidor produção
npm run test         # Testes
npm run db:push      # Gerar + aplicar migrações
```

---

## Features Notáveis

1. **OCR de Faturas** — IA extrai dados de imagens de faturas
2. **Tracking GPS em Tempo Real** — Alertas velocidade via Zello
3. **Sync MultiPark** — Reservas auto-sincronizadas cada 15 min
4. **Métricas Diárias de Condutores** — km, horas, bateria, rotas GeoJSON
5. **Gestão de Reclamações** — Workflow kanban multi-fase com SLA
6. **Exames de Carreira** — Certificações por tier (extra→condutor→senior→team_leader→supervisor)
7. **Avaliação de Performance** — Scoring semanal de condutores
8. **Geração de Recibos/Payslip** — PDF com breakdown salarial
9. **Faturação de Parceiros** — Comissões e faturação automática
10. **Respostas IA a Google Reviews** — Auto-resposta com contexto
11. **Gestão de PDAs** — Tracking e check-in/out de dispositivos
12. **Cross-Reference Perdidos/Achados** — Cruzamento com histórico de condutores
13. **Import Excel Histórico Reservas** — Análise de quem mexeu no carro
14. **Portal de Formação** — Vídeos, manuais, FAQs, quizzes, exames
15. **Dashboard Custos por Projeto** — Matriz orçamental
