/**
 * P3 lote 24e — decisões do Jorge (3 out 2026):
 *  - D40: caixa própria para os cancelamentos (migração 0455);
 *  - D41: o email ao cliente sai pela caixa info (ficha da reserva e do cliente);
 *  - D42: quem entrega/levanta pelo cliente tem os botões de contacto;
 *  - D43: o pedido semanal e o lembrete de disponibilidade só vão a extras com cidade.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANCELLATIONS_BOX, INTENT_BOX, ROUTING_TARGETS, TOPIC_BOX_SEEDS, whatsappBoxFor } from "../shared/commsBoxes";
import { MIGRATION_0455_STATEMENTS } from "./migrations/migration_0455";
import { SCHEMA_MIGRATION_IDS } from "./migrations";
import { availabilityRequestTargets } from "./extrasAutomation";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("D40 — caixa Cancelamentos", () => {
  it("intenção cancelamento → Cancelamentos; alteração continua em Alterações", () => {
    expect(INTENT_BOX.cancelamento).toBe("cancelamentos");
    expect(INTENT_BOX.alteracao).toBe("alteracoes");
    const base = { boxKey: null, boxSource: null, employeeId: null, isLead: false } as const;
    expect(whatsappBoxFor({ ...base, intent: "cancelamento" })).toEqual({ boxKey: "cancelamentos", boxSource: "ai" });
    expect(whatsappBoxFor({ ...base, boxKey: "alteracoes", boxSource: "manual", intent: "cancelamento" })).toBeNull();
  });

  it("a IA do email também separa: alterar ≠ cancelar", () => {
    const keys = ROUTING_TARGETS.map((t) => t.key);
    expect(keys).toContain("cancelamentos");
    expect(ROUTING_TARGETS.find((t) => t.key === "alteracoes")!.hint).not.toMatch(/cancelar uma/);
    expect(ROUTING_TARGETS.find((t) => t.key === "cancelamentos")!.hint).toMatch(/cancelar/);
  });

  it("migração 0455: cria a caixa uma vez (como as Alterações), muda só as conversas que a IA tinha posto em Alterações por cancelamento", () => {
    expect(CANCELLATIONS_BOX).toMatchObject({ key: "cancelamentos", label: "Cancelamentos", module: "reservas_operacoes", cityRule: "linked" });
    expect(TOPIC_BOX_SEEDS.map((b) => b.key)).not.toContain("cancelamentos"); // a 0365 já correu
    expect(SCHEMA_MIGRATION_IDS.indexOf("0455")).toBeGreaterThan(SCHEMA_MIGRATION_IDS.indexOf("0450"));
    const all = MIGRATION_0455_STATEMENTS.join("\n");
    expect(all).toContain("INSERT IGNORE INTO `mail_mailboxes`");
    expect(all).toContain("'cancelamentos', 'Cancelamentos', '[]', 'tema'");
    expect(all).toContain("WHERE `boxKey` = 'alteracoes' AND `boxSource` = 'ai' AND `aiIntent` = 'cancelamento'");
    expect(all).toContain("'0455_cancellations_box'");
    expect(all).not.toMatch(/\bDELETE\b|\bDROP\b/);
  });
});

describe("D41/D42 — fichas", () => {
  it("email ao cliente pela info (reserva e CRM); quem entrega/levanta com os botões", () => {
    const bf = src("client/src/pages/BookingFilePage.tsx");
    expect(bf).toContain('<ContactActions className="col-span-2" phones={[b.client.phone]} emails={[b.client.email]} mailbox="info" />');
    expect(bf).not.toContain('mailbox="reservas"');
    expect(bf).toContain('<ContactActions phones={[dr.phone]} emails={[dr.email]} mailbox="info" />');
    expect(bf).toMatch(/!b\.client\.anonymized && \(dr\.phone \|\| dr\.email\)/);
    expect(src("client/src/pages/CrmClientPage.tsx")).toMatch(/emails=\{ownEmails\}\s*\/\/ D41[^\n]*\n\s*mailbox="info"/);
  });
});

describe("D43 — pedido de disponibilidade só a extras com cidade", () => {
  const extras = [
    { employeeId: 1, city: "lisboa", responded: false },
    { employeeId: 2, city: null, responded: false },
    { employeeId: 3, city: "porto", responded: true },
    { employeeId: 4, city: null, responded: true },
  ];
  it("pedido de quinta: todos com cidade; lembrete: com cidade e sem resposta", () => {
    expect(availabilityRequestTargets(extras, false)).toEqual([1, 3]);
    expect(availabilityRequestTargets(extras, true)).toEqual([1]);
    expect(availabilityRequestTargets([{ employeeId: 9, city: null, responded: false }], false)).toEqual([]);
  });
  it("o automático já não manda a 'todos' (null)", () => {
    const a = src("server/extrasAutomation.ts");
    expect(a).not.toContain("return sendAvailabilityRequest(weekStart, null, null);");
    expect(a).toContain("return sendAvailabilityRequest(weekStart, availabilityRequestTargets(ov.extras, false), null);");
    expect(a).toContain("availabilityRequestTargets(ov.extras, true)");
  });
});
