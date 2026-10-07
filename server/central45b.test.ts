/**
 * Lote 45b — Central Vodafone (Jorge, 7 out 2026): "o click to call, quando
 * tem +351, não está a fazer a chamada" e "quando a aplicação toca, dê algum
 * input aqui e também toque aqui".
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dialNumber, telHref } from "../shared/phone";
import {
  CENTRAL_RING_FLAG, CENTRAL_RING_STREAM_PATH, CENTRAL_RING_WINDOW_MS, formatRingEvent, parseRingNote, phoneTail, pickRing, ringContactHref, wasDialedByMe,
} from "../shared/centralRing";
import { searchNote } from "../shared/centralSugar";
import { AUTOMATION_FLAGS } from "../shared/appSettings";

vi.mock("./db", () => ({ getDb: async () => null }));
const src = (p: string) => readFileSync(p, "utf8");

describe("Número para marcar (tel:)", () => {
  it("Portugal sem +351; estrangeiro com 00; extensões como estão", () => {
    expect(dialNumber("+351913225918")).toBe("913225918");
    expect(dialNumber("+351 913 225 918")).toBe("913225918");
    expect(dialNumber("00351913225918")).toBe("913225918");
    expect(dialNumber("913 225 918")).toBe("913225918");
    expect(dialNumber("+351211234567")).toBe("211234567");
    expect(dialNumber("+34612345678")).toBe("0034612345678");
    expect(dialNumber("+44 7700 900123")).toBe("00447700900123");
    expect(dialNumber("410")).toBe("410");
    expect(dialNumber("")).toBe("");
    expect(dialNumber(null)).toBe("");
    expect(telHref("+351935625800")).toBe("tel:935625800");
    expect(telHref("  ")).toBe("");
  });
  it("todos os botões \"Ligar\" usam o telHref (nenhum tel: com o + à mão)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f)) files.push(p);
      }
    };
    walk("client/src");
    const raw = files.filter((f) => /href=\{`tel:/.test(src(f)));
    expect(raw).toEqual([]);
    for (const f of ["client/src/components/ContactActions.tsx", "client/src/pages/CrmClientPage.tsx", "client/src/pages/ContactsPage.tsx", "client/src/pages/CrmParkPage.tsx"]) {
      expect(src(f)).toContain("href={telHref(");
    }
  });
});

describe("Toque da central: que chamada está a tocar", () => {
  const now = Date.parse("2026-10-07T15:00:00Z");
  const row = (id: number, agoMs: number, phone: string, ref: string, name: string) => ({ id, atMs: now - agoMs, note: searchNote(phone, ref, name) });

  it("lê a nota da pesquisa por número ou extensão (não a por nome, nem a vazia)", () => {
    expect(parseRingNote(searchNote("+351913225918", "crm-12", "Maria Silva"))).toEqual({ phone: "+351913225918", ref: "crm-12", name: "Maria Silva" });
    expect(parseRingNote(searchNote("410", "ext-410", "Extensão 410"))).toEqual({ phone: "410", ref: "ext-410", name: "Extensão 410" });
    expect(parseRingNote('pesquisa por nome "maria" → 3 resultados')).toBeNull();
    expect(parseRingNote("pesquisa sem número (resposta vazia)")).toBeNull();
    expect(parseRingNote(null)).toBeNull();
  });

  it("a mais recente; a mesma pesquisa em vários módulos é a mesma chamada (o id não muda)", () => {
    const rows = [
      row(10, 8_000, "+351913225918", "crm-12", "Maria Silva"),
      row(11, 7_500, "+351913225918", "crm-12", "Maria Silva"),
      row(12, 7_000, "+351913225918", "crm-12", "Maria Silva"),
    ];
    expect(pickRing(rows, now)).toMatchObject({ id: 10, phone: "+351913225918", ref: "crm-12", name: "Maria Silva" });
    expect(pickRing([...rows].reverse(), now)?.id).toBe(10);
  });

  it("passada a janela do toque já não toca; a pesquisa por nome nunca toca", () => {
    expect(pickRing([row(1, CENTRAL_RING_WINDOW_MS + 1_000, "+351913225918", "crm-12", "Maria")], now)).toBeNull();
    expect(pickRing([{ id: 2, atMs: now - 1_000, note: 'pesquisa por nome "maria" → 3 resultados' }], now)).toBeNull();
    expect(pickRing([], now)).toBeNull();
  });

  it("a consola a reler as recentes ao entrar (3+ números em 5 s) não toca", () => {
    const rows = [
      row(1, 3_000, "+351911111111", "tel-351911111111", "Sem ficha"),
      row(2, 2_500, "+351922222222", "crm-2", "Ana"),
      row(3, 2_000, "+351933333333", "emp-3", "Rui"),
    ];
    expect(pickRing(rows, now)).toBeNull();
    // Duas chamadas seguidas (2 números) continuam a tocar: a última.
    expect(pickRing(rows.slice(1), now)).toMatchObject({ id: 3, name: "Rui" });
  });

  it("uma chamada nova do mesmo número, passado o tempo da mesma chamada, é outra", () => {
    const rows = [row(1, 40_000, "+351913225918", "crm-12", "Maria"), row(2, 2_000, "+351913225918", "crm-12", "Maria")];
    expect(pickRing(rows, now)?.id).toBe(2);
  });

  it("extensão interna toca como chamada interna", () => {
    expect(pickRing([row(5, 1_000, "410", "ext-410", "Extensão 410")], now)).toMatchObject({ id: 5, ref: "ext-410" });
    expect(ringContactHref("ext-410")).toBeNull();
  });

  it("\"Abrir ficha\" leva ao mesmo sítio que o contacto aberto na consola", () => {
    expect(ringContactHref("crm-12")).toBe("/clientes/12");
    expect(ringContactHref("emp-3")).toBe("/rh");
    expect(ringContactHref("tel-351913225918")).toBe("/clientes?q=%2B351913225918");
    expect(ringContactHref("ct-4")).toBe("/clientes");
    expect(ringContactHref("x")).toBeNull();
  });

  it("chamada feita pelo \"Ligar\" da dashboard (mesmo número, < 90 s) não toca", () => {
    const at = now;
    expect(phoneTail("tel:913225918")).toBe("913225918");
    expect(phoneTail("+351913225918")).toBe("913225918");
    expect(wasDialedByMe([{ tail: "913225918", atMs: at - 10_000 }], "+351913225918", at)).toBe(true);
    expect(wasDialedByMe([{ tail: "913225918", atMs: at - 200_000 }], "+351913225918", at)).toBe(false);
    expect(wasDialedByMe([{ tail: "922222222", atMs: at - 10_000 }], "+351913225918", at)).toBe(false);
    expect(wasDialedByMe([], "+351913225918", at)).toBe(false);
  });

  it("o stream só leva o id (quem liga vem pelo tRPC, com a sessão)", () => {
    expect(formatRingEvent(42)).toBe('event: ring\ndata: {"id":42}\n\n');
    expect(CENTRAL_RING_STREAM_PATH).toBe("/api/central/ring/stream");
  });
});

describe("Toque da central: servidor e ecrã", () => {
  it("interruptor novo, desligado por omissão, só o super admin", () => {
    expect(AUTOMATION_FLAGS.find((f) => f.name === CENTRAL_RING_FLAG)).toMatchObject({ defaultEnabled: false, superAdminOnly: true });
  });

  it("DATETIME em UTC (texto ou Date) → ms", async () => {
    const { dbUtcMs } = await import("./centralRing");
    expect(dbUtcMs("2026-10-07 15:00:00")).toBe(Date.parse("2026-10-07T15:00:00Z"));
    expect(dbUtcMs(new Date("2026-10-07T15:00:00Z"))).toBe(Date.parse("2026-10-07T15:00:00Z"));
    expect(Number.isNaN(dbUtcMs(null))).toBe(true);
  });

  it("só lê a consola da própria pessoa (acesso ativo) e nunca escreve", () => {
    const s = src("server/centralRing.ts");
    expect(s).toContain("JOIN central_accounts a ON a.id = r.accountId AND a.userId = ${userId} AND a.revokedAt IS NULL");
    expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    const r = src("server/centralRouter.ts");
    expect(r).toContain("ringSetup: protectedProcedure.query(");
    expect(r).toContain("myRing: protectedProcedure.query(");
    expect(r).toContain("return ringForUser(ctx.user.id);");
  });

  it("stream montado nos dois entrypoints; desligado ou sem acesso da consola → 204", () => {
    for (const f of ["server/_core/index.ts", "server/_core/api-entry.ts"]) expect(src(f)).toContain("registerCentralRingStreamRoute(app);");
    const s = src("server/centralRing.ts");
    expect(s).toContain("enabled: enabled && (await hasCentralAccount(ctx.user.id))");
    expect(s).toContain('if (!auth.enabled) { res.status(204).end(); return; }');
  });

  it("o aviso está em todas as páginas; sem som nas chamadas feitas por mim; som silenciável", () => {
    expect(src("client/src/components/DashboardLayout.tsx")).toContain("<CentralRingManager enabled={!!user} />");
    const c = src("client/src/components/CentralRingManager.tsx");
    expect(c).toContain("const ringing = !!card && !card.mine && !muted && !soundOver && silencedId !== card.ring.id;");
    expect(c).toContain("closest?.('a[href^=\"tel:\"]')");
    expect(c).toContain("Atende e desliga na consola.");
  });
});
