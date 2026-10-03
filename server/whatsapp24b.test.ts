/**
 * P3 lote 24b — WhatsApp (decisões do Jorge, 3 out 2026):
 *  - D28: o TL continua nos responsáveis; juntam-se GRUPOS DE CIDADE (Lisboa,
 *    Porto, Faro). Atribuída a um grupo, os avisos de atraso vão à equipa dessa
 *    cidade e quem responder primeiro fica com ela;
 *  - D29: respostas rápidas por cidade (cada cidade as suas + nacionais; cada
 *    um só edita as da sua cidade; as nacionais só quem vê todas).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cityGroupLabel, decodeAssignee, encodeAssignee, isCityKey, matchesInboxFilters, quickReplyEditable, quickReplyVisible,
} from "../shared/whatsappConversation";
import { groupAlertsByCity, ASSIGNABLE_ROLES } from "./whatsappInboxOps";
import { SCHEMA_MIGRATION_IDS } from "./migrations/index";
import { MIGRATION_0440_STATEMENTS } from "./migrations/migration_0440";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("D28 — grupos de cidade nos responsáveis", () => {
  it("o team leader continua a poder ser responsável", () => {
    expect(ASSIGNABLE_ROLES).toContain("team_leader");
  });

  it("valor do seletor: pessoa, grupo ou ninguém (ida e volta)", () => {
    expect(encodeAssignee(12, null)).toBe("u:12");
    expect(encodeAssignee(null, "porto")).toBe("c:porto");
    expect(encodeAssignee(null, null)).toBe("none");
    expect(encodeAssignee(12, "porto")).toBe("u:12"); // pessoa ganha
    expect(decodeAssignee("u:12")).toEqual({ userId: 12, cityKey: null });
    expect(decodeAssignee("c:faro")).toEqual({ userId: null, cityKey: "faro" });
    expect(decodeAssignee("none")).toEqual({ userId: null, cityKey: null });
    expect(decodeAssignee("c:madrid")).toBeNull();
    expect(cityGroupLabel("lisboa")).toBe("Grupo Lisboa");
    expect(cityGroupLabel("x")).toBeNull();
    expect(isCityKey("porto")).toBe(true);
  });

  it("'Sem responsável' não mostra as que estão num grupo", () => {
    const f = { assignee: "unassigned" as const, status: "all" as const, userId: 1 };
    expect(matchesInboxFilters({ status: "aberto", assignedUserId: null, assignedCityKey: "porto" }, f)).toBe(false);
    expect(matchesInboxFilters({ status: "aberto", assignedUserId: null, assignedCityKey: null }, f)).toBe(true);
  });

  it("avisos de atraso: atribuída a um grupo → grupo dessa cidade (não a da conversa)", () => {
    const groups = groupAlertsByCity(
      [{ id: 1, projectId: 10, name: "Ana" }, { id: 2, projectId: 10, name: "Rui", assignedCityKey: "porto" }],
      [{ id: 3, projectId: null, name: "Zé", assignedCityKey: "porto" }],
    );
    expect(groups).toHaveLength(2);
    const porto = groups.find((g) => g.cityKey === "porto")!;
    expect(porto).toMatchObject({ projectId: null, cityKey: "porto" });
    expect(porto.overdue.map((r) => r.id)).toEqual([2]);
    expect(porto.closing.map((r) => r.id)).toEqual([3]);
    expect(groups.find((g) => g.projectId === 10)!.overdue.map((r) => r.id)).toEqual([1]);
    expect(src("server/whatsappInboxOps.ts")).toMatch(/\.\.\.\(g\.cityKey \? \{ city: g\.cityKey \} : \{ projectId: g\.projectId \}\),/);
  });

  it("atribuir: pessoa OU grupo (nunca os dois); quem responde fica com ela e sai do grupo", () => {
    const r = src("server/routers.ts");
    expect(r).toMatch(/cityKey: z\.enum\(CITY_KEYS\)\.nullable\(\)\.optional\(\) \}\)\)/);
    expect(r).toMatch(/Escolhe uma pessoa ou um grupo de cidade, não os dois\./);
    const ops = src("server/whatsappInboxOps.ts");
    expect(ops).toMatch(/set\(\{ assignedUserId: null, assignedCityKey: cityKey \}\)/);
    expect(ops).toMatch(/set\(\{ assignedUserId: userId, assignedCityKey: null \}\)\.where\(eq\(whatsappConversations\.id, conversationId\)\)/);
    expect(ops).toMatch(/\.set\(\{ assignedUserId: userId, assignedCityKey: null \}\)\s*\.where\(and\(eq\(whatsappConversations\.id, conversationId\), sql`\$\{whatsappConversations\.assignedUserId\} IS NULL`\)\)/);
    const page = src("client/src/pages/WhatsAppInboxPage.tsx");
    expect(page).toMatch(/\{CITY_KEYS\.map\(\(k\) => \(\s*<SelectItem key=\{k\} value=\{encodeAssignee\(null, k\)\}>\{cityGroupLabel\(k\)\}<\/SelectItem>/);
  });
});

describe("D29 — respostas rápidas por cidade", () => {
  it("quem vê: nacionais + as das suas cidades; quem vê todas vê tudo", () => {
    expect(quickReplyVisible(null, ["lisboa"])).toBe(true);
    expect(quickReplyVisible("lisboa", ["lisboa"])).toBe(true);
    expect(quickReplyVisible("porto", ["lisboa"])).toBe(false);
    expect(quickReplyVisible("porto", null)).toBe(true);
  });

  it("quem edita: só as das suas cidades; as nacionais só quem vê todas", () => {
    expect(quickReplyEditable("lisboa", ["lisboa"])).toBe(true);
    expect(quickReplyEditable("porto", ["lisboa"])).toBe(false);
    expect(quickReplyEditable(null, ["lisboa"])).toBe(false);
    expect(quickReplyEditable(null, null)).toBe(true);
    expect(quickReplyEditable("faro", null)).toBe(true);
  });

  it("o servidor filtra a lista e recusa gravar fora da cidade (também ao alterar uma existente)", () => {
    const ops = src("server/whatsappInboxOps.ts");
    expect(ops).toMatch(/\.filter\(\(r\) => quickReplyVisible\(r\.cityKey, userCities\)\)/);
    expect(ops).toMatch(/if \(!quickReplyEditable\(cityKey, userCities\)\) throw new QuickReplyForbidden/);
    expect(ops).toMatch(/if \(!quickReplyEditable\(cur\.cityKey, userCities\)\) throw new QuickReplyForbidden/);
    const r = src("server/routers.ts");
    expect(r).toMatch(/return listQuickReplies\(userCityKeys\(\)\);/);
    expect(r).toMatch(/id = await saveQuickReply\(input, ctx\.user\.id, userCityKeys\(\)\);/);
    expect(r).toMatch(/if \(e instanceof QuickReplyForbidden\) throw new TRPCError\(\{ code: "FORBIDDEN", message: e\.message \}\);/);
  });

  it("a gestão mostra a cidade e só deixa editar as editáveis", () => {
    const d = src("client/src/components/whatsapp/QuickRepliesDialog.tsx");
    expect(d).toMatch(/\{canEdit && r\.editable && \(/);
    expect(d).toMatch(/if \(access\.data\.all\) return \[NATIONAL, \.\.\.CITY_KEYS\];/);
  });
});

describe("Migração 0440", () => {
  it("só acrescenta as duas colunas", () => {
    expect(SCHEMA_MIGRATION_IDS).toContain("0440");
    expect(SCHEMA_MIGRATION_IDS.indexOf("0440")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0435"));
    expect(MIGRATION_0440_STATEMENTS).toEqual([
      "ALTER TABLE `whatsapp_conversations` ADD COLUMN `assignedCityKey` VARCHAR(16) NULL",
      "ALTER TABLE `whatsapp_quick_replies` ADD COLUMN `cityKey` VARCHAR(16) NULL",
    ]);
  });
});
