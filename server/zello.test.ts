import { describe, it, expect } from "vitest";
import crypto from "crypto";

// Teste de integração contra a API real da Zello: só corre com as credenciais
// no ambiente (ZELLO_API_KEY/ZELLO_USERNAME/ZELLO_PASSWORD, como em server/zello.ts).
const NETWORK = process.env.ZELLO_NETWORK ?? "airpark";
const BASE_URL = `https://${NETWORK}.zellowork.com`;
const API_KEY = process.env.ZELLO_API_KEY;
const USERNAME = process.env.ZELLO_USERNAME;
const PASSWORD = process.env.ZELLO_PASSWORD;

describe.skipIf(!API_KEY || !USERNAME || !PASSWORD)("zello API (integração)", () => {
  it("can get token from Zello API", async () => {
    const res = await fetch(`${BASE_URL}/user/gettoken`);
    const data = await res.json();
    expect(data.status).toBe("OK");
    expect(data.token).toBeTruthy();
    expect(data.sid).toBeTruthy();
  });

  it("can authenticate with Zello API", async () => {
    // Step 1: Get token
    const tokenRes = await fetch(`${BASE_URL}/user/gettoken`);
    const tokenData = await tokenRes.json();
    expect(tokenData.status).toBe("OK");

    const { sid, token } = tokenData;

    // Step 2: Login with md5(md5(password) + token + api_key)
    const md5pass = crypto.createHash("md5").update(PASSWORD!).digest("hex");
    const combined = md5pass + token + API_KEY!;
    const authHash = crypto.createHash("md5").update(combined).digest("hex");

    const params = new URLSearchParams({ username: USERNAME!, password: authHash });
    const loginRes = await fetch(`${BASE_URL}/user/login?sid=${sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const loginData = await loginRes.json();
    expect(loginData.status).toBe("OK");
    expect(loginData.code).toBe("200");
  });
});
