import type { Express, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
vi.mock("./oauth", () => ({
  buildConsentUrl: vi.fn(), consumeOAuthState: vi.fn(), createOAuthState: vi.fn(),
  exchangeCodeForTokens: vi.fn(), saveConnection: vi.fn(), storeRefreshToken: vi.fn(),
}));
vi.mock("./sync", () => ({ refreshAccounts: vi.fn(), runGoogleAdsSync: vi.fn() }));

import { registerGoogleAdsRoutes } from "./routes";
import { runGoogleAdsSync } from "./sync";

type Handler = (req: Request, res: Response) => Promise<void>;

async function callCron(authorization?: string, kind = "hourly") {
  const handlers = new Map<string, Handler>();
  registerGoogleAdsRoutes({ get: (path: string, handler: Handler) => handlers.set(path, handler) } as unknown as Express);
  const status = vi.fn().mockReturnThis();
  const json = vi.fn().mockReturnThis();
  await handlers.get("/api/cron/google-ads")!(
    { headers: { authorization }, query: { kind } } as unknown as Request,
    { status, json } as unknown as Response,
  );
  return { status, json };
}

describe("Google Ads scheduled collection authentication", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "", "   "])("rejects collection when CRON_SECRET is not configured (%s)", async (secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    const response = await callCron(secret === undefined ? undefined : `Bearer ${secret}`);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(runGoogleAdsSync).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong-secret"])("rejects a missing or incorrect token (%s)", async (authorization) => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await callCron(authorization);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(runGoogleAdsSync).not.toHaveBeenCalled();
  });

  it("runs the requested collection only after validating the token", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.mocked(runGoogleAdsSync).mockResolvedValue({ status: "completed", done: true } as any);
    const response = await callCron("Bearer test-cron-secret", "nightly");
    expect(response.status).not.toHaveBeenCalled();
    expect(runGoogleAdsSync).toHaveBeenCalledTimes(1);
    expect(runGoogleAdsSync).toHaveBeenCalledWith({
      // "nightly" é sinónimo antigo: normaliza para a recolha diária
      kind: "daily", deadlineAt: expect.any(Number), triggeredById: null,
    });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", done: true }));
  });
});
