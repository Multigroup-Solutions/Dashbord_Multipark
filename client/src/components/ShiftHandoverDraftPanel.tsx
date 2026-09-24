import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import {
  OPEN_ITEM_LABELS,
  SHIFT_LABELS,
  openItemKey,
  type OpenItem,
} from "@shared/shiftHandoverAuto";
import type { HandoverDraft } from "../../../server/shiftHandoverDraft";

// ─── Resumo automático do turno (só leitura, secções colapsáveis) ───────────

function Section({ title, count, link, linkLabel, tone, children }: {
  title: string; count: number; link?: string; linkLabel?: string; tone?: "warn" | "bad"; children?: React.ReactNode;
}) {
  const badgeCls = count === 0 ? "" : tone === "bad" ? "border-red-300 text-red-700" : tone === "warn" ? "border-amber-300 text-amber-700" : "";
  return (
    <details className="border rounded-lg group">
      <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer select-none text-sm">
        <span className="font-medium">{title}</span>
        <span className="flex items-center gap-2">
          <Badge variant="outline" className={`tabular-nums ${badgeCls}`}>{count}</Badge>
          {link && <Link href={link} className="text-xs text-blue-700 hover:underline" onClick={(e) => e.stopPropagation()}>{linkLabel ?? "abrir"}</Link>}
        </span>
      </summary>
      {count > 0 && children && <div className="px-3 pb-3 text-xs space-y-1 max-h-72 overflow-y-auto">{children}</div>}
    </details>
  );
}

const eur = (n: number | null) => (n == null ? "" : `${n.toFixed(2).replace(".", ",")} €`);

export function ShiftHandoverDraftPanel({ draft, loading, onRefresh }: { draft: HandoverDraft | null | undefined; loading: boolean; onRefresh: () => void }) {
  if (loading && !draft) return <Card><CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />A preparar o resumo automático…</CardContent></Card>;
  if (!draft) return null;
  const c = draft.counts;
  const nextLabel = `${SHIFT_LABELS[draft.next.shift]} ${draft.next.date}`;
  const tl = (list: HandoverDraft["people"]["current"]) => list.filter((p) => p.isTeamLeader).map((p) => p.name).join(", ") || "—";
  const peak = draft.byHour.reduce((m, h) => Math.max(m, h.checkins + h.checkouts), 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">Resumo automático do turno</CardTitle>
          <Button type="button" size="sm" variant="ghost" onClick={onRefresh} disabled={loading} title="Atualizar o resumo">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">Só leitura — é guardado com a passagem. Próximo turno: {nextLabel}.</p>
      </CardHeader>
      <CardContent className="space-y-2">
        <Section title={`Equipa — agora (TL: ${tl(draft.people.current)}) · a seguir (TL: ${tl(draft.people.next)})`} count={draft.people.next.length} link="/extras-dia" linkLabel="escala">
          <p><b>Agora:</b> {draft.people.current.map((p) => `${p.name}${p.isTeamLeader ? " (TL)" : ""} ${p.startHour}–${p.endHour}h`).join(" · ") || "—"}</p>
          <p><b>A seguir:</b> {draft.people.next.map((p) => `${p.name}${p.isTeamLeader ? " (TL)" : ""} ${p.startHour}–${p.endHour}h`).join(" · ") || "—"}</p>
        </Section>
        <Section title={`Recolhas / entregas no próximo turno (${c.checkinsNext} / ${c.checkoutsNext})`} count={c.checkinsNext + c.checkoutsNext} link="/operacoes" linkLabel="operações">
          <div className="grid grid-cols-6 sm:grid-cols-12 gap-1 mb-2">
            {draft.byHour.map((h) => (
              <div key={h.hour} className={`rounded border p-1 text-center ${peak > 0 && h.checkins + h.checkouts === peak ? "border-amber-400 bg-amber-50/60" : ""}`} title={`${h.label}: ${h.checkins} recolhas, ${h.checkouts} entregas`}>
                <div className="text-[10px] text-muted-foreground">{h.label}</div>
                <div className="tabular-nums"><span className="text-emerald-700">{h.checkins}</span>/<span className="text-blue-700">{h.checkouts}</span></div>
              </div>
            ))}
          </div>
          {draft.coveredCheckinsNext > 0 && <p className="text-muted-foreground">Recolhas com lugar coberto: {draft.coveredCheckinsNext}</p>}
          {draft.checkouts.length > 0 && <p className="font-medium mt-1">Entregas{c.toCollectEur > 0 ? ` — a cobrar ${eur(c.toCollectEur)}` : ""}</p>}
          {draft.checkouts.map((b) => (
            <p key={`o${b.externalId}`}>{b.time} · {b.clientName}{b.plate ? ` · ${b.plate}` : ""}{b.flight ? ` · ✈ ${b.flight}` : ""}{(b.remainingToPay ?? 0) > 0 ? <span className="text-amber-700"> · a pagar {eur(b.remainingToPay)}</span> : ""}</p>
          ))}
          {draft.checkins.length > 0 && <p className="font-medium mt-1">Recolhas</p>}
          {draft.checkins.map((b) => (
            <p key={`i${b.externalId}`}>{b.time} · {b.clientName}{b.plate ? ` · ${b.plate}` : ""}{b.flight ? ` · ✈ ${b.flight}` : ""}</p>
          ))}
        </Section>
        <Section title="Carros p/ coberto (no parque, ainda sem movimento)" count={draft.coveredCars?.count ?? 0} link="/operacoes" linkLabel="operações" tone="warn">
          <p className="text-muted-foreground">Reservas de lugar coberto com check-in feito e sem movimento registado depois da receção.</p>
          {(draft.coveredCars?.list ?? []).map((b) => <p key={`cv${b.externalId}`}>{b.plate ?? "sem matrícula"} · {b.bookingNumber ?? b.externalId}{b.park ? ` · ${b.park}` : ""} · check-in {b.checkIn}</p>)}
        </Section>
        <Section title="Entregas pendentes (sem check-out)" count={c.pendingDeliveries} link="/operacoes" linkLabel="operações" tone="bad">
          {draft.pendingDeliveries.map((b) => <p key={b.externalId}>{b.since} · {b.bookingNumber ?? b.externalId} · {b.clientName}{b.plate ? ` · ${b.plate}` : ""}</p>)}
        </Section>
        <Section title={`Reclamações (novas no turno: ${c.complaintsNew})`} count={c.complaintsOpen} link="/reclamacoes" linkLabel="reclamações" tone="warn">
          {draft.complaints.map((x) => <p key={x.id}>{x.isNew ? "🆕 " : ""}#{x.id} {x.title} <span className="text-muted-foreground">({x.status})</span></p>)}
        </Section>
        <Section title="Perdidos e achados abertos" count={c.lostFoundOpen} link="/perdidos-achados" linkLabel="perdidos e achados" tone="warn">
          {draft.lostFound.map((x) => <p key={x.id}>#{x.id} {x.clientName} — {x.description.slice(0, 100)} <span className="text-muted-foreground">({x.status})</span></p>)}
        </Section>
        <Section title="Ocorrências abertas" count={c.incidentsOpen} link="/ocorrencias" linkLabel="ocorrências" tone="warn">
          {draft.incidents.map((x) => <p key={x.id}>#{x.id}{x.plate ? ` ${x.plate}` : ""} — {x.description.slice(0, 100)} <span className="text-muted-foreground">({x.severity})</span></p>)}
        </Section>
        <Section title="WhatsApp por ler" count={c.whatsappUnread} link="/whatsapp" linkLabel="WhatsApp" tone="warn">
          {draft.whatsapp.map((x) => <p key={x.id}>{x.name} · {x.unreadCount} por ler</p>)}
        </Section>
        <Section title="PDAs ainda com check-in" count={c.pdasCheckedIn} link="/operacional" linkLabel="PDAs" tone="warn">
          {draft.pdas.map((x) => <p key={x.id}>{x.pdaName ?? "PDA"} · {x.employeeName ?? "?"} desde {x.since}</p>)}
        </Section>
        <Section title="Picagens de entrada sem saída" count={c.clockInsOpen} link="/rh" linkLabel="ponto" tone="warn">
          {draft.clockIns.map((x) => <p key={x.employeeId}>{x.name} desde {x.since}</p>)}
        </Section>
        <Section title={`Alertas do turno (velocidade ${c.speedAlerts} · GPS ${c.gpsAlerts})`} count={c.speedAlerts + c.gpsAlerts} link="/operacional" linkLabel="GPS" tone="bad">
          {draft.speed.map((x, i) => <p key={`s${i}`}>{x.at} · {x.name} · {x.speed} km/h (limite {x.limit})</p>)}
          {draft.gps.map((x, i) => <p key={`g${i}`}>{x.at} · {x.name} · {x.type}</p>)}
        </Section>
      </CardContent>
    </Card>
  );
}

// ─── Pendentes que passam de turno ──────────────────────────────────────────

export function OpenItemsEditor({ items, onChange, disabled }: { items: OpenItem[]; onChange: (items: OpenItem[]) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (t.length < 3) return;
    const key = openItemKey("note", t);
    if (!items.some((i) => i.key === key)) onChange([...items, { key, kind: "note", text: t.slice(0, 300), resolved: false }]);
    setText("");
  };
  const open = items.filter((i) => !i.resolved).length;
  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="text-xs text-muted-foreground">Sem pendentes.</p>}
      {items.map((i) => (
        <label key={i.key} className={`flex items-start gap-2 text-sm border rounded-md px-2 py-1.5 ${i.resolved ? "opacity-60" : ""}`}>
          <Checkbox
            className="mt-0.5"
            checked={i.resolved}
            disabled={disabled}
            onCheckedChange={(v) => onChange(items.map((x) => (x.key === i.key ? { ...x, resolved: !!v, resolvedAt: v ? x.resolvedAt ?? null : null, resolvedByName: v ? x.resolvedByName ?? null : null } : x)))}
          />
          <span className="flex-1">
            <Badge variant="outline" className="mr-1 text-[10px]">{OPEN_ITEM_LABELS[i.kind]}</Badge>
            <span className={i.resolved ? "line-through" : ""}>{i.text}</span>
            {i.since && <span className="text-[10px] text-muted-foreground"> · desde {i.since.replace(" morning", " manhã").replace(" night", " noite")}</span>}
            {i.resolved && i.resolvedByName && <span className="text-[10px] text-muted-foreground"> · resolvido por {i.resolvedByName}</span>}
          </span>
          {!i.resolved && i.kind === "note" && !i.since && (
            <button type="button" className="text-xs text-muted-foreground hover:text-red-600" disabled={disabled} onClick={(e) => { e.preventDefault(); onChange(items.filter((x) => x.key !== i.key)); }}>remover</button>
          )}
        </label>
      ))}
      <div className="flex gap-2">
        <Input value={text} maxLength={300} disabled={disabled} placeholder="Novo pendente para o turno seguinte…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <Button type="button" size="sm" variant="outline" disabled={disabled || text.trim().length < 3} onClick={add}><Plus className="w-4 h-4" /></Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{open} por resolver — os que ficarem abertos aparecem ao turno seguinte.</p>
    </div>
  );
}

export function AiSummaryBox({ text, onGenerate, pending, available }: { text: string | null; onGenerate: () => void; pending: boolean; available: boolean }) {
  return (
    <div className="border rounded-lg p-3 space-y-2 bg-muted/20">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" />Resumo IA para o turno seguinte</p>
        {available && (
          <Button type="button" size="sm" variant="outline" onClick={onGenerate} disabled={pending}>
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}{text ? "Gerar de novo" : "Gerar resumo"}
          </Button>
        )}
      </div>
      {text ? <p className="text-sm whitespace-pre-line">{text}</p> : <p className="text-xs text-muted-foreground">{available ? "Gerado automaticamente ao guardar (ou carrega em \"Gerar resumo\")." : "Gerado ao guardar, se a IA estiver configurada."}</p>}
    </div>
  );
}
