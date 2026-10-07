/**
 * P3 lote 17f (parte 2) — Comunicação única: a lista da caixa junta emails e
 * conversas de WhatsApp, a conversa de WhatsApp abre dentro da Comunicação,
 * o WhatsApp passa para o menu Comunicação e cada conversa diz quem é
 * (ficha do RH, candidato a extra ou cliente do CRM, com o histórico).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeIdentity } from "../shared/commsBoxes";
import { conversationDisplayName, crmNamesByPhone } from "./whatsappInbox";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Quem é: uma linha a partir do RH e do CRM", () => {
  it("colaborador → cargo e cidade", () => {
    expect(describeIdentity({ employee: { fullName: "Ana Sousa", position: "driver", city: "Lisboa" } }))
      .toEqual({ kind: "employee", name: "Ana Sousa", detail: "Colaborador · Condutor · Lisboa" });
    expect(describeIdentity({ employee: { fullName: "Rui", position: null, city: null } }).detail).toBe("Colaborador");
  });
  it("candidato a extra → estado em português", () => {
    expect(describeIdentity({ lead: { fullName: "Zé", status: "replied", city: "Porto" } }).detail).toBe("Candidato a extra · respondeu · Porto");
  });
  it("cliente do CRM → reservas, por vir e última visita (dd/mm/aaaa)", () => {
    const r = describeIdentity({ client: { id: 7, name: "Maria", email: "m@x.pt", bookings: 3, upcoming: 1, lastVisit: "2026-09-12 10:00:00" } });
    expect(r).toEqual({ kind: "client", name: "Maria", detail: "Cliente · 3 reservas (1 por vir) · última 12/09/2026", clientId: 7, email: "m@x.pt" });
    expect(describeIdentity({ client: { id: 8, name: null, email: null, bookings: 1, upcoming: 0, lastVisit: null } }).detail).toBe("Cliente · 1 reserva");
  });
  it("a ficha ganha ao candidato e ao cliente; sem nada diz-o", () => {
    const all = {
      employee: { fullName: "Ana", position: "extra", city: null },
      lead: { fullName: "Ana L", status: "new", city: null },
      client: { id: 1, name: "Ana C", email: null, bookings: 2, upcoming: 0, lastVisit: null },
    };
    expect(describeIdentity(all).kind).toBe("employee");
    expect(describeIdentity({ lead: all.lead, client: all.client }).kind).toBe("lead");
    expect(describeIdentity({})).toEqual({ kind: "unknown", name: null, detail: "Número sem ficha, candidatura nem cliente no CRM" });
  });
  it("nome da conversa: ficha → lead → CRM → perfil → número", () => {
    const p = "+351912345678";
    expect(conversationDisplayName({ crmName: "Maria CRM", profileName: "Mary", phoneE164: p })).toBe("Maria CRM");
    expect(conversationDisplayName({ leadName: "Zé", crmName: "Maria CRM", phoneE164: p })).toBe("Zé");
    expect(conversationDisplayName({ crmName: "  ", profileName: "Mary", phoneE164: p })).toBe("Mary");
    expect(conversationDisplayName({ phoneE164: p })).toBe(p);
  });
  it("nomes do CRM: uma consulta, o mais recente por número; sem números não pergunta; falha = sem nome", async () => {
    let calls = 0;
    const db = { execute: async () => { calls++; return [[{ phone: "+351911", name: "Maria" }, { phone: "+351911", name: "Antiga" }, { phone: "+351922", name: "Rui" }]]; } };
    const m = await crmNamesByPhone(db, ["+351911", "+351922", "+351911", ""]);
    expect(calls).toBe(1);
    expect(m.get("+351911")).toBe("Maria");
    expect(m.get("+351922")).toBe("Rui");
    expect((await crmNamesByPhone(db, [])).size).toBe(0);
    expect(calls).toBe(1);
    const broken = { execute: async () => { throw new Error("BD em baixo"); } };
    expect((await crmNamesByPhone(broken, ["+351911"])).size).toBe(0);
  });
  it("o servidor procura pelo número em E.164 e só mostra a quem vê a conversa", () => {
    const inbox = src("server/whatsappInbox.ts");
    // uma consulta com os números como parâmetros (o índice do telefone serve), nunca COLLATE por linha
    expect(inbox).toContain("WHERE cp.phone IN (${sql.join(uniq.map((p) => sql`${p}`), sql`, `)})");
    expect(inbox).not.toMatch(/cp\.phone = \$\{whatsappConversations\.phoneE164\} COLLATE/);
    expect(inbox).toContain("name: conversationDisplayName({ ...c, crmName: crmNames.get(c.phoneE164) ?? null }),");
    expect(inbox).toContain("const name = conversationDisplayName({ ...conv, crmName });");
    const r = src("server/routers.ts");
    const i = r.indexOf("identity: protectedProcedure");
    expect(i).toBeGreaterThan(0);
    const body = r.slice(i, i + 600);
    expect(body).toContain('requireAccess(ctx.user, "whatsapp", "view");');
    expect(body).toContain("await conversationVisible(input.conversationId, ctx.user)");
  });
});

describe("Caixas de email (lote 45, Jorge 7 out 2026: \"é só de email\")", () => {
  const page = src("client/src/pages/ComunicacaoPage.tsx");
  it("já não mistura o WhatsApp: a lista é só de email e o WhatsApp tem a página dele", () => {
    expect(page).not.toMatch(/whatsapp\.conversations\.list/);
    expect(page).not.toMatch(/WhatsAppInboxPage/);
    expect(page).not.toMatch(/canWa/);
    // a página do WhatsApp continua a poder ser embutida noutros sítios
    expect(src("client/src/pages/WhatsAppInboxPage.tsx")).toContain("const embedded = embeddedConversationId !== undefined;");
  });
  it("as caixas à esquerda, umas por baixo das outras, com o O meu email na mesma lista", () => {
    expect(page).toContain('aria-label="Caixas de email"');
    expect(page).toContain('boxButton(ME, "O meu email"');
    expect(page).toMatch(/boxes\.map\(\(b\) => boxButton\(b\.key, b\.label, b\.unread/);
    expect(page).toContain('<div className="w-52 xl:w-60 shrink-0 min-h-0">{boxesColumn}</div>');
  });
  it("cada um entra pela sua caixa: link → escolhida (★) → a primeira que é dele → a primeira", () => {
    expect(page).toContain("pickInitialMailbox({ home: overview.data.homeBox ?? null, boxes, triage: !!triage })");
    expect(page).toContain("trpc.mail.setHomeBox.useMutation");
    expect(src("server/mail/router.ts")).toContain("setHomeBox: protectedProcedure");
    expect(src("server/mail/inbox.ts")).toContain("mine: mailboxIsMine(m.addresses, viewer),");
  });
});

describe("Menu", () => {
  it("no PC o menu recolhe nas caixas e volta como estava ao sair", () => {
    const page = src("client/src/pages/ComunicacaoPage.tsx");
    expect(page).toContain("if (sidebar.open) sidebar.setOpen(false);");
    expect(page).toContain("return () => { if (sidebarWasOpen.current) sidebar.setOpen(true); };");
  });
  it("o WhatsApp está na Comunicação; as caixas são só de email", () => {
    const layout = src("client/src/components/DashboardLayout.tsx");
    const comms = layout.indexOf('label: "Comunicação"');
    const waItem = layout.indexOf('label: "WhatsApp", path: "/whatsapp"');
    expect(comms).toBeGreaterThan(0);
    expect(waItem).toBeGreaterThan(comms);
    expect(waItem).toBeLessThan(layout.indexOf('label: "Sistema"'));
    expect(layout).toContain('label: "Caixas de email", path: "/comunicacao"');
    // Ordem do lote 45: Caixas de email → O meu email → WhatsApp.
    const boxes = layout.indexOf('label: "Caixas de email", path: "/comunicacao"');
    const mine = layout.indexOf('label: "O meu email", path: "/comunicacao/meu-email"');
    expect(boxes).toBeLessThan(mine);
    expect(mine).toBeLessThan(waItem);
    expect(src("docs/ajuda/whatsapp.md")).toContain("Menu **Comunicação → WhatsApp**");
  });
});
