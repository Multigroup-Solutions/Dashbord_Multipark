import { describe, expect, it } from "vitest";
import { normalizeLeadInput } from "./extraLeads";
import { findWhatsAppTemplate, templateHasBodyParams, LEAD_RECRUITMENT_TEMPLATE_ID } from "../shared/whatsappTemplate";

describe("normalizeLeadInput", () => {
  it("aceita nome + telemóvel (email opcional) e normaliza o número", () => {
    const r = normalizeLeadInput({ fullName: "  Rui   Costa ", phone: "912 345 678" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lead.fullName).toBe("Rui Costa");
      expect(r.lead.phoneE164).toBe("+351912345678");
      expect(r.lead.email).toBeNull();
    }
  });

  it("aceita nome + email (telemóvel opcional) e baixa o email", () => {
    const r = normalizeLeadInput({ fullName: "Ana", email: " Ana@Exemplo.PT " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lead.email).toBe("ana@exemplo.pt");
      expect(r.lead.phone).toBeNull();
      expect(r.lead.phoneE164).toBeNull();
    }
  });

  it("recusa quando faltam os dois contactos", () => {
    const r = normalizeLeadInput({ fullName: "Sem Contacto" });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("telemóvel ou o email") });
  });

  it("recusa nome vazio ou de 1 carácter", () => {
    expect(normalizeLeadInput({ fullName: " ", phone: "912345678" }).ok).toBe(false);
    expect(normalizeLeadInput({ fullName: "A", phone: "912345678" }).ok).toBe(false);
  });

  it("um telemóvel escrito tem de ser válido — não fica um lead incontactável", () => {
    const r = normalizeLeadInput({ fullName: "Bruno", phone: "12", email: "b@x.pt" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/inválido/);
  });

  it("um email escrito tem de ser plausível", () => {
    expect(normalizeLeadInput({ fullName: "Carla", email: "carla@localhost" }).ok).toBe(false);
  });

  it("apara as notas a 512 caracteres e devolve null quando vazias", () => {
    const long = normalizeLeadInput({ fullName: "Dora", phone: "912345678", notes: "x".repeat(600) });
    if (long.ok) expect(long.lead.notes).toHaveLength(512);
    const empty = normalizeLeadInput({ fullName: "Dora", phone: "912345678", notes: "   " });
    if (empty.ok) expect(empty.lead.notes).toBeNull();
  });
});

describe("catálogo — templates sem parâmetros", () => {
  it("seja_motorista e morada_e_regras existem e não têm parâmetros de body", () => {
    for (const id of ["seja_motorista", "morada_regras"]) {
      const def = findWhatsAppTemplate(id);
      expect(def, id).toBeDefined();
      expect(def!.roles).toBeNull();
      expect(def!.sharedParam).toBeNull();
      expect(templateHasBodyParams(def!)).toBe(false);
    }
    expect(findWhatsAppTemplate("seja_motorista")!.name).toBe("seja_motorista");
    expect(findWhatsAppTemplate("morada_regras")!.name).toBe("morada_e_regras");
  });

  it("os templates antigos continuam com parâmetros", () => {
    expect(templateHasBodyParams(findWhatsAppTemplate("disponibilidade")!)).toBe(true);
    expect(templateHasBodyParams(findWhatsAppTemplate("aviso_trabalho")!)).toBe(true);
  });

  it("a página de leads usa o template de recrutamento", () => {
    expect(LEAD_RECRUITMENT_TEMPLATE_ID).toBe("seja_motorista");
  });
});
