/**
 * ROAS por campanha → reservas (Jorge, 24 set 2026). Por campanha (Google Ads
 * e Meta): gasto, cliques, conversões da plataforma, reservas LIGADAS, valor
 * s/ IVA, ROAS s/ IVA e CPA. Ligação reserva → campanha: ID da campanha no
 * link (gclid/fbclid + {campaignid}); sem ele, a campanha do clique (gclid)
 * que o Google Ads identifica (8 out 2026); senão utm_campaign ou código de
 * desconto que o admin liga à campanha aqui. Em baixo, as conversões por ação.
 * Via net por campanha (8 out 2026): as reservas via net de cada marca/cidade
 * repartidas pelas campanhas (conversões → cliques → gasto), ao lado das
 * ligadas; valor e ROAS com os parques de terceiros pela nossa comissão.
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
import { STICKY_FIRST_COL } from "@/components/finance/layoutClasses";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { describeMatchCounts, LINKED_EXPLAINER } from "@shared/campaignEvidence";
import { fmtViaNet, VIA_NET_BASE_LABEL, VIA_NET_SPLIT_EXPLAINER } from "@shared/viaNet";

const EUR = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EUR0 = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
const eur = (v: number | null | undefined, d = 2) => (v == null ? "—" : (d ? EUR : EUR0).format(v));
const num = (v: number | null | undefined) => (v == null ? "—" : NUM.format(v));
const roasX = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2).replace(".", ",")}×`);
const KEY_LABEL: Record<string, string> = { utm_campaign: "utm_campaign", discount_code: "código" };

function statusBadge(status: string | null | undefined) {
  const s = String(status ?? "").toUpperCase();
  if (s === "REMOVED" || s === "DELETED") return <Badge variant="outline" className="ml-1.5 text-[11px] text-rose-700 border-rose-200">removida</Badge>;
  if (s === "PAUSED" || s === "CAMPAIGN_PAUSED") return <Badge variant="outline" className="ml-1.5 text-[11px] text-amber-700 border-amber-200">pausada</Badge>;
  if (s === "ARCHIVED") return <Badge variant="outline" className="ml-1.5 text-[11px]">arquivada</Badge>;
  return null;
}

export default function CampaignRoasPanel({ from, to, projectId }: { from: string; to: string; projectId?: number }) {
  const { user } = useAuth();
  const isAdmin = can(user, "marketing", "manage");
  const utils = trpc.useUtils();
  const roasQ = trpc.marketing.campaignRoas.useQuery({ from, to, projectId });
  const { data, isLoading, error } = roasQ;
  const refresh = () => { utils.marketing.campaignRoas.invalidate(); utils.marketing.campaignLinks.list.invalidate(); };
  const add = trpc.marketing.campaignLinks.add.useMutation({ onSuccess: (r) => { refresh(); toast.success(r.movedFromCampaignId != null ? "Ligação passada para esta campanha (estava noutra)" : "Ligação criada"); }, onError: (e) => toast.error(e.message) });
  const remove = trpc.marketing.campaignLinks.remove.useMutation({ onSuccess: () => { refresh(); toast.success("Ligação retirada (fica no registo)"); }, onError: (e) => toast.error(e.message) });
  const [open, setOpen] = useState<string | null>(null);
  const [linkType, setLinkType] = useState<"utm_campaign" | "discount_code">("utm_campaign");
  const [linkValue, setLinkValue] = useState("");
  const rows: any[] = data?.rows ?? [];
  const totals = useMemo(() => rows.reduce((t, r) => ({ cost: t.cost + r.cost, clicks: t.clicks + r.clicks, conversions: t.conversions + r.conversions, bookings: t.bookings + r.bookings, revenue: t.revenue + r.revenue, revenueNet: t.revenueNet + r.revenueNet,
    viaNet: t.viaNet + Number(r.viaNetBookings ?? 0), viaNetValue: t.viaNetValue + Number(r.viaNetValue ?? 0) }), { cost: 0, clicks: 0, conversions: 0, bookings: 0, revenue: 0, revenueNet: 0, viaNet: 0, viaNetValue: 0 }), [rows]);
  const vat = Number(data?.vatRate ?? 0.23);
  const viaNetTitle = (r: any) => (r.viaNetBookings == null ? "Campanha sem marca/cidade: o via net não se reparte" : `${Math.round(Number(r.viaNetShare ?? 0) * 1000) / 10} % do via net da marca/cidade · repartido pelos ${VIA_NET_BASE_LABEL[r.viaNetBase as keyof typeof VIA_NET_BASE_LABEL] ?? "—"}`);

  if (error) return <QueryErrorNote error={error} onRetry={() => roasQ.refetch()} retrying={roasQ.isFetching} what="o ROAS por campanha" />;
  if (isLoading || !data) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>ROAS por campanha</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Reservas ligadas = reservas do período (data de criação, sem canceladas) {LINKED_EXPLAINER} (o ID no link ganha), ou com um utm_campaign / código de desconto ligado à campanha{isAdmin ? " (abre a linha para ligar)" : ""}. Cada reserva conta uma vez. Valor e ROAS sem IVA (÷ {(1 + Number(data.vatRate)).toFixed(2).replace(".", ",")}). CPA = gasto ÷ reservas ligadas.
          </p>
          {data.linkedTotal > 0 && data.linkedByTotal && (
            <p className="text-xs text-muted-foreground mt-1">De onde vieram as ligadas: {describeMatchCounts(data.linkedByTotal)}.</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            <b>Via net</b> = reservas que não são de parceiros (sem pendentes, clientes Pro nem avenças) de cada marca/cidade, {VIA_NET_SPLIT_EXPLAINER}; as campanhas nacionais entram em cada cidade pela sua parte. "≈" = fração. Ao lado das ligadas, que são as diretas. <b>Valor</b>: parques nossos pelo preço inteiro; parques de terceiros (Marketplace) só pela nossa comissão.
            {(data.viaNetUnassigned?.bookings ?? 0) > 0 && <> {num(data.viaNetUnassigned.bookings)} reserva(s) via net de marcas/cidades sem campanhas ficam por repartir.</>}
          </p>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {rows.length === 0 ? <p className="text-sm text-muted-foreground p-6 text-center">Sem campanhas com gasto no período.</p> : (
            <table className={`w-full text-sm tabular-nums ${STICKY_FIRST_COL}`}>
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
                  <th className="text-right px-4 py-2 font-medium border-l" title="Reservas via net da marca/cidade repartidas pelas campanhas (conversões; sem conversões, cliques; sem cliques, gasto)">Via net (repartido)</th>
                  <th className="text-right px-4 py-2 font-medium">Valor via net s/ IVA</th>
                  <th className="text-right px-4 py-2 font-medium" title="Valor via net sem IVA ÷ gasto">ROAS via net</th>
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
                          <Badge variant="outline" className="ml-1.5 text-[11px]">{r.provider === "meta" ? "Meta" : "Google"}</Badge>
                          {statusBadge(r.status)}
                          {r.links?.length > 0 && <Badge variant="outline" className="ml-1.5 text-[11px]"><Link2 className="w-3 h-3 mr-0.5" />{r.links.length}</Badge>}
                          {r.accountName && <div className="text-[11px] text-muted-foreground pl-5">conta {r.accountName}</div>}
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{eur(r.cost)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{num(r.clicks)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{num(r.conversions)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums font-semibold" title={r.bookings > 0 ? describeMatchCounts(r.linkedBy) : undefined}>
                          {num(r.bookings)}
                          {r.linkedBy?.gclid > 0 && <div className="text-[11px] font-normal text-muted-foreground">{num(r.linkedBy.gclid)} pelo clique (gclid)</div>}
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{eur(r.revenueNet)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{roasX(r.roasNet)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{eur(r.cpa)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums border-l" title={viaNetTitle(r)}>{fmtViaNet(r.viaNetBookings)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{r.viaNetValue == null ? "—" : eur(r.viaNetValue / (1 + vat))}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{roasX(r.roasViaNetNet)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b bg-muted/20">
                          <td colSpan={11} className="px-6 py-3 space-y-3">
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
                  <td className="px-4 py-2 text-right tabular-nums border-l">{fmtViaNet(totals.viaNet)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{eur(totals.viaNetValue / (1 + vat))}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{roasX(totals.cost > 0 ? totals.viaNetValue / (1 + vat) / totals.cost : null)}</td>
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
            <table className={`w-full text-sm tabular-nums ${STICKY_FIRST_COL}`}>
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
