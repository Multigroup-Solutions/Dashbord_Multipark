import { mysqlTable, mysqlSchema, AnyMySqlColumn, bigint, int, varchar, text, timestamp, datetime, index, uniqueIndex, decimal, mysqlEnum, tinyint, boolean, date, json, mediumtext, primaryKey, char } from "drizzle-orm/mysql-core"
import { sql } from "drizzle-orm"

export const activityLogs = mysqlTable("activity_logs", {
	id: bigint({ mode: "number" }).autoincrement().primaryKey(),
	userId: int().notNull(),
	action: varchar({ length: 64 }).notNull(),
	entity: varchar({ length: 64 }).notNull(),
	entityId: int(),
	details: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	// Migração 0095: página de Logs (datas/entidade) + retenção por data.
	index("idx_activity_logs_createdAt").on(table.createdAt),
	index("idx_activity_logs_entity_createdAt").on(table.entity, table.createdAt),
]);

export const annualReports = mysqlTable("annual_reports", {
	id: int().autoincrement().primaryKey(),
	projectId: int(),
	month: int().notNull(),
	year: int().notNull(),
	totalRevenue: int().default(0),
	totalExpenses: int().default(0),
	partnerShare: int().default(0),
	companyShare: int().default(0),
	splitRatio: varchar({ length: 10 }).default('60/40'),
	notes: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const apiKeys = mysqlTable("api_keys", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 100 }).notNull(),
	// LEGADO (migração 0095): a chave em claro já não é guardada — fica NULL.
	// A autenticação usa `keyHash` (SHA-256 hex); `keyPrefix` é só para a UI.
	apiKey: varchar({ length: 64 }),
	keyHash: varchar({ length: 64 }),
	keyPrefix: varchar({ length: 16 }),
	expiresAt: timestamp({ mode: 'string' }),
	permissions: text(),
	active: tinyint().default(1).notNull(),
	lastUsedAt: timestamp({ mode: 'string' }),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("api_keys_apiKey_unique").on(table.apiKey),
	uniqueIndex("api_keys_keyHash_unique").on(table.keyHash),
]);

export const campaignDailyStats = mysqlTable("campaign_daily_stats", {
	id: int().autoincrement().primaryKey(),
	campaignId: int().notNull(),
	date: timestamp({ mode: 'string' }).notNull(),
	spend: decimal({ precision: 10, scale: 2 }).default('0').notNull(),
	impressions: int().default(0),
	clicks: int().default(0),
	// 0063: decimal — a Google atribui conversões fracionadas
	conversions: decimal({ precision: 14, scale: 4 }).default('0'),
	conversionValue: decimal({ precision: 10, scale: 2 }).default('0'),
	cpc: decimal({ precision: 8, scale: 4 }),
	ctr: decimal({ precision: 6, scale: 4 }),
	costPerConversion: decimal({ precision: 10, scale: 2 }),
	importedById: int().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

// ─── Integração Google Ads (0063) — fonte ÚNICA das métricas de anúncios ─────
// Ligação OAuth (uma por fornecedor); o refresh token fica CIFRADO.
export const integrationConnections = mysqlTable("integration_connections", {
	id: int().autoincrement().primaryKey(),
	provider: varchar({ length: 32 }).notNull(),
	status: mysqlEnum(['disconnected','connected','reauth_required','error']).default('disconnected').notNull(),
	refreshTokenEnc: text(),
	scope: varchar({ length: 256 }),
	accountEmail: varchar({ length: 320 }),
	loginCustomerId: varchar({ length: 32 }),        // conta gestora (MCC) usada no acesso
	connectedById: int(),
	connectedAt: timestamp({ mode: 'string' }),
	lastCheckedAt: timestamp({ mode: 'string' }),
	lastError: text(),
	syncLockAt: timestamp({ mode: 'string' }),          // mutex da recolha (linha, não GET_LOCK: sobrevive a pool/serverless)
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("uq_integration_connections_provider").on(table.provider),
]);

// Último estado ALERTADO por ligação/cron (migração 0105) — alertas de
// reautorização/erro/cron parado uma vez por transição.
export const integrationAlertState = mysqlTable("integration_alert_state", {
	alertKey: varchar({ length: 96 }).primaryKey(),
	state: varchar({ length: 32 }).notNull(),
	detail: varchar({ length: 500 }),
	changedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	alertedAt: timestamp({ mode: 'string' }),
});

// Estado anti-CSRF do fluxo OAuth (consumido uma vez).
export const oauthStates = mysqlTable("oauth_states", {
	state: varchar({ length: 96 }).primaryKey(),
	provider: varchar({ length: 32 }).notNull(),
	userId: int().notNull(),
	redirectTo: varchar({ length: 512 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp({ mode: 'string' }).notNull(),
});

// Contas publicitárias (customerId oficial, sem hífens). `projectId` = marca/cidade.
export const adAccounts = mysqlTable("ad_accounts", {
	id: int().autoincrement().primaryKey(),
	provider: varchar({ length: 32 }).notNull(),
	customerId: varchar({ length: 32 }).notNull(),
	loginCustomerId: varchar({ length: 32 }),
	name: varchar({ length: 256 }),
	currency: varchar({ length: 8 }),
	timezone: varchar({ length: 64 }),
	isManager: tinyint().default(0).notNull(),
	status: varchar({ length: 32 }),
	selected: tinyint().default(0).notNull(),        // a dashboard consulta esta conta
	projectId: int(),
	lastSyncAt: timestamp({ mode: 'string' }),
	lastError: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("uq_ad_accounts_provider_customer").on(table.provider, table.customerId),
]);

// Campanhas por ID oficial (nomes iguais em contas diferentes são campanhas diferentes).
export const adCampaigns = mysqlTable("ad_campaigns", {
	id: int().autoincrement().primaryKey(),
	provider: varchar({ length: 32 }).notNull(),
	accountId: int().notNull(),
	externalId: varchar({ length: 64 }).notNull(),
	name: varchar({ length: 256 }),
	status: varchar({ length: 32 }),
	channelType: varchar({ length: 32 }),
	budgetMicros: bigint({ mode: 'number' }),        // orçamento (indicador separado; NUNCA gasto)
	projectId: int(),                                // marca/cidade da campanha (nó marca debaixo da cidade)
	// 0075 — 'national' = campanha da MARCA sem cidade (Brand, Pmax, Portugal):
	// conta no total da marca e em nenhuma cidade. 'city' + projectId NULL = por associar.
	scope: mysqlEnum(['city','national']).default('city').notNull(),
	legacyCampaignId: int(),                         // ligação à tabela `campaigns` antiga
	firstSeenAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp({ mode: 'string' }),
},
(table) => [
	uniqueIndex("uq_ad_campaigns_ext").on(table.provider, table.accountId, table.externalId),
]);

// UM registo por fornecedor + conta + campanha + dia + origem. Repetir a
// recolha substitui o mesmo registo. Dinheiro em micros (exato).
export const adDailyMetrics = mysqlTable("ad_daily_metrics", {
	id: int().autoincrement().primaryKey(),
	provider: varchar({ length: 32 }).notNull(),
	accountId: int().notNull(),
	campaignExternalId: varchar({ length: 64 }).notNull(),
	date: date({ mode: 'string' }).notNull(),
	costMicros: bigint({ mode: 'number' }).default(0).notNull(),
	currency: varchar({ length: 8 }),
	impressions: bigint({ mode: 'number' }).default(0).notNull(),
	clicks: bigint({ mode: 'number' }).default(0).notNull(),
	conversions: decimal({ precision: 14, scale: 4 }).default('0').notNull(),
	conversionValueMicros: bigint({ mode: 'number' }).default(0).notNull(),
	allConversions: decimal({ precision: 14, scale: 4 }).default('0').notNull(),
	source: mysqlEnum(['api','csv','email','manual']).default('api').notNull(),
	isProvisional: tinyint().default(0).notNull(),
	syncRunId: int(),
	collectedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("uq_ad_daily_metrics").on(table.provider, table.accountId, table.campaignExternalId, table.date, table.source),
	index("idx_ad_daily_metrics_date").on(table.date),
]);

// Conversões por ação (à parte: juntar várias ações NÃO pode multiplicar o gasto).
export const adConversionActionMetrics = mysqlTable("ad_conversion_action_metrics", {
	id: int().autoincrement().primaryKey(),
	provider: varchar({ length: 32 }).notNull(),
	accountId: int().notNull(),
	campaignExternalId: varchar({ length: 64 }).notNull(),
	date: date({ mode: 'string' }).notNull(),
	actionResource: varchar({ length: 256 }).notNull(),
	actionName: varchar({ length: 256 }),
	category: varchar({ length: 64 }),
	conversions: decimal({ precision: 14, scale: 4 }).default('0').notNull(),
	valueMicros: bigint({ mode: 'number' }).default(0).notNull(),
	syncRunId: int(),
	collectedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("uq_ad_conv_action").on(table.provider, table.accountId, table.campaignExternalId, table.date, table.actionResource),
]);

// Execuções da recolha: retomáveis (cursor), sem credenciais no registo.
export const integrationSyncRuns = mysqlTable("integration_sync_runs", {
	id: int().autoincrement().primaryKey(),
	provider: varchar({ length: 32 }).notNull(),
	kind: mysqlEnum(['initial','hourly','nightly','monthly','manual','daily']).notNull(), // daily desde 0074; hourly/nightly = execuções antigas
	status: mysqlEnum(['running','partial','done','failed','skipped']).default('running').notNull(),
	rangeFrom: date({ mode: 'string' }),
	rangeTo: date({ mode: 'string' }),
	accountsTotal: int().default(0).notNull(),
	accountsDone: int().default(0).notNull(),
	rowsWritten: int().default(0).notNull(),
	cursor: varchar({ length: 256 }),                // JSON {accountIdx, chunkIdx}
	error: text(),
	warnings: text(),
	triggeredById: int(),
	startedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp({ mode: 'string' }),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	index("idx_integration_sync_runs_provider").on(table.provider, table.startedAt),
]);

// ─── Marketing (0093) ─────────────────────────────────────────────────────────
// Orçamento mensal por nó cidade/marca (provider 'all' = todos os fornecedores).
export const marketingBudgets = mysqlTable("marketing_budgets", {
	id: int().autoincrement().primaryKey(),
	month: char({ length: 7 }).notNull(),             // "YYYY-MM"
	projectId: int().notNull(),
	provider: varchar({ length: 32 }).default('all').notNull(),
	amount: decimal({ precision: 12, scale: 2 }).notNull(),
	notes: varchar({ length: 255 }),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("uq_marketing_budgets").on(table.month, table.projectId, table.provider),
]);

// Campanha de anúncios (ad_campaigns.id) ↔ utm_campaign / código de desconto.
export const adCampaignLinks = mysqlTable("ad_campaign_links", {
	id: int().autoincrement().primaryKey(),
	adCampaignId: int().notNull(),
	keyType: mysqlEnum(['utm_campaign','discount_code']).notNull(),
	keyValue: varchar({ length: 256 }).notNull(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("uq_ad_campaign_links").on(table.keyType, table.keyValue),
	index("idx_ad_campaign_links_campaign").on(table.adCampaignId),
]);

export const campaigns = mysqlTable("campaigns", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 256 }).notNull(),
	platform: mysqlEnum(['google_ads','meta_ads','instagram','other']).notNull(),
	projectId: int(),
	campaignStatus: mysqlEnum(['active','paused','completed']).default('active').notNull(),
	startDate: timestamp({ mode: 'string' }),
	endDate: timestamp({ mode: 'string' }),
	budget: decimal({ precision: 10, scale: 2 }),
	notes: text(),
	createdById: int().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

// ─── Campanhas internas (das reservas Multipark) ──────────────────────────────
// Campanha lógica: agrupa vários campaignId/nomes/links sob um nome.
export const internalCampaigns = mysqlTable("internal_campaigns", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 256 }).notNull(),
	projectId: int(), // "para onde vai" — projeto/centro de custos
	dailyBudget: decimal({ precision: 10, scale: 2 }), // orçamento diário (Google Ads); gasto estimado = dailyBudget × dias
	city: varchar({ length: 64 }),
	brand: varchar({ length: 32 }),
	campaignStatus: mysqlEnum(['active','paused','completed']).default('active').notNull(),
	notes: text(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

// Chaves que pertencem a uma campanha lógica (atribuição "uma vez").
// type: campaign_id (do originUrl) | campaign_name | url_pattern (LIKE no originUrl)
export const internalCampaignKeys = mysqlTable("internal_campaign_keys", {
	id: int().autoincrement().primaryKey(),
	campaignType: mysqlEnum(['internal','ad']).default('internal').notNull(), // internal_campaigns ou campaigns
	campaignId: int().notNull(), // FK -> internal_campaigns.id OU campaigns.id (conforme campaignType)
	keyType: mysqlEnum(['campaign_id','campaign_name','url_pattern']).notNull(),
	keyValue: varchar({ length: 512 }).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("internal_campaign_keys_type_value_unique").on(table.keyType, table.keyValue),
	index("idx_internal_campaign_keys_campaign").on(table.campaignId),
]);

// Gasto por dia de uma campanha lógica.
export const internalCampaignCosts = mysqlTable("internal_campaign_costs", {
	id: int().autoincrement().primaryKey(),
	campaignType: mysqlEnum(['internal','ad']).default('internal').notNull(),
	campaignId: int().notNull(), // FK -> internal_campaigns.id OU campaigns.id
	costDate: varchar({ length: 10 }).notNull(), // YYYY-MM-DD
	amount: decimal({ precision: 10, scale: 2 }).notNull(),
	impressions: int(),
	clicks: int(),
	ctr: decimal({ precision: 7, scale: 3 }), // %
	conversions: decimal({ precision: 10, scale: 2 }),
	conversionValue: decimal({ precision: 10, scale: 2 }),
	notes: varchar({ length: 255 }),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("internal_campaign_costs_campaign_date_unique").on(table.campaignType, table.campaignId, table.costDate),
]);

export const careerExamAttempts = mysqlTable("career_exam_attempts", {
	id: int().autoincrement().primaryKey(),
	examId: int().notNull(),
	employeeId: int().notNull(),
	totalQuestions: int().notNull(),
	correctAnswers: int().notNull(),
	score: int().notNull(),
	passed: tinyint().notNull(),
	timeSpentSeconds: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const careerExamQuestions = mysqlTable("career_exam_questions", {
	id: int().autoincrement().primaryKey(),
	examId: int().notNull(),
	question: text().notNull(),
	optionA: text().notNull(),
	optionB: text().notNull(),
	optionC: text().notNull(),
	optionD: text().notNull(),
	correctOption: mysqlEnum(['A','B','C','D']).notNull(),
	explanation: text(),
	points: int().default(10).notNull(),
});

export const careerExams = mysqlTable("career_exams", {
	id: int().autoincrement().primaryKey(),
	level: varchar({ length: 32 }).notNull(), // condutor_1..4, terminal_1..4, front_1..4, team_leader, supervisor
	title: varchar({ length: 255 }).notNull(),
	description: text(),
	passingScore: int().notNull(),
	timeLimitMinutes: int().default(30),
	validityMonths: int().default(12).notNull(), // validade do certificado (0090)
	maxAttemptsPerDay: int().default(3).notNull(), // (0090)
	archivedAt: timestamp({ mode: 'string' }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const appNotifications = mysqlTable("app_notifications", {
	id: int().autoincrement().primaryKey(),
	userId: int().notNull(),
	title: varchar({ length: 255 }).notNull(),
	body: text(),
	kind: varchar({ length: 32 }).default('info'),
	link: varchar({ length: 512 }),
	isRead: tinyint().default(0).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_app_notifications_user_unread").on(table.userId, table.isRead, table.createdAt),
	index("idx_app_notifications_kind").on(table.kind),
]);

export const complaintDriversOnDuty = mysqlTable("complaint_drivers_on_duty", {
	id: int().autoincrement().primaryKey(),
	complaintId: int().notNull(),
	employeeId: int(),
	employeeName: varchar({ length: 256 }).notNull(),
	roleAtTime: varchar({ length: 64 }),
	source: varchar({ length: 32 }).notNull(),
	penaltyPointsApplied: int().default(0).notNull(),
	notes: varchar({ length: 512 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_cdod_complaint").on(table.complaintId),
	index("idx_cdod_employee").on(table.employeeId),
]);

export const complaintPenaltyConfig = mysqlTable("complaint_penalty_config", {
	id: int().autoincrement().primaryKey(),
	complaintType: varchar({ length: 32 }).notNull(),
	basePoints: int().default(0).notNull(),
	description: varchar({ length: 255 }),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("uq_complaint_type").on(table.complaintType),
]);

export const complaintMessages = mysqlTable("complaint_messages", {
	id: int().autoincrement().primaryKey(),
	complaintId: int().notNull(),
	message: text().notNull(),
	isInternal: tinyint().default(0).notNull(),
	authorId: int(),
	authorName: varchar({ length: 200 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const complaintPhotos = mysqlTable("complaint_photos", {
	id: int().autoincrement().primaryKey(),
	complaintId: int().notNull(),
	url: varchar({ length: 500 }).notNull(),
	fileKey: varchar({ length: 500 }).notNull(),
	label: varchar({ length: 100 }),
	uploadedById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const complaints = mysqlTable("complaints", {
	id: int().autoincrement().primaryKey(),
	title: varchar({ length: 255 }).notNull(),
	description: text(),
	complaintType: mysqlEnum("complaint_type", ['damage','dirt','delay','overcharge','staff','other']).notNull(),
	complaintStatus: mysqlEnum("complaint_status", ['new','analyzing','waiting_client','resolved','closed','converted']).default('new').notNull(),
	complaintPriority: mysqlEnum("complaint_priority", ['low','medium','high','urgent']).default('medium').notNull(),
	clientName: varchar({ length: 200 }),
	clientEmail: varchar({ length: 320 }),
	clientPhone: varchar({ length: 50 }),
	reservationRef: varchar({ length: 100 }),
	reservationStart: timestamp({ mode: 'string' }),
	reservationEnd: timestamp({ mode: 'string' }),
	vehicleId: int(),
	vehiclePlate: varchar({ length: 20 }),
	driversInvolved: text(),
	slaDeadline: timestamp({ mode: 'string' }),
	resolvedAt: timestamp({ mode: 'string' }),
	projectId: int(),
	assignedToId: int(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	penaltyPoints: int().default(0).notNull(),
	clientEmailSentAt: timestamp({ mode: 'string' }),
	clientEmailSubject: varchar({ length: 255 }),
	clientEmailBody: text(),
	dueDate: timestamp({ mode: 'string' }),
	investigatedById: int(),
	closedById: int(),
	closedAt: timestamp({ mode: 'string' }),
	clientNotes: text(),
	/** Aviso de receção automático enviado (sai no máximo 1×) — migration 0085. */
	autoAckSentAt: timestamp({ mode: 'string' }),
	/** Message-ID do último email enviado ao cliente (threading) — migration 0085. */
	lastOutboundMessageId: varchar({ length: 255 }),
	// 0092 — conversões não destrutivas (ligação nos dois sentidos)
	convertedToType: varchar({ length: 16 }),
	convertedToId: int(),
	convertedFromType: varchar({ length: 16 }),
	convertedFromId: int(),
});

export const dailyDriverHistory = mysqlTable("daily_driver_history", {
	id: int().autoincrement().primaryKey(),
	zelloUsername: varchar({ length: 255 }).notNull(),
	displayName: varchar({ length: 255 }),
	employeeId: int(),
	date: timestamp({ mode: 'string' }).notNull(),
	totalKm: decimal({ precision: 10, scale: 2 }).default('0'),
	hoursWorked: decimal({ precision: 6, scale: 2 }).default('0'),
	hoursStopped: decimal({ precision: 6, scale: 2 }).default('0'),
	totalHoursOnline: decimal({ precision: 6, scale: 2 }).default('0'),
	avgSpeed: decimal({ precision: 6, scale: 2 }).default('0'),
	maxSpeed: decimal({ precision: 6, scale: 2 }).default('0'),
	speedViolations: int().default(0),
	avgBattery: int().default(0),
	minBattery: int().default(0),
	gpsPointsCount: int().default(0),
	geoJsonUrl: text(),
	rawDataUrl: text(),
	notes: text(),
	/** 2 = km/h corrigidos + funcionário resolvido (migração 0078). */
	metricsVersion: int().default(1).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const employeeDocuments = mysqlTable("employee_documents", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	docType: mysqlEnum(['id_card','residence_permit','driving_license','nib_proof','address_proof','contract','extra_contract','contract_annex','responsibility_term','work_accident_insurance','photo','other']).notNull(),
	label: varchar({ length: 256 }),
	fileUrl: text().notNull(),
	fileKey: varchar({ length: 512 }).notNull(),
	mimeType: varchar({ length: 128 }),
	uploadedById: int().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const employees = mysqlTable("employees", {
	id: int().autoincrement().primaryKey(),
	fullName: varchar({ length: 256 }).notNull(),
	// `email`/`phone` = contactos de TRABALHO (o email é a identidade: login
	// Google e agente Multipark). Os pessoais são só para contacto e só fazem
	// sentido nos internos (extras usam o pessoal como principal) — 0067.
	email: varchar({ length: 320 }),
	phone: varchar({ length: 32 }),
	personalEmail: varchar({ length: 320 }),
	personalPhone: varchar({ length: 32 }),
	nif: varchar({ length: 20 }),
	nib: varchar({ length: 30 }),
	address: text(),
	birthDate: timestamp({ mode: 'string' }),
	nationality: varchar({ length: 64 }),
	photoUrl: text(),
	photoKey: varchar({ length: 512 }),
	position: mysqlEnum(['director','supervisor','team_leader','backoffice','frontoffice','senior_driver','driver','extra']).default('driver').notNull(),
	extraLevel: int(),
	careerLevel: varchar({ length: 32 }), // nível de carreira aprovado (migration 0090)
	department: varchar({ length: 128 }),
	projectId: int(),
	contractType: mysqlEnum(['permanent','fixed_term','extra']).default('permanent'),
	contractStart: timestamp({ mode: 'string' }),
	contractEnd: timestamp({ mode: 'string' }),
	monthlySalary: decimal({ precision: 10, scale: 2 }),
	isActive: tinyint().default(1).notNull(),
	userId: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	mealAllowancePerDay: decimal({ precision: 6, scale: 2 }),
	multiparkAgentName: varchar({ length: 256 }),
	multiparkAgentUserId: varchar({ length: 128 }),
	// Utilizador Zello ANEXADO ao colaborador (persistente, como o agente
	// Multipark) — o GPS mostra sempre o colaborador, nunca o nome Zello.
	zelloUsername: varchar({ length: 128 }),
	docsWarningAt: timestamp({ mode: 'string' }),
	loginBlocked: tinyint().default(0).notNull(),
	loginBlockedReason: varchar({ length: 255 }),
	// 0064 — motivos de bloqueio SEPARADOS (loginBlocked = OR dos três; um
	// processo nunca apaga o estado criado por outro)
	blockedByDocs: tinyint().default(0).notNull(),
	blockedByPenalties: tinyint().default(0).notNull(),
	blockedManually: tinyint().default(0).notNull(),
	// 0071 — motivo da desativação da FICHA (mesmo vocabulário do utilizador;
	// ver users.deactivationReason). Vive aqui também porque há fichas sem
	// conta associada e a ficha tem de mostrar o motivo.
	deactivationReason: varchar({ length: 48 }),
	deactivationReasonOther: varchar({ length: 200 }),
	deactivationNotes: text(),
	deactivatedAt: timestamp({ mode: 'string' }),
	deactivatedById: int(),
});

// Candidaturas de condutores vindas do website multidriver ("Be a Driver").
// Email normalizado (lowercase/trim) e UNIQUE — re-submissões actualizam em vez
// de duplicar. `payload` guarda a candidatura completa em bruto.
export const driverApplications = mysqlTable("driver_applications", {
	id: int().autoincrement().primaryKey(),
	email: varchar({ length: 320 }).notNull(),
	fullName: varchar({ length: 256 }).notNull(),
	phone: varchar({ length: 32 }),
	city: varchar({ length: 128 }),
	country: varchar({ length: 64 }),
	nif: varchar({ length: 20 }),
	drivingExperience: varchar({ length: 64 }),
	expectedHourlyRate: varchar({ length: 32 }),
	howDidYouKnow: varchar({ length: 64 }),
	status: mysqlEnum(['new','reviewed','approved','rejected']).default('new').notNull(),
	employeeId: int(),
	payload: json(),
	submissionCount: int().default(1).notNull(),
	lastSubmittedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	reviewedById: int(),
	reviewedAt: timestamp({ mode: 'string' }),
	notes: varchar({ length: 512 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("driver_applications_email_unique").on(table.email),
	index("idx_driver_applications_status").on(table.status),
]);

export const employeeLeaves = mysqlTable("employee_leaves", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	leaveType: mysqlEnum(['vacation','sick','unpaid','other']).default('vacation').notNull(),
	fromDate: varchar({ length: 10 }).notNull(),
	toDate: varchar({ length: 10 }).notNull(),
	notes: varchar({ length: 255 }),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_employee_leaves_emp").on(table.employeeId),
	index("idx_employee_leaves_dates").on(table.fromDate, table.toDate),
]);

export const employeeSalaryHistory = mysqlTable("employee_salary_history", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	monthlySalary: decimal({ precision: 10, scale: 2 }),
	mealAllowancePerDay: decimal({ precision: 6, scale: 2 }),
	effectiveFrom: varchar({ length: 10 }).notNull(),
	effectiveUntil: varchar({ length: 10 }),
	changedById: int(),
	notes: varchar({ length: 255 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_salary_history_emp").on(table.employeeId),
	index("idx_salary_history_from").on(table.effectiveFrom),
]);

export const employeePenalties = mysqlTable("employee_penalties", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	reason: mysqlEnum(['no_show_extra_dia','speeding','lost_found_investigation','complaint_investigation','other']).notNull(),
	severity: mysqlEnum(['warning','penalty','serious']).default('penalty').notNull(),
	points: int().default(1).notNull(),
	relatedId: int(),
	notes: varchar({ length: 512 }),
	clearedAt: timestamp({ mode: 'string' }),
	clearedById: int(),
	// 0064 — faltas automáticas nascem "pending" (possível falta) e só contam
	// pontos depois de confirmadas por alguém da operação
	status: mysqlEnum(['pending','confirmed','dismissed']).default('confirmed').notNull(),
	reviewedById: int(),
	reviewedAt: timestamp({ mode: 'string' }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_employee_penalties_emp").on(table.employeeId),
	index("idx_employee_penalties_open").on(table.employeeId, table.clearedAt),
	uniqueIndex("uq_employee_penalties_related").on(table.employeeId, table.reason, table.relatedId),
]);

export const expenseCategories = mysqlTable("expense_categories", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 128 }).notNull(),
	department: varchar({ length: 128 }),
	color: varchar({ length: 16 }).default('#6366f1'),
	// IVA da categoria em % (migração 0083); NULL = taxa normal (23%)
	vatRate: decimal({ precision: 5, scale: 2 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const expenses = mysqlTable("expenses", {
	id: int().autoincrement().primaryKey(),
	supplier: varchar({ length: 256 }),
	description: text(),
	amount: decimal({ precision: 10, scale: 2 }).notNull(),
	currency: varchar({ length: 8 }).default('EUR').notNull(),
	paymentMethod: mysqlEnum(['cash','card','transfer','check','other']).default('card'),
	expenseDate: timestamp({ mode: 'string' }).notNull(),
	paymentDueDate: timestamp({ mode: 'string' }),
	paidAt: timestamp({ mode: 'string' }),
	status: mysqlEnum(['pending','paid','overdue','cancelled']).default('pending').notNull(),
	categoryId: int(),
	projectId: int(),
	buyerId: int(),
	insertedById: int().notNull(),
	invoiceImageUrl: text(),
	invoiceImageKey: varchar({ length: 512 }),
	extractedByAi: tinyint().default(0),
	notes: text(),
	recurringTemplateId: int(), // se gerada por um modelo recorrente
	// 0062 — fornecedor estruturado + circuito financeiro (fase 2 em diante).
	supplierNif: varchar({ length: 32 }),
	documentNumber: varchar({ length: 64 }),
	paidBy: mysqlEnum(['company','employee']),           // quem suportou a compra
	approvalStatus: mysqlEnum(['legacy','draft','submitted','approved','returned']).default('legacy').notNull(),
	submittedAt: timestamp({ mode: 'string' }),
	approvedAt: timestamp({ mode: 'string' }),
	approvedById: int(),
	returnReason: text(),
	recurringPeriod: varchar({ length: 7 }),             // "YYYY-MM" (único por modelo)
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	index("idx_expenses_date").on(table.expenseDate),
	index("idx_expenses_project").on(table.projectId),
	index("idx_expenses_status").on(table.status),
	uniqueIndex("uq_expenses_recurring_period").on(table.recurringTemplateId, table.recurringPeriod),
]);

// ─── Circuito financeiro (0062) — estrutura preparada; a UI chega por fases. ───

// Contas por onde se paga: banco / cartão / caixa. `externalRef` liga à conta
// equivalente na app de caixa (a reconciliação vive lá; aqui só se importa).
export const financeAccounts = mysqlTable("finance_accounts", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 128 }).notNull(),
	type: mysqlEnum(['bank','card','cash']).notNull(),
	iban: varchar({ length: 34 }),
	externalRef: varchar({ length: 64 }),
	active: tinyint().default(1).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

// Liquidações: uma despesa pode receber vários pagamentos (parciais) e um
// pagamento pode vir de importação. `source`+`externalRef` únicos = reimportar
// nunca duplica. Estornos: `reversalOfId` aponta para o original (que fica).
export const expensePayments = mysqlTable("expense_payments", {
	id: int().autoincrement().primaryKey(),
	expenseId: int().notNull(),
	accountId: int(),
	amount: decimal({ precision: 10, scale: 2 }).notNull(),
	paidOn: date({ mode: 'string' }).notNull(),
	method: mysqlEnum(['cash','card','transfer','check','other']),
	reference: varchar({ length: 128 }),
	proofUrl: text(),
	proofKey: varchar({ length: 512 }),
	note: text(),
	source: mysqlEnum(['manual','legacy','caixa_import','bank_import']).default('manual').notNull(),
	importBatchId: int(),
	externalRef: varchar({ length: 128 }),
	reversalOfId: int(),
	reversedAt: timestamp({ mode: 'string' }),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_expense_payments_expense").on(table.expenseId),
	index("idx_expense_payments_batch").on(table.importBatchId),
	uniqueIndex("uq_expense_payments_external").on(table.source, table.externalRef),
]);

// Orçamento mensal por centro de custos e/ou categoria (alertas 80%/100%).
export const expenseBudgets = mysqlTable("expense_budgets", {
	id: int().autoincrement().primaryKey(),
	projectId: int(),
	categoryId: int(),
	period: varchar({ length: 7 }).notNull(),           // "YYYY-MM"
	amount: decimal({ precision: 12, scale: 2 }).notNull(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("uq_expense_budgets_scope").on(table.projectId, table.categoryId, table.period),
]);

// Histórico de cada despesa: quem mudou o quê (valores anteriores em JSON).
export const expenseEvents = mysqlTable("expense_events", {
	id: int().autoincrement().primaryKey(),
	expenseId: int().notNull(),
	type: varchar({ length: 32 }).notNull(),             // created|updated|status|paid|document|deleted|approved|...
	userId: int(),
	before: text(),
	after: text(),
	note: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_expense_events_expense").on(table.expenseId),
]);

// Lotes de importação (caixa da app externa / extratos): idempotentes por hash.
export const financeImportBatches = mysqlTable("finance_import_batches", {
	id: int().autoincrement().primaryKey(),
	source: mysqlEnum(['caixa','bank_csv']).notNull(),
	accountId: int(),
	fileName: varchar({ length: 256 }),
	fileHash: varchar({ length: 64 }),
	periodFrom: date({ mode: 'string' }),
	periodTo: date({ mode: 'string' }),
	rowsTotal: int().default(0).notNull(),
	rowsImported: int().default(0).notNull(),
	rowsMatched: int().default(0).notNull(),
	status: mysqlEnum(['pending','done','failed']).default('pending').notNull(),
	error: text(),
	importedById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("uq_finance_import_hash").on(table.source, table.fileHash),
]);

// Despesas recorrentes (fixas do mês): geram automaticamente uma expense/mês.
export const recurringExpenses = mysqlTable("recurring_expenses", {
	id: int().autoincrement().primaryKey(),
	description: text(),
	supplier: varchar({ length: 256 }),
	amount: decimal({ precision: 10, scale: 2 }).notNull(),
	currency: varchar({ length: 8 }).default('EUR').notNull(),
	paymentMethod: mysqlEnum(['cash','card','transfer','check','other']).default('transfer'),
	categoryId: int(),
	projectId: int(),
	dayOfMonth: int().default(1).notNull(),
	active: tinyint().default(1).notNull(),
	notes: text(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const extraRates = mysqlTable("extra_rates", {
	id: int().autoincrement().primaryKey(),
	level: int().notNull(),
	levelName: varchar({ length: 32 }),
	hourlyRate: decimal({ precision: 6, scale: 2 }).notNull(),
	label: varchar({ length: 64 }),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	index("extra_rates_level_unique").on(table.level),
	index("idx_extra_rates_levelname").on(table.levelName),
]);

export const extrasDiaAssignments = mysqlTable("extras_dia_assignments", {
	id: int().autoincrement().primaryKey(),
	assignmentDate: varchar({ length: 10 }).notNull(),
	employeeId: int(),
	personName: varchar({ length: 128 }).notNull(),
	level: mysqlEnum(['junior','senior','terminal','master']),
	isTeamLeader: tinyint().default(0).notNull(),
	shift: mysqlEnum(['morning','night']).default('morning').notNull(),
	city: varchar({ length: 16 }).default('lisbon').notNull(), // lisbon|porto|faro
	startHour: int().notNull(),
	endHour: int().notNull(),
	sentHomeHour: int(),
	notes: varchar({ length: 255 }),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	index("idx_extras_dia_date").on(table.assignmentDate),
]);

// Passagem de turno (team leaders) — 1 registo por (dia, turno, cidade).
// Criada pela migration 0087 (antes nascia em db.ts). `createdBy*` = autor
// original; `filledBy*` = último a editar; `version` = lock otimista.
export const shiftHandovers = mysqlTable("shift_handovers", {
	id: int().autoincrement().primaryKey(),
	handoverDate: varchar({ length: 10 }).notNull(),
	shift: varchar({ length: 10 }).notNull(),
	city: varchar({ length: 16 }).default('lisbon').notNull(),
	carsForCovered: int(),
	chargedUntilDate: varchar({ length: 10 }),
	cashClosedInSafe: tinyint(),
	checkoutCashDone: tinyint(),
	frontPouchValue: decimal({ precision: 10, scale: 2 }),
	terminalPouchValue: decimal({ precision: 10, scale: 2 }),
	ticketsExpensesPaid: decimal({ precision: 10, scale: 2 }),
	mbRolls: int(),
	mbRollsInPouch: int(),
	pensInPouch: int(),
	mbBattery: int(),
	pdasCharged: tinyint(),
	// 0088 — "Material OK?" + exceções (JSON, shared/shiftHandoverAuto.ts)
	materialOk: tinyint(),
	materialExceptions: text(),
	uniformsCount: int(),
	clothingItems: text(),
	notes: text(),
	// 0088 — pendentes que passam de turno (JSON), resumo automático (JSON) e IA
	openItems: text(),
	autoSummary: mediumtext(),
	aiSummary: text(),
	filledById: int(),
	filledByName: varchar({ length: 255 }),
	createdById: int(),
	createdByName: varchar({ length: 255 }),
	version: int().default(1).notNull(),
	// 0088 — "Recebi" do team leader que entra + email enviado por versão
	ackById: int(),
	ackByName: varchar({ length: 255 }),
	ackAt: timestamp({ mode: 'string' }),
	emailSentVersion: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("shift_handover_unique").on(table.handoverDate, table.shift, table.city),
]);

// 0088 — lembrete de passagem de turno em falta, 1× por (dia, turno, cidade).
export const shiftHandoverReminders = mysqlTable("shift_handover_reminders", {
	handoverDate: varchar({ length: 10 }).notNull(),
	shift: varchar({ length: 10 }).notNull(),
	city: varchar({ length: 16 }).notNull(),
	reminderSentAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	recipients: int().default(0).notNull(),
},
(table) => [
	primaryKey({ columns: [table.handoverDate, table.shift, table.city] }),
]);

export const extrasAvailability = mysqlTable("extras_availability", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	weekStart: varchar({ length: 10 }).notNull(),
	day: varchar({ length: 10 }).notNull(),
	morning: tinyint().default(0).notNull(),
	night: tinyint().default(0).notNull(),
	fromHour: int(),
	toHour: int(),
	note: varchar({ length: 300 }),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("extras_availability_emp_day_unique").on(table.employeeId, table.day),
	index("extras_availability_week_idx").on(table.weekStart),
	index("extras_availability_emp_idx").on(table.employeeId),
]);

export const faqs = mysqlTable("faqs", {
	id: int().autoincrement().primaryKey(),
	categoryId: int(),
	question: text().notNull(),
	answer: text().notNull(),
	sortOrder: int().default(0),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const googleReviews = mysqlTable("google_reviews", {
	googleReviewKey: varchar({ length: 64 }).unique('uq_google_review_key'),
	googleLocationId: int(),
	googleUpdatedAt: varchar({ length: 40 }),
	googleReply: text(),
	// Nome do recurso na API (accounts/…/locations/…/reviews/…) — é o que
	// permite PUBLICAR a resposta no Google a partir do dashboard (0073).
	googleReviewName: varchar({ length: 255 }),
	id: int().autoincrement().primaryKey(),
	reviewerName: varchar({ length: 200 }).notNull(),
	reviewerEmail: varchar({ length: 320 }),
	rating: int().notNull(),
	reviewText: text(),
	reviewDate: timestamp({ mode: 'string' }),
	projectId: int(),
	vehiclePlate: varchar({ length: 20 }),
	aiResponse: text(),
	aiResponseApproved: tinyint().default(0),
	respondedAt: timestamp({ mode: 'string' }),
	respondedBy: int(),
	complaintId: int(),
	status: mysqlEnum(['pending_response','ai_responded','manually_responded','converted_complaint','dismissed']).default('pending_response').notNull(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	sourceEmailId: varchar({ length: 100 }),
	sourceEmailDate: timestamp({ mode: 'string' }),
	importedAt: timestamp({ mode: 'string' }),
});

export const gpsAlerts = mysqlTable("gps_alerts", {
	id: int().autoincrement().primaryKey(),
	zelloUsername: varchar({ length: 255 }).notNull(),
	displayName: varchar({ length: 255 }),
	employeeId: int(),
	alertType: mysqlEnum(['gps_off','zello_off','battery_low','no_signal']).notNull(),
	message: text(),
	latitude: decimal({ precision: 10, scale: 7 }),
	longitude: decimal({ precision: 10, scale: 7 }),
	batteryLevel: int(),
	notificationSent: tinyint().default(0),
	acknowledged: tinyint().default(0),
	acknowledgedById: int(),
	acknowledgedAt: timestamp({ mode: 'string' }),
	occurredAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const incidents = mysqlTable("incidents", {
	id: int().autoincrement().primaryKey(),
	projectId: int(),
	vehiclePlate: varchar({ length: 20 }),
	employeeId: int(),
	reportedBy: int(),
	incidentType: mysqlEnum(['vidro_aberto','mal_estacionado','dano','chave_errada','combustivel','limpeza','documentos','outro']).default('outro').notNull(),
	severity: mysqlEnum(['low','medium','high','critical']).default('medium').notNull(),
	description: text().notNull(),
	status: mysqlEnum(['open','investigating','resolved','dismissed','converted']).default('open').notNull(),
	resolution: text(),
	resolvedAt: timestamp({ mode: 'string' }),
	resolvedBy: int(),
	weekNumber: int(),
	yearNumber: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	sourceEmailId: varchar({ length: 100 }),
	sourceEmailDate: timestamp({ mode: 'string' }),
	importedAt: timestamp({ mode: 'string' }),
	gpsLatitude: varchar({ length: 20 }),
	gpsLongitude: varchar({ length: 20 }),
	reservationLink: text(),
	aiClassification: text(),
	aiSeverity: mysqlEnum(['low','medium','high','critical']),
	// 0092 — pontos justos: só conta contra o condutor com envolvimento confirmado
	driverConfirmed: tinyint().default(0).notNull(),
	driverConfirmedById: int(),
	driverConfirmedAt: timestamp({ mode: 'string' }),
	dueAt: timestamp({ mode: 'string' }),
	lastReminderAt: timestamp({ mode: 'string' }),
	costAmount: decimal({ precision: 10, scale: 2 }),
	convertedToType: varchar({ length: 16 }),
	convertedToId: int(),
	convertedFromType: varchar({ length: 16 }),
	convertedFromId: int(),
});

export const inviteTokens = mysqlTable("invite_tokens", {
	id: int().autoincrement().primaryKey(),
	token: varchar({ length: 128 }).notNull(),
	email: varchar({ length: 320 }).notNull(),
	userId: int().notNull(),
	invitedById: int().notNull(),
	inviteStatus: mysqlEnum("invite_status", ['pending','accepted','expired']).default('pending').notNull(),
	expiresAt: timestamp({ mode: 'string' }).notNull(),
	acceptedAt: timestamp({ mode: 'string' }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("invite_tokens_token_unique").on(table.token),
]);

export const invoices = mysqlTable("invoices", {
	id: int().autoincrement().primaryKey(),
	projectId: int(),
	invoiceNumber: varchar({ length: 100 }).notNull(),
	clientName: varchar({ length: 255 }),
	clientNif: varchar({ length: 20 }),
	issueDate: timestamp({ mode: 'string' }).notNull(),
	dueDate: timestamp({ mode: 'string' }),
	totalAmount: int().default(0).notNull(),
	taxAmount: int().default(0),
	status: mysqlEnum(['draft','issued','paid','overdue','cancelled']).default('draft').notNull(),
	paymentMethod: varchar({ length: 50 }),
	notes: text(),
	fileUrl: text(),
	fileKey: text(),
	createdBy: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const lostFoundItems = mysqlTable("lost_found_items", {
	id: int().autoincrement().primaryKey(),
	projectId: int(),
	vehiclePlate: varchar({ length: 20 }),
	clientName: varchar({ length: 255 }).notNull(),
	clientEmail: varchar({ length: 320 }),
	clientPhone: varchar({ length: 50 }),
	bookingRef: varchar({ length: 100 }),
	itemType: mysqlEnum(['money','electronics','clothing','documents','accessories','other']).default('other').notNull(),
	description: text().notNull(),
	estimatedValue: int(),
	status: mysqlEnum(['new','investigating','found','returned','closed','converted']).default('new').notNull(),
	priority: mysqlEnum(['low','medium','high']).default('medium').notNull(),
	assignedTo: int(),
	resolution: text(),
	foundLocation: varchar({ length: 255 }),
	foundByName: varchar({ length: 255 }),
	returnMethod: varchar({ length: 100 }),
	returnedAt: timestamp({ mode: 'string' }),
	returnPhotoUrl: text(),
	returnPhotoKey: varchar({ length: 512 }),
	clientEmailSentAt: timestamp({ mode: 'string' }),
	dueDate: timestamp({ mode: 'string' }),
	investigatedById: int(),
	closedById: int(),
	closedAt: timestamp({ mode: 'string' }),
	clientNotes: text(),
	// 0092 — conversões + reclamação relacionada + lembretes SLA
	convertedToType: varchar({ length: 16 }),
	convertedToId: int(),
	convertedFromType: varchar({ length: 16 }),
	convertedFromId: int(),
	relatedComplaintId: int(),
	lastReminderAt: timestamp({ mode: 'string' }),
	createdBy: int().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const lostFoundMessages = mysqlTable("lost_found_messages", {
	id: int().autoincrement().primaryKey(),
	itemId: int().notNull(),
	userId: int().notNull(),
	userName: varchar({ length: 255 }).notNull(),
	message: text().notNull(),
	isInternal: tinyint().default(1).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const lostFoundPhotos = mysqlTable("lost_found_photos", {
	id: int().autoincrement().primaryKey(),
	itemId: int().notNull(),
	url: text().notNull(),
	fileKey: text().notNull(),
	caption: varchar({ length: 255 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const lostFoundAttachedDrivers = mysqlTable("lost_found_attached_drivers", {
	id: int().autoincrement().primaryKey(),
	itemId: int().notNull(),
	employeeId: int(),
	driverName: varchar({ length: 256 }).notNull(),
	source: varchar({ length: 32 }).default('manual').notNull(),
	movementDate: varchar({ length: 10 }),
	movementsSummary: varchar({ length: 512 }),
	notes: varchar({ length: 512 }),
	attachedById: int(),
	// 0092 — responsabilização: custo de recuperação + pontos (penalização RH pendente até supervisor confirmar)
	costAmount: decimal({ precision: 10, scale: 2 }),
	points: int().default(0).notNull(),
	pointsConfirmed: tinyint().default(0).notNull(),
	penaltyId: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_lfad_item").on(table.itemId),
	index("idx_lfad_employee").on(table.employeeId),
]);

export const bookingHistory = mysqlTable("booking_history", {
	id: int().autoincrement().primaryKey(),
	historyId: varchar({ length: 128 }).notNull(),
	bookingId: varchar({ length: 128 }).notNull(),
	changeType: varchar({ length: 128 }).notNull(),
	userName: varchar({ length: 128 }),
	userLastName: varchar({ length: 128 }),
	userEmail: varchar({ length: 320 }),
	remarks: text(),
	actionDate: timestamp({ mode: 'string' }),
	parkName: varchar({ length: 128 }),
	licensePlate: varchar({ length: 32 }),
	bookingStatus: varchar({ length: 64 }),
	importedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("bh_booking_idx").on(table.bookingId),
	index("bh_plate_idx").on(table.licensePlate),
	index("bh_user_idx").on(table.userName),
	index("bh_type_idx").on(table.changeType),
]);

export const marketingExpenses = mysqlTable("marketing_expenses", {
	id: int().autoincrement().primaryKey(),
	description: varchar({ length: 512 }).notNull(),
	mktCategory: mysqlEnum(['google_ads','meta_ads','influencer','print','merchandise','event','other']).notNull(),
	amount: decimal({ precision: 10, scale: 2 }).notNull(),
	date: timestamp({ mode: 'string' }).notNull(),
	projectId: int(),
	supplier: varchar({ length: 256 }),
	invoiceUrl: text(),
	invoiceKey: varchar({ length: 512 }),
	notes: text(),
	createdById: int().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const multiparkBookings = mysqlTable("multipark_bookings", {
	id: int().autoincrement().primaryKey(),
	externalId: varchar({ length: 128 }).notNull(),
	bookingNumber: varchar({ length: 64 }),
	status: varchar({ length: 64 }),
	checkIn: timestamp({ mode: 'string' }),
	checkOut: timestamp({ mode: 'string' }),
	checkInTime: varchar({ length: 8 }),
	checkOutTime: varchar({ length: 8 }),
	parkingType: varchar({ length: 32 }),
	vehicleType: varchar({ length: 32 }),
	clientFirstName: varchar({ length: 128 }),
	clientLastName: varchar({ length: 128 }),
	clientEmail: varchar({ length: 320 }),
	clientPhone: varchar({ length: 64 }),
	clientNif: varchar({ length: 32 }),
	licensePlate: varchar({ length: 32 }),
	vehicleBrand: varchar({ length: 64 }),
	vehicleModel: varchar({ length: 64 }),
	vehicleColor: varchar({ length: 32 }),
	totalPrice: decimal({ precision: 10, scale: 2 }),
	currency: varchar({ length: 8 }).default('EUR'),
	parkId: varchar({ length: 128 }),
	parkName: varchar({ length: 128 }),
	city: varchar({ length: 64 }),
	projectId: int(),
	deliveryService: tinyint().default(0),
	deliveryAddress: varchar({ length: 256 }),
	pickupAddress: varchar({ length: 256 }),
	campaign: varchar({ length: 128 }),
	parkingPrice: decimal({ precision: 10, scale: 2 }),
	deliveryCharges: decimal({ precision: 10, scale: 2 }),
	extrasTotal: decimal({ precision: 10, scale: 2 }),
	discount: decimal({ precision: 10, scale: 2 }),
	remainingToPay: decimal({ precision: 10, scale: 2 }),
	arrivalFlight: varchar({ length: 32 }),
	departureFlight: varchar({ length: 32 }),
	deliveryType: varchar({ length: 64 }),
	returnFlight: varchar({ length: 32 }),
	departingFlight: varchar({ length: 32 }),
	remarks: varchar({ length: 512 }),
	enrichedAt: timestamp({ mode: 'string' }),
	detailRetryAt: timestamp({ mode: 'string' }),
	detailAttempts: int().default(0).notNull(),
	detailErrorCode: varchar({ length: 64 }),
	sourceUpdatedAt: timestamp({ mode: 'string' }),
	origin: varchar({ length: 64 }),
	originUrl: varchar({ length: 512 }),
	currentGarage: varchar({ length: 64 }),
	currentSpot: varchar({ length: 64 }),
	lastKnownMileage: int(),
	checkinAgentName: varchar({ length: 256 }),
	checkinAgentUserId: varchar({ length: 128 }),
	checkoutAgentName: varchar({ length: 256 }),
	checkoutAgentUserId: varchar({ length: 128 }),
	historyFetchedAt: timestamp({ mode: 'string' }),
	historyRetryAt: timestamp({ mode: 'string' }),
	historyAttempts: int().default(0).notNull(),
	historyErrorCode: varchar({ length: 64 }),
	spotType: mysqlEnum(['covered','uncovered','indoor','unknown']),
	parkBrand: varchar({ length: 16 }),
	paymentMethod: varchar({ length: 128 }),
	totalPaid: decimal({ precision: 10, scale: 2 }),
	pro: tinyint().default(0),
	partnerId: varchar({ length: 128 }),
	partnerName: varchar({ length: 256 }),
	campaignId: varchar({ length: 128 }),
	campaignName: varchar({ length: 256 }),
	cashValidatedByName: varchar({ length: 256 }),
	driverValidatedByName: varchar({ length: 256 }),
	cashierClosedByName: varchar({ length: 256 }),
	cancelledAt: timestamp({ mode: 'string' }),
	cancelReason: text(),
	notes: text(),
	rawJson: text(),
	bookingCreatedAt: timestamp({ mode: 'string' }),
	// 0063 — atribuição ao Google Ads a partir do originUrl (regra local; nunca inventada)
	gclid: varchar({ length: 128 }),
	gbraid: varchar({ length: 128 }),
	wbraid: varchar({ length: 128 }),
	utmSource: varchar({ length: 128 }),
	utmMedium: varchar({ length: 128 }),
	utmCampaign: varchar({ length: 256 }),
	utmContent: varchar({ length: 256 }),
	utmTerm: varchar({ length: 256 }),
	adCampaignExternalId: varchar({ length: 64 }),
	adAttribution: mysqlEnum(['google_paid','meta_paid','unknown']),
	fbclid: varchar({ length: 255 }),                // 0093 — clique Meta (Facebook/Instagram)
	adAttributedAt: timestamp({ mode: 'string' }),
	syncedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("multipark_bookings_externalId_unique").on(table.externalId),
]);

export const multiparkBookingExtras = mysqlTable("multipark_booking_extras", {
	id: int().autoincrement().primaryKey(),
	bookingExternalId: varchar({ length: 128 }).notNull(),
	extraId: varchar({ length: 128 }),
	name: varchar({ length: 256 }),
	description: varchar({ length: 512 }),
	price: decimal({ precision: 10, scale: 2 }),
	done: tinyint().default(0),
	syncedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_mp_booking_extras_booking").on(table.bookingExternalId),
]);

export const multiparkDailySnapshots = mysqlTable("multipark_daily_snapshots", {
	id: int().autoincrement().primaryKey(),
	snapshotDate: timestamp({ mode: 'string' }).notNull(),
	parkName: varchar({ length: 128 }).notNull(),
	city: varchar({ length: 64 }).notNull(),
	totalBookings: int().default(0).notNull(),
	reservedCount: int().default(0),
	checkinCount: int().default(0),
	checkoutCount: int().default(0),
	cancelledCount: int().default(0),
	totalRevenue: int().default(0).notNull(),
	parkingRevenue: int().default(0),
	deliveryRevenue: int().default(0),
	extrasRevenue: int().default(0),
	onlineCount: int().default(0),
	agentCount: int().default(0),
	externalCampaigns: text(),
	importSource: varchar({ length: 32 }).default('excel'),
	importedById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const multiparkSyncLogs = mysqlTable("multipark_sync_logs", {
	id: int().autoincrement().primaryKey(),
	syncType: varchar({ length: 64 }).notNull(),
	status: varchar({ length: 32 }).notNull(),
	recordsProcessed: int().default(0),
	recordsCreated: int().default(0),
	recordsUpdated: int().default(0),
	errorMessage: text(),
	triggeredById: int(),
	startedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp({ mode: 'string' }),
	// Migração 0101: janela pedida e meta (JSON). NULL nas linhas antigas.
	windowStart: datetime({ mode: 'string' }),
	windowEnd: datetime({ mode: 'string' }),
	meta: text(),
});

// Migração 0101 — última cobertura completa do sync recente, por parque.
export const multiparkSyncCoverage = mysqlTable("multipark_sync_coverage", {
	parkId: varchar({ length: 64 }).primaryKey(),
	recentCoveredAt: datetime({ mode: 'string' }),
	lastRunAt: datetime({ mode: 'string' }),
	lastStatus: varchar({ length: 16 }),
	lastErrorCode: varchar({ length: 64 }),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

// Migração 0101 — trinco (lease) da sincronização: cron, botões e MCP.
export const multiparkSyncLock = mysqlTable("multipark_sync_lock", {
	name: varchar({ length: 64 }).primaryKey(),
	holder: varchar({ length: 64 }),
	owner: varchar({ length: 64 }),
	acquiredAt: datetime({ mode: 'string' }),
	leaseUntil: datetime({ mode: 'string' }),
});

// Migração 0101 — reconciliação diária (report D-1/D-2 vs BD).
export const multiparkReconciliation = mysqlTable("multipark_reconciliation", {
	id: int().autoincrement().primaryKey(),
	day: varchar({ length: 10 }).notNull(),
	parkId: varchar({ length: 64 }).notNull(),
	actionType: varchar({ length: 16 }).notNull(),
	apiTotal: int(),
	apiCount: int().default(0).notNull(),
	dbFound: int().default(0).notNull(),
	missing: int().default(0).notNull(),
	status: varchar({ length: 16 }).notNull(),
	errorCode: varchar({ length: 64 }),
	checkedAt: datetime({ mode: 'string' }).notNull(),
}, (table) => [
	uniqueIndex("uq_mp_recon").on(table.day, table.parkId, table.actionType),
	index("idx_mp_recon_status").on(table.status, table.day),
]);

// Migração 0101 — estado dos alertas da sincronização (1 aviso por transição).
export const multiparkSyncAlerts = mysqlTable("multipark_sync_alerts", {
	alertKey: varchar({ length: 64 }).primaryKey(),
	active: tinyint().default(0).notNull(),
	since: datetime({ mode: 'string' }),
	detail: varchar({ length: 255 }),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const partnershipInvoices = mysqlTable("partnership_invoices", {
	id: int().autoincrement().primaryKey(),
	partnershipId: int().notNull(),
	invoiceNumber: varchar({ length: 50 }),
	amount: int().default(0).notNull(),
	referenceMonth: int().notNull(),
	referenceYear: int().notNull(),
	invoiceStatus: mysqlEnum(['draft','sent','paid','overdue','cancelled']).default('draft').notNull(),
	sentAt: timestamp({ mode: 'string' }),
	dueDate: timestamp({ mode: 'string' }),
	paidAt: timestamp({ mode: 'string' }),
	invoiceNotes: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const partnershipTransactions = mysqlTable("partnership_transactions", {
	id: int().autoincrement().primaryKey(),
	partnershipId: int().notNull(),
	projectId: int(),
	transactionType: mysqlEnum(['booking','commission','payment','adjustment']).default('booking').notNull(),
	description: varchar({ length: 500 }),
	amount: int().default(0).notNull(),
	transactionDate: timestamp({ mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const partnerships = mysqlTable("partnerships", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 255 }).notNull(),
	campaignKey: varchar({ length: 128 }),
	partnerType: varchar({ length: 64 }).default('other').notNull(),
	contactName: varchar({ length: 255 }),
	contactEmail: varchar({ length: 320 }),
	contactPhone: varchar({ length: 50 }),
	commissionRate: int().default(0),
	billingAgreement: text(),
	partnerStatus: mysqlEnum(['active','inactive','pending']).default('active').notNull(),
	notes: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	partnerNif: varchar("partner_nif", { length: 20 }),
	monthlyFee: int().default(0),
	multiparkPartnerId: varchar({ length: 128 }),
	// Migration 0082 — quando um admin gravou o parceiro no ecrã. NULL = "por
	// configurar" (ex.: criado pela sincronização automática com 0%).
	configuredAt: timestamp({ mode: 'string' }),
});

export const multiparkBookingHistory = mysqlTable("multipark_booking_history", {
	id: int().autoincrement().primaryKey(),
	bookingExternalId: varchar({ length: 128 }).notNull(),
	historyId: varchar({ length: 128 }).notNull(),
	changeType: varchar({ length: 32 }),
	actionTime: timestamp({ mode: 'string' }),
	remarks: text(),
	agentName: varchar({ length: 256 }),
	agentUserId: varchar({ length: 128 }),
	agentEmail: varchar({ length: 320 }),
	modifiedFields: text(),
	platform: varchar({ length: 32 }),
	fetchedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("uq_booking_history").on(table.bookingExternalId, table.historyId),
	index("idx_bh_booking").on(table.bookingExternalId),
	index("idx_bh_agent").on(table.agentUserId),
	index("idx_bh_actionTime").on(table.actionTime),
	index("idx_bh_changeType").on(table.changeType),
]);

export const partnerAliases = mysqlTable("partner_aliases", {
	id: int().autoincrement().primaryKey(),
	partnershipId: int().notNull(),
	aliasType: mysqlEnum(['multipark_partner_id','payment_method']).notNull(),
	aliasValue: varchar({ length: 128 }).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("uq_alias").on(table.aliasType, table.aliasValue),
	index("idx_partner_aliases_partnership").on(table.partnershipId),
]);

export const payslipHistory = mysqlTable("payslip_history", {
	id: int().autoincrement().primaryKey(),
	employeeId: int(),
	employeeName: varchar({ length: 255 }),
	year: int().notNull(),
	month: int().notNull(),
	payslipType: mysqlEnum("payslip_type", ['individual','payroll','timesheet']).notNull(),
	url: text().notNull(),
	fileName: varchar({ length: 512 }),
	generatedById: int().notNull(),
	generatedByName: varchar({ length: 255 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const pdaCheckins = mysqlTable("pda_checkins", {
	id: int().autoincrement().primaryKey(),
	pdaId: int().notNull(),
	employeeId: int(),
	zelloUsername: varchar({ length: 255 }),
	teamLeaderId: int(),
	photoEntryUrl: text(),
	photoExitUrl: text(),
	mobileDataMbStart: int(),
	mobileDataMbEnd: int(),
	checkinAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	checkoutAt: timestamp({ mode: 'string' }),
	checkinStatus: mysqlEnum("checkin_status", ['checked_in','checked_out']).default('checked_in').notNull(),
	notes: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const pdas = mysqlTable("pdas", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 255 }).notNull(),
	phoneNumber: varchar({ length: 50 }),
	imei: varchar({ length: 50 }),
	model: varchar({ length: 255 }),
	// Utilizador Zello instalado neste PDA — GPS/velocidades vêm daqui, mas a
	// atividade mostra sempre o FUNCIONÁRIO com check-in ativo no PDA.
	zelloUsername: varchar({ length: 128 }),
	// Token guardado no localStorage do browser do próprio PDA ("este aparelho
	// é o PDA X") — o check-in do ponto envia-o e liga a pessoa ao PDA/Zello
	// automaticamente, sem passos manuais.
	deviceToken: varchar({ length: 64 }),
	// Código secreto do QR colado no PDA (migração 0079) — ler o QR no próprio
	// aparelho regista-o como este PDA.
	qrCode: varchar({ length: 40 }),
	status: mysqlEnum(['active','inactive','maintenance','lost']).default('active').notNull(),
	photoUrl: text(),
	simDataPlan: varchar({ length: 255 }),
	notes: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const performanceEvaluations = mysqlTable("performance_evaluations", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	weekNumber: int().notNull(),
	yearNumber: int().notNull(),
	hoursWorked: decimal({ precision: 8, scale: 2 }).default('0'),
	movementsCount: int().default(0),
	movementsPerHour: decimal({ precision: 8, scale: 2 }).default('0'),
	weeklyCost: decimal({ precision: 10, scale: 2 }), // custo da escala extras-dia na semana
	speedAlerts: int().default(0),
	incidentsPositive: int().default(0),
	incidentsNegative: int().default(0),
	positivePoints: int().default(0),
	negativePoints: int().default(0),
	totalPoints: int().default(0),
	notes: text(),
	evaluatedBy: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

// ─── Motor único da avaliação (migration 0099) ───────────────────────────────
// Métricas CALCULADAS por (colaborador, dia operacional 03h→03h Lisboa). Só o
// motor escreve aqui (server/evaluationEngine.ts); os ajustes manuais vivem em
// employee_metric_adjustments e aplicam-se por cima, na leitura.
export const employeeDayMetrics = mysqlTable("employee_day_metrics", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	day: varchar({ length: 10 }).notNull(),
	projectId: int(),
	city: varchar({ length: 16 }),
	shift: varchar({ length: 8 }),
	isTeamLeader: tinyint().default(0).notNull(),
	level: varchar({ length: 16 }),
	hoursSource: varchar({ length: 8 }),
	hoursWorked: decimal({ precision: 8, scale: 2 }).default('0').notNull(),
	suspiciousHours: decimal({ precision: 8, scale: 2 }).default('0').notNull(),
	scheduledHours: decimal({ precision: 8, scale: 2 }).default('0').notNull(),
	pontoEvents: int().default(0).notNull(),
	cost: decimal({ precision: 10, scale: 2 }).default('0').notNull(),
	actions: int().default(0).notNull(),
	actionsMorning: int().default(0).notNull(),
	actionsNight: int().default(0).notNull(),
	recolhas: int().default(0).notNull(),
	entregas: int().default(0).notNull(),
	movements: int().default(0).notNull(),
	parkingMoves: int().default(0).notNull(),
	cancels: int().default(0).notNull(),
	otherActions: int().default(0).notNull(),
	weightedActions: decimal({ precision: 10, scale: 2 }).default('0').notNull(),
	actionsByType: text(),
	speedingEvents: int().default(0).notNull(),
	delays: int().default(0).notNull(),
	lateServices: int().default(0).notNull(),
	complaints: int().default(0).notNull(),
	accidents: int().default(0).notNull(),
	incidentsReported: int().default(0).notNull(),
	incidentsAgainst: int().default(0).notNull(),
	penaltyPoints: int().default(0).notNull(),
	positivePoints: decimal({ precision: 10, scale: 2 }).default('0').notNull(),
	negativePoints: decimal({ precision: 10, scale: 2 }).default('0').notNull(),
	totalPoints: decimal({ precision: 10, scale: 2 }).default('0').notNull(),
	computedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("uq_employee_day_metrics").on(table.employeeId, table.day),
	index("idx_edm_day").on(table.day),
	index("idx_edm_project_day").on(table.projectId, table.day),
	index("idx_edm_day_emp").on(table.day, table.employeeId),
]);

// Ajustes MANUAIS (delta sobre uma métrica de um dia) — nunca alteram o
// calculado; anulam-se (voidedAt) em vez de se apagarem.
export const employeeMetricAdjustments = mysqlTable("employee_metric_adjustments", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	day: varchar({ length: 10 }).notNull(),
	metric: varchar({ length: 32 }).notNull(),
	delta: decimal({ precision: 10, scale: 2 }).notNull(),
	reason: varchar({ length: 500 }).notNull(),
	authorId: int(),
	authorName: varchar({ length: 128 }),
	disputeId: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	voidedAt: timestamp({ mode: 'string' }),
	voidedById: int(),
	voidReason: varchar({ length: 255 }),
},
(table) => [
	index("idx_ema_emp_day").on(table.employeeId, table.day),
	index("idx_ema_day").on(table.day),
]);

// Contestações do colaborador a um dia/métrica; o gestor aceita (com ajuste
// opcional) ou recusa.
export const employeeMetricDisputes = mysqlTable("employee_metric_disputes", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	day: varchar({ length: 10 }).notNull(),
	metric: varchar({ length: 32 }),
	comment: text().notNull(),
	status: varchar({ length: 16 }).default('open').notNull(),
	createdByUserId: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	resolvedById: int(),
	resolvedByName: varchar({ length: 128 }),
	resolvedAt: timestamp({ mode: 'string' }),
	resolution: text(),
	adjustmentId: int(),
},
(table) => [
	index("idx_emd_emp_day").on(table.employeeId, table.day),
	index("idx_emd_status").on(table.status, table.createdAt),
]);

export const projectEmployees = mysqlTable("project_employees", {
	id: int().autoincrement().primaryKey(),
	projectId: int().notNull(),
	employeeId: int().notNull(),
	role: varchar({ length: 64 }).default('member'),
	assignedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const projects = mysqlTable("projects", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	parentId: int(),
	isActive: tinyint().default(1).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	level: mysqlEnum(['group','brand','city','project']).default('project').notNull(),
	color: varchar({ length: 16 }).default('#6366f1'),
	managerId: int(),
	budget: decimal({ precision: 12, scale: 2 }),
	partnerName: varchar({ length: 200 }),
	partnerPercent: decimal({ precision: 5, scale: 2 }),
});

export const quizAttempts = mysqlTable("quiz_attempts", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	totalQuestions: int().notNull(),
	correctAnswers: int().notNull(),
	score: int().notNull(),
	timeSpentSeconds: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const quizQuestions = mysqlTable("quiz_questions", {
	id: int().autoincrement().primaryKey(),
	categoryId: int(),
	question: text().notNull(),
	optionA: text().notNull(),
	optionB: text().notNull(),
	optionC: text().notNull(),
	optionD: text().notNull(),
	correctOption: mysqlEnum(['A','B','C','D']).notNull(),
	explanation: text(),
	difficulty: mysqlEnum(['easy','medium','hard']).default('medium').notNull(),
	points: int().default(10).notNull(),
	published: tinyint().default(1).notNull(), // 0 = rascunho (ex.: gerado por IA) — 0090
	sourceManualId: int(), // manual de origem (perguntas geradas por IA) — 0090
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const radioTranscriptions = mysqlTable("radio_transcriptions", {
	id: int().autoincrement().primaryKey(),
	audioUrl: text(),
	transcription: text(),
	summary: text(),
	employeeId: int(),
	vehicleId: int(),
	duration: int(),
	transcribedAt: timestamp({ mode: 'string' }),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const schedules = mysqlTable("schedules", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	weekday: int().notNull(),
	startTime: varchar({ length: 8 }).notNull(),
	endTime: varchar({ length: 8 }).notNull(),
	isWorkDay: tinyint().default(1).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const services = mysqlTable("services", {
	id: int().autoincrement().primaryKey(),
	projectId: int(),
	employeeId: int(),
	serviceType: mysqlEnum(['lavagem','carregamento_eletrico','valet_flex','outro']).default('lavagem').notNull(),
	clientName: varchar({ length: 255 }),
	vehiclePlate: varchar({ length: 20 }),
	bookingRef: varchar({ length: 100 }),
	revenue: int().default(0),
	cost: int().default(0),
	commission: int().default(0),
	notes: text(),
	serviceDate: timestamp({ mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const speedAlerts = mysqlTable("speed_alerts", {
	id: int().autoincrement().primaryKey(),
	vehicleId: int().notNull(),
	employeeId: int(),
	speed: int().notNull(),
	speedLimit: int().notNull(),
	latitude: decimal({ precision: 10, scale: 7 }),
	longitude: decimal({ precision: 10, scale: 7 }),
	roadName: varchar({ length: 255 }),
	acknowledged: tinyint().default(0),
	acknowledgedById: int(),
	acknowledgedAt: timestamp({ mode: 'string' }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const speedLimits = mysqlTable("speed_limits", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 255 }).notNull(),
	maxSpeed: int().notNull(),
	tolerancePercent: int().default(10).notNull(),
	isDefault: tinyint().default(0),
	isActive: tinyint().default(1),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const speedViolations = mysqlTable("speed_violations", {
	id: int().autoincrement().primaryKey(),
	zelloUsername: varchar({ length: 255 }).notNull(),
	displayName: varchar({ length: 255 }),
	speed: decimal({ precision: 8, scale: 2 }).notNull(),
	speedLimit: int().notNull(),
	excessPercent: decimal({ precision: 5, scale: 2 }).notNull(),
	latitude: decimal({ precision: 10, scale: 7 }),
	longitude: decimal({ precision: 10, scale: 7 }),
	heading: decimal({ precision: 6, scale: 2 }),
	notificationSent: tinyint().default(0),
	acknowledged: tinyint().default(0),
	acknowledgedById: int(),
	acknowledgedAt: timestamp({ mode: 'string' }),
	notes: text(),
	occurredAt: timestamp({ mode: 'string' }).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const taskAssignees = mysqlTable("task_assignees", {
	id: int().autoincrement().primaryKey(),
	taskId: int().notNull(),
	employeeId: int().notNull(),
	assignedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const tasks = mysqlTable("tasks", {
	id: int().autoincrement().primaryKey(),
	title: varchar({ length: 256 }).notNull(),
	description: text(),
	projectId: int(),
	assigneeId: int(),
	createdById: int().notNull(),
	taskStatus: mysqlEnum(['backlog','todo','in_progress','review','done']).default('todo').notNull(),
	taskPriority: mysqlEnum(['low','medium','high','urgent']).default('medium').notNull(),
	dueDate: timestamp({ mode: 'string' }),
	completedAt: timestamp({ mode: 'string' }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	notifiedOverdue: tinyint().default(0),
	notifiedComplete: tinyint().default(0),
	// 0091 — origem (link + fecho automático), prazo com hora, checklists
	sourceModule: varchar({ length: 32 }),
	sourceId: int(),
	sourceKey: varchar({ length: 128 }),
	dueHasTime: tinyint().default(0).notNull(),
	templateId: int(),
	templateDate: varchar({ length: 10 }),
	templateShift: varchar({ length: 8 }),
	completedById: int(),
});

// 0091 — checklists recorrentes por turno/cidade
export const taskTemplates = mysqlTable("task_templates", {
	id: int().autoincrement().primaryKey(),
	title: varchar({ length: 256 }).notNull(),
	description: text(),
	cityProjectId: int(),
	shift: varchar({ length: 8 }).default('any').notNull(),
	weekdaysMask: int().default(127).notNull(),
	dueHour: int(),
	priority: varchar({ length: 16 }).default('medium').notNull(),
	assigneeRole: varchar({ length: 32 }),
	assigneeEmployeeIds: text(),
	active: tinyint().default(1).notNull(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

// 0091 — comentários por tarefa
export const taskComments = mysqlTable("task_comments", {
	id: int().autoincrement().primaryKey(),
	taskId: int().notNull(),
	userId: int().notNull(),
	body: text().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const timeRecords = mysqlTable("time_records", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	type: mysqlEnum(['check_in','check_out']).notNull(),
	recordedAt: timestamp({ mode: 'string' }).notNull(),
	photoUrl: text(),
	photoKey: varchar({ length: 512 }),
	latitude: decimal({ precision: 10, scale: 7 }),
	longitude: decimal({ precision: 10, scale: 7 }),
	locationName: varchar({ length: 256 }),
	hoursWorked: decimal({ precision: 6, scale: 2 }),
	notes: text(),
	// Snapshot do Zello preenchido automaticamente no check-out (km/velocidades
	// do turno + tempo com o Zello desligado durante o turno)
	zelloKm: decimal({ precision: 10, scale: 2 }),
	zelloAvgSpeed: decimal({ precision: 6, scale: 2 }),
	zelloMaxSpeed: decimal({ precision: 6, scale: 2 }),
	zelloOfflineMinutes: int(),
	zelloOnlineMinutes: int(),
	// 0064 — revisão do ponto: suspeitos não pagam até serem aprovados
	reviewStatus: mysqlEnum(['ok','suspicious','approved','rejected']).default('ok').notNull(),
	reviewedById: int(),
	reviewedAt: timestamp({ mode: 'string' }),
	reviewNote: varchar({ length: 255 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

// ─── Fecho mensal de ordenados (0064): apuramento → aprovado → pago ───────────
// Cada fecho é uma VERSÃO imutável do cálculo (linhas em JSON). O cálculo ao
// vivo continua a existir como "apuramento provisório".
export const payrollRuns = mysqlTable("payroll_runs", {
	id: int().autoincrement().primaryKey(),
	year: int().notNull(),
	month: int().notNull(),
	version: int().default(1).notNull(),
	status: mysqlEnum(['draft','approved','paid','void']).default('draft').notNull(),
	employeesCount: int().default(0).notNull(),
	totalGross: decimal({ precision: 12, scale: 2 }).default('0').notNull(),
	totalNetEstimate: decimal({ precision: 12, scale: 2 }).default('0').notNull(),
	warningsCount: int().default(0).notNull(),
	notes: text(),
	createdById: int(),
	approvedById: int(),
	approvedAt: timestamp({ mode: 'string' }),
	paidById: int(),
	paidAt: timestamp({ mode: 'string' }),
	paymentRef: varchar({ length: 128 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("uq_payroll_runs_month_version").on(table.year, table.month, table.version),
]);

export const payrollRunLines = mysqlTable("payroll_run_lines", {
	id: int().autoincrement().primaryKey(),
	runId: int().notNull(),
	employeeId: int().notNull(),
	fullName: varchar({ length: 256 }),
	isExtra: tinyint().default(0).notNull(),
	totalHours: decimal({ precision: 8, scale: 2 }).default('0').notNull(),
	totalPayment: decimal({ precision: 12, scale: 2 }).default('0').notNull(),
	netEstimate: decimal({ precision: 12, scale: 2 }).default('0').notNull(),
	snapshot: text().notNull(),                       // JSON do cálculo completo
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_payroll_run_lines_run").on(table.runId),
	uniqueIndex("uq_payroll_run_lines_emp").on(table.runId, table.employeeId),
]);

export const trainingCategories = mysqlTable("training_categories", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 255 }).notNull(),
	description: text(),
	icon: varchar({ length: 50 }),
	sortOrder: int().default(0),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const trainingManuals = mysqlTable("training_manuals", {
	id: int().autoincrement().primaryKey(),
	categoryId: int(),
	title: varchar({ length: 255 }).notNull(),
	content: text().notNull(),
	type: varchar({ length: 32 }).default('manual').notNull(), // manual|update|news|procedure|link
	published: tinyint().default(1),
	createdBy: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	fileUrl: text(),
	fileKey: text(),
	fileName: varchar({ length: 255 }),
	fileMimeType: varchar({ length: 100 }),
	careerLevel: varchar({ length: 32 }), // módulo de um nível de carreira (opcional)
});

export const trainingVideos = mysqlTable("training_videos", {
	id: int().autoincrement().primaryKey(),
	categoryId: int().notNull(),
	title: varchar({ length: 255 }).notNull(),
	description: text(),
	videoUrl: text().notNull(),
	thumbnailUrl: text(),
	durationMinutes: int(),
	careerLevel: varchar({ length: 32 }), // módulo de um nível de carreira (opcional)
	sortOrder: int().default(0),
	createdBy: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

// ─── Formação: percursos obrigatórios (migration 0090) ───────────────────────
export const trainingPaths = mysqlTable("training_paths", {
	id: int().autoincrement().primaryKey(),
	name: varchar({ length: 255 }).notNull(),
	description: text(),
	targetRole: varchar({ length: 32 }), // extra | condutor | terminal | front | …
	city: varchar({ length: 16 }), // lisbon | porto | faro | null = todas
	active: tinyint().default(1).notNull(),
	isDefaultOnboarding: tinyint().default(0).notNull(),
	blocksEscala: tinyint().default(1).notNull(),
	dueDays: int().default(7).notNull(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const trainingPathItems = mysqlTable("training_path_items", {
	id: int().autoincrement().primaryKey(),
	pathId: int().notNull(),
	itemType: varchar({ length: 16 }).notNull(), // video | manual | exam | quiz
	itemId: int().notNull(), // quiz: categoria (0 = geral)
	sortOrder: int().default(0).notNull(),
	required: tinyint().default(1).notNull(),
},
(table) => [index("training_path_items_path_idx").on(table.pathId)]);

export const trainingAssignments = mysqlTable("training_assignments", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	pathId: int().notNull(),
	status: varchar({ length: 16 }).default('assigned').notNull(), // assigned | in_progress | completed | overdue
	dueAt: datetime({ mode: 'string' }),
	assignedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	completedAt: datetime({ mode: 'string' }),
	assignedById: int(),
	source: varchar({ length: 32 }),
	lastReminderAt: datetime({ mode: 'string' }),
	escalatedAt: datetime({ mode: 'string' }),
},
(table) => [
	uniqueIndex("training_assignments_emp_path").on(table.employeeId, table.pathId),
	index("training_assignments_status_idx").on(table.status),
]);

export const trainingProgress = mysqlTable("training_progress", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	itemType: varchar({ length: 16 }).notNull(),
	itemId: int().notNull(),
	viewedAt: datetime({ mode: 'string' }),
	completedAt: datetime({ mode: 'string' }),
	seconds: int().default(0).notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [uniqueIndex("training_progress_unique").on(table.employeeId, table.itemType, table.itemId)]);

export const trainingAttemptSessions = mysqlTable("training_attempt_sessions", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	kind: varchar({ length: 8 }).notNull(), // quiz | exam
	examId: int(),
	categoryId: int(),
	questionIds: text().notNull(), // JSON: ids servidos nesta tentativa
	startedAt: datetime({ mode: 'string' }).notNull(),
	deadlineAt: datetime({ mode: 'string' }),
	submittedAt: datetime({ mode: 'string' }),
	resultId: int(),
	score: int(),
	passed: tinyint(),
},
(table) => [index("training_attempt_sessions_emp_idx").on(table.employeeId, table.kind, table.startedAt)]);

export const trainingPromotions = mysqlTable("training_promotions", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	examId: int().notNull(),
	attemptId: int(),
	level: varchar({ length: 32 }).notNull(),
	score: int(),
	status: varchar({ length: 16 }).default('pending').notNull(), // pending | approved | rejected
	requestedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	decidedAt: datetime({ mode: 'string' }),
	decidedById: int(),
	note: varchar({ length: 500 }),
	certificateId: int(),
},
(table) => [index("training_promotions_status_idx").on(table.status)]);

export const trainingCertificates = mysqlTable("training_certificates", {
	id: int().autoincrement().primaryKey(),
	employeeId: int().notNull(),
	examId: int().notNull(),
	level: varchar({ length: 32 }).notNull(),
	issuedAt: datetime({ mode: 'string' }).notNull(),
	validUntil: date({ mode: 'string' }),
	fileKey: varchar({ length: 512 }),
	fileUrl: text(),
	promotionId: int(),
	recertAssignedAt: datetime({ mode: 'string' }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [index("training_certificates_emp_idx").on(table.employeeId)]);

export const users = mysqlTable("users", {
	id: int().autoincrement().primaryKey(),
	openId: varchar({ length: 64 }).notNull(),
	name: text(),
	email: varchar({ length: 320 }),
	loginMethod: varchar({ length: 64 }),
	role: mysqlEnum(['super_admin','admin','team_leader','backoffice','frontoffice','supervisor','condutor','extra','user']).default('user').notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	lastSignedIn: timestamp({ mode: 'string' }).defaultNow().notNull(),
	department: varchar({ length: 128 }),
	isActive: tinyint().default(1).notNull(),
	// 0071 — POR QUE RAZÃO está desativado. `deactivationReason` guarda o CÓDIGO
	// de shared/deactivationReasons.ts (nunca a etiqueta); o texto livre só
	// existe quando o código é `outro`. Reativar põe tudo a NULL — o histórico
	// completo fica em `activity_logs`.
	deactivationReason: varchar({ length: 48 }),
	deactivationReasonOther: varchar({ length: 200 }),
	deactivationNotes: text(),
	deactivatedAt: timestamp({ mode: 'string' }),
	deactivatedById: int(),
	// 0098 — versão da sessão: o cookie leva-a; subir invalida os cookies
	// antigos ("Terminar todas as sessões"). Cookies sem versão = 0.
	sessionVersion: int().default(0).notNull(),
	// 0098 — preferências de notificação ({ muted: string[] }).
	notificationPrefs: json(),
},
(table) => [
	uniqueIndex("users_openId_unique").on(table.openId),
]);

export const vehicleMovements = mysqlTable("vehicle_movements", {
	id: int().autoincrement().primaryKey(),
	vehicleId: int().notNull(),
	employeeId: int().notNull(),
	movementType: mysqlEnum(['pickup','return']).notNull(),
	kmReading: int(),
	latitude: decimal({ precision: 10, scale: 7 }),
	longitude: decimal({ precision: 10, scale: 7 }),
	notes: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const vehicles = mysqlTable("vehicles", {
	id: int().autoincrement().primaryKey(),
	plate: varchar({ length: 20 }).notNull(),
	brand: varchar({ length: 100 }),
	model: varchar({ length: 100 }),
	year: int(),
	color: varchar({ length: 50 }),
	vehicleStatus: mysqlEnum(['active','maintenance','inactive']).default('active').notNull(),
	projectId: int(),
	notes: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	index("vehicles_plate_unique").on(table.plate),
]);

// ─── Inbound emails (leitura IMAP da reservas@ → roteamento para módulos) ────
export const inboundEmails = mysqlTable("inbound_emails", {
	id: int().autoincrement().primaryKey(),
	messageId: varchar({ length: 255 }).notNull(),         // Message-ID do email (dedup)
	alias: varchar({ length: 40 }).notNull(),              // criticas | reclamacoes | perdidos | recursos-humanos
	fromName: varchar({ length: 255 }),
	fromEmail: varchar({ length: 320 }),                   // remetente do cabeçalho (pode vir mascarado)
	clientName: varchar({ length: 255 }),                  // cliente real extraído do corpo
	clientEmail: varchar({ length: 320 }),
	clientPhone: varchar({ length: 50 }),
	vehiclePlate: varchar({ length: 20 }),
	bookingRef: varchar({ length: 100 }),
	subject: varchar({ length: 500 }),
	bodyText: text(),
	attachmentsJson: text(),                               // [{filename, contentType, size, url?}] — url presente desde que a ingestão guarda os ficheiros no storage (migration 0061)
	targetModule: varchar({ length: 40 }),                 // review | complaint | lostfound | rh
	targetId: int(),                                       // id do registo criado
	taskId: int(),                                         // tarefa criada (ex: RH → Kamila)
	gmThreadId: varchar({ length: 64 }),                   // X-GM-THRID (thread do Gmail) p/ agrupar respostas
	headerRefs: text(),                                    // In-Reply-To + References (message-ids) p/ threading
	notes: text(),                                         // notas internas do backoffice sobre o candidato/email (migration 0061)
	status: mysqlEnum(['processed', 'skipped', 'error', 'processing']).default('processed').notNull(), // processing = Message-ID reservado, reclamação a ser criada (migration 0085)
	errorMsg: varchar({ length: 500 }),
	receivedAt: timestamp({ mode: 'string' }),
	processedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("inbound_emails_message_id_unique").on(table.messageId),
	index("inbound_emails_alias_idx").on(table.alias),
	index("inbound_emails_gm_thread_idx").on(table.gmThreadId),
]);

// ─── WhatsApp (integração Cloud API) ────────────────────────────────────────
// Conversa 1-a-1 com um contacto (chave = número E.164). lastInboundAt é a
// fonte de verdade da janela de 24h da Meta: se null ou > 24h atrás, a janela
// está fechada e só se pode enviar TEMPLATE (não texto livre).
export const whatsappConversations = mysqlTable("whatsapp_conversations", {
	id: int().autoincrement().primaryKey(),
	phoneE164: varchar({ length: 20 }).notNull(),
	employeeId: int(),
	lastInboundAt: timestamp({ mode: 'string' }),
	lastMessageAt: timestamp({ mode: 'string' }),
	unreadCount: int().default(0).notNull(),
	// Migração 0094 ─────────────────────────────────────────────────────────
	/** Pediu para não receber mensagens (STOP/PARAR…); "INICIAR" limpa. */
	optedOutAt: timestamp({ mode: 'string' }),
	/** Nome de perfil WhatsApp (contacts[].profile.name do webhook). */
	profileName: varchar({ length: 128 }),
	/** Resumo da última mensagem (lista do inbox sem ler as mensagens). */
	lastPreview: varchar({ length: 160 }),
	lastDirection: mysqlEnum(['in', 'out']),
	lastType: varchar({ length: 16 }),
	/** Cidade inferida pelo telefone de uma reserva (números sem ficha nem lead). */
	bookingProjectId: int(),
	bookingCheckedAt: timestamp({ mode: 'string' }),
	// Migração 0097 ─────────────────────────────────────────────────────────
	/** aberto/pendente/resolvido — nova mensagem recebida reabre (shared/whatsappConversation.ts). */
	status: mysqlEnum(['aberto', 'pendente', 'resolvido']).default('aberto').notNull(),
	/** Responsável pela conversa (users.id). */
	assignedUserId: int(),
	statusChangedAt: timestamp({ mode: 'string' }),
	resolvedAt: timestamp({ mode: 'string' }),
	/** 1.ª mensagem recebida ainda sem resposta nossa (SLA); null = respondida. */
	awaitingSince: timestamp({ mode: 'string' }),
	/** Aviso de SLA enviado (1× por período sem resposta). */
	slaAlertedAt: timestamp({ mode: 'string' }),
	/** Aviso de "janela a fechar" enviado (1× por mensagem recebida). */
	windowAlertedAt: timestamp({ mode: 'string' }),
	/** Ligação manual a uma reserva (multipark_bookings.id) / cliente (email). */
	linkedBookingId: int(),
	linkedClientEmail: varchar({ length: 320 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("whatsapp_conversations_phone_unique").on(table.phoneE164),
	index("idx_whatsapp_conversations_status").on(table.status, table.awaitingSince),
	index("idx_whatsapp_conversations_assigned").on(table.assignedUserId),
	index("idx_whatsapp_conversations_employee").on(table.employeeId),
	index("idx_whatsapp_conversations_last_message").on(table.lastMessageAt),
]);

// Mensagem individual (entrada ou saída). waMessageId (id da Meta) é único
// quando presente → serve de dedup do webhook e de correlação dos updates de
// status (sent/delivered/read/failed). MySQL permite múltiplos NULL num UNIQUE,
// por isso mensagens ainda-sem-id não colidem.
export const whatsappMessages = mysqlTable("whatsapp_messages", {
	id: int().autoincrement().primaryKey(),
	conversationId: int().notNull(),
	direction: mysqlEnum(['in', 'out']).notNull(),
	waMessageId: varchar({ length: 128 }),
	// image/audio/document/video acrescentados na 0094; linhas antigas de media
	// continuam 'text' com `mediaType` preenchido (a leitura aceita as duas).
	type: mysqlEnum(['text', 'template', 'image', 'audio', 'document', 'video']).notNull(),
	body: text(),
	templateName: varchar({ length: 128 }),
	// Media recebida (imagem/áudio enviados pela pessoa) — migração 0065.
	// `mediaId` é o id da Meta (permite re-tentar o download); `mediaUrl`/`mediaKey`
	// apontam para o storage da app (server/storage.ts).
	mediaType: mysqlEnum(['image', 'audio', 'video', 'document', 'sticker']),
	mediaId: varchar({ length: 128 }),
	mediaMime: varchar({ length: 128 }),
	mediaUrl: text(),
	mediaKey: varchar({ length: 512 }),
	/** Tentativas de download da media falhadas (retry no cron horário, 0094). */
	mediaAttempts: int().default(0).notNull(),
	/** phone_number_id da Meta que recebeu a mensagem (metadata do webhook, 0094). */
	phoneNumberId: varchar({ length: 32 }),
	status: mysqlEnum(['pending', 'sent', 'delivered', 'read', 'failed']).default('pending').notNull(),
	errorDetail: text(),
	sentById: int(),
	broadcastId: int(),
	waTimestamp: timestamp({ mode: 'string' }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	uniqueIndex("whatsapp_messages_wa_message_id_unique").on(table.waMessageId),
	index("idx_whatsapp_messages_conversation").on(table.conversationId),
	index("idx_whatsapp_messages_broadcast").on(table.broadcastId),
	index("idx_whatsapp_messages_status").on(table.status),
]);

// Status de entrega que chegou ANTES de a linha outbound existir (a Meta pode
// mandar o 'failed' antes de o envio gravar a mensagem). Reconciliado quando o
// envio grava a linha com esse waMessageId; limpo pelo cron ao fim de 7 dias.
// Respostas rápidas do inbox de WhatsApp (migração 0097). `{{nome}}` no texto
// é trocado pelo primeiro nome do contacto ao inserir no composer.
export const whatsappQuickReplies = mysqlTable("whatsapp_quick_replies", {
	id: int().autoincrement().primaryKey(),
	title: varchar({ length: 80 }).notNull(),
	body: text().notNull(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const whatsappPendingStatuses = mysqlTable("whatsapp_pending_statuses", {
	waMessageId: varchar({ length: 128 }).notNull().primaryKey(),
	status: mysqlEnum(['sent', 'delivered', 'read', 'failed']).notNull(),
	errorDetail: text(),
	receivedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

// Envio em massa de um template a N destinatários (agrupa as whatsapp_messages
// resultantes via broadcastId). Contadores para o resumo no backoffice.
export const whatsappBroadcasts = mysqlTable("whatsapp_broadcasts", {
	id: int().autoincrement().primaryKey(),
	templateName: varchar({ length: 128 }).notNull(),
	note: text(),
	createdById: int(),
	weekStart: date({ mode: 'string' }),
	totalCount: int().default(0).notNull(),
	sentCount: int().default(0).notNull(),
	failedCount: int().default(0).notNull(),
	// JSON array dos employeeId que falharam por número inválido/ausente — para
	// depois listar "extras com número inválido" e corrigir na origem.
	invalidEmployeeIds: text(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

// ─── Leads de extras (2026-09-17) ───────────────────────────────────────────
// Contactos que AINDA não são extras mas estão a ser recrutados. Vivem fora de
// `employees` de propósito: uma ficha só nasce quando a pessoa aceita (aí o
// lead passa a `converted` e aponta para o employeeId). O contacto por WhatsApp
// usa o template `seja_motorista` (sem parâmetros) e fica no inbox como conversa
// SEM ficha; `phoneE164` é a chave que liga o lead a essa conversa.
export const extraLeads = mysqlTable("extra_leads", {
	id: int().autoincrement().primaryKey(),
	fullName: varchar({ length: 256 }).notNull(),
	/** Como foi escrito (normalizado à entrada por normalizePhoneForStorage). */
	phone: varchar({ length: 32 }),
	/** E.164 — chave de envio e de ligação à conversa do inbox. */
	phoneE164: varchar({ length: 20 }),
	email: varchar({ length: 320 }),
	// 'replied' acrescentado no FIM do enum (migração 0084 — alteração instantânea).
	status: mysqlEnum(['new','contacted','converted','declined','replied']).default('new').notNull(),
	notes: varchar({ length: 512 }),
	/** manual | site (candidatura Be a Driver) | email (recursos-humanos@). */
	source: varchar({ length: 64 }).default('manual').notNull(),
	/** Origem concreta: "application:123" / "email:456" (UNIQUE, migração 0084). */
	sourceRef: varchar({ length: 64 }),
	/** Última mensagem WhatsApp RECEBIDA deste número (migração 0084). */
	lastInboundAt: datetime({ mode: 'string' }),
	/** 1.º template enviado com sucesso (métrica do funil). */
	firstContactedAt: datetime({ mode: 'string' }),
	convertedAt: datetime({ mode: 'string' }),
	/** Resposta automática com o link da candidatura já enviada (no máximo 1×). */
	autoRepliedAt: datetime({ mode: 'string' }),
	/** Pediu para não receber WhatsApp (STOP/PARAR…) — migração 0094. */
	optedOutAt: datetime({ mode: 'string' }),
	/** Nº de templates ENVIADOS com sucesso a este lead. */
	contactCount: int().default(0).notNull(),
	lastContactedAt: timestamp({ mode: 'string' }),
	/** Preenchido quando o lead vira extra (ficha criada). */
	employeeId: int(),
	/** Centro de custos (cidade) do lead — migração 0077; NULL = visível a todos. */
	projectId: int(),
	createdById: int(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
},
(table) => [
	index("idx_extra_leads_status").on(table.status),
	index("idx_extra_leads_phone").on(table.phoneE164),
	index("idx_extra_leads_email").on(table.email),
	index("idx_extra_leads_project").on(table.projectId),
	uniqueIndex("uq_extra_leads_source_ref").on(table.sourceRef),
]);

// Candidaturas/emails já processados pela importação para leads (migração 0084):
// um lead apagado pelo backoffice não volta a ser criado pela mesma origem.
export const extraLeadSources = mysqlTable("extra_lead_sources", {
	sourceRef: varchar({ length: 64 }).primaryKey(),
	leadId: int(),
	/** created | merged | employee | invalid */
	outcome: varchar({ length: 16 }).notNull(),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

// ─── Tokens do formulário externo de disponibilidades (Fase 4) ──────────────
// Single-use: cada token é assinado (JWT) com um `jti` que também vive aqui.
// A submissão consome-o (usedAt) via UPDATE ... WHERE usedAt IS NULL.
export const availabilityFormTokens = mysqlTable("availability_form_tokens", {
	id: int().autoincrement().primaryKey(),
	jti: varchar({ length: 64 }).notNull(),
	employeeId: int().notNull(),
	weekStart: varchar({ length: 10 }).notNull(),
	expiresAt: timestamp({ mode: 'string' }).notNull(),
	usedAt: timestamp({ mode: 'string' }),
	createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	uniqueIndex("availability_form_tokens_jti_unique").on(table.jti),
	index("idx_availability_form_tokens_employee").on(table.employeeId),
]);

// ─── Select & Insert type aliases ───────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type InsertExpense = typeof expenses.$inferInsert;
export type InsertExpenseCategory = typeof expenseCategories.$inferInsert;
export type InsertExpensePayment = typeof expensePayments.$inferInsert;
export type InsertExpenseBudget = typeof expenseBudgets.$inferInsert;
export type InsertExpenseEvent = typeof expenseEvents.$inferInsert;
export type InsertFinanceAccount = typeof financeAccounts.$inferInsert;
export type InsertFinanceImportBatch = typeof financeImportBatches.$inferInsert;
export type InsertProject = typeof projects.$inferInsert;
export type InsertProjectEmployee = typeof projectEmployees.$inferInsert;
export type InsertTask = typeof tasks.$inferInsert;
export type InsertActivityLog = typeof activityLogs.$inferInsert;
export type InsertCampaign = typeof campaigns.$inferInsert;
export type InsertCampaignDailyStat = typeof campaignDailyStats.$inferInsert;
export type InsertMarketingExpense = typeof marketingExpenses.$inferInsert;
export type InsertVehicle = typeof vehicles.$inferInsert;
export type InsertVehicleMovement = typeof vehicleMovements.$inferInsert;
export type InsertSpeedAlert = typeof speedAlerts.$inferInsert;
export type InsertRadioTranscription = typeof radioTranscriptions.$inferInsert;
export type InsertApiKey = typeof apiKeys.$inferInsert;
export type InsertComplaint = typeof complaints.$inferInsert;
export type InsertComplaintMessage = typeof complaintMessages.$inferInsert;
export type InsertComplaintPhoto = typeof complaintPhotos.$inferInsert;
export type InsertGoogleReview = typeof googleReviews.$inferInsert;
export type InsertMultiparkBooking = typeof multiparkBookings.$inferInsert;
export type InsertMultiparkDailySnapshot = typeof multiparkDailySnapshots.$inferInsert;
export type InsertInviteToken = typeof inviteTokens.$inferInsert;
export type InsertPayslipHistory = typeof payslipHistory.$inferInsert;
export type InsertSpeedLimit = typeof speedLimits.$inferInsert;
export type InsertSpeedViolation = typeof speedViolations.$inferInsert;
export type InsertDailyDriverHistory = typeof dailyDriverHistory.$inferInsert;
export type InsertPda = typeof pdas.$inferInsert;
export type InsertPdaCheckin = typeof pdaCheckins.$inferInsert;
export type InsertGpsAlert = typeof gpsAlerts.$inferInsert;
export type InsertEmployee = typeof employees.$inferInsert;
export type InsertEmployeeDocument = typeof employeeDocuments.$inferInsert;
export type InsertSchedule = typeof schedules.$inferInsert;
export type InsertTimeRecord = typeof timeRecords.$inferInsert;
export type InsertExtraRate = typeof extraRates.$inferInsert;
export type LostFoundItem = typeof lostFoundItems.$inferSelect;
export type LostFoundPhoto = typeof lostFoundPhotos.$inferSelect;
export type LostFoundMessage = typeof lostFoundMessages.$inferSelect;
export type InboundEmail = typeof inboundEmails.$inferSelect;
export type InsertInboundEmail = typeof inboundEmails.$inferInsert;
export type WhatsappConversation = typeof whatsappConversations.$inferSelect;
export type InsertWhatsappConversation = typeof whatsappConversations.$inferInsert;
export type WhatsappMessage = typeof whatsappMessages.$inferSelect;
export type InsertWhatsappMessage = typeof whatsappMessages.$inferInsert;
export type WhatsappBroadcast = typeof whatsappBroadcasts.$inferSelect;
export type InsertWhatsappBroadcast = typeof whatsappBroadcasts.$inferInsert;
export type AvailabilityFormToken = typeof availabilityFormTokens.$inferSelect;
export type InsertAvailabilityFormToken = typeof availabilityFormTokens.$inferInsert;
export type ShiftHandover = typeof shiftHandovers.$inferSelect;

// ─── Definições (0098) ────────────────────────────────────────────────────────
// Corridas dos crons /api/cron/* (GitHub Actions). ok NULL = a correr / sem resposta.
export const cronRuns = mysqlTable("cron_runs", {
	id: bigint({ mode: "number" }).autoincrement().primaryKey(),
	name: varchar({ length: 64 }).notNull(),
	startedAt: datetime({ mode: 'string', fsp: 3 }).notNull(),
	finishedAt: datetime({ mode: 'string', fsp: 3 }),
	ok: tinyint(),
	error: text(),
	durationMs: int(),
	httpStatus: int(),
	meta: varchar({ length: 255 }),
},
(table) => [
	index("idx_cron_runs_name_started").on(table.name, table.startedAt),
	index("idx_cron_runs_started").on(table.startedAt),
]);

// Definições chave → valor JSON (inclui "flag.<NOME>" = sobreposição dos interruptores).
export const appSettings = mysqlTable("app_settings", {
	settingKey: varchar({ length: 100 }).primaryKey(),
	value: json().notNull(),
	updatedById: int(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
});

export const appSettingsAudit = mysqlTable("app_settings_audit", {
	id: bigint({ mode: "number" }).autoincrement().primaryKey(),
	settingKey: varchar({ length: 100 }).notNull(),
	oldValue: json(),
	newValue: json(),
	changedById: int(),
	changedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
},
(table) => [
	index("idx_app_settings_audit_key_changed").on(table.settingKey, table.changedAt),
	index("idx_app_settings_audit_changed").on(table.changedAt),
]);

// Permissões por utilizador (grant/deny além do papel) + overrides de módulo
// (`module.<id>`, migração 0100): scope/actions substituem o que o papel dá
// nesse módulo; expiresOn = último dia (Lisboa) em que vale.
export const userPermissions = mysqlTable("user_permissions", {
	userId: int().notNull(),
	permission: varchar({ length: 64 }).notNull(),
	mode: mysqlEnum(['grant','deny']).notNull(),
	grantedBy: int(),
	updatedAt: timestamp({ mode: 'string' }).defaultNow().onUpdateNow().notNull(),
	scope: varchar({ length: 16 }),
	actions: varchar({ length: 8 }),
	expiresOn: date({ mode: 'string' }),
	note: varchar({ length: 255 }),
	createdAt: timestamp({ mode: 'string' }).defaultNow(),
},
(table) => [
	primaryKey({ columns: [table.userId, table.permission] }),
	index("idx_user_permissions_permission").on(table.permission),
]);

export type UserPermission = typeof userPermissions.$inferSelect;
