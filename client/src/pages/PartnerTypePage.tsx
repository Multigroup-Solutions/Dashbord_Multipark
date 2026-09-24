import { useGlobalFilters } from '@/contexts/GlobalFiltersContext';
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMemo, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { ArrowLeft, Euro, FileText, AlertTriangle, Wallet, Handshake } from "lucide-react";
import { getPartnerType, PARTNER_TYPES } from "@shared/partnerTypes";
import { monthBoundsOf } from "@shared/partnerRules";
import { lisbonToday } from "@shared/expensePeriods";

const fmt = (v: number) => new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

export default function PartnerTypePage() {
  const { projectId } = useGlobalFilters();
  const [, params] = useRoute("/parcerias/tipo/:typeId");
  const [, setLocation] = useLocation();
  const typeId = params?.typeId ?? "outro";
  const typeDef = getPartnerType(typeId);

  // Mês corrente em dias de Lisboa (toISOString de datas locais recuava um dia).
  const { monthStart, monthEnd } = monthBoundsOf(lisbonToday());
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(monthEnd);

  const { data, isLoading, error } = trpc.partnerships.invoicingDetailByType.useQuery({ from, to, partnerType: typeId, projectId });
  const partners = data?.partners ?? [];

  const totals = useMemo(() => {
    return partners.reduce((acc, p) => {
      acc.revenue += p.revenueGross;
      acc.aFaturar += p.aFaturar;
      acc.discount += p.discountTotal;
      acc.cashback += p.cashbackAmount;
      acc.prizes += p.prizeBudget;
      return acc;
    }, { revenue: 0, aFaturar: 0, discount: 0, cashback: 0, prizes: 0 });
  }, [partners]);

  const cm = typeDef.chargeModel;
  const showCommission = cm === "commission_on_revenue" || cm === "small_commission" || cm === "operational";
  const showFee = cm === "monthly_fee" || cm === "yearly_fee";
  const showDiscount = cm === "prepaid_with_discount" || cm === "monthly_invoice_discount" || cm === "own_campaign" || cm === "small_commission";
  const showCashback = cm === "own_campaign";
  const showOperated = cm === "operational";
  const isProInvoice = cm === "monthly_invoice_discount";

  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/parcerias")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <Handshake className="w-5 h-5 text-purple-600" />
            <h1 className="text-2xl font-bold">{typeDef.label}</h1>
            <Badge variant="outline" className="text-[10px]">{cm}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{typeDef.description}</p>
        </div>
        <div className="flex gap-2">
          <div>
            <Label className="text-xs mb-1 block">De</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[140px] h-9" />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Até</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[140px] h-9" />
          </div>
        </div>
      </div>

      {/* KPIs adaptados ao chargeModel */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-1">Parceiros</p>
          <p className="text-2xl font-bold">{partners.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-1">
            {isProInvoice ? "Receita a faturar" : showFee ? "Avenças" : "Receita gerada"}
          </p>
          <p className="text-2xl font-bold text-emerald-700">{fmt(showFee ? totals.aFaturar : totals.revenue)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Euro className="w-3 h-3" />
            {showCashback ? "Custo total (centro de custos)" : "A faturar"}
          </p>
          <p className="text-2xl font-bold text-blue-700">
            {fmt(showCashback ? (totals.discount + totals.cashback + totals.prizes) : totals.aFaturar)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-1">
            {showDiscount ? "Descontos aplicados" : showCommission ? "Comissão" : "—"}
          </p>
          <p className="text-2xl font-bold text-orange-700">
            {fmt(showDiscount ? totals.discount : (showCommission ? totals.aFaturar : 0))}
          </p>
        </Card>
      </div>

      {/* Nota explicativa do chargeModel */}
      <Card className="bg-muted/30">
        <CardContent className="p-4 text-sm">
          {cm === "commission_on_revenue" && (
            <span>Comissão = <strong>receita das reservas SEM IVA × %</strong> (com IVA só nos parceiros marcados como exceção). Cada parceiro tem a sua taxa.</span>
          )}
          {cm === "small_commission" && (
            <span>Comissão pequena (afiliados). Os clientes deles têm desconto já reflectido nas reservas.</span>
          )}
          {cm === "monthly_fee" && (
            <span>Avença <strong>mensal</strong>. Valor mensal (€/mês) × meses do período (meses parciais rateados pelos dias).</span>
          )}
          {cm === "yearly_fee" && (
            <span>Avença <strong>anual</strong>. O valor da avença é €/mês: fatura-se valor mensal × meses do período (12 meses = valor anual).</span>
          )}
          {cm === "prepaid_with_discount" && (
            <span>Enterprise/Corporate paga logo. O desconto já vem na reserva — esta vista é apenas relatório.</span>
          )}
          {cm === "monthly_invoice_discount" && (
            <span>Cliente Pro — só na marca Airpark. Faturado no fim do mês com base nas reservas (desconto já aplicado).</span>
          )}
          {cm === "own_campaign" && (
            <span>Campanha própria. <strong>Custo = descontos + cashback + prémios</strong>, todos imputados ao centro de custos do projeto da reserva. Sem comissões a pagar.</span>
          )}
          {cm === "operational" && (
            <span>Parceiro operacional. Comissão sobre <strong>TODAS</strong> as reservas dos projetos operados, sobre o valor <strong>sem IVA</strong>. Uma reserva de outra agência paga a comissão dessa agência + a operacional; uma reserva com a campanha do PRÓPRIO operacional num centro que ele opera paga só a operacional (nunca duas vezes ao mesmo parceiro).</span>
          )}
          {cm === "manual" && <span>Sem cálculo automático. Lançamento manual.</span>}
        </CardContent>
      </Card>

      {/* Tabela com colunas adaptadas */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Parceiros — {typeDef.label}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-10">A carregar...</p>
          ) : partners.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">
              Sem parceiros do tipo "{typeDef.label}". Vai à <button className="underline" onClick={() => setLocation("/parcerias")}>página de Parcerias</button> e cria um.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="p-2">Parceiro</th>
                    {showOperated && <th className="p-2 text-right">Projetos op.</th>}
                    <th className="p-2 text-right">Reservas</th>
                    <th className="p-2 text-right">Receita (c/ IVA)</th>
                    {showDiscount && <th className="p-2 text-right">Desconto</th>}
                    {showCashback && <th className="p-2 text-right">Cashback %</th>}
                    {showCashback && <th className="p-2 text-right">Cashback €</th>}
                    {showCashback && <th className="p-2 text-right">Prémios €</th>}
                    {showCommission && <th className="p-2 text-right">Taxa %</th>}
                    {showFee && <th className="p-2 text-right">Fee</th>}
                    <th className="p-2 text-right font-bold">{isProInvoice ? "A faturar" : showCashback ? "Custo" : "A faturar"}</th>
                  </tr>
                </thead>
                <tbody>
                  {partners.map((p) => {
                    const customCost = p.discountTotal + p.cashbackAmount + p.prizeBudget;
                    return (
                      <tr key={p.partnershipId} className="border-b hover:bg-muted/50">
                        <td className="p-2 font-medium">{p.partnerName}</td>
                        {showOperated && (
                          <td className="p-2 text-right">
                            {p.operatesProjectsCount > 0 ? (
                              <Badge variant="outline" className="text-[10px]">{p.operatesProjectsCount} proj.</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
                                <AlertTriangle className="w-3 h-3 mr-1" />não configurado
                              </Badge>
                            )}
                          </td>
                        )}
                        <td className="p-2 text-right tabular-nums">{p.bookingsCount}</td>
                        <td className="p-2 text-right tabular-nums">{fmt(p.revenueGross)}</td>
                        {showDiscount && (
                          <td className="p-2 text-right tabular-nums text-red-600">
                            {p.discountTotal > 0 ? fmt(p.discountTotal) : "—"}
                          </td>
                        )}
                        {showCashback && (
                          <td className="p-2 text-right tabular-nums">{p.cashbackPercent > 0 ? `${p.cashbackPercent}%` : "—"}</td>
                        )}
                        {showCashback && (
                          <td className="p-2 text-right tabular-nums">{fmt(p.cashbackAmount)}</td>
                        )}
                        {showCashback && (
                          <td className="p-2 text-right tabular-nums">{fmt(p.prizeBudget)}</td>
                        )}
                        {showCommission && (
                          <td className="p-2 text-right tabular-nums">{p.commissionRate}%</td>
                        )}
                        {showFee && (
                          <td className="p-2 text-right tabular-nums">{fmt(p.monthlyFee)}</td>
                        )}
                        <td className="p-2 text-right tabular-nums font-bold text-blue-700">
                          {fmt(showCashback ? customCost : p.aFaturar)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-muted/50 font-bold border-t-2">
                    <td className="p-2">TOTAL</td>
                    {showOperated && <td className="p-2" />}
                    <td className="p-2 text-right">{partners.reduce((s, p) => s + p.bookingsCount, 0)}</td>
                    <td className="p-2 text-right">{fmt(totals.revenue)}</td>
                    {showDiscount && <td className="p-2 text-right text-red-600">{fmt(totals.discount)}</td>}
                    {showCashback && <td className="p-2" />}
                    {showCashback && <td className="p-2 text-right">{fmt(totals.cashback)}</td>}
                    {showCashback && <td className="p-2 text-right">{fmt(totals.prizes)}</td>}
                    {showCommission && <td className="p-2" />}
                    {showFee && <td className="p-2" />}
                    <td className="p-2 text-right text-blue-700">
                      {fmt(showCashback ? (totals.discount + totals.cashback + totals.prizes) : totals.aFaturar)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Navegação rápida entre tipos */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Outros tipos</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {PARTNER_TYPES.filter((t) => t.id !== typeId).map((t) => (
              <Button key={t.id} variant="outline" size="sm" onClick={() => setLocation(`/parcerias/tipo/${t.id}`)}>
                {t.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
