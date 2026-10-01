import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { avatarToneIndex, contactInitials } from "@shared/whatsappInboxView";

/**
 * Paleta do avatar sem foto (fundo + texto, claro e escuro). A ordem é estável:
 * o índice (`avatarToneIndex`) é a "cor" da pessoa — acrescentar tons no FIM.
 */
const AVATAR_TONES = [
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200",
  "bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-900/60 dark:text-teal-200",
  "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/60 dark:text-indigo-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-900/60 dark:text-orange-200",
] as const;

/**
 * Avatar de um contacto do WhatsApp (estilo WhatsApp): a foto da ficha do
 * colaborador quando existe, senão as iniciais numa cor fixa por nome. A foto
 * que falha a carregar (URL antiga, storage em baixo) cai nas iniciais — o
 * Radix só mostra a imagem depois de carregada.
 */
export function ContactAvatar({
  name,
  photoUrl,
  className,
}: {
  name: string;
  photoUrl?: string | null;
  /** Tamanho e tipo de letra (ex.: "h-10 w-10 text-sm"). */
  className?: string;
}) {
  const tone = AVATAR_TONES[avatarToneIndex(name, AVATAR_TONES.length)];
  return (
    <Avatar className={cn("h-10 w-10 text-sm", className)}>
      {photoUrl && <AvatarImage src={photoUrl} alt="" className="object-cover" referrerPolicy="no-referrer" />}
      <AvatarFallback className={cn("font-semibold select-none", tone)} delayMs={photoUrl ? 300 : 0}>
        {contactInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
