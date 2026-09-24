import { describe, expect, it } from "vitest";
import {
  conversationAlerts,
  fillQuickReply,
  formatWaiting,
  matchesInboxFilters,
  nextAwaitingSince,
  nextStatusOnInbound,
  parseDbUtcMs,
  parseSlaMinutes,
} from "../shared/whatsappConversation";
import { buildAiTranscript, describeAlertGroup, groupAlertsByCity } from "./whatsappInboxOps";
import { MIGRATION_0097_STATEMENTS, IDEMPOTENT_ERROR_CODES_0097 } from "./migrations/migration_0097";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString().slice(0, 19).replace("T", " ");
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();

describe("estado da conversa — transições", () => {
  it("resposta verdadeira reabre resolvida e pendente", () => {
    expect(nextStatusOnInbound("resolvido", true)).toBe("aberto");
    expect(nextStatusOnInbound("pendente", true)).toBe("aberto");
    expect(nextStatusOnInbound("aberto", true)).toBe("aberto");
  });
  it("reação / tipo não suportado não mexe no estado", () => {
    expect(nextStatusOnInbound("resolvido", false)).toBe("resolvido");
    expect(nextStatusOnInbound("pendente", false)).toBe("pendente");
  });
  it("estado desconhecido/nulo conta como aberto", () => {
    expect(nextStatusOnInbound(null, false)).toBe("aberto");
    expect(nextStatusOnInbound("xpto", true)).toBe("aberto");
  });
  it("awaitingSince guarda a 1.ª mensagem por responder", () => {
    expect(nextAwaitingSince(null, "2026-09-24 10:00:00", true)).toBe("2026-09-24 10:00:00");
    expect(nextAwaitingSince("2026-09-24 09:00:00", "2026-09-24 10:00:00", true)).toBe("2026-09-24 09:00:00");
    expect(nextAwaitingSince(null, "2026-09-24 10:00:00", false)).toBeNull();
  });
});

describe("SLA", () => {
  it("parseSlaMinutes: default 15, limites e lixo", () => {
    expect(parseSlaMinutes(undefined)).toBe(15);
    expect(parseSlaMinutes("")).toBe(15);
    expect(parseSlaMinutes("abc")).toBe(15);
    expect(parseSlaMinutes("0")).toBe(15);
    expect(parseSlaMinutes("-5")).toBe(15);
    expect(parseSlaMinutes(" 30 ")).toBe(30);
    expect(parseSlaMinutes("99999")).toBe(1440);
  });
  it("parseDbUtcMs interpreta a hora da BD como UTC", () => {
    expect(parseDbUtcMs("2026-09-24 12:00:00")).toBe(NOW);
    expect(parseDbUtcMs("2026-09-24T12:00:00.000Z")).toBe(NOW);
    expect(parseDbUtcMs(null)).toBeNull();
    expect(parseDbUtcMs("lixo")).toBeNull();
  });
  it("formatWaiting", () => {
    expect(formatWaiting(5)).toBe("5 min");
    expect(formatWaiting(125)).toBe("2h 05m");
    expect(formatWaiting(3 * 1440)).toBe("3 d");
  });
});

describe("conversationAlerts", () => {
  const base = { status: "aberto", awaitingSince: null, unreadCount: 0, windowState: "open" as const, windowExpiresAt: inMinutes(600) };

  it("sem mensagem por responder → sem alertas", () => {
    const a = conversationAlerts(base, NOW, 15);
    expect(a).toMatchObject({ unanswered: false, overdue: false, windowClosing: false, needsAttention: false });
  });
  it("por responder abaixo do SLA: unanswered mas não atrasada", () => {
    const a = conversationAlerts({ ...base, awaitingSince: minutesAgo(10) }, NOW, 15);
    expect(a).toMatchObject({ unanswered: true, overdue: false, waitingMinutes: 10, needsAttention: true });
  });
  it("por responder no/acima do SLA → atrasada", () => {
    expect(conversationAlerts({ ...base, awaitingSince: minutesAgo(15) }, NOW, 15).overdue).toBe(true);
    expect(conversationAlerts({ ...base, awaitingSince: minutesAgo(40) }, NOW, 30).overdue).toBe(true);
  });
  it("pendente/resolvida e opt-out não contam para o SLA", () => {
    expect(conversationAlerts({ ...base, status: "pendente", awaitingSince: minutesAgo(60) }, NOW).overdue).toBe(false);
    expect(conversationAlerts({ ...base, status: "resolvido", awaitingSince: minutesAgo(60) }, NOW).overdue).toBe(false);
    expect(conversationAlerts({ ...base, optedOut: true, awaitingSince: minutesAgo(60) }, NOW).overdue).toBe(false);
  });
  it("janela a fechar: < 2h por usar e conversa não resolvida", () => {
    expect(conversationAlerts({ ...base, windowExpiresAt: inMinutes(119) }, NOW).windowClosing).toBe(true);
    expect(conversationAlerts({ ...base, windowExpiresAt: inMinutes(121) }, NOW).windowClosing).toBe(false);
    expect(conversationAlerts({ ...base, status: "resolvido", windowExpiresAt: inMinutes(30) }, NOW).windowClosing).toBe(false);
    expect(conversationAlerts({ ...base, windowState: "expired", windowExpiresAt: null }, NOW).windowClosing).toBe(false);
    expect(conversationAlerts({ ...base, windowExpiresAt: inMinutes(30) }, NOW).windowMinutesLeft).toBe(30);
  });
  it("por ler conta para o badge, exceto resolvida", () => {
    expect(conversationAlerts({ ...base, unreadCount: 2 }, NOW).needsAttention).toBe(true);
    expect(conversationAlerts({ ...base, status: "pendente", unreadCount: 2 }, NOW).needsAttention).toBe(true);
    expect(conversationAlerts({ ...base, status: "resolvido", unreadCount: 2 }, NOW).needsAttention).toBe(false);
  });
});

describe("filtros do inbox", () => {
  const f = (assignee: any, status: any, userId: number | null = 7) => ({ assignee, status, userId });
  it("Minhas / Sem atribuição / Todas", () => {
    expect(matchesInboxFilters({ status: "aberto", assignedUserId: 7 }, f("mine", "all"))).toBe(true);
    expect(matchesInboxFilters({ status: "aberto", assignedUserId: 8 }, f("mine", "all"))).toBe(false);
    expect(matchesInboxFilters({ status: "aberto", assignedUserId: null }, f("mine", "all", null))).toBe(false);
    expect(matchesInboxFilters({ status: "aberto", assignedUserId: null }, f("unassigned", "all"))).toBe(true);
    expect(matchesInboxFilters({ status: "aberto", assignedUserId: 3 }, f("unassigned", "all"))).toBe(false);
    expect(matchesInboxFilters({ status: "aberto", assignedUserId: 3 }, f("all", "all"))).toBe(true);
  });
  it("estado: ativas esconde resolvidas", () => {
    expect(matchesInboxFilters({ status: "resolvido", assignedUserId: null }, f("all", "active"))).toBe(false);
    expect(matchesInboxFilters({ status: "pendente", assignedUserId: null }, f("all", "active"))).toBe(true);
    expect(matchesInboxFilters({ status: "pendente", assignedUserId: null }, f("all", "aberto"))).toBe(false);
    expect(matchesInboxFilters({ status: "resolvido", assignedUserId: null }, f("all", "resolvido"))).toBe(true);
  });
});

describe("respostas rápidas", () => {
  it("{{nome}} com e sem nome", () => {
    expect(fillQuickReply("Olá {{nome}}, tudo bem?", "Ana")).toBe("Olá Ana, tudo bem?");
    expect(fillQuickReply("Olá {{ Nome }}, tudo bem?", null)).toBe("Olá, tudo bem?");
    expect(fillQuickReply("Obrigado {{nome}}!", "")).toBe("Obrigado!");
  });
});

describe("avisos por cidade", () => {
  it("agrupa por cidade e descreve", () => {
    const groups = groupAlertsByCity(
      [{ id: 1, projectId: 10, name: "Ana Silva" }, { id: 2, projectId: null, name: "+351912345678" }],
      [{ id: 3, projectId: 10, name: "Rui Costa" }],
    );
    expect(groups).toHaveLength(2);
    const lisboa = groups.find((g) => g.projectId === 10)!;
    expect(lisboa.overdue.map((r) => r.id)).toEqual([1]);
    expect(lisboa.closing.map((r) => r.id)).toEqual([3]);
    const d = describeAlertGroup(lisboa, 15);
    expect(d.title).toBe("WhatsApp: 1 sem resposta há +15 min · 1 com a janela de 24h a fechar");
    expect(d.body).toBe("Ana, Rui.");
  });
});

describe("IA — transcrição", () => {
  it("sem telefone, papéis claros e mantém as mais recentes", () => {
    const t = buildAiTranscript(
      [
        { direction: "in", body: "Olá, o meu carro já está pronto?" },
        { direction: "out", body: "Bom dia! Vamos verificar." },
      ],
      "Ana",
    );
    expect(t).toBe("Ana: Olá, o meu carro já está pronto?\nMultipark: Bom dia! Vamos verificar.");
    const long = buildAiTranscript(
      Array.from({ length: 50 }, (_, i) => ({ direction: "in" as const, body: `mensagem ${i}` })),
      "Rui",
      60,
    );
    expect(long.endsWith("Rui: mensagem 49")).toBe(true);
    expect(long.includes("mensagem 0\n")).toBe(false);
  });
});

describe("migração 0097", () => {
  it("backfills guardados por statusChangedAt e o carimbo é o último", () => {
    const updates = MIGRATION_0097_STATEMENTS.filter((s) => s.startsWith("UPDATE"));
    expect(updates.length).toBe(3);
    for (const u of updates) expect(u).toContain("`statusChangedAt` IS NULL");
    expect(MIGRATION_0097_STATEMENTS[MIGRATION_0097_STATEMENTS.length - 1]).toContain("SET `statusChangedAt` =");
    // Sem subquery sobre a própria tabela (erro 1093).
    for (const u of updates) expect(u).not.toMatch(/SELECT[\s\S]*whatsapp_conversations/);
  });
  it("erros idempotentes", () => {
    for (const c of ["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR"]) expect(IDEMPOTENT_ERROR_CODES_0097.has(c)).toBe(true);
  });
});
