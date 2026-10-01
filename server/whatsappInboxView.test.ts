import { describe, expect, it } from "vitest";
import {
  DEFAULT_INBOX_FILTERS,
  activeInboxFilterCount,
  avatarToneIndex,
  contactInitials,
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

describe("daySeparatorLabel", () => {
  const now = new Date(2026, 9, 1, 15, 0).getTime(); // qua 01/10/2026 15:00 local
  it("Hoje / Ontem", () => {
    expect(daySeparatorLabel(new Date(2026, 9, 1, 0, 5).getTime(), now)).toBe("Hoje");
    expect(daySeparatorLabel(new Date(2026, 8, 30, 23, 59).getTime(), now)).toBe("Ontem");
  });
  it("últimos 7 dias → dia da semana com maiúscula", () => {
    const label = daySeparatorLabel(new Date(2026, 8, 28, 10, 0).getTime(), now);
    expect(label).not.toMatch(/^\d/);
    expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
  });
  it("mais antigo → dd/mm; outro ano → dd/mm/aaaa", () => {
    expect(daySeparatorLabel(new Date(2026, 8, 3, 10, 0).getTime(), now)).toBe("03/09");
    expect(daySeparatorLabel(new Date(2025, 11, 31, 10, 0).getTime(), now)).toBe("31/12/2025");
  });
});

describe("localDayKey", () => {
  it("agrupa pelo dia local", () => {
    expect(localDayKey(new Date(2026, 9, 1, 0, 0).getTime())).toBe("2026-10-01");
    expect(localDayKey(new Date(2026, 9, 1, 23, 59).getTime())).toBe("2026-10-01");
    expect(localDayKey(new Date(2026, 9, 2, 0, 0).getTime())).toBe("2026-10-02");
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
        onlyUnread: true,
        onlyUrgent: true,
        onlyAlerts: true,
      }),
    ).toBe(6);
  });
});
