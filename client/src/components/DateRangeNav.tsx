import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type DateGran = "day" | "week" | "month" | "year" | "custom";

/** Data local YYYY-MM-DD (sem UTC shift — o toISOString mudava o dia no verão). */
function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Range da granularidade que CONTÉM a data-âncora. Semana começa à 2ª. */
export function rangeFor(gran: DateGran, anchor: Date): { start: string; end: string } {
  const a = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  if (gran === "day") return { start: iso(a), end: iso(a) };
  if (gran === "week") {
    const dow = (a.getDay() + 6) % 7; // 0 = segunda
    const mon = new Date(a); mon.setDate(a.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { start: iso(mon), end: iso(sun) };
  }
  if (gran === "month") {
    return {
      start: iso(new Date(a.getFullYear(), a.getMonth(), 1)),
      end: iso(new Date(a.getFullYear(), a.getMonth() + 1, 0)),
    };
  }
  if (gran === "year") {
    return { start: iso(new Date(a.getFullYear(), 0, 1)), end: iso(new Date(a.getFullYear(), 11, 31)) };
  }
  return { start: "", end: "" };
}

/** Salta o range um período para trás/frente (calendário real: o mês antes de 1–31 mar é 1–28/29 fev). */
export function shiftRange(gran: DateGran, start: string, end: string, dir: -1 | 1): { start: string; end: string } {
  if (!start && !end) return { start, end };
  const s = new Date(`${start || end}T00:00:00`);
  if (gran === "day") { const d = new Date(s); d.setDate(d.getDate() + dir); return rangeFor("day", d); }
  if (gran === "week") { const d = new Date(s); d.setDate(d.getDate() + 7 * dir); return rangeFor("week", d); }
  if (gran === "month") return rangeFor("month", new Date(s.getFullYear(), s.getMonth() + dir, 1));
  if (gran === "year") return rangeFor("year", new Date(s.getFullYear() + dir, 0, 1));
  // custom: salta pela duração do próprio range
  const e = new Date(`${end || start}T00:00:00`);
  const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1);
  const ns = new Date(s); ns.setDate(ns.getDate() + days * dir);
  const ne = new Date(e); ne.setDate(ne.getDate() + days * dir);
  return { start: iso(ns), end: iso(ne) };
}

const GRAN_LABEL: Record<Exclude<DateGran, "custom">, string> = {
  day: "Dia", week: "Semana", month: "Mês", year: "Ano",
};

/** Segunda-feira da semana que contém a data. */
export function mondayOf(d: Date): string {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (a.getDay() + 6) % 7;
  a.setDate(a.getDate() - dow);
  return iso(a);
}

/**
 * O MESMO filtro completo (Dia/Semana/Mês/Ano + ◀ ▶ + datas) para páginas que
 * trabalham com UM dia-âncora (regra Jorge: "os filtros todos iguais aos do
 * operacional"). Gere o período internamente e devolve o início do range —
 * escolher "Mês" e andar com as setas salta mês a mês; a página usa o 1º dia.
 */
export function UniDateNav({
  date, onChange, defaultGran = "day",
}: {
  date: string;
  onChange: (date: string) => void;
  defaultGran?: DateGran;
}) {
  const [gran, setGran] = useState<DateGran>(defaultGran);
  const [end, setEnd] = useState<string>(() => rangeFor(defaultGran, date ? new Date(`${date}T00:00:00`) : new Date()).end);
  return (
    <DateRangeNav
      start={date}
      end={end || date}
      gran={gran}
      showAll={false}
      onChange={(s, e, g) => {
        setGran(g);
        setEnd(e);
        onChange(s || e);
      }}
    />
  );
}

/**
 * Navegador de datas transversal (pedido do Jorge): escolhe a granularidade
 * (Dia/Semana/Mês/Ano) e as setas ◀ ▶ saltam pelo período; datas manuais
 * passam para "custom" (as setas saltam pela duração escolhida). "Tudo"
 * limpa o range.
 */
export default function DateRangeNav({
  start, end, gran, onChange, showAll = true,
}: {
  start: string;
  end: string;
  gran: DateGran;
  onChange: (start: string, end: string, gran: DateGran) => void;
  showAll?: boolean;
}) {
  const hasRange = Boolean(start || end);
  const step = (dir: -1 | 1) => {
    if (!hasRange) return;
    const r = shiftRange(gran, start, end, dir);
    onChange(r.start, r.end, gran);
  };
  const pickGran = (g: string) => {
    if (g === "all") { onChange("", "", "custom"); return; }
    const anchor = start ? new Date(`${start}T00:00:00`) : new Date();
    const r = rangeFor(g as DateGran, anchor);
    onChange(r.start, r.end, g as DateGran);
  };

  // Design system (pedido Jorge): o seletor de datas vive numa faixa AZUL
  // (mpk-period do kit), maior e uniforme em toda a app.
  return (
    <div className="inline-flex items-center gap-1.5 flex-wrap bg-[#e1ecff] border border-[#c2d6ff] rounded-xl p-1.5">
      <Button variant="outline" size="icon" className="h-10 w-9 shrink-0 bg-white border-[#c2d6ff] text-[#0046ad] hover:bg-[#f0f4ff]" disabled={!hasRange} onClick={() => step(-1)} title="Período anterior">
        <ChevronLeft className="h-4.5 w-4.5" />
      </Button>
      <Select value={hasRange ? gran : "all"} onValueChange={pickGran}>
        <SelectTrigger className="w-[118px] !h-10 bg-white border-[#c2d6ff] text-[#0046ad] font-semibold"><SelectValue /></SelectTrigger>
        <SelectContent>
          {(Object.keys(GRAN_LABEL) as Array<keyof typeof GRAN_LABEL>).map((g) => (
            <SelectItem key={g} value={g}>{GRAN_LABEL[g]}</SelectItem>
          ))}
          <SelectItem value="custom" disabled={!hasRange}>Livre</SelectItem>
          {showAll && <SelectItem value="all">Tudo</SelectItem>}
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon" className="h-10 w-9 shrink-0 bg-white border-[#c2d6ff] text-[#0046ad] hover:bg-[#f0f4ff]" disabled={!hasRange} onClick={() => step(1)} title="Período seguinte">
        <ChevronRight className="h-4.5 w-4.5" />
      </Button>
      <Input
        type="date" value={start} className="w-[150px] !h-10 bg-white border-[#c2d6ff] text-[#0046ad] font-semibold text-[14px]"
        onChange={(e) => onChange(e.target.value, end, "custom")}
      />
      <span className="text-[#0046ad] text-xs font-semibold">a</span>
      <Input
        type="date" value={end} className="w-[150px] !h-10 bg-white border-[#c2d6ff] text-[#0046ad] font-semibold text-[14px]"
        onChange={(e) => onChange(start, e.target.value, "custom")}
      />
    </div>
  );
}
