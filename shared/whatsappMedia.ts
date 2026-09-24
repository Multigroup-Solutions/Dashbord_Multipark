/**
 * Media recebida por WhatsApp (imagens, áudios, vídeos e documentos enviados
 * pelas pessoas) — vocabulário partilhado entre o webhook (que descarrega e
 * guarda) e o inbox (que mostra). PURO, sem I/O.
 *
 * O ficheiro é descarregado da Meta no webhook e guardado no storage da app
 * (`server/storage.ts`) só pela KEY (`mediaKey`); a UI pede um URL ASSINADO de
 * curta duração (`whatsapp.mediaUrl`). Falhas de download ficam com o
 * `mediaId` e o cron horário re-tenta (mediaAttempts, no máximo 5).
 */

/** Tipos de media da Cloud API que descarregamos (stickers ficam de fora). */
export const WHATSAPP_MEDIA_KINDS = ["image", "audio", "video", "document"] as const;
export type WhatsAppMediaKind = (typeof WHATSAPP_MEDIA_KINDS)[number];

/**
 * `type` da mensagem Meta → tipo de media que guardamos. "voice" (nota de voz)
 * é áudio para todos os efeitos. Devolve null para tipos não suportados.
 */
export function mediaKindForMessageType(type: string | null | undefined): WhatsAppMediaKind | null {
  switch (type) {
    case "image":
      return "image";
    case "audio":
    case "voice":
      return "audio";
    case "video":
      return "video";
    case "document":
      return "document";
    default:
      return null;
  }
}

/** Marcadores que o webhook grava no `body` quando não há caption. */
const MEDIA_PLACEHOLDERS = new Set(["[imagem]", "[áudio]", "[mensagem de voz]", "[vídeo]", "[documento]"]);

/**
 * Teto de tamanho da media entrante que descarregamos (documentos e vídeos
 * podem ser grandes; acima disto fica só o `mediaId` e a UI diz porquê).
 */
export const INBOUND_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * `true` quando o body é só o marcador "[imagem]"/"[áudio]" — com o ficheiro
 * visível o marcador é redundante e a bolha só deve mostrar a media (ou a
 * caption, quando existe).
 */
export function isMediaPlaceholderBody(body: string | null | undefined): boolean {
  return MEDIA_PLACEHOLDERS.has((body ?? "").trim());
}

/**
 * Extensão de ficheiro para o mime da Meta. Aceita parâmetros
 * (`audio/ogg; codecs=opus` → `ogg`). Desconhecido → "bin" (nunca inventa).
 */
export function extensionForMime(mime: string | null | undefined): string {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  switch (base) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "audio/ogg":
    case "audio/opus":
      return "ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/amr":
      return "amr";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "video/mp4":
      return "mp4";
    case "video/3gpp":
      return "3gp";
    case "video/quicktime":
      return "mov";
    case "application/pdf":
      return "pdf";
    case "application/msword":
      return "doc";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    case "application/vnd.ms-excel":
      return "xls";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "xlsx";
    case "application/vnd.ms-powerpoint":
      return "ppt";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return "pptx";
    case "text/plain":
      return "txt";
    default:
      return "bin";
  }
}

/** Mime sem parâmetros, para gravar/servir (`audio/ogg; codecs=opus` → `audio/ogg`). */
export function baseMime(mime: string | null | undefined): string | null {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return base || null;
}
