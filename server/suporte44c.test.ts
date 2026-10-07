/**
 * Lote 44c — Suporte: Ocorrências médias que fecham sozinhas ao fim de 3 dias
 * (só cá; a Multipark é só de leitura), Métricas dos extras explicadas (o pago
 * compara-se com a escala até ontem; pouco ponto = ponto em falta, não
 * poupança), Contactos por palavras soltas e com o porquê de vir vazio,
 * Críticas sem "Sem parque" (marca ou lixo).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OCCURRENCE_AUTO_CLOSE_DAYS, OCCURRENCE_KEEP_OPEN_PATTERN, isOccurrenceAutoClosed, occurrenceAutoCloseCutoff,
  occurrenceAutoClosedAt, occurrenceKeepsOpen,
} from "../shared/occurrenceAutoClose";
import { buildOccurrenceListSql, buildOccurrenceStatsSql, mapOccurrenceStatsRow, occurrenceAutoClosedCond } from "./multiparkDb/read";
import { PONTO_MIN_SHARE, paidVsPlanned } from "../shared/extrasMetricsRules";
import { parseContactQuery } from "../shared/contacts";
import { EMPTY_SOURCE_NOTES, emptySourceNote } from "./contactsSearch";
import { TRASH_KEY, brandNames, groupReviewsByPark, isTrashReview, reviewBrandName, type ProjectLike, type ReviewLike } from "../shared/reviewParks";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const midnight = (d: string) => `${d} 00:00:00`;

const NOW = Date.parse("2026-10-07T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const occ = (o: Partial<{ resolved: boolean; priority: string | null; createdAt: string | null; title: string; remarks: string | null }> = {}) => ({
  resolved: false, priority: "MEDIUM", createdAt: daysAgo(4), title: "Vidro Aberto", remarks: null, ...o,
});

describe("44c — Ocorrências: médias fecham sozinhas ao fim de 3 dias", () => {
  it("média, por resolver, com 3+ dias e sem dinheiro/danos/reclamação → fechada sozinha", () => {
    expect(OCCURRENCE_AUTO_CLOSE_DAYS).toBe(3);
    expect(isOccurrenceAutoClosed(occ(), NOW)).toBe(true);
    expect(isOccurrenceAutoClosed(occ({ title: "Atraso", remarks: "cliente chegou tarde" }), NOW)).toBe(true);
    // sem prioridade = média (o omissão da Multipark)
    expect(isOccurrenceAutoClosed(occ({ priority: null }), NOW)).toBe(true);
  });

  it("nunca fecham sozinhas: alta, baixa, resolvidas, com menos de 3 dias ou sem data", () => {
    expect(isOccurrenceAutoClosed(occ({ priority: "HIGH" }), NOW)).toBe(false);
    expect(isOccurrenceAutoClosed(occ({ priority: "LOW" }), NOW)).toBe(false);
    expect(isOccurrenceAutoClosed(occ({ resolved: true }), NOW)).toBe(false);
    expect(isOccurrenceAutoClosed(occ({ createdAt: daysAgo(2.9) }), NOW)).toBe(false);
    expect(isOccurrenceAutoClosed(occ({ createdAt: null }), NOW)).toBe(false);
  });

  it("dinheiro, danos/acidentes e reclamações ficam abertas (tipo ou notas)", () => {
    for (const remarks of ["Cliente pediu reembolso", "valor em falta na caixa", "pagamento por MB Way", "cobrou 20€ a mais",
      "carro amolgado na porta", "risco no para-choques", "reclamação no livro amarelo", "cliente fez queixa", "Acidente no parque"]) {
      expect(occurrenceKeepsOpen({ title: "Outro", remarks }), remarks).toBe(true);
      expect(isOccurrenceAutoClosed(occ({ remarks }), NOW), remarks).toBe(false);
    }
    expect(occurrenceKeepsOpen({ title: "Dano", remarks: null })).toBe(true);
    expect(occurrenceKeepsOpen({ title: "Vidro Aberto", remarks: "fechei o vidro" })).toBe(false);
  });

  it("o padrão serve tal e qual ao Postgres e ao JS (só texto simples e |)", () => {
    expect(OCCURRENCE_KEEP_OPEN_PATTERN).not.toMatch(/[\\^$.*+?()[\]{}]/);
    expect(OCCURRENCE_KEEP_OPEN_PATTERN.split("|").every((w) => w.length >= 1 && w === w.toLowerCase())).toBe(true);
  });

  it("corte = agora − 3 dias em UTC; fecha a criada + 3 dias", () => {
    expect(occurrenceAutoCloseCutoff(NOW)).toBe("2026-10-04 12:00:00");
    expect(occurrenceAutoClosedAt("2026-10-01T08:00:00.000Z")).toBe("2026-10-04T08:00:00.000Z");
    expect(occurrenceAutoClosedAt(null)).toBeNull();
  });

  it("SQL: 'Abertas' tira as fechadas sozinhas; 'Fechadas sozinhas' é a mesma regra", () => {
    const cutoff = occurrenceAutoCloseCutoff(NOW);
    const open = buildOccurrenceListSql({ status: "open", autoCloseBefore: cutoff }, midnight);
    expect(open.sql).toContain(`NOT o."resolved" AND NOT (NOT o."resolved" AND COALESCE(o."priority"::text, 'MEDIUM') = 'MEDIUM'`);
    expect(open.sql).toContain(`concat_ws(' ', o."title", o."remarks") !~*`);
    expect(open.params).toContain(cutoff);
    expect(open.params).toContain(OCCURRENCE_KEEP_OPEN_PATTERN);

    const auto = buildOccurrenceListSql({ status: "auto_closed", autoCloseBefore: cutoff }, midnight);
    expect(auto.sql).toContain(`WHERE (NOT o."resolved" AND COALESCE(o."priority"::text, 'MEDIUM') = 'MEDIUM'`);
    const resolved = buildOccurrenceListSql({ status: "resolved", autoCloseBefore: cutoff }, midnight);
    expect(resolved.sql).toContain(`WHERE o."resolved"`);
  });

  it("SQL: sem corte (ou corte inválido) nada fecha sozinho", () => {
    const p = { add: (_v: unknown) => "$1" } as any;
    expect(occurrenceAutoClosedCond({}, p)).toBe("FALSE");
    expect(occurrenceAutoClosedCond({ autoCloseBefore: "2026-10-04'; DROP" }, p)).toBe("FALSE");
    const legacy = buildOccurrenceStatsSql({ resolved: true }, midnight);
    expect(legacy.sql).toContain(`count(*) FILTER (WHERE NOT o."resolved") AS open`);
    expect(legacy.sql).toContain(`count(*) FILTER (WHERE FALSE) AS auto_closed`);
  });

  it("contagens: abertas sem as fechadas sozinhas + contagem à parte", () => {
    const s = buildOccurrenceStatsSql({ autoCloseBefore: occurrenceAutoCloseCutoff(NOW) }, midnight);
    expect(s.sql).toMatch(/count\(\*\) FILTER \(WHERE NOT o\."resolved" AND NOT \(NOT o\."resolved".*\) AS open/);
    expect(s.sql).toMatch(/AS auto_closed/);
    expect(mapOccurrenceStatsRow({ total: 9, open: 3, auto_closed: 4, resolved: 2 })).toMatchObject({ open: 3, autoClosed: 4, resolved: 2 });
  });

  it("rota: corte de agora, `resolved:false` = abertas a sério e cada linha diz se fechou sozinha", () => {
    const r = src("server/routers.ts");
    expect(r).toContain(`autoCloseBefore: occurrenceAutoCloseCutoff(now)`);
    expect(r).toContain(`resolved === false ? "open" as const`);
    expect(r).toContain(`autoClosed: isOccurrenceAutoClosed(o, now)`);
    expect(r).toContain(`autoClosed: isOccurrenceAutoClosed(r.data, Date.now())`);
  });

  it("página: etiqueta 'Fechada (3 dias)', filtro próprio, sem 'Resolver' nas fechadas e nada se escreve", () => {
    const page = src("client/src/pages/IncidentsPage.tsx");
    expect(page).toContain(`<SelectItem value="auto_closed">`);
    expect(page).toContain(`!occ.resolved && !occ.autoClosed && <ResolveButton />`);
    expect(page).toContain("stats.autoClosed > 0");
    expect(page).not.toMatch(/useMutation/);
  });
});

describe("44c — Métricas dos extras: pago vs escala até ontem", () => {
  it("pouco ponto picado → ponto em falta (sem percentagem); bastante → diferença; sem escala → diz", () => {
    expect(paidVsPlanned({ paidHours: 4, plannedPastHours: 200, paid: 30, plannedPast: 1500 })).toEqual({ kind: "missing_ponto", share: 0.02 });
    expect(paidVsPlanned({ paidHours: 190, plannedPastHours: 200, paid: 1425, plannedPast: 1500 })).toEqual({ kind: "diff", pct: -5 });
    expect(paidVsPlanned({ paidHours: 220, plannedPastHours: 200, paid: 0, plannedPast: 0 })).toEqual({ kind: "diff", pct: 10 });
    expect(paidVsPlanned({ paidHours: 5, plannedPastHours: 0, paid: 30, plannedPast: 0 })).toEqual({ kind: "no_schedule" });
    expect(PONTO_MIN_SHARE).toBe(0.6);
  });

  it("servidor: a escala até ontem sai da mesma conta (sem SQL própria); ecrã explica cada número", () => {
    const m = src("server/extrasMetrics.ts");
    expect(m).toContain("costRows.assignments.filter((a) => a.date < to)");
    expect(src("server/routers.ts")).toContain("planned: 0, paid: 0, plannedPast: 0");
    const ui = src("client/src/components/ExtrasMetricsSection.tsx");
    expect(ui).toContain("O que quer dizer cada número?");
    expect(ui).toContain("paidVsPlanned(m.cost)");
    expect(ui).not.toContain("% vs previsto");
  });
});

describe("44c — Contactos: palavras soltas e o porquê de vir vazio", () => {
  it("uma condição LIKE por palavra (até 5), escapada", () => {
    expect(parseContactQuery("Joao  Silva").likes).toEqual(["%joao%", "%silva%"]);
    expect(parseContactQuery("50%_x").likes).toEqual(["%50\\%\\_x%"]);
    expect(parseContactQuery("a b c d e f g").likes).toHaveLength(5);
  });

  it("CRM comercial vazio → explica; com dados → é mesmo 'nenhum encontrado'", async () => {
    const db = (n: number) => ({ execute: async () => [[{ n }]] }) as any;
    expect(await emptySourceNote(db(0), "crm")).toBe(EMPTY_SOURCE_NOTES.crm);
    expect(await emptySourceNote(db(3), "crm")).toBeNull();
    expect(await emptySourceNote(db(0), "client" as any)).toBeNull();
  });

  it("uma leitura falhada diz que falhou (não 'nenhum')", () => {
    expect(src("server/contactsSearch.ts")).toContain(`error: "Não foi possível ler esta lista agora.`);
    expect(src("client/src/pages/ContactsPage.tsx")).toContain("Não foi possível ler agora:");
  });
});

describe("44c — Críticas: sem 'Sem parque' (marca ou lixo)", () => {
  const projects: ProjectLike[] = [
    { id: 1, name: "Airpark Lisboa", level: "park" },
    { id: 10, name: "Airpark", level: "brand" },
    { id: 11, name: "Airpark", level: "brand" },
    { id: 12, name: "SkyPark", level: "brand" },
  ];
  const review = (o: Partial<ReviewLike> & { id: number }): ReviewLike => ({
    projectId: null, rating: 5, status: "pending_response", respondedAt: null, ...o,
  } as ReviewLike);

  it("marcas sem repetir; a marca vem do perfil Google e, se não, do texto", () => {
    expect(brandNames(projects)).toEqual(["Airpark", "SkyPark"]);
    expect(reviewBrandName({ locationTitle: "SkyPark — Parque Low Cost", reviewText: "airpark?" }, ["Airpark", "SkyPark"])).toBe("SkyPark");
    expect(reviewBrandName({ locationTitle: null, reviewText: "Ótimo serviço da Airpark!" }, ["Airpark", "SkyPark"])).toBe("Airpark");
    expect(reviewBrandName({ locationTitle: "Parque X", reviewText: "bom" }, ["Airpark", "SkyPark"])).toBeNull();
  });

  it("agrupa: parque → parque; sem parque com marca → '<Marca> (marca)'; o resto → lixo, no fim", () => {
    const groups = groupReviewsByPark([
      review({ id: 1, projectId: 1 }),
      review({ id: 2, locationTitle: "SkyPark Porto" }),
      review({ id: 3, reviewText: "nada a dizer" }),
      review({ id: 4, projectId: 999 }),
    ], projects);
    expect(groups.map((g) => g.name)).toEqual(["Airpark Lisboa", "SkyPark (marca)", "Lixo (sem parque nem marca)"]);
    const trash = groups[groups.length - 1];
    expect(trash.key).toBe(TRASH_KEY);
    expect(trash.trash).toBe(true);
    expect(trash.reviews.map((r) => r.id)).toEqual([3, 4]);
    expect(groups.some((g) => g.name === "Sem parque")).toBe(false);
  });

  it("lixo não conta nas estatísticas; mudar o parque pede edição, âmbito e fica registado", () => {
    expect(isTrashReview(review({ id: 5, reviewText: "ok" }), projects)).toBe(true);
    expect(isTrashReview(review({ id: 6, projectId: 1 }), projects)).toBe(false);
    expect(src("server/db.ts")).toContain("!isTrashReview(r as any, projectNodes)");
    const r = src("server/routers.ts");
    const setPark = r.split("setPark: protectedProcedure")[1].split("generateResponse:")[0];
    expect(setPark).toContain(`requireAccess(ctx.user, "criticas", "edit")`);
    expect(setPark).toContain("assertProjectAccess(input.projectId)");
    expect(setPark).toContain("logActivity(");
  });
});
