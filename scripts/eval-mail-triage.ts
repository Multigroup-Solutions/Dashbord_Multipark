// Avalia a triagem dos emails (14 out 2026 — meta do Jorge: mais de 90 % das
// reclamações e dos perdidos vão para lá).
//
// Corre o corpus rotulado (server/fixtures/mailTriageCorpus.ts) pelo MESMO
// pedido à IA e pela MESMA decisão de produção (server/mailTriageEval.ts),
// com o fornecedor de IA configurado no ambiente (o mesmo do servidor:
// server/_core/ai — Gemini/Vertex ou o transporte antigo server/_core/llm.ts),
// e mostra recall e precisão por categoria e os emails que falhou.
// Não escreve nada nos casos nem na Comunicação.
//
// Uso:
//   pnpm tsx scripts/eval-mail-triage.ts            (todos)
//   pnpm tsx scripts/eval-mail-triage.ts --limit 20 (os primeiros 20)
//   pnpm tsx scripts/eval-mail-triage.ts --json     (resultado em JSON)
// Sai com código 1 se as reclamações ou os perdidos ficarem abaixo de 90 %,
// e com 2 se a IA não estiver configurada (nenhum email lido).
import { TRIAGE_CORPUS, corpusCounts } from "../server/fixtures/mailTriageCorpus";
import { evalTriageSlice, triageEvalReport, type EvalItemResult } from "../server/mailTriageEval";
import { MAIL_TRIAGE_CATEGORY_LABELS, parseTriageCategory } from "../shared/mailTriage";

const args = process.argv.slice(2);
const json = args.includes("--json");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Math.max(1, Number(args[limitArg + 1]) || TRIAGE_CORPUS.length) : TRIAGE_CORPUS.length;
const corpus = TRIAGE_CORPUS.slice(0, limit);

const pct = (v: number | null) => (v == null ? "  —  " : `${String(Math.round(v * 100)).padStart(3)} %`);
const label = (k: string | null) => (k ? MAIL_TRIAGE_CATEGORY_LABELS[parseTriageCategory(k) ?? "geral"] ?? k : "falhou");

async function main() {
  const started = Date.now();
  const items: EvalItemResult[] = [];
  let model: string | null = null;
  if (!json) console.log(`Corpus: ${corpus.length} emails — ${Object.entries(corpusCounts(corpus)).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  for (let offset = 0; offset < corpus.length; offset += 12) {
    const r = await evalTriageSlice({ offset, limit: 12, concurrency: 4 }, { corpus });
    items.push(...r.items);
    model = model ?? r.model;
    if (!json) process.stdout.write(`\r${items.length} de ${corpus.length}…`);
  }
  if (!json) process.stdout.write("\n");
  const m = triageEvalReport({ rows: items.map((i) => ({ id: i.id, predicted: i.predicted })), ms: Date.now() - started, model }, corpus, json ? () => {} : (l) => console.log(`\n${l}\n`));
  const readByAi = items.filter((i) => i.via === "ia" || (i.via === "porta" && !i.error)).length;
  if (json) {
    console.log(JSON.stringify({ metrics: m, model, items }, null, 2));
  } else {
    console.log("Categoria                               Exemplos  Recall  Precisão");
    for (const c of m.byCategory) console.log(`${c.label.padEnd(40)}${String(c.support).padStart(8)}  ${pct(c.recall)}  ${pct(c.precision)}`);
    const wrong = items.filter((i) => i.predicted !== i.expected);
    if (wrong.length) {
      console.log(`\nNão acertou (${wrong.length}):`);
      for (const w of wrong) console.log(`  ${w.id.padEnd(9)} devia ser ${label(w.expected)} → foi ${label(w.predicted)}${w.reason ? ` — ${w.reason}` : ""}${w.error ? ` (erro: ${w.error})` : ""}`);
    }
    console.log(`\nModelo: ${model ?? "—"} · ${m.passes ? "PASSA" : "NÃO PASSA"} a meta de ${Math.round(m.target * 100)} %`);
  }
  if (!readByAi) {
    console.error("A IA não leu nenhum email (não configurada, desligada ou sem orçamento?). Configura o fornecedor no ambiente — nunca coloques chaves no código.");
    process.exit(2);
  }
  process.exit(m.passes ? 0 : 1);
}

main().catch((err) => {
  console.error("Falhou:", String(err?.message ?? err));
  process.exit(2);
});
