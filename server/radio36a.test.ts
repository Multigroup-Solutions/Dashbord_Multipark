/**
 * P3 lote 36a — Rádio (Jorge, 6 out 2026):
 *  1. guardar provas "só para supervisor, backoffice, admin e super admin";
 *  2. "a gravação fica a 0 segundos" → o áudio passa a vir pelo nosso servidor
 *     (descarregado do Zello, com a sessão se for preciso, e confirmado como
 *     áudio pelos primeiros bytes).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPlayable, sniffAudioMime } from "../shared/radioCross";
import { canSaveEvidence } from "../shared/radioEvidence";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe("36a — quem guarda provas", () => {
  it("só supervisor, backoffice, admin e super admin", () => {
    for (const r of ["supervisor", "backoffice", "admin", "super_admin"]) expect(canSaveEvidence(r), r).toBe(true);
    for (const r of ["team_leader", "frontoffice", "condutor", "extra", "user", "", null, undefined]) expect(canSaveEvidence(r as any), String(r)).toBe(false);
  });

  it("o servidor recusa os outros (guardar e juntar o áudio) e o ecrã esconde os botões", () => {
    const r = src("server/operationalRouter.ts");
    expect(r).toMatch(/evidenceSave: protectedProcedure[\s\S]{0,700}if \(!canSaveEvidence\(ctx\.user\.role\)\) throw new TRPCError\(\{ code: "FORBIDDEN"/);
    expect(r).toMatch(/evidenceAttachAudio: protectedProcedure[\s\S]{0,400}if \(!canSaveEvidence\(ctx\.user\.role\)\) throw new TRPCError\(\{ code: "FORBIDDEN"/);
    expect(src("client/src/components/radio/ZelloRadioSearch.tsx")).toContain('can(me as any, "radio", "edit") && canSaveEvidence((me as any).role)');
    expect(src("client/src/components/radio/RadioEvidence.tsx")).toContain('can(user as any, "radio", "edit") && canSaveEvidence((user as any).role)');
  });
});

describe("36a — que áudio é (pelos primeiros bytes)", () => {
  it("MP3 (ID3 ou frame), OGG, WAV, AMR, MP4; página de erro = não é áudio", () => {
    expect(sniffAudioMime(ascii("ID3\x04\x00"))).toBe("audio/mpeg");
    expect(sniffAudioMime(bytes(0xff, 0xfb, 0x90, 0x64))).toBe("audio/mpeg");
    expect(sniffAudioMime(ascii("OggS\x00\x02"))).toBe("audio/ogg");
    expect(sniffAudioMime(ascii("RIFF....WAVE"))).toBe("audio/wav");
    expect(sniffAudioMime(ascii("#!AMR\n"))).toBe("audio/amr");
    expect(sniffAudioMime(ascii("\x00\x00\x00\x18ftypM4A "))).toBe("audio/mp4");
    expect(sniffAudioMime(ascii("<!DOCTYPE html>"))).toBeNull();
    expect(sniffAudioMime(ascii('{"status":"Forbidden"}'))).toBeNull();
    expect(sniffAudioMime(bytes(1, 2))).toBeNull();
    expect(browserPlayable("audio/mpeg")).toBe(true);
    expect(browserPlayable("audio/amr")).toBe(false);
  });
});

describe("36a — descarregar o áudio do Zello pelo servidor", () => {
  const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 1, 2, 3]);
  let calls: string[];
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("ZELLO_API_KEY", "k"); vi.stubEnv("ZELLO_USERNAME", "u"); vi.stubEnv("ZELLO_PASSWORD", "p"); vi.stubEnv("ZELLO_NETWORK", "airpark");
    calls = [];
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  const fetchWith = (media: (url: string) => Response) => vi.fn(async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("/user/gettoken")) return new Response(JSON.stringify({ status: "OK", token: "t", sid: "SID123" }));
    if (String(url).includes("/user/login")) return new Response(JSON.stringify({ status: "OK" }));
    return media(String(url));
  });

  it("vem logo: não pede sessão; devolve os bytes e o tipo verdadeiro", async () => {
    vi.stubGlobal("fetch", fetchWith(() => new Response(MP3, { status: 200, headers: { "content-type": "application/octet-stream" } })));
    const { downloadZelloMedia } = await import("./zello");
    const r = await downloadZelloMedia("https://mesh.zellowork.com/media/abc.mp3");
    expect(r.mime).toBe("audio/mpeg");
    expect(r.bytes.equals(MP3)).toBe(true);
    expect(calls).toEqual(["https://mesh.zellowork.com/media/abc.mp3"]);
  });

  it("o Zello recusa sem sessão (ou manda uma página): tenta com a sessão", async () => {
    vi.stubGlobal("fetch", fetchWith((url) => url.includes("sid=SID123") ? new Response(MP3, { status: 200 }) : new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })));
    const { downloadZelloMedia } = await import("./zello");
    const r = await downloadZelloMedia("https://mesh.zellowork.com/media/abc.mp3");
    expect(r.mime).toBe("audio/mpeg");
    expect(calls.at(-1)).toBe("https://mesh.zellowork.com/media/abc.mp3?sid=SID123");
  });

  it("erros claros: recusado, não é áudio, link de outro sítio", async () => {
    vi.stubGlobal("fetch", fetchWith(() => new Response("no", { status: 403 })));
    let { downloadZelloMedia } = await import("./zello");
    await expect(downloadZelloMedia("https://mesh.zellowork.com/media/abc.mp3")).rejects.toThrow(/erro 403/);
    vi.resetModules();
    vi.stubGlobal("fetch", fetchWith(() => new Response("<html/>", { status: 200 })));
    ({ downloadZelloMedia } = await import("./zello"));
    await expect(downloadZelloMedia("https://mesh.zellowork.com/media/abc.mp3")).rejects.toThrow(/não devolveu um áudio/);
    await expect(downloadZelloMedia("https://evil.example.com/a.mp3")).rejects.toThrow(/não veio do Zello/);
  });
});

describe("36a — o ecrã toca o que vem do servidor", () => {
  it("rota zelloAudio (ver Rádio); o browser já não abre o link do Zello", () => {
    const r = src("server/operationalRouter.ts");
    expect(r).toMatch(/zelloAudio: protectedProcedure[\s\S]{0,200}requireAccess\(ctx\.user, "radio", "view"\)/);
    expect(r).not.toContain("zelloMedia: protectedProcedure");
    const z = src("client/src/components/radio/ZelloRadioSearch.tsx");
    expect(z).toContain("trpc.operational.radio.zelloAudio.useMutation()");
    expect(z).toContain("URL.createObjectURL(new Blob([buf], { type: r.mime }))");
    expect(z).toContain('onError={() => setAudioError("O browser não conseguiu tocar este áudio.")}');
    expect(src("server/radioZello.ts")).toContain("downloadZelloMedia(media.url, RADIO_AUDIO_MAX_BYTES)");
  });
});
