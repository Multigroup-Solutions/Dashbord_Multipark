// Migration 0655 — Emails → casos pela IA (Jorge, 14 out 2026: "tudo o que
// está na caixa de correio e é uma reclamação tem de ir para as Reclamações;
// os perdidos e achados também").
//
//  - complaints.aiUnconfirmed / lost_found_items.aiUnconfirmed: a IA criou o
//    caso com certeza média → "Por confirmar (IA)" até uma pessoa confirmar
//    (ou arquivar — nunca se apaga).
//  - lost_found_items.origin: de onde veio o perdido (email | ia | manual…),
//    como as reclamações (0630).
//  - complaint_mail_intake passa a guardar também os perdidos: `caseKind`
//    (complaint | lost_found), `lostFoundId` e `uncertain`. Continua UMA linha
//    por conversa (threadId UNIQUE): uma conversa nunca dá dois casos.
//  - comms_ai_routing: o que a triagem decidiu (`category`), as duas certezas
//    da IA (`complaintScore`, `lostScore`), as tentativas quando a IA falha
//    (`attempts` — o email fica onde está e volta a ser lido), o aviso que a
//    regra reconheceu (`notice`: review | occurrence | livro), quando ficou
//    lido pela regra (`markedReadAt`) e quando o varrimento dos antigos o leu
//    (`sweptAt`).
//
// Só acrescenta. ADD COLUMN ignora o que já existe (ER_DUP_FIELDNAME).

export const MIGRATION_0655_STATEMENTS: string[] = [
  "ALTER TABLE `complaints` ADD COLUMN `aiUnconfirmed` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `lost_found_items` ADD COLUMN `aiUnconfirmed` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `lost_found_items` ADD COLUMN `origin` VARCHAR(16) NULL",
  "ALTER TABLE `complaint_mail_intake` ADD COLUMN `caseKind` VARCHAR(12) NOT NULL DEFAULT 'complaint'",
  "ALTER TABLE `complaint_mail_intake` ADD COLUMN `lostFoundId` INT NULL",
  "ALTER TABLE `complaint_mail_intake` ADD COLUMN `uncertain` TINYINT NOT NULL DEFAULT 0",
  "ALTER TABLE `comms_ai_routing` ADD COLUMN `category` VARCHAR(20) NULL",
  "ALTER TABLE `comms_ai_routing` ADD COLUMN `complaintScore` DECIMAL(4,3) NULL",
  "ALTER TABLE `comms_ai_routing` ADD COLUMN `lostScore` DECIMAL(4,3) NULL",
  "ALTER TABLE `comms_ai_routing` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0",
  "ALTER TABLE `comms_ai_routing` ADD COLUMN `notice` VARCHAR(16) NULL",
  "ALTER TABLE `comms_ai_routing` ADD COLUMN `markedReadAt` DATETIME NULL",
  "ALTER TABLE `comms_ai_routing` ADD COLUMN `sweptAt` DATETIME NULL",
];

/** ER_DUP_FIELDNAME (1060), ER_DUP_KEYNAME (1061). */
export const IDEMPOTENT_ERROR_CODES_0655 = new Set<string>(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"]);
