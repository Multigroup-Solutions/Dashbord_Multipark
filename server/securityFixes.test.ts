import { describe, expect, it } from "vitest";
import { canReadEmployeeRecord, canViewTimeAndSchedule, canEditIdentity, type RhViewer } from "./rhAccess";
import { USER_ROLES, inviteCompletionError, superAdminGuard } from "./userAdminRules";
import { parseLastSignedIn, shouldTouchLastSignedIn, LAST_SIGNED_IN_THROTTLE_MS } from "./_core/lastSignedIn";
import { isGoogleEmailVerified, shouldRejectUnverifiedGoogleEmail } from "./_core/googleIdentity";
import { loginBlockMessage, LOGIN_BLOCKED_FALLBACK_MSG } from "./loginBlock";

describe("canReadEmployeeRecord — próprio / no âmbito / fora / admin de cidade", () => {
  const extra = { role: "extra", employeeId: 40 };
  const front = { role: "frontoffice", employeeId: 20 };
  const admin = { role: "admin", employeeId: null };
  const lisboa = { id: 99, projectId: 10 };
  const porto = { id: 98, projectId: 50 };

  it("a própria ficha passa sempre (mesmo abaixo do role mínimo e fora da cidade)", () => {
    expect(canReadEmployeeRecord(extra, { id: 40, projectId: 50 }, "admin", [10])).toBe(true);
  });
  it("abaixo do role mínimo não lê fichas de terceiros", () => {
    expect(canReadEmployeeRecord(extra, lisboa, "frontoffice", undefined)).toBe(false);
    expect(canReadEmployeeRecord(front, lisboa, "admin", undefined)).toBe(false);
  });
  it("com o role, só dentro do âmbito de cidade", () => {
    expect(canReadEmployeeRecord(front, lisboa, "frontoffice", [10, 11])).toBe(true);
    expect(canReadEmployeeRecord(front, porto, "frontoffice", [10, 11])).toBe(false);
  });
  it("admin limitado a uma cidade não lê outra; admin global lê tudo", () => {
    expect(canReadEmployeeRecord(admin, lisboa, "admin", [10])).toBe(true);
    expect(canReadEmployeeRecord(admin, porto, "admin", [10])).toBe(false);
    expect(canReadEmployeeRecord(admin, porto, "admin", undefined)).toBe(true);
    // ficha sem centro (ou inexistente) só para quem vê todas as cidades
    expect(canReadEmployeeRecord(admin, { id: 7, projectId: null }, "admin", [10])).toBe(false);
  });
});

describe("canViewTimeAndSchedule — team_leader só no seu centro", () => {
  const tl: RhViewer = { id: 4, role: "team_leader", employeeId: 40, scopeProjectIds: [100, 101] };
  it("vê horário/ponto no seu centro de quem está abaixo dele (não de admins)", () => {
    expect(canViewTimeAndSchedule(tl, { id: 1, projectId: 101 })).toBe(true);
    expect(canViewTimeAndSchedule(tl, { id: 5, projectId: 101, role: "condutor" })).toBe(true);
    expect(canViewTimeAndSchedule(tl, { id: 2, projectId: 101, role: "admin" })).toBe(false);
  });
  it("já não vê fichas de outros centros/cidades", () => {
    expect(canViewTimeAndSchedule(tl, { id: 3, projectId: 500 })).toBe(false);
    expect(canViewTimeAndSchedule(tl, { id: 3, projectId: null })).toBe(false);
  });
});

describe("canEditIdentity — email pessoal só admin+", () => {
  const extra: RhViewer = { id: 7, role: "extra", employeeId: 70, scopeProjectIds: null };
  const sup: RhViewer = { id: 6, role: "supervisor", employeeId: 60, scopeProjectIds: [100] };
  const admin: RhViewer = { id: 2, role: "admin", employeeId: 20, scopeProjectIds: null };
  it("nem o próprio nem o gestor do centro mudam o email pessoal", () => {
    expect(canEditIdentity(extra, { id: 70, projectId: 100 })).toBe(false);
    expect(canEditIdentity(sup, { id: 71, projectId: 100 })).toBe(false);
  });
  it("admin sim, excepto em fichas de super_admin", () => {
    expect(canEditIdentity(admin, { id: 71, projectId: 100 })).toBe(true);
    expect(canEditIdentity(admin, { id: 1, projectId: 100, role: "super_admin" })).toBe(false);
  });
});

describe("inviteCompletionError — email da sessão tem de ser o do convite", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const invite = { email: "Maria@Multipark.pt", inviteStatus: "pending", expiresAt: future };
  it("aceita o mesmo email na forma canónica", () => {
    expect(inviteCompletionError(invite, "  maria@multipark.pt ")).toBeNull();
  });
  it("recusa outro email (FORBIDDEN) e sessão sem email", () => {
    expect(inviteCompletionError(invite, "intruso@gmail.com")?.code).toBe("FORBIDDEN");
    expect(inviteCompletionError(invite, null)?.code).toBe("FORBIDDEN");
  });
  it("uso único e validade", () => {
    expect(inviteCompletionError({ ...invite, inviteStatus: "accepted" }, "maria@multipark.pt")?.message).toMatch(/já utilizado/);
    expect(inviteCompletionError({ ...invite, expiresAt: "2020-01-01 00:00:00" }, "maria@multipark.pt")?.message).toMatch(/expirado/);
    expect(inviteCompletionError({ ...invite, inviteStatus: "expired" }, "maria@multipark.pt")?.message).toMatch(/expirado/);
    expect(inviteCompletionError(null, "maria@multipark.pt")?.code).toBe("NOT_FOUND");
  });
});

describe("superAdminGuard + USER_ROLES", () => {
  it("o enum tem exactamente os roles reais", () => {
    expect([...USER_ROLES].sort()).toEqual(["admin", "backoffice", "condutor", "extra", "frontoffice", "super_admin", "supervisor", "team_leader", "user"]);
  });
  const sa = { id: 3, role: "super_admin", isActive: 1 };
  it("não se tira o último super_admin ativo (despromover ou desativar)", () => {
    expect(superAdminGuard(1, sa, "admin", 1)).toMatch(/último super_admin/);
    expect(superAdminGuard(1, sa, null, 1)).toMatch(/último super_admin/);
    expect(superAdminGuard(1, sa, "admin", 2)).toBeNull();
  });
  it("um super_admin não se despromove nem se desativa", () => {
    expect(superAdminGuard(3, sa, "admin", 5)).toMatch(/próprio role/);
    expect(superAdminGuard(3, sa, null, 5)).toMatch(/própria conta/);
  });
  it("mudanças que não tiram super_admin passam", () => {
    expect(superAdminGuard(1, { id: 2, role: "backoffice", isActive: 1 }, "super_admin", 1)).toBeNull();
    expect(superAdminGuard(3, sa, "super_admin", 1)).toBeNull();
    // super_admin já inativo não conta para o mínimo
    expect(superAdminGuard(1, { ...sa, isActive: 0 }, "admin", 1)).toBeNull();
  });
});

describe("lastSignedIn — no máximo uma escrita a cada 5 min", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  it("lê o formato MySQL como UTC", () => {
    expect(parseLastSignedIn("2026-09-24 12:00:00")).toBe(now);
    expect(parseLastSignedIn(new Date(now))).toBe(now);
    expect(parseLastSignedIn("lixo")).toBeNull();
  });
  it("não escreve dentro da janela; escreve depois dela", () => {
    expect(shouldTouchLastSignedIn("2026-09-24 11:58:00", now)).toBe(false);
    expect(shouldTouchLastSignedIn("2026-09-24 11:55:00", now)).toBe(true);
    expect(shouldTouchLastSignedIn(new Date(now - LAST_SIGNED_IN_THROTTLE_MS + 1000), now)).toBe(false);
  });
  it("sem valor ou valor no futuro distante: escreve", () => {
    expect(shouldTouchLastSignedIn(null, now)).toBe(true);
    expect(shouldTouchLastSignedIn("2026-09-24 14:00:00", now)).toBe(true);
  });
});

describe("Google email_verified", () => {
  it("recusa email não verificado", () => {
    expect(shouldRejectUnverifiedGoogleEmail({ email: "a@b.pt", email_verified: false })).toBe(true);
    expect(shouldRejectUnverifiedGoogleEmail({ email: "a@b.pt", email_verified: "false" })).toBe(true);
    expect(shouldRejectUnverifiedGoogleEmail({ email: "a@b.pt" })).toBe(true);
  });
  it("aceita verificado (booleano ou texto)", () => {
    expect(shouldRejectUnverifiedGoogleEmail({ email: "a@b.pt", email_verified: true })).toBe(false);
    expect(isGoogleEmailVerified({ email: "a@b.pt", email_verified: "true" })).toBe(true);
  });
  it("sem email não há nada a verificar", () => {
    expect(shouldRejectUnverifiedGoogleEmail({ email: "", email_verified: false })).toBe(false);
  });
});

describe("loginBlockMessage — bloqueio aplicado no servidor", () => {
  it("bloqueia abaixo de admin com o motivo em PT-PT", () => {
    expect(loginBlockMessage("extra", { loginBlocked: 1, loginBlockedReason: "Documentos em falta." })).toBe("Acesso bloqueado: Documentos em falta.");
    expect(loginBlockMessage("team_leader", { loginBlocked: true })).toBe(LOGIN_BLOCKED_FALLBACK_MSG);
  });
  it("não bloqueia sem flag, sem ficha, nem admin+", () => {
    expect(loginBlockMessage("extra", { loginBlocked: 0 })).toBeNull();
    expect(loginBlockMessage("extra", null)).toBeNull();
    expect(loginBlockMessage("admin", { loginBlocked: 1 })).toBeNull();
    expect(loginBlockMessage("super_admin", { loginBlocked: 1 })).toBeNull();
  });
});
