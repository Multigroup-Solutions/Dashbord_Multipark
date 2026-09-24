import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Sem BD nos testes: o middleware de cidades (centro de custos) dá acesso total.
vi.mock("./cityAccess", async original => ({
  ...await original<object>(),
  loadCityAccess: async () => ({ all: true, defaultCityId: null, cityIds: [], projectIds: [], missingCostCenter: false }),
}));

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "admin@example.com",
    name: "Admin User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

function createUserContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "regular-user",
    email: "user@example.com",
    name: "Regular User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

describe("rh.documents.checklist", () => {
  it("returns checklist with 7 mandatory document types for admin", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const checklist = await caller.rh.documents.checklist({ employeeId: 99999 });
    expect(Array.isArray(checklist)).toBe(true);
    expect(checklist.length).toBe(7);
    const types = checklist.map((c: any) => c.docType);
    expect(types).toContain("photo");
    expect(types).toContain("id_card");
    expect(types).toContain("driving_license");
    expect(types).toContain("nib_proof");
    expect(types).toContain("address_proof");
    expect(types).toContain("contract");
    expect(types).toContain("responsibility_term");
    // For a non-existent employee, all should be not present
    for (const item of checklist) {
      expect(item.present).toBe(false);
    }
  });

  it("rejects non-admin users", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.rh.documents.checklist({ employeeId: 1 })).rejects.toThrow();
  });
});

describe("rh.documents.allStatus", () => {
  it("returns document status map for admin", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const status = await caller.rh.documents.allStatus();
    expect(typeof status).toBe("object");
    // Should be a record (could be empty if no employees have docs)
    expect(status).toBeDefined();
  });

  it("rejects non-admin users", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.rh.documents.allStatus()).rejects.toThrow();
  });
});

describe("rh.documents.uploadBatch", () => {
  it("rejects non-admin users", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(
      caller.rh.documents.uploadBatch({
        employeeId: 1,
        docType: "id_card",
        files: [{ fileBase64: "dGVzdA==", mimeType: "image/png", fileName: "test.png" }],
      })
    ).rejects.toThrow();
  });
});
