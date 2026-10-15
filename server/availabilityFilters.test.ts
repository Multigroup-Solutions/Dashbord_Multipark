/**
 * Disponibilidade dos extras — redesenho de 14 out 2026 (Jorge: "é uma grande
 * confusão, não se percebe nada"). Regras puras (shared/availabilityFilters.ts)
 * e a estrutura do ecrã (extrasDia/AvailabilityTab.tsx + Grid + diálogos).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AVAILABILITY_FILTERS,
  STATUS_SECTION_ORDER,
  applyAvailabilityFilters,
  availabilityPopoverFilterCount,
  availabilitySendTarget,
  availabilityStatusTiles,
  availabilityWindowMode,
  closedSectionsNote,
  defaultOpenStatuses,
  emailConfirmText,
  emptyAvailabilityMessage,
  hasActiveAvailabilityFilters,
  hiddenGridRowIds,
  isSectionOpen,
  matchesAvailabilityFilters,
  matchesExtraQuery,
  perDayShiftTotals,
  sectionKey,
  sendAllLabel,
  sendBlockReason,
  sendNeedsAllConfirm,
  sendTargetBreakdown,
  sendTargetPhrase,
  sendTargetShort,
  shortDayHeader,
  splitByStatus,
  statusCountLabel,
  statusSectionTitle,
  toggleStatusTile,
  windowFilterLabel,
  type AvailabilityFilters,
  type AvailabilityFilterRow,
} from "../shared/availabilityFilters";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

const MON = "2026-10-19";
const TUE = "2026-10-20";
const day = (d: string, p: Partial<{ morning: boolean; night: boolean; fromHour: number | null; toHour: number | null }> = {}) => ({
  day: d, morning: false, night: false, fromHour: null, toHour: null, ...p,
});

type Row = AvailabilityFilterRow & { employeeId: number };
const row = (employeeId: number, fullName: string, p: Partial<Row> = {}): Row => ({
  employeeId,
  fullName,
  phone: null,
  phoneE164: null,
  city: "lisboa",
  responded: false,
  availableDays: 0,
  contactedWithin24h: false,
  days: [day(MON), day(TUE)],
  ...p,
});

const ana = row(1, "Ana Sousa", { responded: true, availableDays: 1, phoneE164: "+351912000001", days: [day(MON, { morning: true }), day(TUE)] });
const bruno = row(2, "Bruno Ana", { city: "porto", responded: true, availableDays: 0 });
const carla = row(3, "Carla Dias", { city: null, contactedWithin24h: true, phone: "91 200 0003" });
const mariana = row(4, "Mariana Costa", { responded: true, availableDays: 1, days: [day(MON), day(TUE, { fromHour: 18, toHour: 23 })] });
const rui = row(5, "Rui Reis", { city: "faro" });
const ALL = [rui, mariana, carla, bruno, ana];

const f = (p: Partial<AvailabilityFilters> = {}): AvailabilityFilters => ({ ...DEFAULT_AVAILABILITY_FILTERS, ...p });

describe("filtros que se compõem (AND)", () => {
  it("sem filtros: todos, disponíveis → sem resposta → indisponíveis, por nome", () => {
    expect(applyAvailabilityFilters(ALL, f()).map((r) => r.fullName)).toEqual([
      "Ana Sousa", "Mariana Costa", "Carla Dias", "Rui Reis", "Bruno Ana",
    ]);
  });
  it("cidade, 'Sem cidade', estado e 24 h", () => {
    expect(applyAvailabilityFilters(ALL, f({ city: "lisboa" })).map((r) => r.employeeId)).toEqual([1, 4]);
    expect(applyAvailabilityFilters(ALL, f({ city: "none" })).map((r) => r.employeeId)).toEqual([3]);
    expect(applyAvailabilityFilters(ALL, f({ status: "no_answer" })).map((r) => r.employeeId)).toEqual([3, 5]);
    expect(applyAvailabilityFilters(ALL, f({ onlyNotContacted24h: true })).map((r) => r.employeeId)).not.toContain(3);
    expect(applyAvailabilityFilters(ALL, f({ city: "lisboa", status: "no_answer" }))).toEqual([]);
  });
  it("disponível em: só o dia, ou dia + horas (sobreposição); uma hora só não filtra", () => {
    expect(applyAvailabilityFilters(ALL, f({ windowDay: MON })).map((r) => r.employeeId)).toEqual([1]);
    expect(applyAvailabilityFilters(ALL, f({ windowDay: TUE, windowFrom: 20, windowTo: 22 })).map((r) => r.employeeId)).toEqual([4]);
    expect(applyAvailabilityFilters(ALL, f({ windowFrom: 4, windowTo: 6 })).map((r) => r.employeeId)).toEqual([1]);
    expect(applyAvailabilityFilters(ALL, f({ windowFrom: 4 }))).toHaveLength(5);
    expect(availabilityWindowMode(f())).toBe("off");
    expect(availabilityWindowMode(f({ windowDay: MON }))).toBe("day");
    expect(availabilityWindowMode(f({ windowTo: 9 }))).toBe("incomplete");
    expect(availabilityWindowMode(f({ windowFrom: 8, windowTo: 9 }))).toBe("hours");
  });
  it("pesquisa: nome sem acentos, número E.164 ou em bruto; quem começa pelo texto vem primeiro", () => {
    expect(applyAvailabilityFilters(ALL, f({ search: "ana" })).map((r) => r.fullName)).toEqual(["Ana Sousa", "Bruno Ana", "Mariana Costa"]);
    expect(matchesExtraQuery("912000001", ana)).toBe(true);
    expect(matchesExtraQuery("200 0003", carla)).toBe(true);
    expect(matchesExtraQuery("dias", carla)).toBe(true);
    expect(matchesExtraQuery("zé", carla)).toBe(false);
  });
});

describe("quadrados de estado", () => {
  it("contam com os outros filtros, nunca com o próprio estado", () => {
    expect(availabilityStatusTiles(ALL, f())).toEqual({ all: 5, available: 2, unavailable: 1, no_answer: 2 });
    // Com "Sem resposta" escolhido, os números continuam a mostrar o resto (para se poder trocar).
    expect(availabilityStatusTiles(ALL, f({ status: "no_answer" }))).toEqual({ all: 5, available: 2, unavailable: 1, no_answer: 2 });
    expect(availabilityStatusTiles(ALL, f({ city: "lisboa" }))).toEqual({ all: 2, available: 2, unavailable: 0, no_answer: 0 });
    expect(matchesAvailabilityFilters(carla, f({ status: "available" }), { ignoreStatus: true })).toBe(true);
  });
  it("carregar no escolhido volta a Todos", () => {
    expect(toggleStatusTile("all", "available")).toBe("available");
    expect(toggleStatusTile("available", "available")).toBe("all");
    expect(toggleStatusTile("available", "no_answer")).toBe("no_answer");
    expect(toggleStatusTile("no_answer", "all")).toBe("all");
  });
});

describe("botão Filtros e 'Limpar filtros'", () => {
  it("o número do botão conta só o que está lá dentro (dia/horas e 24 h)", () => {
    expect(availabilityPopoverFilterCount(f())).toBe(0);
    expect(availabilityPopoverFilterCount(f({ windowDay: MON, onlyNotContacted24h: true }))).toBe(2);
    expect(availabilityPopoverFilterCount(f({ windowFrom: 3 }))).toBe(0); // incompleto não filtra
    expect(availabilityPopoverFilterCount(f({ search: "x", status: "available", city: "porto" }))).toBe(0);
  });
  it("cidade presa à de cima não conta como filtro a limpar", () => {
    expect(hasActiveAvailabilityFilters(f())).toBe(false);
    expect(hasActiveAvailabilityFilters(f({ city: "lisboa" }))).toBe(true);
    expect(hasActiveAvailabilityFilters(f({ city: "lisboa" }), { cityLocked: true })).toBe(false);
    expect(hasActiveAvailabilityFilters(f({ search: "  " }))).toBe(false);
    expect(hasActiveAvailabilityFilters(f({ windowTo: 3 }))).toBe(true);
  });
  it("chip do filtro 'disponível em'", () => {
    const label = (d: string) => (d === MON ? "Segunda 19/10" : d);
    expect(windowFilterLabel(f(), label)).toBeNull();
    expect(windowFilterLabel(f({ windowFrom: 8 }), label)).toBeNull();
    expect(windowFilterLabel(f({ windowDay: MON }), label)).toBe("Segunda 19/10 · qualquer hora");
    expect(windowFilterLabel(f({ windowFrom: 8, windowTo: 20 }), label)).toBe("qualquer dia · 08h–20h");
  });
});

describe("destinatários: nunca ambíguo", () => {
  it("sem seleção → os filtrados (ou TODOS, sem filtro nenhum); com seleção → os marcados (mesmo fora da vista, contados à parte)", () => {
    const shown = [ana, mariana];
    expect(availabilitySendTarget(ALL, shown, new Set(), { filtersActive: true })).toEqual({ scope: "filtered", rows: shown, hiddenSelected: 0 });
    // Sem filtro nenhum não se diz "filtrados": são todos.
    expect(availabilitySendTarget(ALL, ALL, new Set()).scope).toBe("all");
    expect(availabilitySendTarget(ALL, ALL, new Set(), { filtersActive: false }).scope).toBe("all");
    const t = availabilitySendTarget(ALL, shown, new Set([1, 5]));
    expect(t.scope).toBe("selected");
    expect(t.rows.map((r) => r.employeeId).sort()).toEqual([1, 5]);
    expect(t.hiddenSelected).toBe(1);
  });
  it("frases dos botões e da confirmação", () => {
    expect(sendTargetPhrase("filtered", 317)).toBe("aos 317 extras filtrados");
    expect(sendTargetPhrase("selected", 12)).toBe("aos 12 extras selecionados");
    expect(sendTargetPhrase("selected", 1)).toBe("ao extra selecionado");
    expect(sendTargetPhrase("all", 317)).toBe("a todos os 317 extras");
    expect(sendTargetShort("all", 317)).toBe("todos os 317 extras");
    expect(sendTargetShort("filtered", 40)).toBe("40 filtrados");
    expect(sendTargetShort("selected", 1)).toBe("1 selecionado");
    expect(emailConfirmText("filtered", 317, "Segunda 19/10 a Domingo 25/10")).toBe(
      "Vais enviar o pedido de disponibilidade por email aos 317 extras filtrados, semana Segunda 19/10 a Domingo 25/10. Confirmas?",
    );
    expect(emailConfirmText("all", 3, "X", "1 disponível · 2 sem resposta")).toBe(
      "Vais enviar o pedido de disponibilidade por email a todos os 3 extras (1 disponível · 2 sem resposta), semana X. Confirmas?",
    );
  });
  it("travão: só sem seleção, com 'Todos' E (todos os extras OU mais de um estado); destrava-se com o link", () => {
    const b = (p: Partial<Parameters<typeof sendBlockReason>[0]>) =>
      sendBlockReason({ scope: "filtered", status: "all", count: 40, statesCount: 2, unlocked: false, ...p });
    expect(b({ scope: "all", count: 317, statesCount: 3 })).toContain("Escolhe primeiro um estado");
    expect(b({ scope: "all", count: 317, statesCount: 3 })).toContain("“Enviar a todos os 317 extras”");
    expect(b({})).toContain("“Enviar aos 40 extras filtrados (2 estados)”");
    // Filtrado com um só estado (ex.: "Sem mensagem 24h" em Faro, só sem resposta) → não trava.
    expect(b({ statesCount: 1 })).toBeNull();
    // "Todos os extras" trava mesmo que só haja um estado.
    expect(b({ scope: "all", statesCount: 1 })).not.toBeNull();
    expect(b({ scope: "all", unlocked: true })).toBeNull();
    expect(b({ status: "no_answer" })).toBeNull();
    expect(b({ scope: "selected", statesCount: 3 })).toBeNull();
    expect(b({ status: "available", count: 0 })).toBe("Ninguém a quem enviar com estes filtros.");
    // O diálogo pede o passo explícito nos mesmos casos (mesmo com 1 pessoa).
    expect(sendNeedsAllConfirm("all", "all", 1)).toBe(true);
    expect(sendNeedsAllConfirm("filtered", "all", 2)).toBe(true);
    expect(sendNeedsAllConfirm("filtered", "all", 1)).toBe(false);
    expect(sendNeedsAllConfirm("filtered", "no_answer", 1)).toBe(false);
    expect(sendNeedsAllConfirm("selected", "all", 3)).toBe(false);
    expect(sendAllLabel("all", 320, 3)).toBe("Enviar a todos os 320 extras");
    expect(sendAllLabel("filtered", 12, 2)).toBe("Enviar aos 12 extras filtrados (2 estados)");
    expect(sendAllLabel("filtered", 12, 1)).toBe("Enviar aos 12 extras filtrados");
  });
  it("divisão por estado e quem vai em secções fechadas (os fora da grelha não contam aqui)", () => {
    const shownIds = new Set([1, 2, 3, 4]);
    // Por defeito, com "Todos": só "Disponíveis" aberta.
    const closed = (r: Row) => !isSectionOpen({}, r.city ?? "none", r.responded ? (r.availableDays > 0 ? "available" : "unavailable") : "no_answer", "all");
    const b = sendTargetBreakdown(ALL, shownIds, closed);
    expect(b.counts).toEqual({ available: 2, no_answer: 2, unavailable: 1 });
    expect(b.text).toBe("2 disponíveis · 2 sem resposta · 1 indisponível");
    expect(b.notVisible).toBe(2); // carla (sem resposta) e bruno (indisponível); rui está fora da grelha
    expect(b.statesCount).toBe(3);
    expect(closedSectionsNote(b.notVisible)).toBe("inclui 2 que não estão à vista (secções fechadas ou por mostrar)");
    expect(closedSectionsNote(1)).toBe("inclui 1 que não está à vista (secções fechadas ou por mostrar)");
    expect(closedSectionsNote(0)).toBeNull();
    expect(sendTargetBreakdown([ana], new Set([1]), () => false)).toMatchObject({ text: "1 disponível", notVisible: 0, statesCount: 1 });
  });
  it("quem não está à vista: cidade fechada, secção fechada e além do 'Mostrar mais' (como a grelha desenha)", () => {
    const many = Array.from({ length: 30 }, (_, i) => row(100 + i, `Disp ${String(i).padStart(2, "0")}`, { responded: true, availableDays: 1 }));
    const sorted = applyAvailabilityFilters([...many, carla, rui], f());
    const view = { closedCities: new Set<"lisboa" | "porto" | "faro" | "none">(), sectionOverrides: {}, shownPer: {} };
    const hidden = hiddenGridRowIds(sorted, view, { status: "all", searching: false });
    // 5 disponíveis de Lisboa além das 25 + sem resposta (secções fechadas por defeito).
    expect([...hidden].filter((id) => id >= 100)).toEqual([125, 126, 127, 128, 129]);
    expect(hidden.has(3)).toBe(true);
    expect(hidden.has(5)).toBe(true);
    // "Mostrar todos" nessa secção e abrir os sem resposta de Faro → só fica a Carla (Sem cidade).
    const more = hiddenGridRowIds(sorted, { ...view, shownPer: { "lisboa:available": 30 }, sectionOverrides: { "faro:no_answer": true } }, { status: "all", searching: false });
    expect([...more]).toEqual([3]);
    // Cidade fechada esconde tudo dela; a pesquisar não há secções, só a paginação da lista.
    expect(hiddenGridRowIds(sorted, { ...view, closedCities: new Set(["lisboa"]) }, { status: "all", searching: false }).has(100)).toBe(true);
    expect([...hiddenGridRowIds(sorted, view, { status: "all", searching: true })]).toEqual([125, 126, 127, 128, 129]);
  });
  it("secção aberta: a escolha explícita manda; senão a regra por defeito", () => {
    expect(isSectionOpen({}, "lisboa", "available", "all")).toBe(true);
    expect(isSectionOpen({}, "lisboa", "no_answer", "all")).toBe(false);
    expect(isSectionOpen({ "lisboa:no_answer": true }, "lisboa", "no_answer", "all")).toBe(true);
    expect(isSectionOpen({ "lisboa:available": false }, "lisboa", "available", "all")).toBe(false);
    expect(isSectionOpen({}, "porto", "no_answer", "no_answer")).toBe(true);
  });
});

describe("grelha: secções por estado", () => {
  it("parte pela ordem disponíveis → sem resposta → indisponíveis, sem secções vazias, mantendo a ordem", () => {
    expect(STATUS_SECTION_ORDER).toEqual(["available", "no_answer", "unavailable"]);
    const secs = splitByStatus([carla, ana, bruno, rui, mariana]);
    expect(secs.map((s) => [s.status, s.rows.map((r) => r.employeeId)])).toEqual([
      ["available", [1, 4]],
      ["no_answer", [3, 5]],
      ["unavailable", [2]],
    ]);
    expect(splitByStatus([ana]).map((s) => s.status)).toEqual(["available"]);
  });
  it("abertas por defeito: só 'Disponíveis'; com um estado escolhido, esse", () => {
    expect([...defaultOpenStatuses({ status: "all" })]).toEqual(["available"]);
    expect([...defaultOpenStatuses({ status: "no_answer" })]).toEqual(["no_answer"]);
    expect(sectionKey("none", "no_answer")).toBe("none:no_answer");
    expect(statusSectionTitle("no_answer", 237)).toBe("Sem resposta · 237");
    expect([statusCountLabel("available", 1), statusCountLabel("available", 3), statusCountLabel("unavailable", 1), statusCountLabel("unavailable", 0), statusCountLabel("no_answer", 237)])
      .toEqual(["1 disponível", "3 disponíveis", "1 indisponível", "0 indisponíveis", "237 sem resposta"]);
  });
  it("totais por dia e turno; cabeçalho curto dos dias", () => {
    expect(perDayShiftTotals([MON, TUE], [ana, mariana, row(9, "X", { days: [day(MON, { morning: true, night: true })] })])).toEqual([
      { day: MON, morning: 2, night: 1 },
      { day: TUE, morning: 0, night: 0 },
    ]);
    expect(shortDayHeader("Segunda 19/10")).toEqual({ weekday: "Seg", date: "19/10" });
    expect(shortDayHeader("Sábado 24/10")).toEqual({ weekday: "Sáb", date: "24/10" });
    expect(shortDayHeader("estranho")).toEqual({ weekday: "estranho", date: "" });
  });
  it("lista vazia diz qual filtro a esvaziou", () => {
    expect(emptyAvailabilityMessage(f({ search: " zé " }))).toBe("Sem resultados para “zé”.");
    expect(emptyAvailabilityMessage(f({ windowFrom: 8, windowTo: 10, windowDay: MON }))).toBe("Ninguém disponível das 08h–10h nesse dia.");
    expect(emptyAvailabilityMessage(f({ windowDay: MON }))).toBe("Ninguém marcou disponibilidade nesse dia.");
    expect(emptyAvailabilityMessage(f({ onlyNotContacted24h: true }))).toContain("últimas 24 h");
    expect(emptyAvailabilityMessage(f({ city: "faro" }))).toBe("Nenhum extra neste filtro de cidade.");
    expect(emptyAvailabilityMessage(f({ status: "unavailable" }))).toBe("Nenhum extra com o estado “Indisponíveis” nesta semana.");
    expect(emptyAvailabilityMessage(f())).toContain("Não há extras ativos");
  });
});

describe("ecrã (estrutura)", () => {
  const tab = src("client/src/pages/extrasDia/AvailabilityTab.tsx");
  const grid = src("client/src/pages/extrasDia/AvailabilityGrid.tsx");
  const email = src("client/src/pages/extrasDia/AvailabilityEmailDialog.tsx");
  const wa = src("client/src/pages/extrasDia/AvailabilityWhatsAppDialog.tsx");

  it("a página Disponibilidade continua a importar a secção da ExtrasDiaPage (que só a reexporta)", () => {
    expect(src("client/src/pages/DisponibilidadePage.tsx")).toContain('import { AvailabilitySection } from "@/pages/ExtrasDiaPage";');
    const page = src("client/src/pages/ExtrasDiaPage.tsx");
    expect(page).toContain('export { AvailabilitySection } from "./extrasDia/AvailabilityTab";');
    expect(page).not.toContain("function AvailabilitySection(");
  });
  it("ordem dos blocos: semana + quadrados → filtros → envio → grelha", () => {
    const i = (s: string) => tab.indexOf(s);
    expect(i('role="group" aria-label="Estado da resposta nesta semana"')).toBeGreaterThan(0);
    expect(i('role="group" aria-label="Estado da resposta nesta semana"')).toBeLessThan(i('aria-label="Pesquisar extras por nome ou número"'));
    expect(i('aria-label="Pesquisar extras por nome ou número"')).toBeLessThan(i("<Popover>"));
    expect(i("<Popover>")).toBeLessThan(i('<span className="text-muted-foreground">Para: </span>'));
    expect(i('<span className="text-muted-foreground">Para: </span>')).toBeLessThan(i("<AvailabilityGrid"));
    // Os quadrados SÃO o filtro de estado (não há um seletor de estado à parte).
    expect(tab).toContain("onClick={() => patchFilters({ status: toggleStatusTile(filters.status, t.key) })}");
    expect(tab).not.toContain('aria-label="Estado da resposta">');
  });
  it("'Filtros' guarda o dia/horas e as 24 h, com o número de filtros ligados; os ligados ficam em chips", () => {
    const pop = tab.slice(tab.indexOf("<PopoverContent"), tab.indexOf("</PopoverContent>"));
    expect(pop).toContain("Disponível em");
    expect(pop).toContain('aria-label="Hora de início"');
    expect(pop).toContain("Sem mensagem nas últimas 24h");
    expect(tab).toContain("const popoverCount = availabilityPopoverFilterCount(effective);");
    expect(tab).toContain("Filtros ligados:");
    expect(tab).toContain("<ActiveChip label=\"disponível em\"");
  });
  it("cidade: a de cima manda; sem ela, um seletor compacto com 'Sem cidade'", () => {
    expect(tab).toContain('title={`Segue a cidade escolhida em cima (${CITY_LABELS[globalCity]}).`}');
    expect(tab).toContain('{ key: "none" as const, label: "Sem cidade" }');
    expect(tab).toContain("useEffect(() => { setSelectedIds(new Set()); }, [globalCity]);");
  });
  it("mudar um filtro (menos a pesquisa) limpa a seleção", () => {
    expect(tab).toContain('if (Object.keys(patch).some((k) => k !== "search")) setSelectedIds(new Set());');
  });
  it("a barra de envio diz para quem vai, e os diálogos repetem-no antes de tudo", () => {
    expect(tab).toContain("() => availabilitySendTarget(universe, shownExtras, selectedIds, { filtersActive: anyFilter }),");
    expect(tab).toContain("continuam incluídos no envio.");
    expect(tab).toContain("Limpar seleção");
    expect(email).toContain("<span>Vai {targetPhrase}</span>");
    expect(wa).toContain("<span>Vai {targetPhrase}</span>");
    expect(wa).toContain("sem número válido (ficam de fora)");
    // O email manda SEMPRE a lista explícita e confirma a várias pessoas (já não é um confirm() do browser).
    expect(email).toContain("employeeIds: targetIds,");
    expect(email).toContain("emailConfirmText(scope, count, weekLabel, breakdown)");
    expect(tab).not.toContain("confirm(`");
  });
  it("permissões: sem 'editar' não se envia nem se marca por alguém (o servidor já recusava)", () => {
    expect(tab).toContain('const canEdit = can(user as any, "disponibilidade_extras", "edit");');
    expect(tab).toContain('const canWhatsApp = can(user as any, "whatsapp", "edit");');
    expect(tab).toContain("disabled={!effectiveWeek || target.rows.length === 0 || !canEdit || !!blockReason}");
    expect(grid).toContain("{canEdit && (");
  });
  it("grelha: cidades com contagens, 'Sem resposta' fechada, totais por turno, avisos de número e de canais", () => {
    expect(grid).toContain("sectionOpenRule(sectionOverrides, city, st, status)");
    expect(grid).toContain('aria-label={`Selecionar todos de ${cityGroupLabel(g.key)}`}');
    expect(grid).toContain("Total por turno");
    expect(grid).toContain('"número não reconhecido" : "sem número"');
    expect(grid).toContain('"sem WA" : "sem email"');
    expect(grid).toContain("Mostrar mais {Math.min(AVAILABILITY_PAGE_SIZE, remaining)}");
  });
  it("telemóvel: a grelha faz scroll dentro do cartão, com o nome fixo à esquerda", () => {
    expect(grid).toContain('<div className="overflow-x-auto">');
    expect(grid).toContain('"sticky left-0 z-[1] py-1.5 pl-3 pr-2 align-top');
    expect(tab).toContain('className="grid grid-cols-2 sm:grid-cols-4 gap-2"');
  });
});

describe("auditoria 14 out 2026 (ronda 1)", () => {
  const tab = src("client/src/pages/extrasDia/AvailabilityTab.tsx");
  const grid = src("client/src/pages/extrasDia/AvailabilityGrid.tsx");
  const email = src("client/src/pages/extrasDia/AvailabilityEmailDialog.tsx");
  const wa = src("client/src/pages/extrasDia/AvailabilityWhatsAppDialog.tsx");

  it("barra: 'todos os N' sem filtros, divisão por estado e aviso de secções fechadas; travão com 'Enviar a todos'", () => {
    expect(tab).toContain("<b>{sendTargetShort(target.scope, target.rows.length)}");
    expect(tab).toContain("{breakdown.text && <span");
    expect(tab).toContain("{closedNote ? <b");
    expect(tab).toContain("onClick={() => setAllUnlocked(true)}");
    expect(tab).toContain("disabled={!effectiveWeek || target.rows.length === 0 || !canEdit || !!blockReason}");
    expect(tab).toContain("disabled={target.rows.length === 0 || !canWhatsApp || !!blockReason}");
    expect(tab).toContain("title={!canWhatsApp ? \"Sem permissão para enviar WhatsApp\" : blockReason ?? ");
    // O que está fechado na grelha é sabido pela página (a grelha recebe o estado).
    expect(tab).toContain("openState={gridOpen}");
    expect(grid).toContain("onOpenStateChange({ ...openState, closedCities: next });");
  });
  it("os dois diálogos repetem a divisão e as secções fechadas, também no passo Confirmar; 'Enviar a todos os N'", () => {
    for (const d of [email, wa]) {
      expect(d).toContain("{breakdown && <p");
      expect(d).toContain("Atenção: {closedNote} da grelha.");
      expect(d).toContain("(forceConfirm ? sendAllLabel(scope, ");
    }
    expect(email).toContain("if (!confirming && (forceConfirm || needsBroadcastConfirm(count)))");
    expect(wa).toContain("if (!waConfirm && (forceConfirm || needsBroadcastConfirm(waValidCount)))");
    expect(email).toContain("emailConfirmText(scope, count, weekLabel, breakdown)");
    expect(wa).toContain("{breakdown && <span className=\"block mt-1\">{breakdown}</span>}");
  });
  it("mudar de semana limpa a seleção", () => {
    expect(tab).toContain("useEffect(() => { setSelectedIds(new Set()); }, [effectiveWeek]);");
  });
  it("se a semana sugerida não carregar, aparece o erro com 'Tentar de novo' (nunca 'A carregar…' para sempre)", () => {
    expect(tab).toContain('<QueryErrorNote error={hints.error} onRetry={() => hints.refetch()}');
    expect(tab).toContain("{!o && !overview.error && !(hints.error && !effectiveWeek) && (");
  });
  it("acessibilidade: quadrados com aria-pressed; caixas de cidade/secção/todos com 'alguns' (indeterminate)", () => {
    expect(tab).toContain("aria-pressed={active}");
    expect(tab).not.toContain('role="radio"');
    expect(grid).toContain("ref.current.indeterminate = !!indeterminate && !checked;");
    expect(grid).toContain("indeterminate={selectedInGroup > 0}");
    expect(grid).toContain("indeterminate={selectedInSec > 0}");
    expect(tab).toContain("indeterminate={shownSelectedCount > 0}");
  });
  it("cores do tema, sem hexadecimais à mão", () => {
    for (const f of [tab, grid, email, wa]) {
      expect(f).not.toMatch(/(text|bg|border)-\[#[0-9a-fA-F]{3,6}\]/);
      expect(f).not.toContain("accent-[var(--primary)]");
    }
  });
});

describe("auditoria 14 out 2026 (ronda 2)", () => {
  const tab = src("client/src/pages/extrasDia/AvailabilityTab.tsx");
  const grid = src("client/src/pages/extrasDia/AvailabilityGrid.tsx");
  it("o travão usa o número de estados do alvo e o link diz a quem vai", () => {
    expect(tab).toContain("statesCount: breakdown.statesCount, unlocked: allUnlocked");
    expect(tab).toContain("sendNeedsAllConfirm(target.scope, filters.status, breakdown.statesCount)");
    expect(tab).toContain("{sendAllLabel(target.scope, target.rows.length, breakdown.statesCount)}…");
    expect(tab).not.toContain("Enviar a todos os {target.rows.length}");
  });
  it("'não estão à vista' conta também a paginação: a grelha usa o mesmo estado e as mesmas chaves", () => {
    expect(tab).toContain("const hidden = hiddenGridRowIds(availSort.sorted, gridOpen, { status: filters.status, searching });");
    expect(grid).toContain("const { closedCities, sectionOverrides, shownPer } = openState;");
    expect(grid).toContain("const key = searchListKey(g.key);");
    expect(grid).toContain("onOpenStateChange({ ...openState, shownPer: { ...shownPer, [key]: (shownPer[key] ?? AVAILABILITY_PAGE_SIZE) + by } });");
  });
});
