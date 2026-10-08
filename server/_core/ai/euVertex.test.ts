/**
 * Jorge (8 out 2026, ponto 7 do 26b): os documentos e CV do RH vão INTEIROS
 * para a IA — só correm com o Gemini em Vertex AI numa região da UE. Fora
 * disso não correm, mesmo com o interruptor ligado; o resto da IA não muda.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ getDb: async () => null }));

import {
  EU_VERTEX_ONLY_FEATURES, EU_VERTEX_ONLY_FLAGS, aiWhereLabel, euVertexNote, euVertexOk, flagRequiresEuVertex, isEuRegion, requiresEuVertex,
} from "../../../shared/aiLimits";
import { AI_FEATURES } from "../../../shared/aiFeatures";
import { setAiProvidersForTests } from "./client";
import { AI_USER_MESSAGES, AiEuOnlyError } from "./errors";
import { runAi } from "./run";
import { aiFeatureAvailable, aiFeatureRegionOk, aiWhere } from "./status";
import { aiTrpcError } from "./trpcError";
import { createFakeProvider, okResponse } from "./testUtils";

const KEYS = ["GEMINI_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_SERVICE_ACCOUNT_JSON",
  "LLM_API_KEY", "OPENAI_API_KEY", "AI_PROVIDER", "AI_PROVIDER_HR_AUTOFILL", "AI_ENABLED", "AI_HR_AUTOFILL", "AI_HR_EMAIL_ATTACHMENTS", "AI_RADIO", "AI_EXPENSE_OCR"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  setAiProvidersForTests(null);
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setAiProvidersForTests(null);
});

const studio = { GEMINI_API_KEY: "k", AI_HR_AUTOFILL: "on", AI_HR_EMAIL_ATTACHMENTS: "on" };
const vertex = (location?: string) => ({
  GOOGLE_GENAI_USE_VERTEXAI: "true", GOOGLE_CLOUD_PROJECT: "multipark", ...(location ? { GOOGLE_CLOUD_LOCATION: location } : {}),
  AI_HR_AUTOFILL: "on", AI_HR_EMAIL_ATTACHMENTS: "on",
});

describe("regra pura: só Vertex AI na UE", () => {
  it("regiões da UE (Londres e Zurique não são UE)", () => {
    for (const l of ["europe-west1", "europe-west3", "europe-west4", "europe-west9", "europe-southwest1", "europe-north1", "europe-central2", "eu", " Europe-West1 "]) expect(isEuRegion(l), l).toBe(true);
    for (const l of ["europe-west2", "europe-west6", "us-central1", "global", "", null, undefined, "europe"]) expect(isEuRegion(l as any), String(l)).toBe(false);
  });

  it("só o Gemini em Vertex numa região da UE passa", () => {
    expect(euVertexOk({ provider: "gemini", mode: "vertex", location: "europe-west1" })).toBe(true);
    expect(euVertexOk({ provider: "gemini", mode: "vertex", location: "us-central1" })).toBe(false);
    expect(euVertexOk({ provider: "gemini", mode: "studio", location: null })).toBe(false);
    expect(euVertexOk({ provider: "legacy", mode: "legacy", location: null })).toBe(false);
    expect(euVertexOk({ provider: null, mode: null, location: null })).toBe(false);
  });

  it("o texto ao lado do interruptor diz onde está a IA hoje", () => {
    expect(euVertexNote({ provider: "gemini", mode: "studio", location: null })).toEqual({ ok: false, text: "Só corre com a IA em Vertex AI na UE (hoje: Gemini). Até lá não corre, mesmo ligado." });
    expect(euVertexNote({ provider: "gemini", mode: "vertex", location: "europe-west1" })).toEqual({ ok: true, text: "Só corre com a IA em Vertex AI na UE (hoje: Gemini (Vertex AI, europe-west1))." });
    expect(aiWhereLabel({ provider: "legacy", mode: "legacy", location: null })).toBe("fornecedor antigo");
    expect(aiWhereLabel({ provider: null, mode: null, location: null })).toBe("sem IA configurada");
  });

  it("só os documentos e CV do RH; nunca o rádio, as faturas ou o resto", () => {
    expect([...EU_VERTEX_ONLY_FEATURES]).toEqual(["hr_autofill", "hr_email_attachments"]);
    expect(EU_VERTEX_ONLY_FEATURES.map((f) => AI_FEATURES[f].flag)).toEqual([...EU_VERTEX_ONLY_FLAGS]);
    for (const f of ["radio_transcription", "radio_summary", "expense_ocr", "quiz_generation", "knowledge_extract", "handover_summary"]) expect(requiresEuVertex(f), f).toBe(false);
    expect(flagRequiresEuVertex("AI_HR_AUTOFILL")).toBe(true);
    expect(flagRequiresEuVertex("AI_RADIO")).toBe(false);
  });
});

describe("no servidor: aiFeatureAvailable e runAi", () => {
  it("aiWhere lê o fornecedor da funcionalidade (sem segredos)", () => {
    expect(aiWhere(studio)).toEqual({ provider: "gemini", mode: "studio", location: null });
    expect(aiWhere(vertex())).toEqual({ provider: "gemini", mode: "vertex", location: "europe-west1" });
    expect(aiWhere({ ...vertex("europe-west4"), LLM_API_KEY: "x", AI_PROVIDER_HR_AUTOFILL: "legacy" }, "hr_autofill")).toEqual({ provider: "legacy", mode: "legacy", location: null });
  });

  it("Google AI Studio: os do RH não correm mesmo ligados; o rádio e as faturas correm", () => {
    expect(aiFeatureRegionOk("hr_autofill", studio)).toBe(false);
    expect(aiFeatureAvailable("hr_autofill", studio)).toBe(false);
    expect(aiFeatureAvailable("hr_email_attachments", studio)).toBe(false);
    expect(aiFeatureAvailable("radio_transcription", studio)).toBe(true);
    expect(aiFeatureAvailable("expense_ocr", studio)).toBe(true);
  });

  it("Vertex na UE: correm se o interruptor estiver ligado; fora da UE não", () => {
    expect(aiFeatureAvailable("hr_autofill", vertex())).toBe(true);
    expect(aiFeatureAvailable("hr_email_attachments", vertex("europe-west9"))).toBe(true);
    expect(aiFeatureAvailable("hr_autofill", { ...vertex(), AI_HR_AUTOFILL: "off" })).toBe(false);
    expect(aiFeatureAvailable("hr_autofill", vertex("us-central1"))).toBe(false);
    expect(aiFeatureAvailable("hr_autofill", vertex("europe-west2"))).toBe(false);
  });

  it("runAi recusa antes de mandar o ficheiro (nada chega ao fornecedor) e diz porquê", async () => {
    Object.assign(process.env, studio);
    const p = createFakeProvider("gemini", [okResponse("{}")]);
    setAiProvidersForTests({ gemini: p });
    await expect(runAi({ feature: "hr_autofill", input: [{ type: "pdf", data: "AAAA" }] })).rejects.toBeInstanceOf(AiEuOnlyError);
    await expect(runAi({ feature: "hr_email_attachments", input: "cv" })).rejects.toMatchObject({ code: "eu_only" });
    expect(p.calls).toHaveLength(0);
    // o resto continua com o Gemini do AI Studio
    await runAi({ feature: "expense_ocr", input: "fatura" });
    expect(p.calls).toHaveLength(1);
    const e = aiTrpcError(new AiEuOnlyError("hr_autofill"));
    expect(e.code).toBe("PRECONDITION_FAILED");
    expect(e.message).toBe(AI_USER_MESSAGES.eu_only);
  });

  it("runAi com Vertex na UE deixa passar", async () => {
    Object.assign(process.env, vertex());
    const p = createFakeProvider("gemini", [okResponse("ok")]);
    setAiProvidersForTests({ gemini: p });
    await runAi({ feature: "hr_autofill", input: "doc" });
    expect(p.calls).toHaveLength(1);
  });
});
