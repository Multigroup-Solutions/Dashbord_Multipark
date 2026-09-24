/**
 * ROAS por campanha → reservas (Jorge, 24 set 2026). Por campanha (Google Ads
 * e Meta): gasto, cliques, conversões da plataforma, reservas LIGADAS, valor
 * s/ IVA, ROAS s/ IVA e CPA. Ligação reserva → campanha: ID da campanha no
 * link (gclid/fbclid + {campaignid}); senão utm_campaign ou código de desconto
 * que o admin liga à campanha aqui. Em baixo, as conversões por ação.
 */
import React, { useMemo, useState } from "react";
import { can, roleRank, seesBeyondOwn } from "@shared/access";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Link2, Loader2, Plus, X } from "lucide-react";

const EUR = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EUR0 = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
const eur = (v: number | null | undefined, d = 2) => (v == null ? "—" : (d ? EUR : EUR0).format(v));
const num = (v: number | null | undefined) => (v == null ? "—" : NUM.format(v));
const roasX = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2).replace(".", ",")}×`);
const KEY_LABEL: Record<string, string> = { utm_campaign: "utm_campaign", discount_code: "código" };

function statusBadge(status: string | null | undefined) {
  const s = String(status ?? "").toUpperCase();
  if (s === "REMOVED" || s === "DELETED") return <Badge variant="outline" className="ml-1.5 text-[10px] text-rose-700 border-rose-200">removida</Badge>;
  if (s === "PAUSED" || s === "CAMPAIGN_PAUSED") return <Badge variant="outline" className="ml-1.5 text-[10px] text-amber-700 border-amber-200">pausada</Badge>;
  if (s === "ARCHIVED") return <Badge variant="outline" className="ml-1.5 text-[10px]">arquivada</Badge>;
  return null;
}

export default function CampaignRoasPanel({ from, to, projectId }: { from: string; to: string; projectId?: number }) {
  const { user } = useAuth();
  const isAdmin = can(user?.role, "marketing", "manage");
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.marketing.campaignRoas.useQuery({ from, to, projectId });
  const refresh = () => { utils.marketing.campaignRoas.invalidate(); utils.marketing.campaignLinks.list.invalidate(); };
  const add = trpc.marketing.campaignLinks.add.useMutation({ onSuccess: () => { refresh(); toast.success("Ligação criada"); }, onError: (e) => toast.error(e.message) });
  const remove = trpc.marketing.campaignLinks.remove.useMutation({ onSuccess: refresh, onError: (e) => toast.error(e.message) });
  const [open, setOpen] = useState<string | null>(null);
  const [linkType, setLinkType] = useState<"utm_campaign" | "discount_code">("utm_campaign");
  const [linkValue, setLinkValue] = useState("");
  const rows: any[] = data?.rows ?? [];
  const totals = useMemo(() => rows.reduce((t, r) => ({ cost: t.cost + r.cost, clicks: t.clicks + r.clicks, conversions: t.conversions + r.conversions, bookings: t.bookings + r.bookings, revenue: t.revenue + r.revenue, revenueNet: t.revenueNet + r.revenueNet }), { cost: 0, clicks: 0, conversions: 0, bookings: 0, revenue: 0, revenueNet: 0 }), [rows]);

  if (error) return <p role="alert" className="text-sm text-destructive">{error.message}</p>;
  if (isLoading || !data) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>ROAS por campanha</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Reservas ligadas = reservas do período (data de criação, sem canceladas) com o ID da campanha no link de origem (gclid/fbclid + campanha), ou com um utm_campaign / código de desconto ligado à campanha{isAdmin ? " (abre a linha para ligar)" : ""}. Cada reserva conta uma vez. Valor e ROAS sem IVA (÷ {(1 + Number(data.vatRate)).toFixed(2).replace(".", ",")}). CPA = gasto ÷ reservas ligadas.
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {rows.length === 0 ? <p className="text-sm text-muted-foreground p-6 text-center">Sem campanhas com gasto no período.</p> : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Campanha</th>
                  <th className="text-right px-4 py-2 font-medium">Gasto</th>
                  <th className="text-right px-4 py-2 font-medium">Cliques</th>
                  <th className="text-right px-4 py-2 font-medium" title="Conversões contadas pela plataforma (Google/Meta)">Conv. plataforma</th>
                  <th className="text-right px-4 py-2 font-medium">Reservas ligadas</th>
                  <th className="text-right px-4 py-2 font-medium">Valor s/ IVA</th>
                  <th className="text-right px-4 py-2 font-medium">ROAS (s/ IVA)</th>
                  <th className="text-right px-4 py-2 font-medium">CPA</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isOpen = open === r.key;
                  return (
                    <React.Fragment key={r.key}>
                      <tr className="border-b hover:bg-muted/30 cursor-pointer" onClick={() => setOpen(isOpen ? null : r.key)}>
                        <td className="px-4 py-1.5">
                          <span className="inline-flex items-center gap-1">
                            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            {r.name}
                          </span>
                          <Badge variant="outline" className="ml-1.5 text-[10px]">{r.provider === "meta" ? "Meta" : "Google"}</Badge>
                          {statusBadge(r.status)}
                          {r.links?.length > 0 && <Badge variant="outline" className="ml-1.5 text-[10px]"><Link2 className="w-3 h-3 mr-0.5" />{r.links.length}</Badge>}
                          {r.accountName && <div className="text-[11px] text-muted-foreground pl-5">conta {r.accountName}</div>}
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{eur(r.cost)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{num(r.clicks)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{num(r.conversions)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums font-semibold">{num(r.bookings)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{eur(r.revenueNet)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{roasX(r.roasNet)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{eur(r.cpa)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b bg-muted/20">
                          <td colSpan={8} className="px-6 py-3 space-y-3">
                            <div>
                              <div className="text-xs font-semibold mb-1">Conversões por ação</div>
                              {r.actions?.length ? (
                                <ul className="text-xs space-y-0.5">
                                  {r.actions.map((a: any, i: number) => <li key={i}>{a.actionName || a.category || "—"}{a.category && a.category !== a.actionName ? <span className="text-muted-foreground"> · {a.category}</span> : null}: <b>{num(a.conversions)}</b>{a.value ? ` · ${eur(a.value)}` : ""}</li>)}
                                </ul>
                              ) : <p className="text-xs text-muted-foreground">Sem conversões por ação no período.</p>}
                            </div>
                            <div>
                              <div className="text-xs font-semibold mb-1">Ligações (utm_campaign / código de desconto)</div>
                              <div className="flex flex-wrap gap-1.5">
                                {(r.links ?? []).map((l: any) => (
                                  <Badge key={l.id} variant="secondary" className="text-[11px]">
                                    {KEY_LABEL[l.keyType]}: {l.keyValue}
                                    {isAdmin && <button type="button" aria-label={`Remover ligação ${l.keyValue}`} className="ml-1" onClick={(e) => { e.stopPropagation(); remove.mutate({ id: l.id }); }}><X className="w-3 h-3" /></button>}
                                  </Badge>
                                ))}
                                {!r.links?.length && <span className="text-xs text-muted-foreground">nenhuma</span>}
                              </div>
                              {isAdmin && r.campaignId != null && (
                                <div className="flex flex-wrap items-center gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                                  <Select value={linkType} onValueChange={(v) => setLinkType(v as any)}>
                                    <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="utm_campaign">utm_campaign</SelectItem>
                                      <SelectItem value="discount_code">Código de desconto</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <Input className="h-8 w-56 text-xs" value={linkValue} onChange={(e) => setLinkValue(e.target.value)} placeholder={linkType === "utm_campaign" ? "ex.: verao_lisboa" : "ex.: VERAO10"} aria-label="Valor da ligação" />
                                  <Button size="sm" variant="outline" disabled={!linkValue.trim() || add.isPending} onClick={() => { add.mutate({ adCampaignId: r.campaignId, keyType: linkType, keyValue: linkValue.trim() }); setLinkValue(""); }}>
                                    <Plus className="w-3.5 h-3.5 mr-1" /> Ligar
                                  </Button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                <tr className="bg-muted/50 font-semibold">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right tabular-nums">{eur(totals.cost)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(totals.clicks)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(totals.conversions)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{num(totals.bookings)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{eur(totals.revenueNet)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{roasX(totals.cost > 0 ? totals.revenueNet / totals.cost : null)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{eur(totals.bookings > 0 ? totals.cost / totals.bookings : null)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Conversões por ação (todas as campanhas do âmbito)</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {!(data.conversionActions ?? []).length ? <p className="text-sm text-muted-foreground p-4">Sem conversões por ação no período.</p> : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr><th className="text-left px-4 py-2 font-medium">Ação</th><th className="text-left px-4 py-2 font-medium">Plataforma</th><th className="text-left px-4 py-2 font-medium">Categoria</th><th className="text-right px-4 py-2 font-medium">Conversões</th><th className="text-right px-4 py-2 font-medium">Valor</th></tr>
              </thead>
              <tbody>
                {data.conversionActions.map((a: any, i: number) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-1.5">{a.actionName || "—"}</td>
                    <td className="px-4 py-1.5 text-muted-foreground">{a.provider === "meta" ? "Meta" : "Google"}</td>
                    <td className="px-4 py-1.5 text-muted-foreground">{a.category ?? "—"}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{num(a.conversions)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{eur(a.value, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
