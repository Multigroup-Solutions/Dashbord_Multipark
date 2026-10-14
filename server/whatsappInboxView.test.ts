import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_INBOX_FILTERS,
  activeInboxFilterCount,
  avatarToneIndex,
  contactInitials,
  conversationCityKey,
  matchesCityFilter,
  inboxCityScope,
  inboxBoxCounts,
  daySeparatorLabel,
  localDayKey,
} from "../shared/whatsappInboxView";

describe("contactInitials", () => {
  it("primeiro + último nome", () => {
    expect(contactInitials("Ana Maria Sousa")).toBe("AS");
    expect(contactInitials("  joão  ")).toBe("J");
  });
  it("acentos e letras não latinas", () => {
    expect(contactInitials("Íris Ângelo")).toBe("ÍÂ");
  });
  it("número sem nome → últimos 2 dígitos", () => {
    expect(contactInitials("+351 912 345 678")).toBe("78");
    expect(contactInitials("+351912345678")).toBe("78");
  });
  it("vazio → ?", () => {
    expect(contactInitials("")).toBe("?");
    expect(contactInitials(null)).toBe("?");
  });
  it("ignora tokens sem letras (ex.: emojis/números soltos)", () => {
    expect(contactInitials("Rui 2 🚗 Costa")).toBe("RC");
  });
});

describe("avatarToneIndex", () => {
  it("é determinístico e fica dentro da paleta", () => {
    const a = avatarToneIndex("Ana Sousa", 8);
    expect(avatarToneIndex("Ana Sousa", 8)).toBe(a);
    expect(avatarToneIndex("  ana sousa ", 8)).toBe(a);
    for (const n of ["", "x", "Maria", "+351912345678", "Zé Manel"]) {
      const i = avatarToneIndex(n, 8);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(8);
    }
  });
  it("paleta vazia → 0", () => {
    expect(avatarToneIndex("Ana", 0)).toBe(0);
  });
});

// Horas de LISBOA (17a), sejam quais forem as do aparelho. Outubro = UTC+1.
const lx = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h - (mo >= 4 && mo <= 10 ? 1 : 0), mi);

describe("daySeparatorLabel", () => {
  const now = lx(2026, 10, 1, 15, 0); // qua 01/10/2026 15:00 em Lisboa
  it("Hoje / Ontem (dias de Lisboa)", () => {
    expect(daySeparatorLabel(lx(2026, 10, 1, 0, 5), now)).toBe("Hoje");
    expect(daySeparatorLabel(lx(2026, 9, 30, 23, 59), now)).toBe("Ontem");
    // 23:30 UTC de 30/09 = 00:30 de 01/10 em Lisboa → hoje
    expect(daySeparatorLabel(Date.UTC(2026, 8, 30, 23, 30), now)).toBe("Hoje");
  });
  it("últimos 7 dias → dia da semana com maiúscula", () => {
    const label = daySeparatorLabel(lx(2026, 9, 28, 10, 0), now);
    expect(label).toBe("Segunda-feira");
  });
  it("mais antigo → dd/mm; outro ano → dd/mm/aaaa", () => {
    expect(daySeparatorLabel(lx(2026, 9, 3, 10, 0), now)).toBe("03/09");
    expect(daySeparatorLabel(lx(2025, 12, 31, 10, 0), now)).toBe("31/12/2025");
  });
});

describe("localDayKey", () => {
  it("agrupa pelo dia de Lisboa", () => {
    expect(localDayKey(lx(2026, 10, 1, 0, 0))).toBe("2026-10-01");
    expect(localDayKey(lx(2026, 10, 1, 23, 59))).toBe("2026-10-01");
    expect(localDayKey(lx(2026, 10, 2, 0, 0))).toBe("2026-10-02");
    expect(localDayKey(Date.UTC(2026, 8, 30, 23, 30))).toBe("2026-10-01");
  });
});

describe("activeInboxFilterCount", () => {
  it("omissão = 0", () => {
    expect(activeInboxFilterCount(DEFAULT_INBOX_FILTERS)).toBe(0);
  });
  it("conta cada filtro diferente do valor por omissão", () => {
    expect(activeInboxFilterCount({ ...DEFAULT_INBOX_FILTERS, assignee: "mine" })).toBe(1);
    expect(
      activeInboxFilterCount({
        assignee: "unassigned",
        status: "pendente",
        intent: "reclamacao",
        onlyNoCity: true,
        onlyUnread: true,
        onlyUrgent: true,
        onlyAlerts: true,
      }),
    ).toBe(7);
  });
});

describe("conversationCityKey (cidade da pessoa da conversa)", () => {
  it("a ficha manda sobre o lead e a reserva", () => {
    expect(conversationCityKey({ employeeCity: "porto", leadCity: "lisboa", bookingCity: "faro" })).toBe("porto");
  });
  it("ficha sem cidade → lead → reserva", () => {
    expect(conversationCityKey({ employeeCity: null, leadCity: "faro", bookingCity: "lisboa" })).toBe("faro");
    expect(conversationCityKey({ employeeCity: null, leadCity: null, bookingCity: "lisboa" })).toBe("lisboa");
  });
  it("nada conhecido → null (nunca se adivinha)", () => {
    expect(conversationCityKey({ employeeCity: null, leadCity: null, bookingCity: null })).toBeNull();
  });
});

describe("matchesCityFilter", () => {
  it("all deixa passar tudo, incluindo sem cidade", () => {
    expect(matchesCityFilter("porto", "all")).toBe(true);
    expect(matchesCityFilter(null, "all")).toBe(true);
  });
  it("Porto mostra SÓ Porto — nem Lisboa, nem Faro, nem sem cidade", () => {
    expect(matchesCityFilter("porto", "porto")).toBe(true);
    expect(matchesCityFilter("lisboa", "porto")).toBe(false);
    expect(matchesCityFilter("faro", "porto")).toBe(false);
    expect(matchesCityFilter(null, "porto")).toBe(false);
    expect(matchesCityFilter(undefined, "porto")).toBe(false);
  });
  it("none = só as sem cidade conhecida", () => {
    expect(matchesCityFilter(null, "none")).toBe(true);
    expect(matchesCityFilter(undefined, "none")).toBe(true);
    expect(matchesCityFilter("lisboa", "none")).toBe(false);
  });
});

describe("matchesCityFilter com as sem cidade (2026-10-14)", () => {
  it("Porto + sem cidade: Porto e as sem cidade passam, as outras cidades não", () => {
    expect(matchesCityFilter("porto", "porto", true)).toBe(true);
    expect(matchesCityFilter(null, "porto", true)).toBe(true);
    expect(matchesCityFilter(undefined, "porto", true)).toBe(true);
    expect(matchesCityFilter("lisboa", "porto", true)).toBe(false);
  });
  it("none continua a ser SÓ as sem cidade", () => {
    expect(matchesCityFilter("lisboa", "none", true)).toBe(false);
  });
});

describe("inboxCityScope (a cidade segue o seletor de cima)", () => {
  it("cidade escolhida em cima → essa cidade + as sem cidade (ninguém perde conversas)", () => {
    expect(inboxCityScope({ globalCity: "faro", onlyNoCity: false })).toEqual({ cityKey: "faro", withNoCity: true });
  });
  it("todas as cidades → sem filtro", () => {
    expect(inboxCityScope({ globalCity: null, onlyNoCity: false })).toEqual({ cityKey: "all", withNoCity: false });
  });
  it("chip Sem cidade → só as sem cidade, com ou sem cidade em cima", () => {
    expect(inboxCityScope({ globalCity: "lisboa", onlyNoCity: true })).toEqual({ cityKey: "none", withNoCity: false });
    expect(inboxCityScope({ globalCity: null, onlyNoCity: true })).toEqual({ cityKey: "none", withNoCity: false });
  });
  it("o chip Sem cidade conta como filtro; a caixa e a cidade já não", () => {
    expect(activeInboxFilterCount({ ...DEFAULT_INBOX_FILTERS, onlyNoCity: true })).toBe(1);
    expect(Object.keys(DEFAULT_INBOX_FILTERS)).not.toContain("box");
    expect(Object.keys(DEFAULT_INBOX_FILTERS)).not.toContain("city");
  });
});

describe("inboxBoxCounts (coluna das caixas)", () => {
  it("conta por caixa, Geral = sem caixa, e as por ler", () => {
    const m = inboxBoxCounts([
      { boxKey: "rh", unreadCount: 2 },
      { boxKey: "rh", unreadCount: 0 },
      { boxKey: null, unreadCount: 1 },
      { boxKey: undefined, unreadCount: 0 },
      { boxKey: "", unreadCount: 0 },
    ]);
    expect(m.get("all")).toEqual({ total: 5, unread: 2 });
    expect(m.get("rh")).toEqual({ total: 2, unread: 1 });
    expect(m.get("geral")).toEqual({ total: 3, unread: 1 });
    expect(m.get("reservas")).toBeUndefined();
  });
});

describe("página do WhatsApp como as caixas de email (2026-10-14)", () => {
  const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
  const page = src("client/src/pages/WhatsAppInboxPage.tsx");
  const header = src("client/src/components/whatsapp/InboxListHeader.tsx");
  it("três colunas no PC: caixas | conversas | conversa; o menu recolhe ao entrar (não embutida)", () => {
    expect(page).toContain('<div className="w-52 xl:w-60 shrink-0 min-h-0">{boxesColumn}</div>');
    expect(page).toContain("if (embedded || sidebar.isMobile) return;");
    expect(header).toContain('aria-label="Caixas de WhatsApp"');
  });
  it("a cidade segue o seletor de cima: sem seletor de cidade no topo da lista", () => {
    expect(header).not.toContain("Todas as cidades</SelectItem>");
    expect(page).toContain("inboxCityScope({ globalCity: globalCityKey, onlyNoCity: filters.onlyNoCity })");
  });
});
