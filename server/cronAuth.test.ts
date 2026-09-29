import { describe, expect, it } from "vitest";
import { bearerMatches, bearerToken, cronAuthOk, safeEqual } from "./cronAuth";
import { cronBearerOk } from "./opsRules";

describe("autenticação partilhada dos crons", () => {
  it("compara em tempo constante e só aceita o segredo exato", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
  it("extrai o Bearer (com trim, maiúsculas indiferentes)", () => {
    expect(bearerToken("Bearer xyz")).toBe("xyz");
    expect(bearerToken("  bearer   xyz  ")).toBe("xyz");
    expect(bearerToken(["Bearer a", "Bearer b"])).toBe("a");
    expect(bearerToken("Basic xyz")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
  it("o segredo com espaços/quebra de linha no painel continua a funcionar", () => {
    expect(cronAuthOk("Bearer cron123", { CRON_SECRET: "cron123\n" })).toBe(true);
    expect(cronAuthOk("Bearer cron123 ", { CRON_SECRET: " cron123" })).toBe(true);
  });
  it("sem segredo configurado nunca autoriza", () => {
    expect(cronAuthOk("Bearer ", {})).toBe(false);
    expect(cronAuthOk("Bearer x", { CRON_SECRET: "   " })).toBe(false);
    expect(bearerMatches("Bearer x", undefined)).toBe(false);
  });
  it("recusa segredo errado e o /api/health usa a mesma regra", () => {
    expect(cronAuthOk("Bearer nope", { CRON_SECRET: "cron123" })).toBe(false);
    expect(cronBearerOk("Bearer cron123", { CRON_SECRET: "cron123" })).toBe(true);
    expect(cronBearerOk("Bearer nope", { CRON_SECRET: "cron123" })).toBe(false);
  });
});
