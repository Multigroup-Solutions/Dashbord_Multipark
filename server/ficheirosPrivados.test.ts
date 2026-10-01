import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Ficheiros privados (P1, 1 out 2026): os procedimentos devolvem links
// ASSINADOS só a quem pode abrir o ficheiro, o que o cliente devolve volta a
// URL canónica, e as keys vindas do cliente não apontam para outro módulo.

const BUCKET = "dashboard-multipark-bucket";
const REGION = "eu-west-1";
const BASE = `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
const OWN_PHOTO = `${BASE}/employees/7/photo-1700000000.jpg`;
const OTHER_DOC = `${BASE}/employees/5/docs/id_card-1700000000-cc.jpg`;

const state = vi.hoisted(() => ({ created: 0 }));
vi.mock("./cityAccess", async (original) => ({
  ...(await original<object>()),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityName: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));
vi.mock("./db", async (original) => ({
  ...(await original<object>()),
  getUserModuleOverrides: async () => ({}),
  getUserPermissionOverrides: async () => ({}),
  getEmployeeByUserId: async (userId: number) => (userId === 30
    ? { employee: { id: 7, fullName: "Condutor", position: "driver", photoUrl: OWN_PHOTO, projectId: 49, loginBlocked: 0, loginBlockedReason: null } }
    : undefined),
  getEmployeeById: async (id: number) => ({ employee: { id, projectId: 49, userId: null } }),
  getUserById: async () => null,
  createTrainingManual: async () => { state.created++; return { id: 1 }; },
  logActivity: async () => undefined,
}));

import { appRouter } from "./routers";
import { publicProcedure, router } from "./_core/trpc";
import { _resetSignCache } from "./storageSign";
import { storageKeyOf, uploadRefsAllowed } from "./storageRefs";

const ENV = {
  AWS_S3_REGION: REGION,
  AWS_S3_BUCKET_NAME: BUCKET,
  AWS_S3_ACCESS_KEY: "AKIAFAKEFAKEFAKE",
  AWS_S3_SECRET_ACCESS_KEY: "fakesecretfakesecretfakesecret",
};
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  _resetSignCache();
  state.created = 0;
});
afterEach(() => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const ctxFor = (user: Record<string, unknown> | null) => ({ user, req: { headers: {} }, res: { clearCookie: () => undefined } }) as any;

describe("procedimentos devolvem links assinados só a quem os pode abrir", () => {
  it("auth.me: a foto do próprio sai assinada; a URL de um documento de outra ficha (num campo de texto) não", async () => {
    // o nome da conta traz a URL de um documento de RH — p.ex. colada num campo livre
    const me: any = await appRouter.createCaller(ctxFor({ id: 30, role: "condutor", name: OTHER_DOC })).auth.me();
    expect(me.employee.photoUrl).toContain("X-Amz-Signature=");
    expect(decodeURIComponent(new URL(me.employee.photoUrl).pathname)).toBe("/employees/7/photo-1700000000.jpg");
    expect(me.name).toBe(OTHER_DOC); // fica a URL canónica: com o bucket privado não abre
  });

  it("à entrada, um link assinado volta à URL canónica antes de chegar ao procedimento", async () => {
    const seen: string[] = [];
    const echo = router({
      save: publicProcedure.input(z.object({ photoUrl: z.string() })).mutation(({ input }) => { seen.push(input.photoUrl); return { ok: true }; }),
    });
    const me: any = await appRouter.createCaller(ctxFor({ id: 30, role: "condutor", name: "x" })).auth.me();
    await echo.createCaller(ctxFor({ id: 30, role: "condutor" })).save({ photoUrl: me.employee.photoUrl });
    expect(seen).toEqual([OWN_PHOTO]);
  });
});

describe("keys vindas do cliente", () => {
  it("storageKeyOf: key crua, URL deste bucket, URL relativa local; Blob e externas não são nossas", () => {
    const env = { region: REGION, bucket: BUCKET, accessKeyId: "a", secretAccessKey: "b", publicBaseUrl: BASE };
    expect(storageKeyOf("employees/5/docs/x.pdf", env)).toBe("employees/5/docs/x.pdf");
    expect(storageKeyOf(`${BASE}/employees/5/docs/x.pdf?X-Amz-Signature=1`, env)).toBe("employees/5/docs/x.pdf");
    expect(storageKeyOf("/uploads/training/manuals/1-a.pdf", env)).toBe("training/manuals/1-a.pdf");
    expect(storageKeyOf("https://abc.public.blob.vercel-storage.com/x.pdf", env)).toBeNull();
    expect(storageKeyOf("https://youtube.com/watch?v=1", env)).toBeNull();
    expect(storageKeyOf("", env)).toBeNull();
    expect(uploadRefsAllowed(["uploads/1-a.pdf", "https://example.com/a"], ["uploads/", "training/"], env)).toBe(true);
    expect(uploadRefsAllowed(["uploads/1-a.pdf", OTHER_DOC], ["uploads/", "training/"], env)).toBe(false);
  });

  it("um manual da Formação não pode apontar para um documento de RH", async () => {
    const c = appRouter.createCaller(ctxFor({ id: 2, role: "admin" }));
    await expect(c.training.createManual({ title: "M", content: "", fileKey: "employees/5/docs/id_card-1-cc.jpg" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Anexo inválido") });
    await expect(c.training.createManual({ title: "M", content: "", type: "link" as any, fileUrl: OTHER_DOC }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Anexo inválido") });
    expect(state.created).toBe(0);
    await c.training.createManual({ title: "M", content: "", fileKey: "uploads/1700-abc.pdf", fileUrl: `${BASE}/uploads/1700-abc.pdf` });
    expect(state.created).toBe(1);
  });

  it("a foto da ficha não pode ser a key de um documento nem a foto de outra ficha", async () => {
    const c = appRouter.createCaller(ctxFor({ id: 2, role: "admin" }));
    await expect(c.rh.update({ id: 10, photoKey: "employees/5/docs/id_card-1-cc.jpg" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Foto inválida") });
    await expect(c.rh.update({ id: 10, photoUrl: `${BASE}/employees/11/photo-1.jpg` })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Foto inválida") });
  });
});
