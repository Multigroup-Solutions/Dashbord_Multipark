/**
 * Central Vodafone (Jorge, 14 out 2026): quem atende na consola não pode ficar
 * a ouvir o dashboard a tocar — botão "Já atendi", qualquer clique silencia,
 * som mais curto e o gancho "atendida" para quando a API da Vodafone chegar.
 * E o nome de quem atendeu leva à ficha dessa pessoa.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CENTRAL_CONSOLE_URL, CENTRAL_RING_ANSWERED_EVENT, CENTRAL_RING_SOUND_MS, centralPersonHref, employeeFichaHref, formatRingAnsweredEvent,
  parseRingEventId, ringContactHref,
} from "../shared/centralRing";

const src = (p: string) => readFileSync(p, "utf8");

describe("toque: atender na consola", () => {
  it("o som dura 12 s (4 toques), não 25", () => {
    expect(CENTRAL_RING_SOUND_MS).toBe(12_000);
  });

  it("sem endereço da consola (aplicação do Windows): o botão só silencia", () => {
    expect(CENTRAL_CONSOLE_URL).toBeNull();
  });

  it("evento \"atendida\" do stream: formato SSE e leitura do id", () => {
    expect(formatRingAnsweredEvent(42)).toBe(`event: ${CENTRAL_RING_ANSWERED_EVENT}\ndata: {"id":42}\n\n`);
    expect(parseRingEventId('{"id":42}')).toBe(42);
    expect(parseRingEventId('{"id":"7"}')).toBe(7);
    expect(parseRingEventId("{}")).toBeNull();
    expect(parseRingEventId("lixo")).toBeNull();
    expect(parseRingEventId('{"id":-1}')).toBeNull();
    expect(parseRingEventId(undefined)).toBeNull();
  });

  it("o aviso: botão grande \"Já atendi\", clique no aviso silencia, \"Sem som neste browser\" fica, escuta o \"answered\"", () => {
    const c = src("client/src/components/CentralRingManager.tsx");
    expect(c).toContain('"Já atendi"');
    expect(c).toContain('"Atender na consola"');
    expect(c).toMatch(/role="alert" onClick=\{silence\}/);
    expect(c).toContain("Sem som neste browser");
    expect(c).toContain("es.addEventListener(CENTRAL_RING_ANSWERED_EVENT");
    expect(c).toContain("window.open(CENTRAL_CONSOLE_URL, CENTRAL_CONSOLE_WINDOW)");
    expect(c).toContain("ctx.suspend()");
  });
});

describe("Central → chamadas: quem atendeu leva à ficha", () => {
  it("ficha RH quando a conta tem ficha; senão a conta em Utilizadores; nada → null", () => {
    expect(employeeFichaHref(12)).toBe("/rh?employeeId=12");
    expect(centralPersonHref(12, 3)).toBe("/rh?employeeId=12");
    expect(centralPersonHref(null, 3)).toBe("/rh/utilizadores?userId=3");
    expect(centralPersonHref(undefined, null)).toBeNull();
    expect(centralPersonHref(0, 0)).toBeNull();
  });

  it("o contacto \"Equipa\" abre a ficha certa (não o RH em geral)", () => {
    expect(ringContactHref("emp-3")).toBe("/rh?employeeId=3");
    const r = src("server/centralRouter.ts");
    expect(r).toContain('kind: "Equipa", href: employeeFichaHref(Number(e.id))');
    expect(r).not.toContain('kind: "Equipa", href: "/rh"');
  });

  it("o servidor manda o link de quem atendeu (ficha ativa primeiro, contas extra incluídas) e as páginas usam-no", () => {
    const r = src("server/centralRouter.ts");
    expect(r).toContain("FROM employee_accounts ea JOIN employees e ON e.id = ea.employeeId");
    expect(r).toContain("ORDER BY x.isActive DESC, x.viaAlias ASC, x.employeeId ASC");
    expect(r.match(/userHref:/g)?.length).toBe(2);
    expect(src("client/src/pages/CentralPage.tsx")).toContain("<Link href={c.userHref}");
    expect(src("client/src/components/central/CentralVodafoneCard.tsx")).toContain("<Link href={c.userHref}");
  });
});
