# IA e Multis

Fonte de verdade: `server/_core/ai/*`, `shared/aiFeatures.ts`, `docs/ia.md`, `docs/ia-inventario.md`, plano `docs/plans/2026-10-15-multis-ia-plano.md` (MPV). Confirma no código antes de afirmar.

## 1. Princípios
- **Uma porta só**: toda a IA passa por `runAi()` (`server/_core/ai/run.ts`) com uma `feature` registada em `AI_FEATURES` (`shared/aiFeatures.ts`). Nada de chamar o fornecedor diretamente.
- **Ferramentas nunca chamam IA** e são só de leitura, com as permissões de quem pergunta (`appRouter.createCaller` com o utilizador do pedido).
- **PII**: `redactPii` (email, telefone, IBAN, NIF, matrícula) + nomes: colaboradores como `[NOME_n]` que se repõem no fim (contexto único por turno), clientes/avaliadores só pelo 1.º nome (`firstName`). Redigir **antes** de cortar texto (`cutText` nunca parte marcadores). Instruções vindas de dados (críticas, emails) são dados, não instruções.
- **Só UE**: `hr_autofill` e `hr_email_attachments` só correm em Vertex AI na UE; fora disso `AiEuOnlyError` e registo `eu_only`.
- **Orçamento**: global `ai.monthlyBudgetEur` (30 €/mês); as não essenciais param a 100 %. Funcionalidades com `ownBudget` (`assistant_smart`, `assistant_eval`) têm teto próprio e ficam fora do global.
- **Interruptor por funcionalidade** (`flag` em `AI_FEATURES`); novas entram desligadas.
- **Nada de IA real nos testes** — fornecedores falsos (`setAiProvidersForTests`, `createFakeProvider`).

## 2. Níveis e modelos (mudar = variável na Vercel, sem deploy)
| Nível | Omissão | Env |
|---|---|---|
| lite | `gemini-3.1-flash-lite` | `AI_MODEL_LITE` |
| fast | `gemini-3.8-flash` | `AI_MODEL_FAST` |
| smart | `gemini-3.1-pro-preview`; no piloto `gemini-4-argon` | `AI_MODEL_SMART` |
| vetores | `gemini-embedding-001` (768 dim) | `AI_MODEL_EMBED` |

- Nível por funcionalidade: omissão em `AI_FEATURES[f].tier` → `AI_TIER_<FEATURE>` (env) → `ai.featureTiers` (Definições) — `resolveFeatureTier`.
- smart com 404/429 → cai para fast (só antes da 1.ª ronda); orçamento próprio esgotado → lite ("modo económico").
- Raciocínio por funcionalidade: `ai.thinkingLevels` (Definições; omissão vazia = como sempre). "minimal" só onde houver eval a passar (`mail_routing`, `whatsapp_triage`, `complaint_triage` têm evals: `scripts/eval-mail-triage.ts`, `eval-whatsapp-triage.ts`, `eval-complaint-triage.ts`). `maxTokensFor` sobe o teto de saída com o raciocínio.
- Argon: só cache implícita (sem cache explícita); preço 2/10/0,1 USD por M (entrada/saída/cache), **introdutório até 30 nov 2026** (`server/_core/ai/pricing.ts`) — pode subir.
- Produção usa AI Studio (`mode "studio"`); ver `settings.aiUsage`.

## 3. Funcionalidades (nível por omissão)
Tudo **lite**, exceto: `quiz_generation` e `quiz_live` (**fast**), `assistant_smart` (**smart**, teto próprio). Lista completa em `shared/aiFeatures.ts` (expense_ocr, review_reply, review_auto_draft, review_auto_publish, complaint_triage, whatsapp_*, mail_routing, mail_reply, radio_*, handover_*, hr_autofill, hr_email_attachments, kb_faq, knowledge_embed/extract, training_*, lost_found_match, crm_identity, assistant, assistant_eval, ops_briefing, weekly_report, anomaly_explain, availability_classify, lead_*, evaluation_explain, tasks_from_text, web_insight, gbp_post_draft, pagespeed_explain, healthcheck).

## 4. Medição
- `ai_usage_log`: feature, tier, model, tokens, custo, latência, status, `finishReason`, `rounds`, `variant` (`v1`|`mpv`), `forcedFinal`; índice `(feature, userId, createdAt)`.
- `ai_chat_messages`: `variant`, `tier`, `contentMasked`, `maskedNames`.
- Ecrãs: Definições → Estado → **"IA — uso por dia"** (`settings.aiUsageDaily`/`aiUsageRepeats`) e **"Multis piloto"** (`settings.aiPilotStats`).
- Alarme: `finishReason = MAX_TOKENS` > 2 %.

## 5. Multis (assistente) — v1 e MPV
- **v1** (toda a gente): `assistant` (lite), `STAFF_TOOLS` declaradas por pessoa, ajuda por palavras-chave (`server/_core/ai/chat/retrieval.ts`, `docForPath` usa `pagesForPath`). **O v1 tem de ficar byte a byte igual** quando se mexe no MPV — há testes de hash (`server/assistant/mpvF3.test.ts`).
- **MPV / piloto** (`MPV` + `AI_ASSISTANT_SMART` ligados e a pessoa em `ai.assistantPilot`; `assistantModeFor`, `mode.pilot`):
  - sistema estável igual para todos com o índice da árvore da ajuda (`KNOWLEDGE_INDEX`, ≈ 4 450 tokens em out 2026, teto 6 000) → 1 cache por modelo; `declareAllTools` + lista das permitidas no `<contexto>`; recusas à parte (`toolsRefused`, `TOOL_REFUSED_ERROR`).
  - por pergunta: perfil da página (`shared/multisProfiles.ts`, `<pagina_atual>`), secção do separador aberto (`useMultisPage` no cliente, `shared/multisPage.ts` valida `tab`/`entity`), + 2 secções da pesquisa; teto 5 000 car.
  - pesquisa (F5): lexical ∪ FULLTEXT ∪ vetores (`server/knowledge/vectorIndex.ts`, `server/assistant/helpSearch.ts`); só-vetor exige `cos ≥ max(0,7; melhor − 0,08)`; > 3 s → só lexical.
  - ferramentas MPV (`MPV_STAFF_TOOLS`, `staffToolsFor(mode)`): `ajuda_abrir`, `ajuda_procurar` (`helpTools.ts`), `regras_em_vigor` (`rulesTool.ts` + `shared/rulesInForce.ts` + lista branca `shared/rulesLiveWhitelist.ts`), e as 8 de dados (`mpvDataTools.ts`): `parcerias_resumo`, `despesas_resumo`, `pressao_explicar`, `tempos_resumo`, `avaliacao_minha`, `criticas_por_responder`, `formacao_progresso`, `extras_dia_situacao`. Perguntas sugeridas com `needs` (só aparecem se a ferramenta existe e é permitida).
  - leituras lentas: prazo 12 s, uma leitura por chave, cache 5 min com `lidoAs` (`slowCallCache.ts`); qualquer mutation de negócio da pessoa limpa a cache dela (gancho em `server/_core/trpc.ts`, lista aprovada em `mpvF4CacheList.test.ts`).
  - orçamento do turno: Argon 4 voltas, lite 3; 35 s com 8 s guardados para a chamada final sem ferramentas; descida smart→lite com prazo até 50 s desde o início.
  - teto próprio (`ai.assistantSmartBudget`/`Limits`, omissão 10 €/dia, 150 €/mês, 3 €/pessoa/dia), reserva por turno calculada (`ownBudgetTurnEstimateEur`, mín. 0,20 €) com validade 2× o prazo.

## 6. Eval do Multis (`scripts/eval-multis.ts`)
- `--set A|B --variant v1-lite|mpv-lite|mpv-argon --reps 3`; funcionalidade `assistant_eval` (teto próprio), sem BD, sem vetores, sem gravar; ferramentas respondem do gravado (`server/fixtures/multisEval/`), argumento não gravado = erro do eval.
- Passa com ≥ 2 de 3; juiz lite só para "inventou uma regra?" (sem juiz → "não avaliado", nunca "Cumpre"); teto 15 € → "INCOMPLETO".
- Critérios (só conjunto A): Argon ≥ 90 % factos+secção, 0 regras inventadas, p95 < 25 s; lite ≥ 80 %.
- Conjunto A = perguntas reais do Jorge + 2 TL; rascunho anonimizado com `scripts/export-multis-eval-draft.ts` (lê produção READ ONLY → só a pedido do Jorge; escreve em `rascunhoA/` fora do git; rever à mão).
- Correr só quando o Jorge mandar, com a chave no ambiente do terminal dele: `$env:AI_MODEL_SMART="gemini-4-argon"; pnpm tsx scripts/eval-multis.ts --set A --variant mpv-argon --reps 3`.

## 7. Outras IAs com regras próprias
- Críticas: rascunho automático só de críticas com ≤ 14 dias (`REVIEW_AUTO_DRAFT_MAX_AGE_DAYS`, data da crítica → do email → de entrada); nunca as "não é crítica"/repetidas. 5★ automáticas (`REVIEW_AUTO_PUBLISH_5STAR`, desligado): 6 h com Cancelar, leitura na fonte antes de publicar, 20/perfil/24 h, pára com 3 falhas, `onlyIfNoReply`.
- Email/WhatsApp: `mail_routing` separa pelas caixas; leitura reaproveitada só na sincronização (`reuseRead`, `server/mailReadCache.ts`); W1 `WA_TRIAGE_SKIP_STAFF` (colaboradores sem IA salvo urgência).
- Anomalias: `maxTokens ≥ 400 + 80·n`; repetições no trabalho `ops-anomaly-retries`.
- OCR das faturas fica em lite (Flash se falhar); não mudar sem eval.
