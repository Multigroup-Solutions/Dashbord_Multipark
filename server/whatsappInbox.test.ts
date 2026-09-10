import { describe, expect, it } from "vitest";
import { deriveWindowState, sortConversations } from "./whatsappInbox";

const NOW = new Date("2026-07-09T12:00:00Z");

/** Constrói uma timestamp UTC wall-clock ('YYYY-MM-DD HH:MM:SS') a N ms de NOW. */
function utcAgo(msAgo: number): string {
  return new Date(NOW.getTime() - msAgo).toISOString().slice(0, 19).replace("T", " ");
}

const HOUR = 60 * 60 * 1000;

describe("deriveWindowState", () => {
  it("lastInboundAt null → awaiting_first_reply (template enviado, sem resposta)", () => {
    const w = deriveWindowState(null, NOW);
    expect(w.windowState).toBe("awaiting_first_reply");
    expect(w.windowExpiresAt).toBeNull();
  });

  it("inbound há 1h → open, com windowExpiresAt", () => {
    const w = deriveWindowState(utcAgo(1 * HOUR), NOW);
    expect(w.windowState).toBe("open");
    expect(w.windowExpiresAt).not.toBeNull();
    // expira 23h a partir de agora (24h após o inbound).
    expect(new Date(w.windowExpiresAt!).getTime()).toBe(NOW.getTime() + 23 * HOUR);
  });

  it("inbound há 23h59m → ainda open", () => {
    const w = deriveWindowState(utcAgo(23 * HOUR + 59 * 60 * 1000), NOW);
    expect(w.windowState).toBe("open");
  });

  it("inbound há exatamente 24h → expired (fronteira fechada)", () => {
    const w = deriveWindowState(utcAgo(24 * HOUR), NOW);
    expect(w.windowState).toBe("expired");
    expect(w.windowExpiresAt).toBeNull();
  });

  it("inbound há 25h → expired", () => {
    expect(deriveWindowState(utcAgo(25 * HOUR), NOW).windowState).toBe("expired");
  });

  it("timestamp malformado → expired (não abre janela por engano)", () => {
    expect(deriveWindowState("not-a-date", NOW).windowState).toBe("expired");
  });
});

describe("gate de resposta (reply usa deriveWindowState)", () => {
  // O reply no servidor só permite texto livre quando windowState === 'open'.
  const canReplyFreeText = (lastInboundAt: string | null) =>
    deriveWindowState(lastInboundAt, NOW).windowState === "open";

  it("bloqueia texto livre quando awaiting_first_reply", () => {
    expect(canReplyFreeText(null)).toBe(false);
  });
  it("bloqueia texto livre quando expired", () => {
    expect(canReplyFreeText(utcAgo(30 * HOUR))).toBe(false);
  });
  it("permite texto livre quando open", () => {
    expect(canReplyFreeText(utcAgo(2 * HOUR))).toBe(true);
  });
});

describe("sortConversations (ordem da lista do inbox)", () => {
  type Row = Parameters<typeof sortConversations>[0][number] & { id: number };

  /** Conversa com janela aberta: respondeu há `inboundAgoMs`, última msg há `lastMsgAgoMs`. */
  const open = (id: number, inboundAgoMs: number, lastMsgAgoMs = inboundAgoMs): Row => ({
    id,
    ...deriveWindowState(utcAgo(inboundAgoMs), NOW),
    lastMessageAt: utcAgo(lastMsgAgoMs),
  });
  /** Conversa fora da janela (expired ou awaiting_first_reply). */
  const closed = (id: number, state: "expired" | "awaiting_first_reply", lastMsgAgoMs: number | null): Row => ({
    id,
    windowState: state,
    windowExpiresAt: null,
    lastMessageAt: lastMsgAgoMs == null ? null : utcAgo(lastMsgAgoMs),
  });
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  it("janela aberta primeiro, da que fecha MAIS CEDO para a que fecha mais tarde", () => {
    // Respondeu há 20h → fecha em 4h; há 1h → fecha em 23h; há 10h → fecha em 14h.
    const rows = [open(1, 1 * HOUR), open(2, 20 * HOUR), open(3, 10 * HOUR)];
    expect(ids(sortConversations(rows))).toEqual([2, 3, 1]);
  });

  it("fora da janela: última mensagem mais recente primeiro, mais antiga no fim", () => {
    const rows = [
      closed(1, "expired", 5 * 24 * HOUR),
      closed(2, "awaiting_first_reply", 2 * HOUR),
      closed(3, "expired", 30 * HOUR),
    ];
    expect(ids(sortConversations(rows))).toEqual([2, 3, 1]);
  });

  it("aberta vai SEMPRE acima de fechada, mesmo com mensagem mais antiga", () => {
    const rows = [
      closed(1, "awaiting_first_reply", 5 * 60 * 1000), // template enviado há 5 min
      open(2, 23 * HOUR), // respondeu há 23h — fecha em 1h
      closed(3, "expired", 26 * HOUR),
    ];
    expect(ids(sortConversations(rows))).toEqual([2, 1, 3]);
  });

  it("awaiting_first_reply e expired ficam no MESMO grupo, só pela última mensagem", () => {
    const rows = [
      closed(1, "expired", 1 * HOUR), // janela fechada mas o Jorge mandou template há 1h
      closed(2, "awaiting_first_reply", 3 * HOUR),
      closed(3, "expired", 2 * HOUR),
    ];
    expect(ids(sortConversations(rows))).toEqual([1, 3, 2]);
  });

  it("empate no grupo aberto → última mensagem mais recente primeiro; empate total → id desc", () => {
    const rows = [
      open(1, 2 * HOUR, 2 * HOUR),
      open(2, 2 * HOUR, 10 * 60 * 1000), // mesma expiração, mas falámos há 10 min
      open(3, 2 * HOUR, 2 * HOUR),
    ];
    expect(ids(sortConversations(rows))).toEqual([2, 3, 1]);
  });

  it("lastMessageAt nulo vai para o fim do grupo fechado", () => {
    const rows = [closed(1, "expired", null), closed(2, "expired", 40 * HOUR)];
    expect(ids(sortConversations(rows))).toEqual([2, 1]);
  });

  it("não muta o array de entrada", () => {
    const rows = [closed(1, "expired", 3 * HOUR), open(2, 1 * HOUR)];
    const copy = [...rows];
    sortConversations(rows);
    expect(rows).toEqual(copy);
  });
});
