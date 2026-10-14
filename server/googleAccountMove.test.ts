/**
 * 15 out 2026 — "Passar a conta Google" (caso Thiago Camargo): a Workspace
 * renomeou a conta de quem saiu (Carlos Jesus) para a pessoa nova. A conta
 * antiga larga a Google e guarda o histórico; a nova passa a entrar com ela.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planGoogleMove, moveGoogleAccount, type MoveAccountRow } from "./googleAccountMove";
import { resolveGoogleAccount } from "./loginAccount";

const carlos: MoveAccountRow = { id: 20582, name: "Thiago Camargo", email: "thiagocamargo@multipark.pt", openId: "google_108805", googleSub: "108805", isActive: 0, role: "team_leader" };
const thiago: MoveAccountRow = { id: 108360, name: "Thiago Camargo", email: "thiagohcamargo1@gmail.com", openId: "google_109251", googleSub: "109251", isActive: 1, role: "team_leader" };
const carlosFicha = { id: 360, fullName: "Carlos Jesus", email: "carlosjesus@multipark.pt" };

describe("planGoogleMove (regras)", () => {
  it("passa da conta desativada para a ativa; a antiga volta ao nome/email da ficha", () => {
    const p = planGoogleMove({ from: carlos, to: thiago, fromEmployee: carlosFicha, nowMs: 1_000_000 });
    expect(p.restore).toEqual({ name: "Carlos Jesus", email: "carlosjesus@multipark.pt", employeeId: 360 });
    expect(p.googleEmail).toBe("thiagocamargo@multipark.pt");
    expect(p.releasedOpenId).toBe("released_20582_1000");
  });
  it("recusa: conta antiga ativa, nova desativada, a mesma conta, sem Google", () => {
    expect(() => planGoogleMove({ from: { ...carlos, isActive: 1 }, to: thiago, fromEmployee: null, nowMs: 0 })).toThrow(/DESATIVADA/);
    expect(() => planGoogleMove({ from: carlos, to: { ...thiago, isActive: 0 }, fromEmployee: null, nowMs: 0 })).toThrow(/ativa/);
    expect(() => planGoogleMove({ from: carlos, to: { ...carlos, isActive: 1 }, fromEmployee: null, nowMs: 0 })).toThrow(/diferentes/);
    expect(() => planGoogleMove({ from: { ...carlos, googleSub: null, openId: "email_abc" }, to: thiago, fromEmployee: null, nowMs: 0 })).toThrow(/nenhuma conta Google/);
  });
});

/** BD falsa: users em memória; UPDATE condicionais como no MySQL. */
function fakeDb(users: MoveAccountRow[], employees: Array<{ id: number; userId: number; fullName: string; email: string; isActive: number }>) {
  // drizzle: o texto vem em StringChunk ({ value: [...] }), os valores vêm crus; um sql`` dentro de outro achata-se
  const chunks = (q: any): any[] => (q?.queryChunks ?? []).flatMap((c: any) => (c?.queryChunks ? chunks(c) : [c]));
  const isText = (c: any) => c != null && typeof c === "object" && Array.isArray(c.value);
  const textOf = (q: any) => chunks(q).map((c: any) => (isText(c) ? c.value.join("") : "?")).join("");
  const params = (q: any) => chunks(q).filter((c: any) => !isText(c));
  return {
    users,
    async execute(q: any) {
      const t = textOf(q);
      const ps = params(q);
      if (/^SELECT .*FROM users WHERE id =/s.test(t.replace(/\s+/g, " ").trim()) || t.includes("FROM users WHERE id =")) {
        const id = Number(ps[ps.length - 1]);
        return [users.filter((u) => u.id === id).map((u) => ({ ...u }))];
      }
      if (t.includes("FROM employees WHERE userId =")) {
        const id = Number(ps[0]);
        return [employees.filter((e) => e.userId === id).sort((a, b) => b.isActive - a.isActive || a.id - b.id).slice(0, 1)];
      }
      if (t.includes("UPDATE users SET googleSub = NULL")) {
        const [releasedOpenId, name, email, id, openId] = ps;
        const u = users.find((x) => x.id === Number(id) && Number(x.isActive) === 0 && x.openId === openId);
        if (!u) return [{ affectedRows: 0 }];
        u.googleSub = null; u.openId = String(releasedOpenId); u.name = (name as any) ?? u.name; u.email = (email as any) ?? u.email;
        return [{ affectedRows: 1 }];
      }
      if (t.includes("UPDATE users SET googleSub =")) {
        const withEmail = t.includes("email =");
        const sub = ps[0]; const email = withEmail ? ps[1] : null; const id = withEmail ? ps[2] : ps[1];
        const u = users.find((x) => x.id === Number(id) && Number(x.isActive) === 1);
        if (!u) return [{ affectedRows: 0 }];
        u.googleSub = String(sub); if (withEmail) u.email = String(email);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`SQL inesperado: ${t}`);
    },
  };
}

describe("moveGoogleAccount (BD)", () => {
  it("o caso do Thiago: Carlos fica com o nome/email e o histórico; o Thiago entra com a Google da Multipark (e a do Gmail continua)", async () => {
    const db = fakeDb([{ ...carlos }, { ...thiago }], [{ id: 360, userId: 20582, fullName: "Carlos Jesus", email: "carlosjesus@multipark.pt", isActive: 0 }]);
    const r = await moveGoogleAccount(db as any, { fromUserId: 20582, toUserId: 108360, setEmail: true, nowMs: 5_000 });
    expect(r.emailSet).toBe(true);
    const c = db.users.find((u) => u.id === 20582)!;
    const t = db.users.find((u) => u.id === 108360)!;
    expect(c).toMatchObject({ id: 20582, googleSub: null, openId: "released_20582_5", name: "Carlos Jesus", email: "carlosjesus@multipark.pt", isActive: 0 });
    expect(t).toMatchObject({ id: 108360, googleSub: "108805", openId: "google_109251", email: "thiagocamargo@multipark.pt" });

    // o login: a Google da Multipark cai na conta do Thiago; a do Gmail também (pelo openId)
    const store = {
      userByGoogleSub: async (s: string) => db.users.find((u) => u.googleSub === s) as any,
      userByOpenId: async (o: string) => db.users.find((u) => u.openId === o) as any,
    } as any;
    const multipark = await resolveGoogleAccount(store, { sub: "108805", email: "thiagocamargo@multipark.pt", codeLogin: false });
    expect(multipark).toMatchObject({ kind: "linked", user: { id: 108360 } });
    const gmail = await resolveGoogleAccount(store, { sub: "109251", email: "thiagohcamargo1@gmail.com", codeLogin: false });
    expect(gmail).toMatchObject({ kind: "default", existing: { id: 108360 } });
  });
  it("dois cliques seguidos: o segundo é recusado (a conta antiga já largou a Google)", async () => {
    const db = fakeDb([{ ...carlos }, { ...thiago }], [{ id: 360, userId: 20582, fullName: "Carlos Jesus", email: "carlosjesus@multipark.pt", isActive: 0 }]);
    await moveGoogleAccount(db as any, { fromUserId: 20582, toUserId: 108360, setEmail: false });
    await expect(moveGoogleAccount(db as any, { fromUserId: 20582, toUserId: 108360, setEmail: false })).rejects.toThrow(/nenhuma conta Google/);
    expect(db.users.find((u) => u.id === 108360)!.email).toBe("thiagohcamargo1@gmail.com"); // sem setEmail o email não muda
  });
});

describe("rota e ecrã", () => {
  const r = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
  it("só admin/super admin, com rh manage e as fichas no âmbito; fica no registo das duas contas", () => {
    const i = r.indexOf("moveGoogleAccount: protectedProcedure");
    const block = r.slice(i, i + 2600);
    expect(block).toContain('requireAccess(ctx.user, "rh", "manage")');
    expect(block).toContain('["admin", "super_admin"].includes(String(ctx.user.role))');
    expect(block).toContain("await assertEmployeeAccess(Number(e.id))");
    expect(block.match(/action: "users_google_move"/g)?.length).toBe(2);
  });
  it("o MCP pessoal pode fazê-lo (área Utilizadores) e o ecrã das Ligações tem o botão nas contas desativadas", () => {
    expect(readFileSync(new URL("./mcpProceduresApi.ts", import.meta.url), "utf8")).toContain('"identityLinks.moveGoogleAccount": { area: "Utilizadores" }');
    const c = readFileSync(new URL("../client/src/components/PersonIdentityCard.tsx", import.meta.url), "utf8");
    expect(c).toContain("{!a.isActive && canMerge && (");
    expect(c).toContain("Passar a conta Google");
  });
});
