/**
 * P3 lote 17f (parte 3) — Ligar / WhatsApp / Email a partir das fichas do
 * cliente, da reserva e do colaborador. Nada é enviado sozinho: o WhatsApp
 * abre (ou cria, sem mensagens) a conversa; o email abre "Nova mensagem" na
 * Comunicação já com o destinatário.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeEmailHref, contactEmails, contactPhones, whatsappConversationHref } from "../shared/contactActions";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Telefones e emails da ficha", () => {
  it("o mesmo número escrito de duas maneiras conta uma vez; sem indicativo seguro não serve para o WhatsApp", () => {
    const r = contactPhones(["+351 912 345 678", "912345678", "", null, "  ", "123"]);
    expect(r).toEqual([{ raw: "+351 912 345 678", e164: "+351912345678" }, { raw: "123", e164: null }]);
  });
  it("emails válidos, sem repetidos (maiúsculas não contam)", () => {
    expect(contactEmails(["Ana@Gmail.com", "ana@gmail.com", "sem-arroba", null, " rui@sapo.pt "])).toEqual(["Ana@Gmail.com", "rui@sapo.pt"]);
  });
  it("ligações: Nova mensagem com destinatário (e caixa sugerida); conversa com ou sem chamada", () => {
    expect(composeEmailHref("a+b@x.pt", "rh")).toBe("/comunicacao?novo=a%2Bb%40x.pt&caixa=rh");
    expect(composeEmailHref("a@x.pt")).toBe("/comunicacao?novo=a%40x.pt");
    expect(whatsappConversationHref(7)).toBe("/whatsapp?c=7");
    expect(whatsappConversationHref(7, true)).toBe("/whatsapp?c=7&ligar=1");
  });
});

describe("Servidor: abrir a conversa de um número", () => {
  const r = src("server/routers.ts");
  const i = r.indexOf("openByPhone: protectedProcedure");
  const route = r.slice(i, i + 2600);
  it("ver chega para abrir a que existe; criar precisa de editar o WhatsApp", () => {
    expect(i).toBeGreaterThan(0);
    expect(route).toContain('requireAccess(ctx.user, "whatsapp", "view");');
    expect(route).toContain("if (existing == null && !canEdit) {");
    expect(route).toContain("Ainda não há conversa de WhatsApp com este número.");
    // quem só vê não escreve nada (nem liga o colaborador nem muda a caixa)
    expect(route).toContain("const r = canEdit ? await openConversationForPhone(phoneE164, employeeId) : { conversationId: existing as number, created: false };");
  });
  it("número inválido é recusado; cidade/caixa que não vês é recusada; criar fica no registo", () => {
    expect(route).toContain("Número de telefone inválido para o WhatsApp.");
    expect(route).toContain("await conversationVisible(r.conversationId, ctx.user)");
    expect(route).toContain('action: "whatsapp_conversation_open"');
  });
  it("o colaborador só fica ligado se o número for o da ficha dele", () => {
    expect(route).toContain("const own = [emp?.phone, emp?.personalPhone].map((p) => (p ? normalizePhoneE164(String(p)) : null));");
    expect(route).toContain("if (own.includes(phoneE164)) employeeId = input.employeeId;");
  });
  it("criar a conversa não envia nada (como uma chamada que chega) e segue as regras de cidade e caixa", () => {
    const ops = src("server/whatsappInboxOps.ts");
    const a = ops.indexOf("export async function openConversationForPhone");
    const fn = ops.slice(a, ops.indexOf("export async function conversationIdForPhone"));
    expect(fn).not.toMatch(/send(Text|Template)|whatsappMessages/);
    expect(fn).toContain("await matchBookingCity(db as any, row.id, phoneE164);");
    expect(fn).toContain("await assignBoxByRule(row.id);");
    expect(fn).toContain("sql`${whatsappConversations.employeeId} IS NULL`");
  });
});

describe("Botões nas fichas", () => {
  const ca = src("client/src/components/ContactActions.tsx");
  it("cada botão só a quem pode; chamadas pelo WhatsApp só com o interruptor; sem Comunicação → programa de email", () => {
    expect(ca).toContain('const canWa = !!user && can(user as any, "whatsapp", "view");');
    expect(ca).toContain('const canMail = !!user && can(user as any, "comunicacao", "view");');
    expect(ca).toContain("const callsOn = canWaEdit && !!callsFlag.data?.enabled;");
    expect(ca).toContain("canMail ? composeEmailHref(e, mailbox) : `mailto:${e}`");
    expect(ca).toContain("href={`tel:${");
  });
  it("cliente (CRM), reserva (não anonimizada) e colaborador (ligado à ficha, caixa RH)", () => {
    expect(src("client/src/pages/CrmClientPage.tsx")).toContain("<ContactActions");
    const bf = src("client/src/pages/BookingFilePage.tsx");
    expect(bf).toContain("{!b.client.anonymized && (");
    // D41 (Jorge, 3 out 2026): o email ao cliente sai pela caixa info.
    expect(bf).toContain('<ContactActions className="col-span-2" phones={[b.client.phone]} emails={[b.client.email]} mailbox="info" />');
    expect(src("client/src/pages/HRPage.tsx")).toContain('<ContactActions phones={[emp.phone, emp.personalPhone]} emails={[emp.email, emp.personalEmail]} employeeId={emp.id} mailbox="rh" />');
  });
  it("Comunicação: ?novo= abre Nova mensagem com o destinatário, numa caixa onde a pessoa pode escrever", () => {
    const page = src("client/src/pages/ComunicacaoPage.tsx");
    expect(page).toContain('const to = params.get("novo");');
    expect(page).toContain("boxes.find((b) => b.key === want && b.canCompose) ?? boxes.find((b) => b.key === mailbox && b.canCompose) ?? boxes.find((b) => b.canCompose)");
    expect(page).toContain("Não tens nenhuma caixa de onde possas escrever um email.");
    expect(page).toContain("prefillTo={composeTo}");
    expect(src("client/src/components/mail/MailComposer.tsx")).toContain('mode === "new" ? prefillTo ?? "" : ""');
  });
  it("WhatsApp: ?ligar=1 abre a chamada quando a conversa carrega (desligadas → avisa)", () => {
    const wa = src("client/src/pages/WhatsAppInboxPage.tsx");
    expect(wa).toContain('new URLSearchParams(window.location.search).get("ligar") === "1"');
    expect(wa).toContain("As chamadas pelo WhatsApp estão desligadas — liga pelo telemóvel.");
  });
});
