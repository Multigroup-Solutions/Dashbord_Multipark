# `server/_core/ai` — a IA da aplicação

**Toda** a chamada a um modelo passa por `runAi`. Configuração, modelos, custos e
RGPD para o dono: [`docs/ia.md`](../../../docs/ia.md).

## API

```ts
import { runAi } from "./_core/ai/run";        // ou: import { runAi } from "./_core/ai"
import { aiTrpcError } from "./_core/ai/trpcError";

// Texto
const r = await runAi({
  feature: "whatsapp_reply",        // AiFeature (shared/aiFeatures.ts) — obrigatório
  system: "…",                      // instruções (PT-PT)
  input: "…" /* ou AiPart[] */,     // texto | imagem | pdf | áudio (base64)
  maxTokens: 400,                   // omissão 1024 (inclui "thinking")
  timeoutMs: 20_000,                // omissão 25 s, máx. 50 s (Vercel = 60 s)
  userId, entity: "whatsapp_conversation", entityId,   // só para o registo
});
r.output   // string
r.model, r.provider, r.tier, r.usage, r.costEur, r.latencyMs, r.attempts

// Saída estruturada: zod → JSON Schema do Gemini; a resposta é validada pelo zod
const inv = await runAi({ feature: "expense_ocr", input: parts, schema: invoiceSchema });
inv.output // z.output<typeof invoiceSchema>, já validado

// Erros → sempre AiError (errors.ts). Na UI só `err.userMessage` (PT-PT genérico):
try { … } catch (err) { throw aiTrpcError(err); }   // tRPC
```

`AiPart`: `{type:"text",text}` · `{type:"image",mimeType,data}` · `{type:"pdf",data}` ·
`{type:"audio",mimeType,data}` (binários em base64, sem `data:`).

`AiError.code`: `disabled` · `not_configured` · `budget` · `timeout` ·
`rate_limited` · `provider` · `invalid_output` · `unsupported`.

O que o `runAi` faz, por ordem:

1. interruptores (`AI_ENABLED` + o da funcionalidade) → `AiDisabledError`;
2. fornecedor (`selectProvider`) → `AiNotConfiguredError`;
3. orçamento mensal → `AiBudgetExceededError` (+ aviso aos admins 1×/mês);
4. nível efetivo → modelo (`resolveFeatureTier` + `resolveModel`);
5. pedido com `AbortSignal` e prazo; 429/5xx/rede → até 2 novas tentativas com
   espera exponencial; resposta fora do schema → 1 nova tentativa; smart 404 → fast;
6. registo em `ai_usage_log` (só metadados — nunca prompt/resposta).

## Ficheiros

| Ficheiro | O quê |
|---|---|
| `run.ts` | `runAi`, `parseStructured`, `backoffMs` |
| `client.ts` | fornecedores (Gemini via `@google/genai`: AI Studio ou Vertex; adaptador "legacy" = `../llm.ts`), `selectProvider`, `aiConfigured` |
| `models.ts` | níveis → modelos (`AI_MODEL_LITE/FAST/SMART/STT`) |
| `features.ts` | interruptores e nível efetivo por funcionalidade (catálogo em `shared/aiFeatures.ts`) |
| `usage.ts` | registo, orçamento, resumo mensal (Definições → Estado) |
| `pricing.ts` | preços por modelo (sobreponíveis em Definições) |
| `pii.ts` | `redactPii` (marcadores reversíveis), `firstName` |
| `stt.ts` | `transcribeAudio` (Gemini áudio; Whisper só com `OPENAI_API_KEY`) |
| `rateLimit.ts` | `checkRateLimit(key, { perMinute, perDay })`, `userKey`, `ipKey` |
| `contextCache.ts` | cache de contexto do Gemini (`runAi({ cacheSystem: true })`) |
| `status.ts` | `aiStatus`, `aiFeatureAvailable(Fresh)`, `testAi` |
| `prompts/` | todos os prompts (PT-PT) + schemas zod |
| `reviewReply.ts` | `draftReviewReply` (o único prompt de resposta a críticas) |
| `trpcError.ts` | `aiTrpcError(err)` |

## Acrescentar uma funcionalidade (ex.: chat, triagem)

1. `shared/aiFeatures.ts`: nova entrada em `AI_FEATURES` —
   `{ label, flag, tier: "lite", essential: false }`. **Nível `lite`** salvo prova
   de que falha (regra do dono: o mais barato); comentar o porquê se for `fast`.
2. Interruptor novo? Acrescentar a `AiFlag` e a `AUTOMATION_FLAGS`
   (`shared/appSettings.ts`, `group: "ia"`) — aparece em Definições → Automações.
3. Prompt em `prompts/<nome>.ts` (usar `PT_PT_RULE`, `PLACEHOLDER_RULE`).
4. Texto livre de clientes/colaboradores → `redactPii(texto)`; `restore()` na
   resposta se for privada, `strip()` se for pública. Nomes: `firstName()`.
5. Chamar `runAi({ feature, … })`; na UI, `aiTrpcError(err)`. Para mostrar/
   esconder botões: `aiFeatureAvailableFresh(feature)`.
6. Testes: mockar `@google/genai` (ver `ai.test.ts` / `server/aiTouchpoints.test.ts`)
   ou `setAiProvidersForTests({ gemini: createFakeProvider(…) })` (`testUtils.ts`).

### Chat (público ou interno)

```ts
import { checkRateLimit, ipKey, userKey } from "./_core/ai/rateLimit";

const rl = await checkRateLimit(`chat:${user ? userKey(user.id) : ipKey(req.ip)}`, { perMinute: 6, perDay: 60 });
if (!rl.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Muitos pedidos. Tenta daqui a ${rl.retryAfterSec} s.` });

const r = await runAi({
  feature: "public_chat",               // nova entrada no catálogo
  system: KNOWLEDGE_BASE,               // prefixo longo e ESTÁVEL
  cacheSystem: { ttlSeconds: 3600 },    // cache de contexto (≈10% do preço nesses tokens)
  input: redactPii(pergunta).text,      // + histórico curto, se houver
  maxTokens: 500,
});
```

A cache de contexto só compensa com prefixos grandes (o Gemini tem um mínimo de
tokens); se não der para criar, a chamada segue sem cache, sem erro.
