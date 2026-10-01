// Helpers de data/hora do inbox WhatsApp (lista + conversa). Extraídos da
// WhatsAppInboxPage sem mudança de comportamento.

/** Timestamp da BD (UTC wall-clock 'YYYY-MM-DD HH:MM:SS') → Date local, ou null. */
export function parseDbTime(s: string | null): Date | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Timestamp da BD → hora local HH:MM (bolhas da thread). */
export function fmtTime(s: string | null): string {
  const d = parseDbTime(s);
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

/**
 * Timestamp da BD → HH:MM se for hoje, "Ontem", senão DD/MM (lista de
 * conversas). A lista está ordenada pela janela/última mensagem e mostrar só a
 * hora numa conversa de há uma semana fazia parecer que era de hoje.
 */
export function fmtListTime(s: string | null, now: number): string {
  const d = parseDbTime(s);
  if (!d) return "";
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Ontem";
  return d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
}

/** Countdown legível até windowExpiresAt (ISO), relativo a `now` (ms). */
export function windowCountdown(expiresAt: string | null, now: number): string {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "a fechar";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Janela a fechar em menos de 2h — a linha ganha destaque na lista. */
export function windowClosingSoon(expiresAt: string | null, now: number): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - now < 2 * 3_600_000;
}

// ─── Linha do tempo: mensagens + chamadas por ordem de hora ─────────────────

export type TimelineItem<M, C> = { kind: "message"; at: number; message: M } | { kind: "call"; at: number; call: C };

/** Junta mensagens e chamadas (ordem cronológica; empate: mensagem primeiro). */
export function timeline<M extends { id: number; waTimestamp: string | null; createdAt: string }, C extends { id: number; startedAt: string }>(
  messages: readonly M[],
  calls: readonly C[],
): TimelineItem<M, C>[] {
  const items: TimelineItem<M, C>[] = [
    ...messages.map((m) => ({ kind: "message" as const, at: parseDbTime(m.waTimestamp ?? m.createdAt)?.getTime() ?? 0, message: m })),
    ...calls.map((c) => ({ kind: "call" as const, at: parseDbTime(c.startedAt)?.getTime() ?? 0, call: c })),
  ];
  // Só chamadas dentro do período das mensagens carregadas (a thread mostra as últimas N).
  const firstMsg = messages.length ? Math.min(...items.filter((i) => i.kind === "message").map((i) => i.at)) : -Infinity;
  return items
    .filter((i) => i.kind === "message" || i.at >= firstMsg || messages.length < 100)
    .sort((a, b) => a.at - b.at || (a.kind === "message" ? -1 : 1));
}
