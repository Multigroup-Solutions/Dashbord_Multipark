import { describe, expect, it } from "vitest";
import { deriveWindowState } from "./whatsappInbox";

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
