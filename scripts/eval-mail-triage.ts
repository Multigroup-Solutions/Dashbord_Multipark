// Avalia a triagem dos emails (14 out 2026 — meta do Jorge: mais de 90 % das
// reclamações e dos perdidos vão para lá).
//
// Corre os corpora rotulados — o principal (server/fixtures/mailTriageCorpus.ts)
// e o de controlo, independente (server/fixtures/mailTriageHoldout.ts) — pelo
// MESMO pedido à IA e pela MESMA decisão de produção (server/mailTriageEval.ts),
// com o fornecedor de IA configurado no ambiente (o mesmo do servidor:
// server/_core/ai — Gemini/Vertex ou o transporte antigo server/_core/llm.ts),
// e mostra recall e precisão por categoria, os "Por confirmar" e os emails que
// falhou. Não escreve nada nos casos nem na Comunicação.
//
// Uso:
//   pnpm tsx scripts/eval-mail-triage.ts                       (corpus principal)
//   pnpm tsx scripts/eval-mail-triage.ts --corpus controlo     (o de controlo; "todos" = os dois)
//   pnpm tsx scripts/eval-mail-triage.ts --limit 20            (os primeiros 20)
//   pnpm tsx scripts/eval-mail-triage.ts --json                (resultado em JSON)
//
// Avaliação SEM chave de IA (substituto offline, para quem audita):
//   --dump DIR      grava em DIR o pedido EXATO de cada email que a IA leria
//                   (sistema + utilizador, depois de tapar os dados pessoais e
//                   dos cortes), com nomes opacos e baralhados (pNNN.txt) e o
//                   mapa DIR/map.json (não o leias antes de responder);
//   --answers F     lê as respostas JSON ({"p001": {box, confidence, complaint,
//                   lostItem, reason}, …}; o mapa ao lado, F/../map.json) e corre a
//                   MESMA decisão de produção sobre elas.
// Sai com código 1 se as reclamações ou os perdidos ficarem abaixo de 90 % (em
// qualquer corpus), e com 2 se a IA não estiver configurada (nenhum email lido).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { corpusCounts, type TriageCorpusItem } from "../server/fixtures/mailTriageCorpus";
import {
  TRIAGE_CORPORA, TRIAGE_CORPUS_KEYS, TRIAGE_CORPUS_LABELS, corpusFacts, evalCorpusItem, evalTriageSlice, productionThresholds, triageEvalReport,
  type EvalItemResult, type TriageCorpusKey,
} from "../server/mailTriageEval";
import { mailRoutingRequest } from "../server/commsRouting";
import { DIRECT_CASE_PIPELINES, MAIL_TRIAGE_CATEGORY_LABELS, parseTriageCategory, preTriageMail, type TriageMetrics } from "../shared/mailTriage";

const args = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const json = args.includes("--json");
const corpusArg = opt("--corpus") ?? "principal";
const keys: TriageCorpusKey[] = corpusArg === "todos" ? TRIAGE_CORPUS_KEYS : TRIAGE_CORPUS_KEYS.includes(corpusArg as TriageCorpusKey) ? [corpusArg as TriageCorpusKey] : [];
if (!keys.length) {
  console.error(`--corpus tem de ser ${[...TRIAGE_CORPUS_KEYS, "todos"].join(", ")}.`);
  process.exit(2);
}
const limitArg = opt("--limit");
const corpusFor = (k: TriageCorpusKey): readonly TriageCorpusItem[] => {
  const all = TRIAGE_CORPORA[k];
  return limitArg ? all.slice(0, Math.max(1, Number(limitArg) || all.length)) : all;
};

const pct = (v: number | null) => (v == null ? "  —  " : `${String(Math.round(v * 100)).padStart(3)} %`);
const label = (k: string | null) => (k ? MAIL_TRIAGE_CATEGORY_LABELS[parseTriageCategory(k) ?? "geral"] ?? k : "falhou");

/** Baralha de forma repetível (o mesmo dump dá os mesmos nomes). */
function shuffled<T>(a: readonly T[], seed = 20261014): T[] {
  const out = [...a];
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** O email passa pela IA em produção? (as regras e o que fica de fora não). */
function readByAi(item: TriageCorpusItem): boolean {
  const f = corpusFacts(item);
  const pre = preTriageMail(f.pre);
  if (pre.action === "ai") return true;
  return pre.action === "skip" && pre.why === "case_box" && !!f.pre.pipeline && DIRECT_CASE_PIPELINES.has(f.pre.pipeline);
}

async function dump(dir: string) {
  const all = keys.flatMap((k) => corpusFor(k).map((item) => ({ k, item })));
  const todo = shuffled(all.filter((x) => readByAi(x.item)));
  mkdirSync(join(dir, "prompts"), { recursive: true });
  const map: Record<string, { corpus: TriageCorpusKey; id: string }> = {};
  let system = "";
  for (const [i, { k, item }] of todo.entries()) {
    const name = `p${String(i + 1).padStart(3, "0")}`;
    const f = corpusFacts(item);
    const req = await mailRoutingRequest(f.msg, f.fromLabel);
    system = req.system;
    writeFileSync(join(dir, "prompts", `${name}.txt`), `### SISTEMA\n${req.system}\n\n### UTILIZADOR\n${req.input}\n`);
    map[name] = { corpus: k, id: item.id };
  }
  writeFileSync(join(dir, "system.txt"), system);
  writeFileSync(join(dir, "map.json"), JSON.stringify(map, null, 2));
  console.log(`${todo.length} pedidos em ${dir}/prompts (de ${all.length} emails; os outros vão por regra). Mapa em ${dir}/map.json.`);
}

type Answer = { box: string; confidence: number; reason: string; complaint?: number; lostItem?: number };

async function runCorpus(k: TriageCorpusKey, classifyFor: ((item: TriageCorpusItem) => Promise<EvalItemResult>) | null) {
  const corpus = corpusFor(k);
  const started = Date.now();
  const items: EvalItemResult[] = [];
  let model: string | null = null;
  if (classifyFor) {
    for (const item of corpus) items.push(await classifyFor(item));
    model = "substituto (respostas gravadas)";
  } else {
    for (let offset = 0; offset < corpus.length; offset += 12) {
      const r = await evalTriageSlice({ offset, limit: 12, concurrency: 4 }, { corpus });
      items.push(...r.items);
      model = model ?? r.model;
      if (!json) process.stdout.write(`\r${items.length} de ${corpus.length}…`);
    }
    if (!json) process.stdout.write("\n");
  }
  const m = triageEvalReport({ rows: items.map((i) => ({ id: i.id, predicted: i.predicted })), ms: Date.now() - started, model, corpus: k }, corpus, json ? () => {} : (l) => console.log(`\n${l}\n`));
  return { k, corpus, items, model, m };
}

function print(r: { k: TriageCorpusKey; corpus: readonly TriageCorpusItem[]; items: EvalItemResult[]; model: string | null; m: TriageMetrics & { missing: number } }) {
  console.log(`== ${TRIAGE_CORPUS_LABELS[r.k]}: ${r.corpus.length} emails — ${Object.entries(corpusCounts(r.corpus)).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  console.log("Categoria                               Exemplos  Recall  Precisão");
  for (const c of r.m.byCategory) console.log(`${c.label.padEnd(40)}${String(c.support).padStart(8)}  ${pct(c.recall)}  ${pct(c.precision)}`);
  for (const [kind, cat] of [["complaint", "reclamacoes"], ["lost_found", "perdidos"]] as const) {
    const opened = r.items.filter((i) => i.caseKind === kind || (i.via !== "ia" && i.predicted === cat));
    const unsure = r.items.filter((i) => i.caseKind === kind && i.uncertain);
    const fp = r.items.filter((i) => i.predicted === cat && i.expected !== cat);
    console.log(`${cat}: ${opened.length} casos abertos, ${unsure.length} "Por confirmar" (${unsure.filter((i) => i.expected === cat).length} certos), falsos positivos ${fp.length}${fp.length ? ` (${fp.map((i) => `${i.id}${i.uncertain ? " por confirmar" : ""}`).join(", ")})` : ""}`);
  }
  const wrong = r.items.filter((i) => i.predicted !== i.expected);
  if (wrong.length) {
    console.log(`Não acertou (${wrong.length}):`);
    for (const w of wrong) console.log(`  ${w.id.padEnd(10)} devia ser ${label(w.expected)} → foi ${label(w.predicted)}${w.reason ? ` — ${w.reason}` : ""}${w.error ? ` (erro: ${w.error})` : ""}`);
  }
  console.log(`Modelo: ${r.model ?? "—"} · ${r.m.passes ? "PASSA" : "NÃO PASSA"} a meta de ${Math.round(r.m.target * 100)} %\n`);
}

async function main() {
  const dumpDir = opt("--dump");
  if (dumpDir) return dump(dumpDir);
  const answersFile = opt("--answers");
  let classifyFor: ((item: TriageCorpusItem, k: TriageCorpusKey) => Promise<EvalItemResult>) | null = null;
  if (answersFile) {
    const answers = JSON.parse(readFileSync(answersFile, "utf8")) as Record<string, Answer>;
    const map = JSON.parse(readFileSync(join(dirname(answersFile), "map.json"), "utf8")) as Record<string, { corpus: TriageCorpusKey; id: string }>;
    const byItem = new Map(Object.entries(map).map(([name, v]) => [`${v.corpus}:${v.id}`, name]));
    // As certezas de omissão (sem BD): as de produção quando não há Definições gravadas.
    const t = await productionThresholds();
    classifyFor = (item, k) => evalCorpusItem(item, async () => {
      const name = byItem.get(`${k}:${item.id}`);
      const out = name ? answers[name] : undefined;
      if (!out) throw Object.assign(new Error(`sem resposta (${name ?? "fora do dump"})`), { code: "sem_resposta" });
      return { output: out as any, restore: (s: string) => s, model: "substituto" };
    }, t);
  }
  const results = [];
  for (const k of keys) results.push(await runCorpus(k, classifyFor ? (item) => classifyFor!(item, k) : null));
  if (json) console.log(JSON.stringify(results.map(({ k, m, model, items }) => ({ corpus: k, metrics: m, model, items })), null, 2));
  else for (const r of results) print(r);
  const readByAiCount = results.flatMap((r) => r.items).filter((i) => i.via === "ia" || (i.via === "porta" && !i.error)).length;
  if (!readByAiCount) {
    console.error("A IA não leu nenhum email (não configurada, desligada ou sem orçamento?). Configura o fornecedor no ambiente — nunca coloques chaves no código.");
    process.exit(2);
  }
  process.exit(results.every((r) => r.m.passes) ? 0 : 1);
}

main().catch((err) => {
  console.error("Falhou:", String(err?.message ?? err));
  process.exit(2);
});
