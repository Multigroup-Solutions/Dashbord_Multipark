/**
 * Comparação ANTES/DEPOIS do motor financeiro único (fase 1).
 *
 * Corre o cálculo antigo (server/finance/legacy.ts) e o novo (server/finance/
 * engine.ts) para os mesmos meses e imprime as diferenças por componente, com a
 * razão esperada de cada uma. Só LÊ da base de dados.
 *
 * Correr da raiz do dashboard (precisa de DATABASE_URL no .env):
 *   ./node_modules/.bin/tsx scripts/finance-parity.ts            # últimos 3 meses fechados + mês atual
 *   ./node_modules/.bin/tsx scripts/finance-parity.ts 2026-06 2026-07 2026-08
 *   ENV_FILE=../.env ./node_modules/.bin/tsx scripts/finance-parity.ts   # .env noutro sítio (worktree)
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(here, "..", ".env") });

const fmt = (v: number) => (Math.round(v * 100) / 100).toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;

function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(dim).padStart(2, "0")}`, year: y, month: m };
}

function defaultMonths(): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 3; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const EXPECTED: Record<string, string> = {
  produced: "igual em produção (UTC). Num PC com fuso Lisboa o legado corta o último dia às 22:59 (new Date('…T23:59:59') local→UTC); o motor usa strings e não depende do fuso",
  collected: "igual (mesma nota do fuso)",
  expenses: "igual (data da despesa, sem canceladas)",
  expensesPending: "igual — mas já NÃO é somada aos custos",
  extrasDia: "↓ se havia team leaders nas escalas (contavam 2×), saídas antecipadas, ou escalas de OUTRA cidade no filtro",
  salaries: "≠ fevereiro (28/30→mês completo), meses de 31 dias (31/30→1), histórico salarial, inativos com contrato no período, + provisões 13.º/14.º + variável do ponto",
  employerTax: "segue os salários (TSU sobre base+variável tributável, não sobre provisões)",
  commissions: "igual (venda + operacional)",
  totalCosts: "↓ pendentes já não somadas 2×; ↑ provisões/variável",
  marginNet: "consequência das linhas acima",
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL em falta (usa ENV_FILE=caminho/.env)"); process.exit(1); }
  const { legacyBillingData, legacyAnnualBreakdown } = await import("../server/finance/legacy");
  const { computeFinance } = await import("../server/finance/engine");
  const { getAnnualBreakdown } = await import("../server/finance/compat");

  const months = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}$/.test(a));
  const list = months.length ? months : defaultMonths();
  console.log(`\n=== PARIDADE FATURAÇÃO — meses: ${list.join(", ")} ===`);

  for (const ym of list) {
    const r = monthRange(ym);
    const [oldR, newR] = await Promise.all([legacyBillingData({ from: r.from, to: r.to }), computeFinance({ from: r.from, to: r.to, granularity: "day" })]);
    const o: any = oldR.summary;
    const rows: Array<[string, number, number]> = [
      ["produced", Number(o.produced ?? 0), newR.revenue.produced],
      ["collected", Number(o.collected ?? 0), newR.revenue.collected],
      ["expenses", Number(o.expensesPaid ?? 0), newR.costs.expenses],
      ["expensesPending", Number(o.expensesPending ?? 0), newR.costs.expensesPending],
      ["extrasDia", Number(o.extrasDiaCost ?? 0), newR.costs.extrasDia],
      ["salaries", Number(o.salariesCost ?? 0), newR.costs.salaries],
      ["employerTax", Number(o.employerTax ?? 0), newR.costs.employerTax],
      ["commissions", Number(o.salesCommissions ?? 0) + Number(o.operationalPartnersPaid ?? 0), newR.costs.salesCommissions + newR.costs.operationalCommissions],
      ["totalCosts", Number(o.totalCostsAll ?? 0), newR.costs.totalGross],
      ["marginNet", Number(o.marginNet ?? 0), newR.margin.margin],
    ];
    console.log(`\n--- ${ym} (${r.from} → ${r.to}) ---`);
    console.log(`${pad("componente", 16)} ${pad("antes", 14)} ${pad("depois", 14)} ${pad("Δ", 14)}  razão esperada`);
    for (const [k, a, b] of rows) {
      const d = b - a;
      const flag = Math.abs(d) < 0.005 ? "=" : d > 0 ? "↑" : "↓";
      console.log(`${pad(k, 16)} ${pad(fmt(a), 14)} ${pad(fmt(b), 14)} ${pad((d >= 0 ? "+" : "") + fmt(d), 14)} ${flag} ${EXPECTED[k] ?? ""}`);
    }
    // Soma do gráfico vs cartões (nova): tem de bater ao cêntimo
    const ts = newR.timeseries.reduce((s, p) => ({ produced: s.produced + p.produced, cost: s.cost + p.totalCost, margin: s.margin + p.margin }), { produced: 0, cost: 0, margin: 0 });
    const ok = Math.abs(ts.produced - newR.revenue.produced) < 0.01 && Math.abs(ts.cost - newR.costs.totalNet) < 0.01 && Math.abs(ts.margin - newR.margin.margin) < 0.01;
    console.log(`gráfico = cartões: ${ok ? "OK" : "FALHA"} (Σ produced ${fmt(ts.produced)} / Σ custo ${fmt(ts.cost)} / Σ margem ${fmt(ts.margin)})`);
    const q = newR.quality;
    console.log(`qualidade: conflitos parceiros=${q.partnerConflicts.length}, sem taxa=${q.partnersRateMissing.length}, campanhas sem parceiro=${q.campaignsWithoutPartner.length}, despesas sem centro=${q.expensesWithoutProject.count} (${fmt(q.expensesWithoutProject.total)}), colaboradores sem centro=${q.employeesWithoutProject}, inativos sem fim de contrato=${q.inactiveWithoutContractEnd}, turnos team leader ignorados=${q.extrasDiaTeamLeaderShifts}, variável RH meses=${q.payrollVariableMonths.join("|") || "-"}, marketing excluído: ads ${fmt(q.marketingExcluded.adSpend)} + mkt ${fmt(q.marketingExcluded.marketingExpenses)}`);
  }

  // ANUAL: motor único vs legado, por mês
  const year = Number(list[list.length - 1].slice(0, 4));
  console.log(`\n=== PARIDADE ANUAL ${year} (lucro por mês) ===`);
  const [oldA, newA] = await Promise.all([legacyAnnualBreakdown(year), getAnnualBreakdown(year)]);
  console.log(`${pad("mês", 4)} ${pad("rec.s/IVA antes", 16)} ${pad("depois", 14)} ${pad("lucro antes", 14)} ${pad("depois", 14)} ${pad("Δ lucro", 12)}`);
  for (let m = 1; m <= 12; m++) {
    const a: any = oldA.find((x: any) => x.month === m), b: any = newA.find((x: any) => x.month === m);
    if (!a || !b) continue;
    if (!a.revenueGrossWithVat && !b.revenueGrossWithVat && !a.salaries && !b.salaries) continue;
    console.log(`${pad(String(m), 4)} ${pad(fmt(a.revenueNoVat), 16)} ${pad(fmt(b.revenueNoVat), 14)} ${pad(fmt(a.profit), 14)} ${pad(fmt(b.profit), 14)} ${pad(fmt(b.profit - a.profit), 12)}${b.fromHistory ? " hist." : ""}`);
  }
  console.log("\nRazões esperadas no Anual: receita ↓ (antes contava status != CANCELLED, incl. previstas; agora só CHECKED_OUT); comissões passam de dedução à receita para custo; marketing (ads + mkt_expenses) deixa de ser somado 2×; pessoal alinhado com a Faturação.\n");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
