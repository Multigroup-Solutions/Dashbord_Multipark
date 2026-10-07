/**
 * Lote 45 — Central Vodafone: as chamadas que a consola de cada pessoa
 * registou (Jorge, 7 out 2026: "cada um vê as SUAS chamadas, nós vemos
 * todas"). Módulo "central": alcance próprio → só as minhas; admin e super
 * admin → todas, com filtro por pessoa. Só lê.
 */
import { useState } from "react";
import { Link } from "wouter";
import { PhoneIncoming, PhoneOutgoing, PhoneCall, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { fmtPhone } from "@/components/crm/crmUi";
import { telHref } from "@shared/phone";
import { formatCallDuration } from "@shared/centralSugar";

const PERIODS = [
  { days: 1, label: "Hoje e ontem" },
  { days: 7, label: "7 dias" },
  { days: 30, label: "30 dias" },
  { days: 90, label: "90 dias" },
] as const;

export default function CentralPage() {
  const [days, setDays] = useState<number>(7);
  const [direction, setDirection] = useState<"all" | "in" | "out">("all");
  const [person, setPerson] = useState<string>("all");
  const q = trpc.central.myCalls.useQuery({
    days,
    direction: direction === "all" ? null : direction,
    userId: person === "all" ? null : Number(person),
  }, { placeholderData: (p) => p });
  const d = q.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold flex items-center gap-2 mr-auto"><PhoneCall className="h-5 w-5" />{d?.seesAll ? "Chamadas da central" : "As minhas chamadas"}</h1>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <Button key={p.days} size="sm" variant={days === p.days ? "selected" : "outline"} className="h-8" onClick={() => setDays(p.days)}>{p.label}</Button>
          ))}
        </div>
        <Select value={direction} onValueChange={(v) => setDirection(v as "all" | "in" | "out")}>
          <SelectTrigger className="h-8 w-[150px]" aria-label="Direção"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            <SelectItem value="in">Recebidas</SelectItem>
            <SelectItem value="out">Feitas</SelectItem>
          </SelectContent>
        </Select>
        {d?.seesAll && (
          <Select value={person} onValueChange={setPerson}>
            <SelectTrigger className="h-8 w-[200px]" aria-label="Pessoa"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as pessoas</SelectItem>
              {d.people.map((p) => <SelectItem key={p.userId} value={String(p.userId)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      {q.isError && <QueryErrorNote error={q.error} what="as chamadas" onRetry={() => q.refetch()} retrying={q.isFetching} />}
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}

      {d && !d.seesAll && !d.hasAccount && (
        <Card><CardContent className="p-4 text-sm text-muted-foreground">
          Ainda não tens um acesso da consola da Vodafone. Quando o administrador te criar um (Integrações → Central Vodafone) e o puseres na tua consola, as tuas chamadas aparecem aqui.
        </CardContent></Card>
      )}

      {d && (
        <>
          <div className="grid grid-cols-3 gap-2 max-w-xl">
            <Kpi label="Recebidas" value={String(d.totals.in)} />
            <Kpi label="Feitas" value={String(d.totals.out)} />
            <Kpi label="Tempo" value={formatCallDuration(d.totals.durationS)} />
          </div>
          {d.calls.length === 0 ? (
            !q.isError && <p className="text-sm text-muted-foreground">Sem chamadas registadas neste período.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-[680px] text-sm">
                <thead className="bg-muted text-[11px] font-bold uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Quando</th>
                    <th className="px-3 py-2 text-left"></th>
                    <th className="px-3 py-2 text-left">Com quem</th>
                    <th className="px-3 py-2 text-left">Número</th>
                    <th className="px-3 py-2 text-left">Duração</th>
                    {d.seesAll && <th className="px-3 py-2 text-left">Quem</th>}
                  </tr>
                </thead>
                <tbody>
                  {d.calls.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="px-3 py-2 whitespace-nowrap">{fmtPTDateTime(c.startedAt)}</td>
                      <td className="px-3 py-2">
                        {c.direction === "in"
                          ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><PhoneIncoming className="h-4 w-4" />Recebida</span>
                          : <span className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400"><PhoneOutgoing className="h-4 w-4" />Feita</span>}
                      </td>
                      <td className="px-3 py-2">
                        {c.contact
                          ? (c.contact.href ? <Link href={c.contact.href} className="text-primary hover:underline">{c.contact.name}</Link> : c.contact.name)
                          : <span className="text-muted-foreground">—</span>}
                        {c.contact && <span className="ml-1.5 text-[11px] text-muted-foreground">{c.contact.kind}</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {c.phone ? (telHref(c.phone) ? <a href={telHref(c.phone)} className="hover:underline">{fmtPhone(c.phone)}</a> : c.phone) : "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatCallDuration(c.durationS)}</td>
                      {d.seesAll && <td className="px-3 py-2">{c.userName ?? "—"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.truncated && <p className="text-xs text-muted-foreground">Mostram-se as 500 mais recentes. Escolhe um período mais curto para ver o resto.</p>}
          <p className="text-xs text-muted-foreground">A consola regista a chamada quando termina; as não atendidas não chegam aqui (ficam na lista da consola).</p>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-[10px] font-bold uppercase text-muted-foreground">{label}</div>
      <div className="font-bold tabular-nums">{value}</div>
    </div>
  );
}
