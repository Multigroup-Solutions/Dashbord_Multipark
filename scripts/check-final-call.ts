// VERIFICAÇÃO MANUAL — NÃO CORRE NO CI (chama a API real do Gemini e custa
// umas décimas de cêntimo). Plano MPV §3.6 / F0a.
//
// Pergunta: o Gemini aceita um histórico com partes functionCall/functionResponse
// (e a thoughtSignature do Gemini 3) SEM declarações de ferramentas? É o que a
// chamada final do runAi faz primeiro ("native"); se a API recusar (400), o
// runAi passa ao resumo em texto ("summary") e fica nesse modo na instância.
// Este script testa os dois caminhos e diz qual funciona com o modelo dado.
//
// Uso (com GEMINI_API_KEY ou o Vertex configurado no ambiente — nunca no chat):
//   pnpm tsx scripts/check-final-call.ts                 (modelo lite: AI_MODEL_LITE ou o de omissão)
//   pnpm tsx scripts/check-final-call.ts --model gemini-4-argon
//
// Não escreve nada na BD (não usa o runAi: nem orçamento nem registo).
// Saída: 0 = "native" aceite; 3 = "native" recusado mas "summary" funciona;
// 1 = nenhum funcionou; 2 = IA não configurada / o modelo não pediu a ferramenta.
import { createGeminiProvider, geminiConfig, type AiToolDeclaration, type AiToolRound, type ProviderRequest } from "../server/_core/ai/client";
import { geminiModelFor } from "../server/_core/ai/models";
import { FINAL_ANSWER_INSTRUCTION, summarizeToolRounds } from "../server/_core/ai/run";

const args = process.argv.slice(2);
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : "";

async function main(): Promise<number> {
  if (!geminiConfig(process.env)) {
    console.error("IA não configurada (GEMINI_API_KEY ou Vertex). Nada a fazer.");
    return 2;
  }
  const provider = createGeminiProvider(process.env);
  const model = modelArg || geminiModelFor("lite", process.env);
  const system = "És um assistente de teste. Responde em português europeu, numa frase.";
  const tool: AiToolDeclaration = {
    name: "hora_atual",
    description: "Diz a hora atual numa cidade.",
    parameters: { type: "object", properties: { cidade: { type: "string" } }, required: ["cidade"] },
  };
  const base = (extra: Partial<ProviderRequest>): ProviderRequest => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30_000).unref?.();
    return {
      model, system, parts: [{ type: "text", text: "Que horas são em Lisboa? Usa a ferramenta hora_atual." }],
      maxOutputTokens: 900, temperature: 0, signal: controller.signal, timeoutMs: 30_000, ...extra,
    };
  };

  console.log(`Modelo: ${model}`);
  const first = await provider.generate(base({ tools: [tool] }));
  if (!first.toolCalls?.length) {
    console.error("O modelo não pediu a ferramenta (respondeu só texto) — repete ou muda de modelo.");
    return 2;
  }
  const round: AiToolRound = {
    modelRaw: first.raw,
    calls: first.toolCalls,
    results: first.toolCalls.map((call) => ({ call, response: { hora: "10:42", cidade: "Lisboa" } })),
  };
  console.log(`1) Pediu ${first.toolCalls.length} chamada(s): ${first.toolCalls.map((c) => c.name).join(", ")}`);

  let nativeOk = false;
  try {
    const r = await provider.generate(base({ toolRounds: [round], trailingText: FINAL_ANSWER_INSTRUCTION }));
    nativeOk = !!r.text.trim() && !r.toolCalls?.length;
    console.log(`2) "native" (histórico com ferramentas, sem as declarar): ${nativeOk ? "ACEITE" : "sem texto"} — ${JSON.stringify(r.text.slice(0, 200))} (finishReason ${r.finishReason})`);
  } catch (err: any) {
    console.log(`2) "native": RECUSADO — HTTP ${err?.status ?? "?"} ${String(err?.message ?? err).slice(0, 200)}`);
  }

  let summaryOk = false;
  try {
    const r = await provider.generate(base({ parts: [...base({}).parts, { type: "text", text: summarizeToolRounds([round]) }] }));
    summaryOk = !!r.text.trim();
    console.log(`3) "summary" (resultados em texto): ${summaryOk ? "OK" : "sem texto"} — ${JSON.stringify(r.text.slice(0, 200))}`);
  } catch (err: any) {
    console.log(`3) "summary": FALHOU — HTTP ${err?.status ?? "?"} ${String(err?.message ?? err).slice(0, 200)}`);
  }

  if (nativeOk) return 0;
  return summaryOk ? 3 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("Erro:", String(err?.message ?? err).slice(0, 300));
  process.exit(1);
});
