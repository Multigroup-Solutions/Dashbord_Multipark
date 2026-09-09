/**
 * Media recebida por WhatsApp (imagens e áudios enviados pelas pessoas) —
 * vocabulário partilhado entre o webhook (que descarrega e guarda) e o inbox
 * (que mostra). PURO, sem I/O.
 *
 * Contexto: até 2026-09-09 uma imagem/áudio entrante ficava só como o texto
 * "[imagem]" / "[áudio]" na `whatsapp_messages.body`. Agora o ficheiro é
 * descarregado da Meta no momento do webhook e guardado no storage da app
 * (`server/storage.ts`); a linha ganha `mediaType` / `mediaUrl` / `mediaMime`.
 */

/** Tipos de media da Cloud API que descarregamos. Vídeo/documento/sticker ficam para depois. */
export const WHATSAPP_MEDIA_KINDS = ["image", "audio"] as const;
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
    default:
      return null;
  }
}

/** Marcadores que o webhook grava no `body` quando não há caption. */
const MEDIA_PLACEHOLDERS = new Set(["[imagem]", "[áudio]", "[mensagem de voz]"]);

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
    default:
      return "bin";
  }
}

/** Mime sem parâmetros, para gravar/servir (`audio/ogg; codecs=opus` → `audio/ogg`). */
export function baseMime(mime: string | null | undefined): string | null {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  return base || null;
}
