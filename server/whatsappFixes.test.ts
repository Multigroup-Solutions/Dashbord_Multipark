import { describe, expect, it } from "vitest";
import { detectOptIntent, normalizeOptText } from "../shared/whatsappOptOut";
import { maskPhone, maskPhonesInText } from "../shared/maskPhone";
import { laterTimestamp, nextStatus, previewFields } from "./whatsappStore";
import { cacheIsFresh, countsAsReply, last9Digits, parseWebhookPayload, planInbound, storedMessageType } from "./whatsappInbound";
import { conversationDisplayName, conversationVisibleTo } from "./whatsappInbox";
import { decideAutoReply, userSeesProject } from "./extrasAutomation";
import { duplicatePhoneIndexes, summarize, type BroadcastRecipient } from "./whatsappBroadcast";
import { isValidWebhookVerification } from "./whatsappWebhook";
import { MIGRATION_0094_STATEMENTS } from "./migrations/migration_0094";

// ─── Opt-out ────────────────────────────────────────────────────────────────

describe("detectOptIntent", () => {
  it("palavras-chave como mensagem inteira (maiúsculas, acentos, pontuação)", () => {
    for (const t of ["STOP", "stop", "Parar", "PARAR!", "pare.", "Remover", "remover-me", "Cancelar subscrição", "cancelar a subscrição", "Não quero receber", "unsubscribe"]) {
      expect(detectOptIntent(t), t).toBe("opt_out");
    }
  });

  it("frases claras dentro de uma mensagem", () => {
    expect(detectOptIntent("Olá, não quero receber mais mensagens, obrigado")).toBe("opt_out");
    expect(detectOptIntent("Por favor removam o meu número")).toBe("opt_out");
    expect(detectOptIntent("quero deixar de receber estas mensagens")).toBe("opt_out");
    expect(detectOptIntent("NAO ME ENVIEM MAIS nada")).toBe("opt_out");
    expect(detectOptIntent("Gostava de cancelar a minha subscrição")).toBe("opt_out");
  });

  it("falsos positivos comuns ficam de fora", () => {
    for (const t of [
      "não pare",
      "não pares de me avisar",
      "vou parar o carro no parque",
      "Sim, posso sexta",
      "não quero receber o pagamento em dinheiro",
      "stop and go na A1, chego atrasado",
      "remover o carro da garagem?",
      "",
      "   ",
    ]) {
      expect(detectOptIntent(t), t).toBeNull();
    }
  });

  it("INICIAR / START voltam a ligar", () => {
    expect(detectOptIntent("INICIAR")).toBe("opt_in");
    expect(detectOptIntent("start")).toBe("opt_in");
    expect(detectOptIntent("Iniciar.")).toBe("opt_in");
    expect(detectOptIntent("vamos iniciar o turno")).toBeNull();
  });

  it("normalizeOptText tira acentos e pontuação", () => {
    expect(normalizeOptText("  Não   QUERO, receber!! ")).toBe("nao quero receber");
  });
});

// ─── Escrita do webhook (planeamento puro) ──────────────────────────────────

describe("planInbound — ordem e dedup", () => {
  const base = { type: "text", body: "Sim, posso", hasMedia: false, optedOut: false };

  it("mensagem nova: conversa → INSERT da mensagem → atualizar conversa → automações", () => {
    const p = planInbound({ ...base, duplicate: false });
    expect(p.steps).toEqual(["ensure_conversation", "insert_message", "update_conversation", "employee_automations", "lead_replied"]);
    expect(p.steps.indexOf("insert_message")).toBeLessThan(p.steps.indexOf("update_conversation"));
    expect(p.bumpUnread).toBe(true);
    expect(p.openWindow).toBe(true);
  });

  it("duplicado (UNIQUE de waMessageId): nada depois do insert", () => {
    const p = planInbound({ ...base, duplicate: true });
    expect(p.steps).toEqual(["ensure_conversation", "insert_message"]);
    expect(p.bumpUnread).toBe(false);
    expect(p.openWindow).toBe(false);
  });

  it("reação / não suportado: guarda, mas não é resposta", () => {
    for (const type of ["reaction", "unsupported"]) {
      const p = planInbound({ ...base, type, body: "[reação 👍]", duplicate: false });
      expect(p.steps).toEqual(["ensure_conversation", "insert_message", "update_conversation"]);
      expect(p.bumpUnread).toBe(false);
      expect(p.openWindow).toBe(false);
    }
    expect(countsAsReply("reaction")).toBe(false);
    expect(countsAsReply("text")).toBe(true);
    expect(countsAsReply("image")).toBe(true);
  });

  it("STOP: opt-out, sem automações, lead não passa a Respondeu", () => {
    const p = planInbound({ ...base, body: "STOP", duplicate: false });
    expect(p.steps).toContain("opt_out");
    expect(p.steps).not.toContain("employee_automations");
    expect(p.steps).not.toContain("lead_replied");
    expect(p.steps).toContain("lead_stamp");
  });

  it("conversa já em opt-out: sem automações nem Respondeu", () => {
    const p = planInbound({ ...base, optedOut: true, duplicate: false });
    expect(p.steps).not.toContain("employee_automations");
    expect(p.steps).not.toContain("lead_replied");
  });

  it("INICIAR limpa o opt-out", () => {
    expect(planInbound({ ...base, body: "INICIAR", optedOut: true, duplicate: false }).steps).toContain("opt_in");
  });

  it("media: descarrega, não corre automações de texto, mas o lead responde", () => {
    const p = planInbound({ ...base, type: "image", body: "[imagem]", hasMedia: true, duplicate: false });
    expect(p.steps).toContain("download_media");
    expect(p.steps).not.toContain("employee_automations");
    expect(p.steps).toContain("lead_replied");
  });

  it("caption 'stop' numa imagem não é opt-out (só texto/botão)", () => {
    expect(planInbound({ ...base, type: "image", body: "stop", hasMedia: true, duplicate: false }).optIntent).toBeNull();
  });

  it("tipo gravado: media no enum novo, resto texto", () => {
    expect(storedMessageType("video")).toBe("video");
    expect(storedMessageType("document")).toBe("document");
    expect(storedMessageType(null)).toBe("text");
  });
});

describe("laterTimestamp (semântica do GREATEST null-safe)", () => {
  it("só anda para a frente; null nunca ganha", () => {
    expect(laterTimestamp("2026-09-24 10:00:00", "2026-09-24 09:00:00")).toBe("2026-09-24 10:00:00");
    expect(laterTimestamp("2026-09-24 10:00:00", "2026-09-24 11:00:00")).toBe("2026-09-24 11:00:00");
    expect(laterTimestamp(null, "2026-09-24 11:00:00")).toBe("2026-09-24 11:00:00");
    expect(laterTimestamp("2026-09-24 10:00:00", null)).toBe("2026-09-24 10:00:00");
    expect(laterTimestamp(null, null)).toBeNull();
  });
});

describe("nextStatus", () => {
  it("não regride; failed ganha e é final", () => {
    expect(nextStatus("read", "delivered")).toBeNull();
    expect(nextStatus("sent", "read")).toBe("read");
    expect(nextStatus("pending", "sent")).toBe("sent");
    expect(nextStatus("read", "failed")).toBe("failed");
    expect(nextStatus("failed", "read")).toBeNull();
  });
});

describe("previewFields", () => {
  it("corta a 120, colapsa espaços e usa o texto do template quando o body falta", () => {
    const long = "a".repeat(300);
    expect(previewFields({ body: long, type: "text", direction: "in" }).lastPreview).toHaveLength(120);
    expect(previewFields({ body: "olá\n\n  tudo", type: "text", direction: "out" })).toEqual({ lastPreview: "olá tudo", lastDirection: "out", lastType: "text" });
    expect(previewFields({ body: null, type: "template", templateName: "x", direction: "out" }).lastPreview).toContain("x");
    expect(previewFields({ body: "[imagem]", type: "image", mediaType: "image", direction: "in" }).lastType).toBe("image");
  });
});

describe("parseWebhookPayload — phone_number_id e perfil", () => {
  const payload = (pnid: string | null) => ({
    entry: [{
      changes: [{
        value: {
          ...(pnid ? { metadata: { phone_number_id: pnid } } : {}),
          contacts: [{ wa_id: "351911111111", profile: { name: "Ana Silva" } }],
          messages: [{ id: "wamid.1", from: "351911111111", type: "text", text: { body: "olá" } }],
          statuses: [{ id: "wamid.2", status: "failed" }],
        },
      }],
    }],
  });

  it("ignora eventos de outro número quando o esperado está definido", () => {
    const out = parseWebhookPayload(payload("999"), "123");
    expect(out.messages).toHaveLength(0);
    expect(out.statuses).toHaveLength(0);
    expect(out.ignored).toBe(2);
  });

  it("aceita o número certo (e sem metadata), guarda phone_number_id e o nome de perfil", () => {
    const ok = parseWebhookPayload(payload("123"), "123");
    expect(ok.messages[0]).toMatchObject({ phoneNumberId: "123", profileName: "Ana Silva" });
    expect(parseWebhookPayload(payload(null), "123").messages).toHaveLength(1);
    expect(parseWebhookPayload(payload("999")).messages).toHaveLength(1); // sem env → aceita
  });

  it("reação tem corpo legível", () => {
    const out = parseWebhookPayload({ entry: [{ changes: [{ value: { messages: [{ id: "r", from: "351911111111", type: "reaction", reaction: { emoji: "👍" } }] } }] }] });
    expect(out.messages[0].body).toBe("[reação 👍]");
  });
});

// ─── Respostas automáticas idempotentes ────────────────────────────────────

describe("decideAutoReply", () => {
  const week = { kind: "week", targetDate: null, weekStart: "2026-09-29" };
  const day = { kind: "day", targetDate: "2026-09-26", weekStart: null };
  const assignment = { kind: "assignment", targetDate: "2026-09-26", weekStart: null };

  it("link da semana só 1× por pedido", () => {
    expect(decideAutoReply({ pending: week, verdict: "yes", alreadyAnswered: false, dayAlreadyMarked: false })).toBe("week_link");
    expect(decideAutoReply({ pending: week, verdict: "yes", alreadyAnswered: true, dayAlreadyMarked: false })).toBe("none");
  });

  it("dia: não volta a marcar nem a responder", () => {
    expect(decideAutoReply({ pending: day, verdict: "yes", alreadyAnswered: false, dayAlreadyMarked: false })).toBe("day_marked");
    expect(decideAutoReply({ pending: day, verdict: "yes", alreadyAnswered: false, dayAlreadyMarked: true })).toBe("none");
    expect(decideAutoReply({ pending: day, verdict: "yes", alreadyAnswered: true, dayAlreadyMarked: false })).toBe("none");
    expect(decideAutoReply({ pending: day, verdict: "no", alreadyAnswered: false, dayAlreadyMarked: false })).toBe("none");
  });

  it("aviso de escala: sim/não, e nada depois de respondido", () => {
    expect(decideAutoReply({ pending: assignment, verdict: "yes", alreadyAnswered: false, dayAlreadyMarked: false })).toBe("confirmed");
    expect(decideAutoReply({ pending: assignment, verdict: "no", alreadyAnswered: false, dayAlreadyMarked: false })).toBe("declined");
    expect(decideAutoReply({ pending: assignment, verdict: "yes", alreadyAnswered: true, dayAlreadyMarked: false })).toBe("none");
  });

  it("sem pedido ou resposta ambígua → nada", () => {
    expect(decideAutoReply({ pending: null, verdict: "yes", alreadyAnswered: false, dayAlreadyMarked: false })).toBe("none");
    expect(decideAutoReply({ pending: week, verdict: "unclear", alreadyAnswered: false, dayAlreadyMarked: false })).toBe("none");
  });
});

// ─── Privacidade ────────────────────────────────────────────────────────────

describe("maskPhone", () => {
  it("mantém só os últimos 3 dígitos", () => {
    expect(maskPhone("+351912345678")).toBe("+*********678");
    expect(maskPhone("912 345 678")).toBe("******678");
    expect(maskPhone("")).toBe("");
    expect(maskPhone(null)).toBe("");
    expect(maskPhone("12")).toBe("***12");
  });
  it("mascara números dentro de texto livre", () => {
    const t = maskPhonesInText("O número +351912345678 não tem WhatsApp (código 131026)");
    expect(t).not.toContain("912345");
    expect(t).toContain("678");
    expect(t).toContain("131026"); // código de 6 dígitos não é telefone
  });
});

// ─── Cidade ─────────────────────────────────────────────────────────────────

describe("conversationVisibleTo", () => {
  const lisboa = [1, 11];
  const unknown = { employeeId: null, employeeProjectId: null, leadProjectIds: [], bookingProjectId: null };

  it("quem vê todas as cidades vê tudo", () => {
    expect(conversationVisibleTo(unknown, undefined)).toBe(true);
  });
  it("número solto sem reserva: só todas-as-cidades", () => {
    expect(conversationVisibleTo(unknown, lisboa)).toBe(false);
  });
  it("número solto com reserva da cidade → visível; de outra cidade → não", () => {
    expect(conversationVisibleTo({ ...unknown, bookingProjectId: 11 }, lisboa)).toBe(true);
    expect(conversationVisibleTo({ ...unknown, bookingProjectId: 2 }, lisboa)).toBe(false);
  });
  it("extra pela ficha; lead por qualquer lead da cidade ou sem cidade", () => {
    expect(conversationVisibleTo({ ...unknown, employeeId: 5, employeeProjectId: 2 }, lisboa)).toBe(false);
    expect(conversationVisibleTo({ ...unknown, employeeId: 5, employeeProjectId: 1 }, lisboa)).toBe(true);
    expect(conversationVisibleTo({ ...unknown, leadProjectIds: [2, null] }, lisboa)).toBe(true);
    expect(conversationVisibleTo({ ...unknown, leadProjectIds: [2] }, lisboa)).toBe(false);
  });
  it("notificações de cidade: âmbito do utilizador", () => {
    expect(userSeesProject({ all: true, projectIds: [] }, 3)).toBe(true);
    expect(userSeesProject({ all: false, projectIds: [1, 11] }, 11)).toBe(true);
    expect(userSeesProject({ all: false, projectIds: [1] }, 2)).toBe(false);
  });
  it("last9Digits para casar com o telefone da reserva", () => {
    expect(last9Digits("+351 912 345 678")).toBe("912345678");
    expect(last9Digits("912-345-678")).toBe("912345678");
    expect(last9Digits("1234")).toBeNull();
  });
});

describe("nome da conversa", () => {
  it("ficha → lead → perfil → número", () => {
    expect(conversationDisplayName({ employeeName: "Ana", leadName: "L", profileName: "P", phoneE164: "+1" })).toBe("Ana");
    expect(conversationDisplayName({ employeeName: null, leadName: "Lead Nome", profileName: "P", phoneE164: "+1" })).toBe("Lead Nome");
    expect(conversationDisplayName({ profileName: "Perfil", phoneE164: "+1" })).toBe("Perfil");
    expect(conversationDisplayName({ phoneE164: "+351911" })).toBe("+351911");
  });
});

// ─── Broadcast ──────────────────────────────────────────────────────────────

describe("dedup de números num envio", () => {
  it("o 2.º destinatário com o mesmo número aponta para o 1.º", () => {
    expect(duplicatePhoneIndexes([{ phoneE164: "+1" }, { phoneE164: "+2" }, { phoneE164: "+1" }, { phoneE164: null }, { phoneE164: null }])).toEqual([-1, -1, 0, -1, -1]);
  });
  it("summarize: duplicados não são falha; opt-out conta como não enviado", () => {
    const r = (status: BroadcastRecipient["status"]): BroadcastRecipient => ({ employeeId: 1, name: "x", phone: "1", phoneE164: "+1", status });
    expect(summarize([r("sent"), r("duplicate_phone"), r("opted_out"), r("failed"), r("invalid_phone")])).toEqual({
      sent: 1, failed: 1, invalidPhone: 1, optedOut: 1, notSent: 3,
    });
  });
});

describe("misc", () => {
  it("cache do mapa de telefones expira aos 5 min", () => {
    expect(cacheIsFresh(1000, 1000 + 60_000)).toBe(true);
    expect(cacheIsFresh(1000, 1000 + 5 * 60_000)).toBe(false);
    expect(cacheIsFresh(null, 1000)).toBe(false);
  });
  it("verify token: igualdade em tempo constante, tamanhos diferentes não atiram", () => {
    expect(isValidWebhookVerification("subscribe", "abc", "abc")).toBe(true);
    expect(isValidWebhookVerification("subscribe", "abcd", "abc")).toBe(false);
    expect(isValidWebhookVerification("subscribe", "abc", undefined)).toBe(false);
  });
  it("migração 0094: sem UPDATE com subquery sobre a própria tabela (1093)", () => {
    for (const st of MIGRATION_0094_STATEMENTS.filter((x) => x.startsWith("UPDATE"))) {
      const target = st.match(/^UPDATE `([a-z_]+)`/)![1];
      const rest = st.slice(st.indexOf("JOIN"));
      expect(rest.includes(`FROM \`${target}\``)).toBe(false);
    }
  });
});
