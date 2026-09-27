/**
 * CRM fase 3 — separadores "Agregadores e agências" e "Parcerias (nós
 * agregamos)" da lista de clientes, lidos ao vivo da BD da Multipark.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Loader2, Search } from "lucide-react";
import { monthLabel } from "@shared/crmPro";
import { Pill, eur, num } from "./crmUi";

const TYPE_LABEL: Record<string, string> = { AGGREGATOR: "Agregador", AGENCY: "Agência", PARTNER: "Parceiro" };
const TYPE_CLASS: Record<string, string> = {
  AGGREGATOR: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  AGENCY: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  PARTNER: "bg-muted text-foreground",
};

function useDebounced(text: string) {
  const [v, setV] = useState("");
  useEffect(() => { const t = setTimeout(() => setV(text.trim()), 300); return () => clearTimeout(t); }, [text]);
  return v;
}

function SearchBox({ value, onChange, placeholder, children }: { value: string; onChange: (v: string) => void; placeholder: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[10px] border bg-card p-3.5">
      <div className="flex h-10 min-w-[260px] flex-1 items-center gap-2 rounded-lg border bg-card px-3">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </div>
      {children}
    </div>
  );
}

function State({ loading, error, unavailable, empty, emptyText }: { loading: boolean; error?: string | null; unavailable?: string | null; empty: boolean; emptyText: string }) {
  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (unavailable) return <div className="rounded-[10px] border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">{unavailable}</div>;
  if (empty) return <div className="rounded-[10px] border bg-card py-12 text-center text-sm text-muted-foreground">{emptyText}</div>;
  return null;
}

export function PartnersPanel() {
  const [, navigate] = useLocation();
  const [text, setText] = useState("");
  const search = useDebounced(text);
  const [type, setType] = useState<"" | "AGGREGATOR" | "AGENCY" | "PARTNER">("");
  const q = trpc.crm.partnersList.useQuery({ search: search || null, type: type || null }, { placeholderData: (p) => p, retry: false });
  const d = q.data;
  const rows = d && d.available ? d.rows : [];
  return (
    <div className="flex flex-col gap-3.5">
      <SearchBox value={text} onChange={setText} placeholder="Procurar parceiro (nome, NIF)…">
        <div className="flex overflow-hidden rounded-lg border bg-card">
          {([["", "Todos"], ["AGGREGATOR", "Agregadores"], ["AGENCY", "Agências"], ["PARTNER", "Outros"]] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setType(v)}
              className={cn("h-[34px] px-3 text-[13px]", type === v ? "bg-primary font-bold text-primary-foreground" : "font-semibold hover:bg-muted")}>{label}</button>
          ))}
        </div>
        {d?.available && <span className="text-[13px]"><strong>{num(rows.length)}</strong> parceiros nos nossos parques</span>}
      </SearchBox>
      <State loading={q.isLoading} error={q.error?.message} unavailable={d && !d.available ? d.reason : null} empty={!!d?.available && !rows.length} emptyText="Nenhum parceiro com este filtro." />
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-[10px] border bg-card">
          <table className="w-full min-w-[980px] text-[13px]">
            <thead>
              <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
                <th className="px-3.5 py-2.5">Parceiro</th><th className="px-3 py-2.5">Parques</th><th className="px-3 py-2.5 text-right">Ficam com</th>
                <th className="px-3 py-2.5 text-right">Este mês</th><th className="px-3 py-2.5 text-right">12 meses</th>
                <th className="px-3 py-2.5 text-right">Valor (12 m)</th><th className="px-3 py-2.5 text-right">Nosso (12 m)</th><th className="px-3 py-2.5">Nas Parcerias</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} onClick={() => navigate(`/clientes/parceiros/${encodeURIComponent(r.userId)}`)} className="cursor-pointer border-t hover:bg-muted/60">
                  <td className="px-3.5 py-2.5">
                    <div className="flex items-center gap-1.5"><strong className="truncate">{r.name}</strong><Pill className={TYPE_CLASS[r.type]}>{TYPE_LABEL[r.type] ?? r.type}</Pill>{!r.active && <Pill className="bg-muted text-muted-foreground">inativo</Pill>}</div>
                    <div className="text-xs text-muted-foreground">{r.taxNumber ? `NIF ${r.taxNumber}` : ""}{r.lastMonth ? `${r.taxNumber ? " · " : ""}última entrada em ${monthLabel(r.lastMonth)}` : ""}</div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.parks.map((p) => p.name).join(", ")}</td>
                  <td className="px-3 py-2.5 text-right">{r.fees.length ? `${r.fees.join(" / ")} %` : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(r.thisMonth.bookings)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(r.last12.bookings)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{eur(r.last12.value)}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{eur(r.last12.ours)}</td>
                  <td className="px-3 py-2.5 text-xs">{r.partnership ? r.partnership.name : <span className="text-muted-foreground">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Lido ao vivo da BD da Multipark. Reservas pelo mês de entrada do carro; "nosso" = o que fica para nós depois da percentagem deles.</p>
    </div>
  );
}

export function ParksPanel() {
  const [, navigate] = useLocation();
  const [text, setText] = useState("");
  const search = useDebounced(text);
  const q = trpc.crm.parksList.useQuery({ search: search || null }, { placeholderData: (p) => p, retry: false });
  const d = q.data;
  const rows = d && d.available ? d.rows : [];
  return (
    <div className="flex flex-col gap-3.5">
      <SearchBox value={text} onChange={setText} placeholder="Procurar parque (nome, empresa, cidade)…">
        {d?.available && <span className="text-[13px]"><strong>{num(rows.length)}</strong> parques que não são nossos</span>}
      </SearchBox>
      <State loading={q.isLoading} error={q.error?.message} unavailable={d && !d.available ? d.reason : null} empty={!!d?.available && !rows.length} emptyText="Nenhum parque com este filtro." />
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-[10px] border bg-card">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead>
              <tr className="bg-muted text-left text-[11px] font-bold uppercase text-muted-foreground">
                <th className="px-3.5 py-2.5">Parque</th><th className="px-3 py-2.5">Cidade</th><th className="px-3 py-2.5">Contacto</th>
                <th className="px-3 py-2.5 text-right">Este mês</th><th className="px-3 py-2.5 text-right">12 meses</th>
                <th className="px-3 py-2.5 text-right">Valor (12 m)</th><th className="px-3 py-2.5 text-right">Nossa comissão (12 m)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => navigate(`/clientes/parques/${encodeURIComponent(r.id)}`)} className="cursor-pointer border-t hover:bg-muted/60">
                  <td className="px-3.5 py-2.5">
                    <div className="flex items-center gap-1.5"><strong className="truncate">{r.name}</strong>{r.status && r.status !== "ACTIVE" && <Pill className="bg-muted text-muted-foreground">{r.status === "PENDING" ? "pendente" : "inativo"}</Pill>}{r.hasNotes && <Pill className="bg-secondary text-secondary-foreground">notas</Pill>}</div>
                    <div className="text-xs text-muted-foreground">{r.companyName ?? ""}</div>
                  </td>
                  <td className="px-3 py-2.5">{[r.city, r.country].filter(Boolean).join(", ") || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{[r.email, r.phone].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(r.thisMonth.bookings)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(r.last12.bookings)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{eur(r.last12.value)}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{eur(r.last12.commission)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Parques no marketplace da Multipark que não são nossos — nós levamos-lhes clientes e ficamos com uma comissão. Lido ao vivo.</p>
    </div>
  );
}
