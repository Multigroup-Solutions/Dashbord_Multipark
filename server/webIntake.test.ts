import { describe, expect, it } from "vitest";
import { mapWebsiteDay, normalizeEmail, parseFreeTextRange } from "./webIntake";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Joao.Silva@Gmail.COM ")).toBe("joao.silva@gmail.com");
  });
});

describe("parseFreeTextRange", () => {
  it("parses 09H-18H", () => {
    expect(parseFreeTextRange("09H-18H")).toEqual({ from: 9, to: 18 });
  });
  it("parses '9 às 18'", () => {
    expect(parseFreeTextRange("9 às 18")).toEqual({ from: 9, to: 18 });
  });
  it("extends ranges crossing midnight", () => {
    expect(parseFreeTextRange("22H-02H")).toEqual({ from: 22, to: 26 });
  });
  it("rejects non-hours", () => {
    expect(parseFreeTextRange("talvez")).toBeNull();
    expect(parseFreeTextRange("99-105")).toBeNull();
  });
});

describe("mapWebsiteDay", () => {
  it("returns null for an empty day", () => {
    expect(mapWebsiteDay([], "")).toBeNull();
  });

  it("keeps 'NÃO' as a note only (day counts as answered but unavailable)", () => {
    expect(mapWebsiteDay([], "NÃO")).toEqual({ note: "NÃO" });
    expect(mapWebsiteDay([], "nao")).toEqual({ note: "nao" });
  });

  it("maps a single morning slot", () => {
    expect(mapWebsiteDay(["08H-15H"], "")).toEqual({
      morning: true,
      night: false,
      fromHour: 8,
      toHour: 15,
      note: null,
    });
  });

  it("maps a night slot crossing midnight (toHour stored mod 24)", () => {
    expect(mapWebsiteDay(["15H-01H"], "")).toEqual({
      morning: false,
      night: true,
      fromHour: 15,
      toHour: 1,
      note: null,
    });
  });

  it("unions multiple slots into one range with both shifts", () => {
    expect(mapWebsiteDay(["04H-08H", "18H-01H"], "")).toEqual({
      morning: true,
      night: true,
      fromHour: 4,
      toHour: 1,
      note: null,
    });
  });

  it("parses an hour range out of free text", () => {
    expect(mapWebsiteDay([], "09H-18H")).toEqual({
      morning: true,
      night: true,
      fromHour: 9,
      toHour: 18,
      note: "09H-18H",
    });
  });

  it("keeps uninterpretable free text as a note", () => {
    expect(mapWebsiteDay([], "só se for mesmo preciso")).toEqual({ note: "só se for mesmo preciso" });
  });

  it("ignores unknown slot codes but keeps valid ones", () => {
    expect(mapWebsiteDay(["XX", "04H-15H"], "")).toEqual({
      morning: true,
      night: false,
      fromHour: 4,
      toHour: 15,
      note: null,
    });
  });
});
