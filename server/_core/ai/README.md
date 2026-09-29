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

// Conversa + ferramentas (function calling, só Gemini; o "legacy" ignora-as)
const c = await runAi({
  feature: "assistant",
  system: PROMPT_ESTAVEL, cacheSystem: true,        // as ferramentas vão DENTRO da cache
  history: [{ role: "user", text: "…" }, { role: "model", text: "…" }],
  input: "Quantas reservas há hoje?",
  tools: {
    declarations: [{ name: "reservas_resumo", description: "…", parameters: { type: "object", properties: { … } } }],
    execute: async (call) => ({ total: 12 }),       // nunca lança; se lançar, o modelo recebe { error }
    maxRounds: 3,                                   // cada volta é mais uma chamada paga (teto 4)
  },
});
c.output; c.toolCalls  // [{ id, name, args }]

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
5. pedido com `AbortSignal` e prazo (um prazo para TODAS as voltas de ferramentas); 429/5xx/rede → até 2 novas tentativas com
   espera exponencial; resposta fora do schema → 1 nova tentativa; smart 404 → fast;
6. com `tools`: se o modelo pedir ferramentas, executa-as e devolve-lhe os
   resultados (`functionResponse`), com o conteúdo do modelo tal e qual (o
   Gemini 3 exige as `thoughtSignature` de volta); máx. `maxRounds` voltas;
7. registo em `ai_usage_log` (só metadados — nunca prompt/resposta), uma
   linha por `runAi` (tokens de todas as voltas somados).

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
| `contextCache.ts` | cache de contexto do Gemini (`runAi({ cacheSystem: true })`; chave = system + ferramentas) |
| `chat/` | núcleo de chat reutilizável: `runChatTurn`, conversas na BD, ajuda por palavras-chave, registo de ferramentas, histórico |
| `status.ts` | `aiStatus`, `aiFeatureAvailable(Fresh)`, `testAi` |
| `prompts/` | todos os prompts (PT-PT) + schemas zod (`ops.ts` = automações internas de `server/aiOps/`) |
| `reviewReply.ts` | `draftReviewReply` (o único prompt de resposta a críticas) |
| `prompts/comms.ts` | triagem de reclamações e do WhatsApp, semelhança dos Perdidos (usados por `server/complaintTriage.ts`, `whatsappTriage.ts`, `lostFoundMatch.ts`, `reviewAutoDraft.ts`) |
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

### Chat (núcleo em `chat/`)

O assistente da equipa (`server/assistant/` + `client/src/components/assistant/`)
é só uma "casca" sobre o núcleo `chat/`, que não sabe nada da equipa:

| Peça | Ficheiro | O quê |
|---|---|---|
| Turno | `chat/engine.ts` → `runChatTurn` | pergunta vazia/longa → interruptor → `checkRateLimit` → conversa + histórico → ajuda → `runAi` (cache + ferramentas) → guardar. Nunca lança: `{ ok:false, reason, message }` em PT-PT |
| Conversas | `chat/store.ts` | `ai_chat_conversations` / `ai_chat_messages` (migração 0130), por `channel` + `ownerKey`; 30 dias (`purgeOldChats` no daily-ops) |
| Ajuda | `chat/retrieval.ts` | markdown com cabeçalho (`modulo`, `titulo`, `rotas`, `palavras`); escolha por palavras-chave + página aberta (sem IA); índice curto no prompt estável |
| Ferramentas | `chat/tools.ts` | `ChatTool<Ctx>` = `available(ctx)` (declarada ou não) + `run(args, ctx)` (volta a verificar); `makeToolExecutor` com gancho de auditoria |
| Histórico | `chat/history.ts` | últimos N turnos (6) + resumo extrativo das perguntas antigas (sem chamada extra) |

Custos: prompt estável (regras + índice da ajuda + ferramentas) na cache de
contexto; por turno só vão o contexto (data/página), o histórico curto, 1–2
ficheiros de ajuda e a pergunta; `maxTokens` 700; nível `lite`.

#### Chat público (multipark.app) — como fazer, quando for a altura

1. `shared/aiFeatures.ts`: `public_chat: { label: "Chat público", flag: "AI_PUBLIC_CHAT", tier: "lite", essential: false }`
   (+ `AI_PUBLIC_CHAT` em `AiFlag` e `AUTOMATION_FLAGS`).
2. Ajuda própria: `docs/faq-publico/*.md` no mesmo formato + um gerador como
   `scripts/gen-ajuda.ts` (o Vercel não tem os .md em runtime).
3. Ferramentas: só FAQ (ex.: `abrir_faq(tema)`), **nunca** as de
   `server/assistant/tools.ts` (usam dados internos e a sessão da equipa).
4. Endpoint `publicProcedure` (ou rota Express) que chama:

```ts
import { runChatTurn } from "./_core/ai/chat";
import { ipKey } from "./_core/ai/rateLimit";

const owner = ipKey(req.ip);                      // IP nunca em claro (hash)
const r = await runChatTurn({
  feature: "public_chat", channel: "public", ownerKey: owner, userId: null,
  question, conversationId,                       // id devolvido ao browser; só vale para o mesmo ownerKey
  rateKey: `public_chat:${owner}`,
  limits: { perMinute: 6, perDay: 60, maxInputChars: 500 },   // por IP, mais apertado
  system: PROMPT_PUBLICO,                          // estável → cacheSystem
  cacheSystem: true,
  helpDocs: FAQ_DOCS, tools: FAQ_TOOLS, toolCtx: {},
  maxTurns: 4, maxOutputTokens: 400,
});
```

5. Respostas públicas: sem dados pessoais — preferir `strip()` a `restore()`
   se a resposta puder ser mostrada a outra pessoa (o motor repõe os
   marcadores da própria pergunta, que é do próprio visitante).
6. Opcional: CAPTCHA/Turnstile antes do 1.º pedido e um teto global diário
   (`checkRateLimit("public_chat:global", { perDay })`) além do orçamento.

### Limitador e cache (exemplo mínimo)

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
