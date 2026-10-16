/**
 * Lê um texto em voz alta (pt-PT) com a voz do navegador — sem custo. Usado
 * pelo tutor da formação e, na página Formação com o Multis como tutor (D7),
 * pelas respostas do Multis.
 */
import { toast } from "sonner";

/** Tira marcas de Markdown e as "Fontes:" do fim (não se leem em voz alta). PURA. */
export function speakableText(text: string): string {
  return String(text ?? "")
    .replace(/\n+Fontes:\n[\s\S]*$/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[K\d+\]/g, "")
    .replace(/[«»*#_`]/g, "")
    .trim();
}

export function speak(text: string): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) { toast.error("O teu navegador não lê texto em voz alta."); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(speakableText(text));
    u.lang = "pt-PT";
    const v = synth.getVoices().find((x) => x.lang?.toLowerCase().startsWith("pt-pt")) ?? synth.getVoices().find((x) => x.lang?.toLowerCase().startsWith("pt"));
    if (v) u.voice = v;
    synth.speak(u);
  } catch {
    toast.error("Não foi possível ler em voz alta.");
  }
}
