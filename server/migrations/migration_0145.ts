// Migration 0145 — Comunicação (Gmail dentro do dashboard) + contas Google por utilizador
//
//  - google_user_accounts: "Ligar a minha conta Google" (1 por utilizador),
//    refresh token CIFRADO (AES-256-GCM, INTEGRATIONS_ENCRYPTION_KEY), âmbitos
//    concedidos (autorização incremental) e estado (connected /
//    reauth_required / error / disconnected).
//  - mail_mailboxes: caixas partilhadas configuráveis (endereços/aliases por
//    marca, conta de origem, módulo, pipeline antigo, regra de cidade, papéis,
//    assinatura por marca). SEMEADAS UMA VEZ (marca 0145_seed_mailboxes em
//    app_notification_maintenance) — o dono pode apagar/editar sem que voltem.
//  - mail_accounts: estado da sincronização por conta Google ("dwd:email" =
//    impersonada pela service account; "user:<id>" = conta ligada de alguém):
//    historyId, cursor da importação inicial, bloqueio, erros, watch (push).
//  - mail_threads / mail_messages: TODOS os emails (decisão do dono), com
//    caixa, marca, direção, estado/responsável/SLA; dedupe por (conta, id Gmail).
//  - mail_links: mensagem/conversa ↔ cliente/reserva/reclamação/perdido/
//    ocorrência, com confiança e origem (auto/manual); `removedAt` guarda o
//    "desligar" manual para a ligação automática não voltar.
//
// Idempotente (corre em cada arranque via ensureRecentSchema): CREATE TABLE IF
// NOT EXISTS e sementes guardadas por marca única.

export const MIGRATION_0145_NAME = "0145_mail_comunicacao";

export const SEED_0145_ID = "0145_seed_mailboxes";

const SRC = "reservas@multipark.pt";

type Seed = {
  key: string; label: string; addresses: Array<{ address: string; brand: string }>; module: string;
  pipeline: string | null; cityRule: "all" | "linked"; visibleRoles: string[]; catchAll: boolean; notify: boolean; sortOrder: number;
};

// Pontos de partida — o dono corrige endereços e contas em Definições → Comunicação.
const SEEDS: Seed[] = [
  { key: "reclamacoes", label: "Reclamações", addresses: [{ address: "reclamacoes@multipark.pt", brand: "multipark" }], module: "reclamacoes", pipeline: "reclamacoes", cityRule: "linked", visibleRoles: [], catchAll: false, notify: false, sortOrder: 10 },
  { key: "perdidos", label: "Perdidos e Achados", addresses: [{ address: "perdidos@multipark.pt", brand: "multipark" }], module: "perdidos", pipeline: "perdidos", cityRule: "linked", visibleRoles: [], catchAll: false, notify: false, sortOrder: 20 },
  { key: "criticas", label: "Críticas", addresses: [{ address: "criticas@multipark.pt", brand: "multipark" }], module: "criticas", pipeline: "criticas", cityRule: "all", visibleRoles: [], catchAll: false, notify: false, sortOrder: 30 },
  { key: "ocorrencias", label: "Ocorrências", addresses: [{ address: "ocorrencias@multipark.pt", brand: "multipark" }], module: "ocorrencias", pipeline: "ocorrencias", cityRule: "linked", visibleRoles: [], catchAll: false, notify: false, sortOrder: 40 },
  { key: "rh", label: "Recursos Humanos", addresses: [{ address: "recursos-humanos@multipark.pt", brand: "multipark" }], module: "rh", pipeline: "recursos-humanos", cityRule: "all", visibleRoles: [], catchAll: false, notify: false, sortOrder: 50 },
  { key: "campanhas", label: "Campanhas", addresses: [{ address: "campanhas@multipark.pt", brand: "multipark" }], module: "marketing", pipeline: "campanhas", cityRule: "all", visibleRoles: [], catchAll: false, notify: false, sortOrder: 60 },
  { key: "info", label: "Info (geral)", addresses: [{ address: "info@multipark.pt", brand: "multipark" }], module: "comunicacao", pipeline: null, cityRule: "all", visibleRoles: [], catchAll: false, notify: true, sortOrder: 70 },
  { key: "comercial", label: "Comercial", addresses: [{ address: "comercial@multipark.pt", brand: "multipark" }], module: "comunicacao", pipeline: null, cityRule: "all", visibleRoles: [], catchAll: false, notify: true, sortOrder: 80 },
  { key: "admin", label: "Administração", addresses: [{ address: "admin@multipark.pt", brand: "multipark" }], module: "comunicacao", pipeline: null, cityRule: "all", visibleRoles: ["admin", "super_admin"], catchAll: false, notify: true, sortOrder: 90 },
  { key: "reservas", label: "Reservas (geral)", addresses: [{ address: "reservas@multipark.pt", brand: "multipark" }], module: "reservas_operacoes", pipeline: null, cityRule: "all", visibleRoles: [], catchAll: true, notify: false, sortOrder: 100 },
];

const q = (s: string) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";

function seedStatement(s: Seed): string {
  const cols = "`mailboxKey`, `label`, `addressesJson`, `sourceKind`, `sourceEmail`, `module`, `pipeline`, `cityRule`, `visibleRolesJson`, `signaturesJson`, `catchAll`, `notify`, `active`, `sortOrder`";
  const vals = [
    q(s.key), q(s.label), q(JSON.stringify(s.addresses)), q("dwd"), q(SRC), q(s.module),
    s.pipeline ? q(s.pipeline) : "NULL", q(s.cityRule), q(JSON.stringify(s.visibleRoles)), q("{}"),
    s.catchAll ? "1" : "0", s.notify ? "1" : "0", "1", String(s.sortOrder),
  ].join(", ");
  return "INSERT IGNORE INTO `mail_mailboxes` (" + cols + ") SELECT " + vals + " FROM DUAL " +
    "WHERE NOT EXISTS (SELECT 1 FROM `app_notification_maintenance` m WHERE m.`id` = '" + SEED_0145_ID + "')";
}

export const MIGRATION_0145_STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS `google_user_accounts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`userId` INT NOT NULL, " +
    "`email` VARCHAR(320) NOT NULL, " +
    "`hostedDomain` VARCHAR(255) NULL, " +
    "`googleSub` VARCHAR(64) NULL, " +
    "`refreshTokenEnc` TEXT NULL, " +
    "`scopes` TEXT NULL, " +
    "`status` VARCHAR(24) NOT NULL DEFAULT 'connected', " +
    "`lastError` VARCHAR(500) NULL, " +
    "`connectedAt` TIMESTAMP NULL, " +
    "`lastCheckedAt` TIMESTAMP NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), UNIQUE KEY `uq_google_user_accounts_user` (`userId`), KEY `idx_google_user_accounts_email` (`email`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `mail_mailboxes` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`mailboxKey` VARCHAR(40) NOT NULL, " +
    "`label` VARCHAR(80) NOT NULL, " +
    "`addressesJson` TEXT NOT NULL, " +
    "`sourceKind` VARCHAR(8) NOT NULL DEFAULT 'dwd', " +
    "`sourceEmail` VARCHAR(320) NULL, " +
    "`sourceUserId` INT NULL, " +
    "`module` VARCHAR(40) NOT NULL DEFAULT 'comunicacao', " +
    "`pipeline` VARCHAR(40) NULL, " +
    "`cityRule` VARCHAR(8) NOT NULL DEFAULT 'all', " +
    "`visibleRolesJson` TEXT NULL, " +
    "`signaturesJson` TEXT NULL, " +
    "`catchAll` TINYINT NOT NULL DEFAULT 0, " +
    "`notify` TINYINT NOT NULL DEFAULT 1, " +
    "`active` TINYINT NOT NULL DEFAULT 1, " +
    "`sortOrder` INT NOT NULL DEFAULT 100, " +
    "`updatedById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), UNIQUE KEY `uq_mail_mailboxes_key` (`mailboxKey`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `mail_accounts` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`accountKey` VARCHAR(360) NOT NULL, " +
    "`email` VARCHAR(320) NULL, " +
    "`historyId` VARCHAR(32) NULL, " +
    "`backfillStartHistoryId` VARCHAR(32) NULL, " +
    "`backfillPageToken` VARCHAR(512) NULL, " +
    "`backfillDays` INT NULL, " +
    "`backfillDoneAt` TIMESTAMP NULL, " +
    "`status` VARCHAR(24) NOT NULL DEFAULT 'pending', " +
    "`lastError` VARCHAR(500) NULL, " +
    "`lastSyncAt` TIMESTAMP NULL, " +
    "`lastOkAt` TIMESTAMP NULL, " +
    "`syncLockAt` TIMESTAMP NULL, " +
    "`messagesStored` INT NOT NULL DEFAULT 0, " +
    "`watchExpiration` BIGINT NULL, " +
    "`pushPendingAt` TIMESTAMP NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), UNIQUE KEY `uq_mail_accounts_key` (`accountKey`), KEY `idx_mail_accounts_email` (`email`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `mail_threads` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`accountKey` VARCHAR(360) NOT NULL, " +
    "`gmailThreadId` VARCHAR(32) NOT NULL, " +
    "`mailboxKey` VARCHAR(40) NULL, " +
    "`ownerUserId` INT NULL, " +
    "`brand` VARCHAR(16) NULL, " +
    "`subject` VARCHAR(500) NULL, " +
    "`snippet` VARCHAR(300) NULL, " +
    "`contactEmail` VARCHAR(320) NULL, " +
    "`contactName` VARCHAR(255) NULL, " +
    "`matchedAddress` VARCHAR(320) NULL, " +
    "`messageCount` INT NOT NULL DEFAULT 0, " +
    "`unreadCount` INT NOT NULL DEFAULT 0, " +
    "`lastMessageAt` DATETIME NULL, " +
    "`lastInboundAt` DATETIME NULL, " +
    "`lastOutboundAt` DATETIME NULL, " +
    "`awaitingSince` DATETIME NULL, " +
    "`status` VARCHAR(12) NOT NULL DEFAULT 'aberto', " +
    "`assignedUserId` INT NULL, " +
    "`statusChangedAt` TIMESTAMP NULL, " +
    "`projectId` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "`updatedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), UNIQUE KEY `uq_mail_threads_account_thread` (`accountKey`, `gmailThreadId`), " +
    "KEY `idx_mail_threads_mailbox` (`mailboxKey`, `lastMessageAt`), KEY `idx_mail_threads_owner` (`ownerUserId`, `lastMessageAt`), " +
    "KEY `idx_mail_threads_assigned` (`assignedUserId`), KEY `idx_mail_threads_contact` (`contactEmail`), KEY `idx_mail_threads_last` (`lastMessageAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `mail_messages` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`threadId` INT NOT NULL, " +
    "`accountKey` VARCHAR(360) NOT NULL, " +
    "`gmailMessageId` VARCHAR(32) NOT NULL, " +
    "`gmailThreadId` VARCHAR(32) NOT NULL, " +
    "`rfcMessageId` VARCHAR(255) NULL, " +
    "`inReplyTo` VARCHAR(255) NULL, " +
    "`referencesText` TEXT NULL, " +
    "`mailboxKey` VARCHAR(40) NULL, " +
    "`brand` VARCHAR(16) NULL, " +
    "`direction` VARCHAR(3) NOT NULL DEFAULT 'in', " +
    "`fromName` VARCHAR(255) NULL, " +
    "`fromEmail` VARCHAR(320) NULL, " +
    "`toJson` TEXT NULL, " +
    "`ccJson` TEXT NULL, " +
    "`deliveredTo` VARCHAR(320) NULL, " +
    "`matchedAddress` VARCHAR(320) NULL, " +
    "`subject` VARCHAR(500) NULL, " +
    "`snippet` VARCHAR(300) NULL, " +
    "`bodyText` MEDIUMTEXT NULL, " +
    "`bodyHtml` MEDIUMTEXT NULL, " +
    "`attachmentsJson` TEXT NULL, " +
    "`labelIdsJson` VARCHAR(1000) NULL, " +
    "`sentAt` DATETIME NULL, " +
    "`isRead` TINYINT NOT NULL DEFAULT 0, " +
    "`automated` TINYINT NOT NULL DEFAULT 0, " +
    "`sentById` INT NULL, " +
    "`pipeline` VARCHAR(40) NULL, " +
    "`pipelineStatus` VARCHAR(16) NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), UNIQUE KEY `uq_mail_messages_account_msg` (`accountKey`, `gmailMessageId`), " +
    "KEY `idx_mail_messages_thread` (`threadId`, `sentAt`), KEY `idx_mail_messages_rfc` (`rfcMessageId`), " +
    "KEY `idx_mail_messages_from` (`fromEmail`), KEY `idx_mail_messages_sent` (`sentAt`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  "CREATE TABLE IF NOT EXISTS `mail_links` (" +
    "`id` INT NOT NULL AUTO_INCREMENT, " +
    "`threadId` INT NOT NULL, " +
    "`messageId` INT NULL, " +
    "`entityType` VARCHAR(16) NOT NULL, " +
    "`entityId` VARCHAR(320) NOT NULL, " +
    "`confidence` INT NOT NULL DEFAULT 100, " +
    "`source` VARCHAR(8) NOT NULL DEFAULT 'auto', " +
    "`reason` VARCHAR(120) NULL, " +
    "`createdById` INT NULL, " +
    "`removedAt` TIMESTAMP NULL, " +
    "`removedById` INT NULL, " +
    "`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`), UNIQUE KEY `uq_mail_links_thread_entity` (`threadId`, `entityType`, `entityId`), " +
    "KEY `idx_mail_links_entity` (`entityType`, `entityId`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",

  // A tabela de marcas de manutenção nasceu na 0140; aqui só por segurança.
  "CREATE TABLE IF NOT EXISTS `app_notification_maintenance` (" +
    "`id` VARCHAR(64) NOT NULL, " +
    "`ranAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "PRIMARY KEY (`id`)" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  ...SEEDS.map(seedStatement),
  "INSERT IGNORE INTO `app_notification_maintenance` (`id`) VALUES ('" + SEED_0145_ID + "')",
];

export const IDEMPOTENT_ERROR_CODES_0145 = new Set<string>(["ER_TABLE_EXISTS_ERROR", "ER_DUP_KEYNAME", "ER_DUP_FIELDNAME", "ER_DUP_ENTRY"]);
