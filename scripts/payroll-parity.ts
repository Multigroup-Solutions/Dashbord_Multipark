/**
 * Compara o cálculo ANTIGO de ordenados (main) com o NOVO (server/payroll) para
 * um mês, contra a base real. Só LÊ. Uso (raiz do dashboard, precisa de DATABASE_URL): ./node_modules/.bin/tsx scripts/payroll-parity.ts 2026 9
 */
import dotenv from "dotenv";
dotenv.config({ path: process.env.ENV_FILE ? process.env.ENV_FILE : ".env" });


const fmt = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const pad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const padR = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

async function main() {
  const year = Number(process.argv[2] ?? 2026), month = Number(process.argv[3] ?? 9);
  const { getPayrollData: legacy } = await import("./payrollLegacy");
  const { computePayrollForMonth } = await import("../server/payroll/payrollData");

  const oldRows: any[] = await legacy(year, month);
  const newRows: any[] = await computePayrollForMonth(year, month, {});
  const byIdNew = new Map(newRows.map((r) => [r.employeeId, r]));
  const byIdOld = new Map(oldRows.map((r) => [r.employeeId, r]));
  const ids = Array.from(new Set([...byIdOld.keys(), ...byIdNew.keys()]));

  console.log(`\n== ${year}-${String(month).padStart(2, "0")} — antigo ${oldRows.length} linhas, novo ${newRows.length} linhas ==\n`);
  console.log(padR("Nome", 26) + pad("Antigo €", 10) + pad("Novo €", 10) + pad("Δ €", 9) + pad("h ant", 7) + pad("h novo", 7) + pad("noite", 7) + pad("FDS", 6) + pad("susp", 6) + "  avisos");
  let tOld = 0, tNew = 0, changed = 0;
  const rows = ids.map((id) => ({ id, o: byIdOld.get(id), n: byIdNew.get(id) }))
    .sort((a, b) => Math.abs((b.n?.totalPayment ?? 0) - (b.o?.totalPayment ?? 0)) - Math.abs((a.n?.totalPayment ?? 0) - (a.o?.totalPayment ?? 0)));
  for (const { o, n } of rows) {
    const ov = o?.totalPayment ?? 0, nv = n?.totalPayment ?? 0;
    tOld += ov; tNew += nv;
    const d = nv - ov;
    if (Math.abs(d) >= 0.01) changed++;
    if (Math.abs(d) < 0.01 && (o?.totalHours ?? 0) === (n?.totalHours ?? 0)) continue;
    const name = (n?.fullName ?? o?.fullName ?? `#${o?.employeeId ?? n?.employeeId}`) + (n?.isExtra || o?.isExtra ? " (extra)" : "");
    const av = [n?.warnings?.join("; ") ?? "", !n ? "SÓ NO ANTIGO" : "", !o ? "SÓ NO NOVO" : ""].filter(Boolean).join(" | ");
    console.log(padR(name, 26) + pad(fmt(ov), 10) + pad(fmt(nv), 10) + pad(fmt(d), 9) + pad(fmt(o?.totalHours ?? 0), 7) + pad(fmt(n?.totalHours ?? 0), 7) + pad(`${fmt(o?.nightHours ?? 0)}→${fmt(n?.nightHours ?? 0)}`, 14) + pad(`${fmt(o?.weekendHours ?? 0)}→${fmt(n?.weekendHours ?? 0)}`, 14) + pad(fmt(n?.suspiciousHours ?? 0), 7) + "  " + av.slice(0, 110));
  }
  console.log("\n" + padR("TOTAL BRUTO", 26) + pad(fmt(tOld), 10) + pad(fmt(tNew), 10) + pad(fmt(tNew - tOld), 9) + `   (${changed} pessoas com valor diferente de ${ids.length})`);
  const susp = newRows.reduce((s, r) => s + (r.suspiciousHours ?? 0), 0);
  const open = newRows.reduce((s, r) => s + (r.openShifts ?? 0), 0);
  console.log(`Horas suspeitas por rever (não pagas no novo): ${fmt(susp)} h · turnos abertos: ${open}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
