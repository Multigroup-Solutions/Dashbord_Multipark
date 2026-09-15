import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./oauth", () => ({ getAccessToken: vi.fn() }));

import { getAccessToken } from "./oauth";
import { listAccessibleCustomers, listCustomerClients } from "./client";
import { missingApiEnvs } from "./config";

describe("Google Ads Cloud project authentication", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GOOGLE_ADS_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_ADS_CLIENT_SECRET", "test-secret");
    vi.stubEnv("GOOGLE_ADS_DEVELOPER_TOKEN", undefined);
    vi.stubEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", undefined);
    vi.stubEnv("GOOGLE_ADS_API_VERSION", undefined);
    vi.mocked(getAccessToken).mockResolvedValue("test-access-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("discovers accounts with OAuth and no retired developer token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] })));
    expect(missingApiEnvs()).toEqual([]);
    await expect(listAccessibleCustomers()).resolves.toEqual(["1234567890"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers",
      expect.objectContaining({ method: "GET", headers: {
        Authorization: "Bearer test-access-token", "Content-Type": "application/json",
      } }),
    );
  });

  it("does not send a legacy token and preserves manager access", async () => {
    vi.stubEnv("GOOGLE_ADS_DEVELOPER_TOKEN", "retired-token");
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ results: [] }])));
    await expect(listCustomerClients("123-456-7890")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:searchStream",
      expect.objectContaining({ method: "POST", headers: {
        Authorization: "Bearer test-access-token", "Content-Type": "application/json",
        "login-customer-id": "1234567890",
      } }),
    );
  });

  it("still reports missing OAuth credentials", () => {
    vi.stubEnv("GOOGLE_ADS_CLIENT_ID", undefined);
    vi.stubEnv("GOOGLE_ADS_CLIENT_SECRET", "  ");
    expect(missingApiEnvs()).toEqual(["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET"]);
  });

  it("propagates Google's project access denial without retrying or returning empty data", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: {
      status: "PERMISSION_DENIED",
      details: [{ errors: [{ errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" } }] }],
    } }), { status: 403 }));
    await expect(listAccessibleCustomers()).rejects.toMatchObject({
      status: 403, retryable: false,
      message: expect.stringContaining("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
