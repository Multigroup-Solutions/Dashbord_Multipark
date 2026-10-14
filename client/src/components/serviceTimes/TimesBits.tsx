/**
 * Tempos de entrega e de recolha — as peças dos ecrãs (Resumo do dia, dia do
 * condutor, Ficha da reserva, Condutores e agentes). Os números chegam já com
 * o portão dos tempos com GPS aplicado no servidor (server/serviceTimesAgg.ts):
 * aqui só se mostra o que veio — "Em calibração" / "Sem dados suficientes" no
 * lugar dos números escondidos, "em calibração" ao lado dos do super admin.
 * Paleta: .times-viz (client/src/index.css), validada para os dois modos.
 */
import { Badge } from "@/components/ui/badge";
import { Info, Lock } from "lucide-react";
import { SERVICE_STATUS_LABELS } from "@shared/serviceTimes";
import type { DeliveryCoverage, MetricView, PickupCoverage } from "../../../../server/serviceTimesAgg";

/** ms → "12 min" (até 1 h) ou "2h05"; null → "—". */
export function fmtDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "—");

/** Etiqueta "em calibração" (super admin com o portão fechado: números provisórios). */
export function CalibrationBadge({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-amber-300 text-amber-800 dark:text-amber-300" title="Só tu (super admin) vês este tempo: depende do GPS e o portão ainda está fechado. Provisório.">provisório · {note}</Badge>;
}

/**
 * Um tempo num cartão: a mediana em grande, p75/média por baixo e a cobertura
 * (% medidos) sempre. Escondido pelo portão → o texto do portão; sem casos →
 * "sem casos" (nunca 0).
 */
export function MetricTile({ m, star, hint }: { m: MetricView; star?: boolean; hint?: string }) {
  const s = m.stats;
  return (
    <div className="rounded-[14px] border bg-card p-3 min-w-0 flex flex-col gap-0.5" title={`${m.label}: ${m.short}${hint ? `. ${hint}` : ""}`}>
      <p className="text-xs text-muted-foreground flex items-center gap-1 min-w-0">
        <span className="truncate">{m.label}{star ? " ★" : ""}</span>
        {m.gps && <span className="text-[10px] text-muted-foreground/80 shrink-0">GPS</span>}
      </p>
      {m.hidden ? (
        <p className="text-sm font-medium text-muted-foreground flex items-start gap-1 leading-snug"><Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" />{m.hidden}</p>
      ) : s ? (
        <>
          <p className="text-xl font-bold leading-tight">{fmtDur(s.p50Ms)}</p>
          <p className="text-[11px] text-muted-foreground leading-snug">mediana · p75 {fmtDur(s.p75Ms)} · média {fmtDur(s.meanMs)}</p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">sem casos medidos</p>
      )}
      <p className="text-[11px] text-muted-foreground leading-snug">{m.short}</p>
      <p className="text-[11px] text-muted-foreground leading-snug">medido em {m.coveragePct == null ? "—" : `${String(m.coveragePct).replace(".", ",")} %`} ({m.measured} de {m.n})</p>
      <CalibrationBadge note={m.note} />
    </div>
  );
}

/** De onde vêm os tempos das entregas: o início da Fila e a chegada ao terminal. */
export function DeliveryCoverageNote({ c }: { c: DeliveryCoverage }) {
  if (!c.n) return null;
  const reasons = Object.entries(c.reasons).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return (
    <p className="text-[11px] text-muted-foreground flex items-start gap-1 leading-snug">
      <Info className="w-3.5 h-3.5 mt-px shrink-0" />
      <span>
        Início da Fila: chamada do cliente {pct(c.withCall, c.n)} · pendente {pct(c.fromPending, c.n)} · sem pedido {pct(c.noRequest, c.n)}.
        {" "}Chegada ao terminal: GPS {pct(c.gps, c.n)} · botão "Cheguei" {pct(c.button, c.n)} · sem medição {pct(c.unmeasured, c.n)}
        {reasons.length > 0 && <> ({reasons.map(([k, v]) => `${statusLabel(k)} ${v}`).join(", ")})</>}.
      </span>
    </p>
  );
}

/** De onde vêm os tempos das recolhas: o início do Cliente e a saída do terminal. */
export function PickupCoverageNote({ c }: { c: PickupCoverage }) {
  if (!c.n) return null;
  const reasons = Object.entries(c.reasons).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return (
    <p className="text-[11px] text-muted-foreground flex items-start gap-1 leading-snug">
      <Info className="w-3.5 h-3.5 mt-px shrink-0" />
      <span>
        Início do Cliente: chamada {pct(c.withCall, c.n)} · "em recolha" {pct(c.fromPickup, c.n)} · sem nenhum {pct(c.noRequest, c.n)}.
        {" "}Saída do terminal: GPS {pct(c.gps, c.n)} · início do movimento na app {pct(c.app, c.n)} · sem medição {pct(c.unmeasured, c.n)}
        {reasons.length > 0 && <> ({reasons.map(([k, v]) => `${statusLabel(k)} ${v}`).join(", ")})</>}.
      </span>
    </p>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  chamada: "chamada do cliente", pendente: "pendente", inicio: "só o \"em entrega\"", em_recolha: "\"em recolha\"",
  gps_zona: "GPS (zona do terminal)", gps_ponto_assinatura: "GPS (onde assinou)", gps_aeroporto: "GPS (aeroporto)", botao: "botão \"Cheguei\"",
  gps: "GPS", app_inicio_movimento: "início do movimento na app",
};
/** De onde veio um tempo ("gps_zona" → "GPS (zona do terminal)"). */
export function sourceLabel(k: string | null | undefined): string {
  if (!k) return "—";
  return SOURCE_LABELS[k] ?? k.replace(/_/g, " ");
}

const FLAG_LABELS: Record<string, string> = {
  chamada_perdida: "chamada perdida", chamada_whatsapp: "chamada pelo WhatsApp", chamada_fora_da_janela: "chamada fora da janela (não conta)",
  telefone_partilhado: "telefone partilhado (não conta)", pedido_antes_da_chamada: "pendente posto antes de o cliente ligar", pedido_repetido: "pendente repetido",
  condutor_esperou: "o condutor esperou o cliente", inicio_no_terminal: "\"em entrega\" marcado já no terminal", inicio_antes_do_pedido: "pegou no carro antes do pedido",
  chegada_ajustada: "chegada acertada à assinatura", nosso_aproximado: "nosso tempo aproximado", precisao_fraca: "GPS com pontos espaçados",
  movimento_durante_pedido: "movimento durante o pedido", checkout_repetido: "check-out repetido", fecho_repetido: "fechada outra vez",
  papel_de_outro_parque: "papel do agente de outro parque", em_recolha_tardio: "\"em recolha\" marcado já no terminal", checkin_repetido: "check-in repetido",
  garagem_sem_papel: "garagem sem papel nas Definições", foi_para_o_sitio_errado: "foi primeiro para o sítio errado", arrumo_por_confirmar: "arrumo por confirmar",
  garagem_desde_o_check_in: "garagem contada desde o check-in", garagem_fora_dos_limites: "1.ª garagem fora dos limites", saida_do_p2_pelo_gps: "saída do P2 pelo GPS",
  zonas_sobrepostas: "zonas P2 e terminal sobrepostas",
};
/** Nota de um ciclo ("condutor_esperou" → "o condutor esperou o cliente"). */
export function flagLabel(k: string): string {
  return FLAG_LABELS[k] ?? k.replace(/_/g, " ");
}

/** Rótulo de um estado ("gps_por_recolher" → "GPS por recolher"). */
export function statusLabel(k: string | null | undefined): string {
  if (!k) return "—";
  return SERVICE_STATUS_LABELS[k] ?? k.replace(/_/g, " ");
}

/**
 * As três partes de uma entrega numa barra (Fila · Trânsito · Cliente), com
 * 2 px de cartão entre elas e os minutos escritos ao lado (a cor nunca é a
 * única pista). `max` = a maior entrega da lista (a escala é a mesma para todas).
 */
export function DeliveryBar({ queueMs, transitMs, customerMs, max }: { queueMs: number | null; transitMs: number | null; customerMs: number | null; max: number }) {
  const parts = [
    { k: "Fila", v: queueMs, c: "var(--times-queue)" },
    { k: "Trânsito", v: transitMs, c: "var(--times-transit)" },
    { k: "Cliente", v: customerMs, c: "var(--times-customer)" },
  ].filter((p) => p.v != null && p.v > 0) as Array<{ k: string; v: number; c: string }>;
  const total = parts.reduce((a, p) => a + p.v, 0);
  const width = max > 0 ? Math.max(4, Math.round((total / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 min-w-0" role="img" aria-label={parts.map((p) => `${p.k} ${fmtDur(p.v)}`).join(", ") || "sem tempos"}>
      <div className="flex-1 min-w-0 h-3">
        <div className="flex h-3 gap-[2px]" style={{ width: `${width}%` }}>
          {parts.map((p, i) => (
            <span key={p.k} title={`${p.k}: ${fmtDur(p.v)}`} className={i === parts.length - 1 ? "rounded-r-[4px]" : ""} style={{ flexGrow: p.v, flexBasis: 0, backgroundColor: p.c }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A legenda da barra (sempre que há barras). */
export function DeliveryBarLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {[["Fila", "var(--times-queue)"], ["Trânsito", "var(--times-transit)"], ["Cliente", "var(--times-customer)"]].map(([k, c]) => (
        <span key={k} className="flex items-center gap-1"><span className="inline-block h-2.5 w-4 rounded-[3px]" style={{ backgroundColor: c }} />{k}</span>
      ))}
    </div>
  );
}
