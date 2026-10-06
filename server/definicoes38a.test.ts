/**
 * Lote 38a — Definições (Jorge, 6 out 2026: "não estou a entender o que tenho
 * que preencher aqui"; "isto também está estúpido, devia dar para pôr o nome
 * do RH, que já tem os contactos").
 *  - As opções ligado/desligado por cidade (escala com os tempos medidos,
 *    recolha pelo meio de uma entrega) apareciam como caixas de texto:
 *    escrever "true" ia como texto e o servidor recusava. Passam a
 *    interruptores por cidade, e as descrições deixam de pedir JSON.
 *  - Alertas sem PDA/Zello: escolhem-se pessoas do RH ("ficha:<id>"); o
 *    telefone vem da ficha na hora de enviar. Números soltos continuam.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESENCE_FICHA_PREFIX, SETTINGS, presenceFichaId, validateSetting } from "../shared/appSettings";
import { normalizePhoneE164 } from "../shared/phone";
import { resolvePresenceRecipients } from "./opsPresence";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const BOOL_CITY_KEYS = ["extras.useMeasuredTimes", "extras.pairPickups"] as const;

describe("38a — ligado/desligado por cidade", () => {
  it("o ecrã desenha um interruptor por cidade e grava booleanos (não texto)", () => {
    const page = src("client/src/pages/DefinicoesPage.tsx");
    expect(page).toContain('const cityMapBool = isCityMap && typeof (item.defaultValue as Record<string, unknown>).lisbon === "boolean";');
    expect(page).toContain("if (cityMapBool) return Object.fromEntries(CITY_FIELDS.map((c) => [c.id, cityBools[c.id] === true]));");
    expect(page).toMatch(/cityMapBool \? \([\s\S]{0,400}<Switch checked=\{cityBools\[c\.id\] === true\}/);
    // o ramo dos interruptores vem antes do das caixas de texto por cidade
    expect(page.indexOf("if (cityMapBool) return")).toBeLessThan(page.indexOf("if (isCityMap) return"));
    expect(page.indexOf(") : cityMapBool ? (")).toBeLessThan(page.indexOf(") : isCityMap ? ("));
  });

  it("o que o ecrã grava passa a validação; o texto \"true\" de antes não passava", () => {
    for (const k of BOOL_CITY_KEYS) {
      expect(validateSetting(k, { lisbon: true, porto: false, faro: false }).ok).toBe(true);
      expect(validateSetting(k, { lisbon: "true", porto: "false", faro: "false" }).ok).toBe(false);
    }
  });

  it("as descrições explicam em português e já não pedem JSON nem true/false", () => {
    for (const k of BOOL_CITY_KEYS) {
      const d = SETTINGS[k].description;
      expect(d).not.toMatch(/JSON|true|false/);
      expect(d).toMatch(/Ligado:[\s\S]*Desligado:[\s\S]*Liga cidade a cidade\./);
    }
    // a regra certa: os tempos medidos nunca pedem mais gente do que a tabela
    expect(SETTINGS["extras.useMeasuredTimes"].description).toContain("nunca pede mais do que a tabela pediria");
  });
});

describe("38a — alertas sem PDA/Zello por pessoa do RH", () => {
  it("a definição aceita pessoas do RH (ficha:<id>) ao lado dos números de sempre", () => {
    expect(PRESENCE_FICHA_PREFIX).toBe("ficha:");
    expect(presenceFichaId("ficha:12")).toBe(12);
    expect(presenceFichaId("+351912345678")).toBeNull();
    expect(presenceFichaId("ficha:0")).toBeNull();
    const ok = { lisbon: ["ficha:12", "+351912345678"], porto: [], faro: ["ficha:7"], copy: ["ficha:3"] };
    expect(validateSetting("ops.presencePhones", ok).ok).toBe(true);
    for (const bad of ["ficha:abc", "ficha:", "ficha:-1", "abc"]) {
      expect(validateSetting("ops.presencePhones", { lisbon: [bad], porto: [], faro: [], copy: [] }).ok).toBe(false);
    }
    expect(SETTINGS["ops.presencePhones"].description).toMatch(/pessoas do RH[\s\S]*telefone vem da ficha[\s\S]*Outros números/);
  });

  it("no envio: telefone da ficha; sem telefone, inativa ou \"Não enviar\" não recebe e fica dito; sem repetidos", () => {
    const fichas = new Map<number, string | null>([[12, "912 345 678"], [7, null], [3, "+351912345678"]]);
    const r = resolvePresenceRecipients(["ficha:12", "+351934567890", "ficha:7", "ficha:3", "ficha:99", "+351 934 567 890"], fichas, normalizePhoneE164);
    expect(r.phones).toEqual(["+351912345678", "+351934567890"]);
    expect(r.missing.sort()).toEqual([7, 99]);
    const s = src("server/opsPresence.ts");
    expect(s).toContain("SELECT id, isActive, noAutoWhatsapp, COALESCE(NULLIF(phone, ''), NULLIF(personalPhone, '')) AS phone");
    expect(s).toContain("Number(r.isActive) === 1 && Number(r.noAutoWhatsapp) !== 1 && r.phone ? String(r.phone) : null");
    expect(s).toContain("resolvePresenceRecipients([...(city ? phones[city] ?? [] : []), ...(phones.copy ?? [])], fichaPhones, normalizePhoneE164)");
    expect(s).toContain('pessoa(s) do RH sem envio (sem telefone na ficha, inativa ou "Não enviar")');
    expect(s).toMatch(/FROM employees WHERE id IN \(\$\{sql\.join\(fichaIds[\s\S]{0,80}\.catch\(\(\) => \[\[\]\]\)/); // a leitura das fichas falhada não trava os números soltos
  });

  it("o ecrã escolhe pessoas do RH por cidade e só mostra o fim do número", () => {
    const r = src("server/settingsRouter.ts");
    expect(r).toMatch(/presencePeople: adminOnly\.query/);
    expect(r).toContain("phoneTail: digits.length >= 3 ? digits.slice(-3) : null");
    expect(r).not.toMatch(/presencePeople[\s\S]{0,1200}phone: (String\(r\.phone|r\.phone)/);
    const page = src("client/src/pages/DefinicoesPage.tsx");
    expect(page).toContain("trpc.settings.values.presencePeople.useQuery(undefined, { enabled: isPhones, staleTime: 60_000 })");
    expect(page).toContain("...(fichaSel[c.id] ?? []).map((id) => `${PRESENCE_FICHA_PREFIX}${id}`),");
    expect(page).toContain('placeholder={people.isLoading ? "A carregar o RH…" : "+ Juntar pessoa do RH"}');
    expect(page).toContain('placeholder="Outros números, fora do RH (um por linha)"');
  });
});
