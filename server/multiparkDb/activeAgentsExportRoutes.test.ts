import type { Express, Request, Response } from "express";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./client", () => ({ getMultiparkDb: vi.fn(), isMultiparkDbConfigured: vi.fn(() => true), redactSecrets: vi.fn(() => "erro ocultado") }));
import { getMultiparkDb } from "./client";
import { ACTIVE_AGENTS_EXPORT_PATH, registerActiveAgentsExportRoutes } from "./activeAgentsExportRoutes";
const body = { stage: "activity", from: "2026-05-01", to: null, asOf: "2026-09-29T07:00:00.000Z", cursor: "", pageSize: 500 };
const db = { engine: "postgres", query: vi.fn(), readOnlyCheck: vi.fn() };
async function request(auth?: string, input: unknown = body) {
  let handler: (req: Request, res: Response) => Promise<unknown>;
  registerActiveAgentsExportRoutes({ post: (p: string, h: typeof handler) => { expect(p).toBe(ACTIVE_AGENTS_EXPORT_PATH); handler = h; } } as unknown as Express);
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() };
  await handler!({ headers: { authorization: auth }, body: input } as Request, res as unknown as Response);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AGENT_ACTIVITY_EXPORT_SECRET", "agent-secret");
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("BOOKING_PRICE_EXPORT_SECRET", "price-secret");
  vi.mocked(getMultiparkDb).mockResolvedValue(db as any);
  db.readOnlyCheck.mockResolvedValue(true); db.query.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());
it.each([undefined, "Bearer wrong", "Bearer cron-secret", "Bearer price-secret"])("rejects credentials outside the dedicated export scope: %s", async auth => {
  expect((await request(auth)).status).toHaveBeenCalledWith(401);
  expect(getMultiparkDb).not.toHaveBeenCalled();
});
it("fails closed with a missing dedicated secret", async () => {
  vi.stubEnv("AGENT_ACTIVITY_EXPORT_SECRET", "");
  expect((await request("Bearer agent-secret")).status).toHaveBeenCalledWith(401);
});
it("refuses writes and disables caching", async () => {
  db.readOnlyCheck.mockResolvedValue(false);
  const res = await request("Bearer agent-secret");
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  expect(db.query).not.toHaveBeenCalled();
});
it.each(["agents", "invites", "history", "activity", "booking-drivers"])("accepts an authorized fixed stage: %s", async stage => {
  expect((await request("Bearer agent-secret", { ...body, stage })).json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, stage, rows: [] }));
});
it.each([{ ...body, sql: "SELECT secret" }, { ...body, stage: "bookings" }, { ...body, pageSize: 1001 }])("rejects arbitrary query input", async input => {
  expect((await request("Bearer agent-secret", input)).status).toHaveBeenCalledWith(400);
  expect(db.query).not.toHaveBeenCalled();
});
