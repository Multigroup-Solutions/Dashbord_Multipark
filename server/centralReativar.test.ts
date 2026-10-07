/**
 * Jorge (7 out 2026): "não me deixa entrar, diz que o acesso está revogado" —
 * um acesso da Central revogado por engano reativa-se com a mesma palavra-passe.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(p, "utf8");

describe("Central: reativar um acesso revogado", () => {
  const router = src("server/centralRouter.ts");
  const block = router.split("reactivateAccount: superOnly")[1]?.slice(0, 1600) ?? "";
  it("só super admin, só contas ativas, sem apagar e com registo", () => {
    expect(block).toMatch(/\.input\(z\.object\(\{ id: z\.number\(\)\.int\(\)\.positive\(\) \}\)\)/);
    expect(block).toMatch(/Number\(a\.isActive\) !== 1/);
    expect(block).toMatch(/SET revokedAt = NULL, revokedById = NULL WHERE id = \$\{input\.id\} AND revokedAt IS NOT NULL/);
    expect(block).toMatch(/action: "reactivate"/);
    expect(block).toMatch(/estava revogado desde/);
    expect(block).not.toMatch(/DELETE FROM/);
  });
  it("o ecrã mostra quem revogou e tem Reativar com confirmação", () => {
    expect(router).toMatch(/rb\.name AS revokedByName/);
    const ui = src("client/src/components/central/CentralVodafoneCard.tsx");
    expect(ui).toMatch(/trpc\.central\.reactivateAccount\.useMutation/);
    expect(ui).toMatch(/Reativar o acesso/);
    expect(ui).not.toMatch(/Não se desfaz: cria-se outro acesso/);
  });
  it("o login da consola continua a recusar acessos revogados", () => {
    const sugar = src("server/centralSugar.ts");
    expect(sugar).toMatch(/WHERE a\.username = \$\{username\} AND a\.revokedAt IS NULL/);
  });
});
