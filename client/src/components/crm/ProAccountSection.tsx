/**
 * CRM fase 2 — CONTA CORRENTE de um cliente Pro, na ficha (desenho "Ficha Pro").
 * Vem da BD da Multipark (sincronizada de 30 em 30 min): reservas Pro a
 * débito, pagamentos a crédito; os meses pagos são os que a Multipark
 * registou. Nada se paga aqui — "Registar pagamento" abre a Multipark.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle2, Download, ExternalLink, Plus } from "lucide-react";
import { lisbonMonth, monthLabel } from "@shared/crmPro";
import { ClientAvatar, Lbl, Pill, eur, fmtPhone, num, shortDate, shortDateTime } from "./crmUi";
import type { CrmProAccount, CrmProLedgerRow } from "./crmTypes";

type KindFilter = "all" | "booking" | "payment" | "marks";

const KIND_LABEL: Record<string, string> = {
  booking: "Reserva", payment: "Pagamento", paid_undated: "Pago (sem data)", settlement: "Período pago na Multipark", online: "Cobrança online",
};
const METHOD_LABEL: Record<string, string> = {
  TRANSFER: "transferência", BANK_TRANSFER: "transferência", CASH: "numerário", CARD: "cartão", MBWAY: "MB WAY", MB_WAY: "MB WAY",
  MULTIBANCO: "Multibanco", PRO_PLAN: "plano Pro", STRIPE: "cartão (Stripe)",
};
const method = (m: string | null | undefined) => (m ? METHOD_LABEL[m.toUpperCase()] ?? m.toLowerCase() : null);

const STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: "pago", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" },
  due: { label: "por pagar", cls: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200" },
  open: { label: "em curso", cls: "bg-secondary text-secondary-foreground" },
  credit: { label: "crédito", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" },
};

export function ProAccountSection({ a, onLinkPerson }: { a: CrmProAccount; onLinkPerson?: () => void }) {
  const s = a.summary;
  const [month, setMonth] = useState<string>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const discounts = [...new Set(a.parks.map((p) => p.discount).filter((x): x is number => x != null))];
  const nowMonthName = monthLabel(lisbonMonth(new Date()) ?? "").split(" ")[0] || "Este mês";

  // último mês pago (com o que a Multipark registou)
  const lastPaid = s.months.find((m) => m.status === "paid" && (m.debit ?? 1) !== 0);

  const rows = useMemo(() => {
    const inKind = (r: CrmProLedgerRow) => kind === "all" || (kind === "booking" && r.kind === "booking")
      || (kind === "payment" && (r.kind === "payment" || r.kind === "paid_undated")) || (kind === "marks" && (r.kind === "settlement" || r.kind === "online"));
    const list = a.ledger.filter((r) => (month === "all" || r.periodKey === month) && inKind(r));
    // saldo corrido (do mais antigo para o mais recente), só dos movimentos que contam
    const asc = [...list].reverse();
    let bal = 0;
    const balOf = new Map<number, number | null>();
    for (const r of asc) {
      if (r.debit == null && r.credit == null) { balOf.set(r.id, null); continue; }
      if (r.kind === "settlement" || r.kind === "online") { balOf.set(r.id, null); continue; }
      bal += (r.debit ?? 0) - (r.credit ?? 0);
      balOf.set(r.id, Math.round(bal * 100) / 100);
    }
    return list.map((r) => ({ ...r, balance: balOf.get(r.id) ?? null }));
  }, [a.ledger, month, kind]);

  const monthTotal = month === "all" ? null : s.months.find((m) => m.periodKey === month) ?? null;

  const exportCsv = () => {
    const f = (v: number | null) => (v == null ? "" : v.toFixed(2).replace(".", ","));
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["Data", "Movimento", "Referência", "Quem viajou", "Matrícula", "Parque", "Débito", "Crédito", "Saldo"].join(";")];
    for (const r of [...rows].reverse()) {
      lines.push([q(r.entryAt), q(KIND_LABEL[r.kind] ?? r.kind), q(r.bookingCode ?? r.mpPeriodKey ?? ""), q(r.travelerName), q(r.plate), q(r.parkName),
        f(r.debit), f(r.credit), f(r.balance)].join(";"));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `conta-corrente-${(a.name ?? "pro").replace(/[^\w-]+/g, "-").toLowerCase()}-${month}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-lg font-bold">Conta corrente</span>
        <Pill className="bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">Pro · paga ao fim do mês</Pill>
        {discounts.map((d) => <Pill key={d} className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">Desconto {d} %</Pill>)}
        {!a.active && <Pill className="bg-muted text-muted-foreground">Pro desativado</Pill>}
        {a.autoBilling && <Pill className="bg-secondary text-secondary-foreground">Cobrança automática</Pill>}
        <div className="flex-1" />
        <Button variant="outline" asChild><a href={a.multiparkUrl} target="_blank" rel="noreferrer">Abrir na Multipark<ExternalLink className="h-3.5 w-3.5" /></a></Button>
        <Button asChild title="Os pagamentos registam-se na Multipark; a conta corrente atualiza sozinha.">
          <a href={a.multiparkUrl} target="_blank" rel="noreferrer">Registar pagamento na Multipark<ExternalLink className="h-3.5 w-3.5" /></a>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Saldo em dívida" value={eur(s.due, 2)} tone={(s.dueMonths ?? 0) > 0 ? "amber" : undefined}
          note={s.oldestDue ? `${s.dueMonths === 1 ? monthLabel(s.oldestDue) : `${s.dueMonths} meses, desde ${monthLabel(s.oldestDue)}`} por pagar` : "nada em atraso"} />
        <Kpi label={`${nowMonthName[0].toUpperCase()}${nowMonthName.slice(1)} até hoje`} value={eur(s.currentMonthDebit, 2)} note={`${num(s.currentMonthBookings)} ${s.currentMonthBookings === 1 ? "reserva" : "reservas"} · fatura no fim do mês`} />
        <Kpi label="Pago este ano" value={eur(s.paidThisYear, 2)} note={s.lastPaidAt ? `último a ${shortDate(s.lastPaidAt)}` : "sem pagamentos"} />
        <Kpi label="Prazo médio de pagamento" value={s.avgPayDays == null ? "—" : `${s.avgPayDays} dias`} note="depois do fim do mês" />
      </div>

      {lastPaid && (
        <div className="flex items-center gap-2.5 rounded-[10px] border border-emerald-300 bg-emerald-50 px-3.5 py-2.5 text-[13px] dark:border-emerald-800 dark:bg-emerald-950/40">
          <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-emerald-700" />
          <span>
            <strong>{capital(monthLabel(lastPaid.periodKey))} pago.</strong>{" "}
            {lastPaid.settledAt
              ? <>A Multipark registou o pagamento{lastPaid.credit != null ? <> de {eur(lastPaid.credit, 2)}</> : null} a {shortDate(lastPaid.settledAt)}{lastPaid.settledMethod ? ` (${method(lastPaid.settledMethod)})` : ""}.</>
              : <>Pago na Multipark{lastPaid.credit != null ? <> ({eur(lastPaid.credit, 2)})</> : null}.</>}
            {" "}A conta corrente atualiza sozinha.
          </span>
        </div>
      )}

      {/* meses */}
      {s.months.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {s.months.slice(0, 18).map((m) => (
            <button key={m.periodKey} type="button" onClick={() => setMonth(month === m.periodKey ? "all" : m.periodKey)}
              className={cn("flex min-w-[132px] shrink-0 flex-col gap-1 rounded-[10px] border bg-card p-2.5 text-left", month === m.periodKey && "border-primary ring-1 ring-primary")}>
              <span className="text-xs font-semibold capitalize">{monthLabel(m.periodKey)}</span>
              <Pill className={cn("self-start", STATUS[m.status]?.cls)}>{STATUS[m.status]?.label ?? m.status}</Pill>
              <span className="text-xs text-muted-foreground">{num(m.bookings)} {m.bookings === 1 ? "reserva" : "reservas"}{m.pending != null && m.pending > 0.005 ? ` · falta ${eur(m.pending, 2)}` : m.debit != null ? ` · ${eur(m.debit, 2)}` : ""}</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <div className="rounded-[10px] border bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="flex-1 font-display text-[15px] font-bold">Movimentos</span>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os meses</SelectItem>
                {s.months.map((m) => <SelectItem key={m.periodKey} value={m.periodKey}><span className="capitalize">{monthLabel(m.periodKey)}</span></SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
              <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os movimentos</SelectItem>
                <SelectItem value="booking">Só reservas</SelectItem>
                <SelectItem value="payment">Só pagamentos</SelectItem>
                <SelectItem value="marks">Marcas da Multipark</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-8" onClick={exportCsv} disabled={!rows.length}><Download className="h-3.5 w-3.5" />Exportar</Button>
          </div>
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px]">
              <thead>
                <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
                  <th className="px-3 py-2">Data</th><th className="px-3 py-2">Movimento</th><th className="px-3 py-2">Quem viajou</th><th className="px-3 py-2">Parque</th>
                  <th className="px-3 py-2 text-right">Débito</th><th className="px-3 py-2 text-right">Crédito</th><th className="px-3 py-2 text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Sem movimentos.</td></tr>}
                {rows.slice(0, 400).map((r) => {
                  const mark = r.kind === "settlement" || r.kind === "online";
                  return (
                    <tr key={r.id} className={cn("border-t align-top", mark && "bg-muted/40")}>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{shortDate(r.entryAt)}</td>
                      <td className="px-3 py-2">
                        <strong>{KIND_LABEL[r.kind] ?? r.kind}</strong>{" "}
                        {r.kind === "booking" && r.multiparkUrl
                          ? <a href={r.multiparkUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:underline">{r.bookingCode ? `n.º ${r.bookingCode}` : ""}</a>
                          : <span className="text-muted-foreground">{r.kind === "settlement" ? r.mpPeriodKey : r.bookingCode ? `n.º ${r.bookingCode}` : ""}</span>}
                        {r.kind === "booking" && r.checkIn && <div className="text-xs text-muted-foreground">{shortDate(r.checkIn)} → {shortDate(r.checkOut)}{r.status?.toUpperCase().includes("CANCEL") ? " · cancelada" : ""}{r.discountAmount ? ` · desconto ${eur(r.discountAmount, 2)}` : ""}</div>}
                        {(r.kind === "payment" || mark) && (method(r.method) || r.status) && <div className="text-xs text-muted-foreground">{[method(r.method), r.kind === "online" ? r.status?.toLowerCase() : null].filter(Boolean).join(" · ")}</div>}
                      </td>
                      <td className="px-3 py-2">{r.travelerName ?? ""}{r.plate && <div className="font-mono text-xs text-muted-foreground">{r.plate}</div>}</td>
                      <td className="px-3 py-2 text-muted-foreground">{r.parkName ?? ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.debit ? eur(r.debit, 2) : ""}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-300">{r.credit ? eur(r.credit, 2) : mark && r.infoAmount ? <span className="italic text-muted-foreground">({eur(r.infoAmount, 2)})</span> : ""}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.balance == null ? "" : eur(r.balance, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-[13px]">
            {monthTotal ? (
              <span><span className="text-muted-foreground">Total de {monthLabel(monthTotal.periodKey)}:</span> <strong>{eur(monthTotal.debit, 2)}</strong>
                {monthTotal.pending != null && monthTotal.pending > 0.005 && <span className="text-amber-700 dark:text-amber-300"> · falta pagar {eur(monthTotal.pending, 2)}</span>}</span>
            ) : <span><span className="text-muted-foreground">Saldo total:</span> <strong>{eur(s.balance, 2)}</strong></span>}
            <span className="text-xs text-muted-foreground">Vem da Multipark: reservas Pro e pagamentos{a.syncedAt ? ` · atualizado ${shortDateTime(a.syncedAt)}` : ""}</span>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2.5 rounded-[10px] border bg-card p-4">
            <div className="flex items-center">
              <span className="flex-1 font-display text-[15px] font-bold">Pessoas desta conta ({a.people.length + a.travelers.length})</span>
              {onLinkPerson && <Button size="sm" variant="outline" className="h-[30px]" onClick={onLinkPerson}><Plus className="h-3.5 w-3.5" />Ligar pessoa</Button>}
            </div>
            {a.people.map((p) => (
              <Link key={p.id} href={`/clientes/${p.id}`} className="flex items-center gap-2.5 rounded-lg p-1.5 hover:bg-muted">
                <ClientAvatar name={p.name} size={32} />
                <span className="min-w-0 flex-1 text-[13px]"><strong className="block truncate">{p.name ?? "Sem nome"}</strong><span className="block truncate text-xs text-muted-foreground">{p.email ?? (p.kind === "manager" ? "gere a conta" : "trabalha na empresa")}</span></span>
              </Link>
            ))}
            {a.travelers.map((t) => (
              <div key={t.name} className="flex items-center gap-2.5 p-1.5">
                <ClientAvatar name={t.name} size={32} />
                <span className="min-w-0 flex-1 truncate text-[13px]">{t.name}</span>
                <span className="text-xs text-muted-foreground">{num(t.trips)} {t.trips === 1 ? "viagem" : "viagens"}</span>
              </div>
            ))}
            {a.people.length + a.travelers.length === 0 && <p className="text-xs text-muted-foreground">Sem pessoas ligadas.</p>}
            <p className="text-xs text-muted-foreground">Cada pessoa tem a sua ficha. As reservas contam no histórico dela e aqui, na conta.</p>
          </div>

          <div className="flex flex-col gap-2 rounded-[10px] border bg-card p-4 text-[13px]">
            <span className="font-display text-[15px] font-bold">Dados da conta</span>
            <Row label="Nome">{a.name ?? "—"}</Row>
            <Row label="NIF">{a.nif ?? "—"}</Row>
            {a.taxName && <Row label="Nome fiscal">{a.taxName}</Row>}
            <Row label="Email de faturação">{a.billingEmail ?? a.email ?? "—"}</Row>
            <Row label="Contacto">{a.phone ? fmtPhone(a.phone) : "—"}</Row>
            <Row label="Cobrança automática">{a.autoBilling ? "sim" : "não"}</Row>
            <div className="mt-1 border-t pt-2">
              <Lbl>Parques</Lbl>
              {a.parks.map((p) => (
                <div key={p.proClientId} className="mt-1 flex justify-between gap-2">
                  <span className={cn(!p.active && "text-muted-foreground line-through")}>{p.name ?? "Parque"}</span>
                  <span className="text-muted-foreground">{p.discount != null ? `${p.discount} %` : ""}{!p.active ? " · desativado" : ""}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Kpi({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "amber" }) {
  return (
    <div className={cn("flex flex-col gap-0.5 rounded-[10px] border bg-card p-3.5", tone === "amber" && "border-amber-300 dark:border-amber-800")}>
      <Lbl>{label}</Lbl>
      <span className={cn("font-display text-2xl font-bold", tone === "amber" && "text-amber-800 dark:text-amber-200")}>{value}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex justify-between gap-3"><span className="text-muted-foreground">{label}</span><strong className="truncate text-right">{children}</strong></div>;
}
