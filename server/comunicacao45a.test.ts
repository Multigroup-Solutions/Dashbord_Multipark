/**
 * Lote 45a — Caixas de email (Jorge, 7 out 2026): só email, cada um entra pela
 * sua caixa, caixas à esquerda como no Gmail, e o que se envia do "O meu email"
 * também fica ligado ao cliente.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAIL_TRIAGE_KEY, mailboxIsMine, pickInitialMailbox } from "../shared/mail";

const src = (p: string) => readFileSync(p, "utf8");

describe("por onde cada pessoa entra", () => {
  const boxes = [{ key: "reclamacoes" }, { key: "rh", mine: true }, { key: "info" }];
  it("link > escolhida > a primeira que é dela > a primeira; sem caixas, o próprio email", () => {
    expect(pickInitialMailbox({ fromUrl: "info", home: "rh", boxes })).toBe("info");
    expect(pickInitialMailbox({ home: "info", boxes })).toBe("info");
    expect(pickInitialMailbox({ home: "me", boxes })).toBe("me");
    expect(pickInitialMailbox({ boxes })).toBe("rh");
    expect(pickInitialMailbox({ boxes: [{ key: "reclamacoes" }, { key: "info" }] })).toBe("reclamacoes");
    expect(pickInitialMailbox({ boxes: [] })).toBe("me");
    // a escolhida que já não vê é ignorada
    expect(pickInitialMailbox({ home: "admin", boxes })).toBe("rh");
    expect(pickInitialMailbox({ home: MAIL_TRIAGE_KEY, boxes, triage: true })).toBe(MAIL_TRIAGE_KEY);
    expect(pickInitialMailbox({ home: MAIL_TRIAGE_KEY, boxes })).toBe("rh");
  });
  it("a caixa é dela quando um endereço ativo a tem (ou ao papel) como responsável", () => {
    expect(mailboxIsMine([{ owner: "user:7" }], { id: 7, role: "backoffice" })).toBe(true);
    expect(mailboxIsMine([{ owner: "role:backoffice" }], { id: 7, role: "backoffice" })).toBe(true);
    expect(mailboxIsMine([{ owner: "user:7", active: false }], { id: 7, role: "backoffice" })).toBe(false);
    expect(mailboxIsMine([{ owner: null }, { owner: "user:8" }], { id: 7, role: null })).toBe(false);
  });
});

describe("servidor", () => {
  it("a caixa inicial guarda-se na pessoa (migração 0525, só acrescenta) e só uma que ela vê", () => {
    expect(src("server/migrations/migration_0525.ts")).toMatch(/ADD COLUMN `mailHomeBox` VARCHAR\(64\) NULL/);
    expect(src("server/migrations/index.ts")).toMatch(/\["0525"/);
    const r = src("server/mail/router.ts");
    const block = r.split("setHomeBox: protectedProcedure")[1]?.slice(0, 900) ?? "";
    expect(block).toMatch(/Essa caixa não está no teu acesso\./);
    expect(block).toMatch(/UPDATE users SET mailHomeBox = \$\{input\.key\} WHERE id = \$\{v\.id\}/);
    expect(r).toMatch(/homeBox, slaHours/);
  });
  it("conversa nova do O meu email também fica ligada ao cliente", () => {
    const inbox = src("server/mail/inbox.ts");
    expect(inbox).toMatch(/else if \(!mailbox && personal && threadId && threadId !== threadRow\?\.id\)/);
    expect(inbox).toMatch(/await autoLinkNewThread\(\{ threadId, messageId: r\.messageId, contactEmail, subject, text, sentAt: p\.sentAt \}\)/);
    expect(inbox).toMatch(/const linkProjects = await autoLinkNewThread\(t\);/);
  });
});
