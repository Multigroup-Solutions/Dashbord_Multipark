import type { Express, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./client", () => ({ getMultiparkDb: vi.fn(), isMultiparkDbConfigured: vi.fn(() => true), redactSecrets: vi.fn(() => "erro ocultado") }));
import { getMultiparkDb, isMultiparkDbConfigured } from "./client";
import { INITIAL_PRICE_EXPORT_PATH, parseExportPage, registerInitialBookingPriceRoutes } from "./initialBookingPriceRoutes";
import { createRemotePriceReader } from "./initialBookingPriceRemote";
import { makePeriod } from "./initialBookingPrice";

const body = { stage: "history", from: "2026-05-01", to: null, asOf: "2026-09-29T07:00:00.000Z", cursor: "", pageSize: 500 };
const period = makePeriod(body.from, undefined, new Date(body.asOf));
const db = { engine: "postgres", query: vi.fn(), readOnlyCheck: vi.fn() };
async function request(authorization: string | undefined, input: unknown = body) {
  let handler: (req: Request, res: Response) => Promise<unknown>;
  registerInitialBookingPriceRoutes({ post: (p: string, h: typeof handler) => { expect(p).toBe(INITIAL_PRICE_EXPORT_PATH); handler = h; } } as unknown as Express);
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() };
  await handler!({ headers: { authorization }, body: input } as unknown as Request, res as unknown as Response);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-secret");
  vi.mocked(getMultiparkDb).mockResolvedValue(db as any);
  vi.mocked(isMultiparkDbConfigured).mockReturnValue(true);
  db.readOnlyCheck.mockResolvedValue(true);
  db.query.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("protected remote export", () => {
  it.each([undefined, "Bearer wrong"])("rejects unauthenticated reads (%s)", async token => {
    expect((await request(token)).status).toHaveBeenCalledWith(401);
    expect(getMultiparkDb).not.toHaveBeenCalled();
  });
  it("rejects reads if the server secret is missing", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await request("Bearer test-secret")).status).toHaveBeenCalledWith(401);
  });
  it("refuses a connection that is not read-only", async () => {
    db.readOnlyCheck.mockResolvedValue(false);
    expect((await request("Bearer test-secret")).status).toHaveBeenCalledWith(409);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("returns only price changes from history and disables caching", async () => {
    db.query.mockResolvedValue([{ id: "h1", booking_id: "b1", change_type: "CREATED", action_time: body.asOf, snapshot_price: 0,
      modified_fields: JSON.stringify({ bookingPrice: { from: null, to: 0 }, email: { to: "private@example.invalid" } }), userId: "private-user" }]);
    const res = await request("Bearer test-secret");
    const result = res.json.mock.calls[0][0];
    expect(result).toMatchObject({ ok: true, rows: [{ snapshot_price: 0, modified_fields: [{ field: "bookingPrice", from: null, to: 0 }] }] });
    expect(JSON.stringify(result)).not.toMatch(/private-user|email|private@example/);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
  it.each([
    { ...body, pageSize: 1001 }, { ...body, cursor: "x".repeat(201) }, { ...body, from: "2026-02-30" },
    { ...body, asOf: "2099-01-01T00:00:00.000Z" }, { ...body, stage: "sql" }, { ...body, sql: "SELECT * FROM Agent" },
  ])("rejects invalid or arbitrary query input", async value => {
    expect((await request("Bearer test-secret", value)).status).toHaveBeenCalledWith(400);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("keeps the same creation window across batches", () => {
    const parsed = parseExportPage({ ...body, cursor: "h9" }, Date.parse(body.asOf));
    expect(parsed.period).toEqual(period);
    expect(parsed.cursor).toBe("h9");
  });
});

describe("remote reader", () => {
  it("sends the credential in a header and the fixed filter in the body", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, stage: "bookings", period, rows: [{ id: "b1" }] })));
    const reader = createRemotePriceReader("https://dashboard.multipark.pt", "test-secret", period, fetcher);
    expect(await reader.bookings("", 500)).toEqual([{ id: "b1" }]);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://dashboard.multipark.pt/api/exports/initial-booking-price");
    expect(init.headers.Authorization).toBe("Bearer test-secret");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({ from: "2026-05-01", asOf: body.asOf, pageSize: 500 });
    expect(init.body).not.toContain("test-secret");
  });
  it("rejects different filters or a silently invalid response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, stage: "history", period: {}, rows: [] })));
    await expect(createRemotePriceReader("https://dashboard.multipark.pt", "secret", period, fetcher).history("", 500)).rejects.toThrow("filtros diferentes");
  });
  it("does not retry rejected credentials or print server response bodies", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("confidential detail", { status: 401 }));
    await expect(createRemotePriceReader("https://dashboard.multipark.pt", "secret", period, fetcher).history("", 500)).rejects.toThrow("HTTP 401");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires HTTPS, origin-only URLs and a credential", () => {
    for (const url of ["http://dashboard.multipark.pt", "https://user:password@dashboard.multipark.pt", "https://dashboard.multipark.pt/path"]) {
      expect(() => createRemotePriceReader(url, "secret", period)).toThrow("HTTPS");
    }
    expect(() => createRemotePriceReader("https://dashboard.multipark.pt", "", period)).toThrow("CRON_SECRET");
  });
});
