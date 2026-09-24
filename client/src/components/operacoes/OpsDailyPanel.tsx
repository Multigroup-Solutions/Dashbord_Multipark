import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { CITY_KEYS, CITY_LABELS, type CityKey } from "@shared/city";
import { ORIGIN_GROUP_LABELS, CHANNEL_LABELS, type OriginGroup } from "@shared/originGroup";
import { joinOpsDaily, periodByCity, ratio, type DailyBookingRow } from "@shared/operationsDaily";

type Action = "creation" | "checkin" | "checkout" | "cancelation";

// Cores por ENTIDADE (fixas, nunca por posição): paleta categórica validada
// (dataviz, slots 1-4). "Sem cidade" em cinzento neutro.
export const GROUP_COLORS: Record<OriginGroup, string> = {
  lisboa: "#2a78d6", porto: "#eb6834", faro: "#1baf7a", marketplace: "#eda100", sem_cidade: "#9ca3af",
};
const ADS_COLOR = "#4a3aa7";
const EXTRAS_COLOR = "#e34948";

const fmtEur = (n: number | null | undefined, digits = 2) =>
  n == null ? "—" : n.toLocaleString("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtX = (n: number | null) => (n == null ? "—" : `${n.toFixed(2).replace(".", ",")}×`);
const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

const NOUN: Record<Action, { plural: string; per: string }> = {
  creation: { plural: "Reservas", per: "reserva" },
  checkin: { plural: "Recolhas", per: "recolha" },
  checkout: { plural: "Entregas", per: "entrega" },
  cancelation: { plural: "Cancelamentos", per: "cancelamento" },
};

export function OpsDailyPanel({ actionType, startDate, endDate, projectId, daily, origins, onPickGroup, activeGroup }: {
  actionType: Action; startDate: string; endDate: string; projectId?: number;
  daily: DailyBookingRow[];
  origins?: Array<{ group: OriginGroup; count: number; active: number; cancelled: number; revenue: number; channels: Array<{ channel: string; count: number }> }>;
  onPickGroup?: (g: string) => void; activeGroup?: string;
}) {
  const wantAds = actionType === "creation" || actionType === "checkin";
  const wantExtras = actionType === "checkin" || actionType === "checkout";
  const adsQ = trpc.multipark.adSpendDaily.useQuery({ startDate, endDate, projectId }, { enabled: wantAds, refetchOnWindowFocus: false, retry: false });
  const extrasQ = trpc.multipark.extrasCostDaily.useQuery({ startDate, endDate, projectId }, { enabled: wantExtras, refetchOnWindowFocus: false, retry: false });
  const ads = wantAds && adsQ.data?.allowed ? adsQ.data.rows : null;
  const adsUnassigned = wantAds && adsQ.data?.allowed ? adsQ.data.unassigned : null;
  const extras = wantExtras && extrasQ.data?.allowed ? extrasQ.data.rows.map((r) => ({ day: r.day, city: r.city, cost: r.cost })) : null;
  const costsHidden = (wantAds && adsQ.data && !adsQ.data.allowed) || (wantExtras && extrasQ.data && !extrasQ.data.allowed);

  const days = useMemo(() => joinOpsDaily({ startDate, endDate, bookings: daily, ads, adsUnassigned, extras }), [startDate, endDate, daily, ads, adsUnassigned, extras]);
  const byCity = useMemo(() => periodByCity(days), [days]);
  const adsUnassignedTotal = useMemo(() => days.reduce((t, d) => t + (d.adsUnassigned ?? 0), 0), [days]);
  const groupsPresent = useMemo(() => (["lisboa", "porto", "faro", "marketplace", "sem_cidade"] as OriginGroup[])
    .filter((g) => g !== "sem_cidade" || days.some((d) => d.byGroup.sem_cidade > 0)), [days]);
  const citiesPresent = useMemo(() => CITY_KEYS.filter((c) => byCity.find((b) => b.city === c && (b.own || b.ops || b.ads || b.extras))), [byCity]);
  const [showDays, setShowDays] = useState(false);

  const chartData = days.map((d) => ({
    day: shortDay(d.day), fullDay: d.day,
    ...Object.fromEntries(groupsPresent.map((g) => [g, d.byGroup[g]])),
    ads: d.ads == null ? undefined : Math.round(d.ads * 100) / 100,
    extras: d.extras == null ? undefined : Math.round(d.extras * 100) / 100,
    _d: d,
  }));
  const noun = NOUN[actionType];
  const showMoneyChart = !!(ads || extras);

  const MoneyTooltip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload._d as (typeof days)[number];
    return (
      <div className="rounded-md border bg-background p-2 text-xs shadow-sm space-y-1">
        <p className="font-medium">{d.day}</p>
        {d.ads != null && <div>
          <p><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: ADS_COLOR }} />Publicidade: <b>{fmtEur(d.ads)}</b></p>
          {CITY_KEYS.map((c) => d.adsByCity[c] ? <p key={c} className="pl-3 text-muted-foreground">{CITY_LABELS[c]}: {fmtEur(d.adsByCity[c])}{actionType === "creation" && d.byGroup[c] ? ` · ${fmtEur(d.adsByCity[c] / d.byGroup[c])}/reserva` : ""}</p> : null)}
          {d.adsUnassigned ? <p className="pl-3 text-muted-foreground">Sem cidade / nacional por atribuir: {fmtEur(d.adsUnassigned)}</p> : null}
        </div>}
        {d.extras != null && <div>
          <p><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: EXTRAS_COLOR }} />Custo extras: <b>{fmtEur(d.extras)}</b></p>
          {CITY_KEYS.map((c) => d.extrasByCity[c] ? <p key={c} className="pl-3 text-muted-foreground">{CITY_LABELS[c]}: {fmtEur(d.extrasByCity[c])}{d.byCity[c] ? ` · ${fmtEur(d.extrasByCity[c] / d.byCity[c])}/${noun.per}` : ""}</p> : null)}
        </div>}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-sm">{noun.plural} por dia — Lisboa / Porto / Faro / Marketplace</CardTitle>
          <p className="text-[11px] text-muted-foreground">Dias de Lisboa. Lisboa/Porto/Faro = marcas próprias (Airpark, Redpark, Skypark); Marketplace = todas as outras marcas (inclui Top Parking).</p>
        </CardHeader>
        <CardContent className="px-1 sm:px-4">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} syncId="opsDaily" margin={{ top: 4, right: 8, left: -16, bottom: 0 }} barCategoryGap={2}>
              <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.08} />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={12} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip cursor={{ fillOpacity: 0.06 }} formatter={(v: any, n: any) => [v, ORIGIN_GROUP_LABELS[n as OriginGroup] ?? n]} labelFormatter={(_l: any, p: any) => p?.[0]?.payload?.fullDay ?? _l} contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: any) => ORIGIN_GROUP_LABELS[v as OriginGroup] ?? v} />
              {groupsPresent.map((g, i) => (
                <Bar key={g} dataKey={g} stackId="g" fill={GROUP_COLORS[g]} stroke="var(--background, #fff)" strokeWidth={1}
                  radius={i === groupsPresent.length - 1 ? [3, 3, 0, 0] : 0} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          {showMoneyChart && (
            <>
              <p className="text-[11px] text-muted-foreground px-3 pt-2">€ por dia (c/ IVA){ads ? " — Publicidade: Google Ads + Meta (nacional repartido pelas cidades; o que não tem cidade conta no total como «por atribuir») + importações antigas" : ""}{extras ? " — Custo extras: ponto real até hoje, escala prevista nos dias futuros" : ""}</p>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={chartData} syncId="opsDaily" margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.08} />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={12} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${Math.round(v)}€`} />
                  <Tooltip content={<MoneyTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {ads && <Line type="monotone" dataKey="ads" name="Publicidade (€)" stroke={ADS_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />}
                  {extras && <Line type="monotone" dataKey="extras" name="Custo extras (€)" stroke={EXTRAS_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />}
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
          {costsHidden && <p className="text-[11px] text-muted-foreground px-3 pt-1">Custos (publicidade/extras) ocultos: sem permissão para ver totais financeiros.</p>}
        </CardContent>
      </Card>

      {/* Custos por cidade no período */}
      {showMoneyChart && citiesPresent.length > 0 && (
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm">Custos por cidade (período, c/ IVA)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="p-2">Cidade</th>
                    <th className="p-2 text-right">{noun.plural}{actionType === "creation" ? " (marcas próprias)" : ""}</th>
                    {ads && <th className="p-2 text-right">Publicidade</th>}
                    {ads && actionType === "creation" && <th className="p-2 text-right">Custo / reserva</th>}
                    {ads && actionType === "creation" && <th className="p-2 text-right">Receita</th>}
                    {ads && actionType === "creation" && <th className="p-2 text-right" title="Receita (não canceladas, c/ IVA) ÷ publicidade">ROAS</th>}
                    {extras && <th className="p-2 text-right">Custo extras</th>}
                    {extras && <th className="p-2 text-right">€ extras / {noun.per}</th>}
                  </tr>
                </thead>
                <tbody>
                  {byCity.filter((b) => citiesPresent.includes(b.city)).map((b) => {
                    const count = actionType === "creation" ? b.own : b.ops;
                    return (
                      <tr key={b.city} className="border-t">
                        <td className="p-2 font-medium"><span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: GROUP_COLORS[b.city] }} />{CITY_LABELS[b.city]}</td>
                        <td className="p-2 text-right">{count}</td>
                        {ads && <td className="p-2 text-right">{fmtEur(b.ads)}</td>}
                        {ads && actionType === "creation" && <td className="p-2 text-right">{fmtEur(b.costPerBooking)}</td>}
                        {ads && actionType === "creation" && <td className="p-2 text-right">{fmtEur(b.revenue)}</td>}
                        {ads && actionType === "creation" && <td className="p-2 text-right">{fmtX(b.roas)}</td>}
                        {extras && <td className="p-2 text-right">{fmtEur(b.extras)}</td>}
                        {extras && <td className="p-2 text-right">{fmtEur(b.extrasPerOp)}</td>}
                      </tr>
                    );
                  })}
                  {ads && adsUnassignedTotal > 0 && (
                    <tr className="border-t text-muted-foreground" title="Campanhas sem cidade (por associar ou nacional de marca sem cidades): contam no total do Marketing, em nenhuma cidade">
                      <td className="p-2">Sem cidade / nacional por atribuir</td>
                      <td className="p-2 text-right">—</td>
                      <td className="p-2 text-right">{fmtEur(adsUnassignedTotal)}</td>
                      {actionType === "creation" && <td className="p-2" colSpan={3} />}
                      {extras && <td className="p-2" colSpan={2} />}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 border-t">
              <button type="button" className="text-xs text-primary underline" onClick={() => setShowDays((v) => !v)}>
                {showDays ? "Esconder detalhe por dia" : "Ver detalhe por dia e cidade"}
              </button>
            </div>
            {showDays && (
              <div className="overflow-x-auto max-h-[420px] border-t">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-muted">
                    <tr className="text-left">
                      <th className="p-1.5">Dia</th>
                      {citiesPresent.map((c) => (
                        <th key={c} className="p-1.5 text-right" colSpan={1 + (ads ? (actionType === "creation" ? 2 : 1) : 0) + (extras ? 2 : 0)}>{CITY_LABELS[c]}</th>
                      ))}
                    </tr>
                    <tr className="text-left text-muted-foreground">
                      <th />
                      {citiesPresent.map((c) => [
                        <th key={`${c}n`} className="p-1.5 text-right font-normal">{actionType === "creation" ? "res." : actionType === "checkin" ? "rec." : "ent."}</th>,
                        ads ? <th key={`${c}a`} className="p-1.5 text-right font-normal">pub.</th> : null,
                        ads && actionType === "creation" ? <th key={`${c}ar`} className="p-1.5 text-right font-normal">€/res.</th> : null,
                        extras ? <th key={`${c}e`} className="p-1.5 text-right font-normal">extras</th> : null,
                        extras ? <th key={`${c}er`} className="p-1.5 text-right font-normal">€/{noun.per.slice(0, 3)}.</th> : null,
                      ])}
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => (
                      <tr key={d.day} className="border-t">
                        <td className="p-1.5 whitespace-nowrap">{shortDay(d.day)}</td>
                        {citiesPresent.map((c) => {
                          const n = actionType === "creation" ? d.byGroup[c] : d.byCity[c];
                          return [
                            <td key={`${c}n`} className="p-1.5 text-right">{n || "·"}</td>,
                            ads ? <td key={`${c}a`} className="p-1.5 text-right">{d.adsByCity[c] ? fmtEur(d.adsByCity[c], 0) : "·"}</td> : null,
                            ads && actionType === "creation" ? <td key={`${c}ar`} className="p-1.5 text-right">{fmtEur(ratio(d.adsByCity[c], n))}</td> : null,
                            extras ? <td key={`${c}e`} className="p-1.5 text-right">{d.extrasByCity[c] ? fmtEur(d.extrasByCity[c], 0) : "·"}</td> : null,
                            extras ? <td key={`${c}er`} className="p-1.5 text-right">{fmtEur(ratio(d.extrasByCity[c], d.byCity[c]))}</td> : null,
                          ];
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Origens por grupo, com o canal como detalhe */}
      {origins && origins.some((o) => o.count > 0) && (
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm">Origens das reservas</CardTitle>
            <p className="text-[11px] text-muted-foreground">Por grupo; o canal de venda é o detalhe. Clica num grupo para filtrar a lista.</p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="p-2">Grupo</th>
                    <th className="p-2 text-right">Criadas</th>
                    <th className="p-2 text-right">Não canceladas</th>
                    <th className="p-2 text-right">Valor não cancelado (c/ IVA)</th>
                    <th className="p-2">Canal</th>
                  </tr>
                </thead>
                <tbody>
                  {origins.map((o) => (
                    <tr key={o.group} className={`border-t cursor-pointer hover:bg-muted/30 ${activeGroup === o.group ? "bg-muted/40" : ""}`}
                      onClick={() => onPickGroup?.(activeGroup === o.group ? "all" : o.group)}>
                      <td className="p-2 font-medium whitespace-nowrap"><span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: GROUP_COLORS[o.group] }} />{ORIGIN_GROUP_LABELS[o.group]}</td>
                      <td className="p-2 text-right">{o.count}</td>
                      <td className="p-2 text-right">{o.active}</td>
                      <td className="p-2 text-right">{fmtEur(o.revenue)}</td>
                      <td className="p-2 text-muted-foreground min-w-[180px]">
                        {o.channels.map((c) => `${CHANNEL_LABELS[c.channel] ?? c.channel}: ${c.count}`).join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
