/**
 * Formação por ÁREA (Multipark, Dashboard, Operacional, Comunicação) e
 * subsecções, e "Procurar formação" por tema (Jorge, 14 out 2026).
 *
 *  - AreaPills / SubareaPills: os separadores em pílula (quebram linha no
 *    telemóvel — nada desliza na horizontal);
 *  - AreaBadge: "Dashboard · Financeiro" (a tracejado quando é proposta);
 *  - AreaFields: escolher área e subsecção nos formulários de quem gere;
 *  - AreaReviewDialog: rever de uma vez as áreas propostas aos conteúdos antigos;
 *  - TrainingFinder: caixa "O que queres aprender?" → "Faz esta formação";
 *  - AreaCatalog: a formação arrumada por área e subsecção.
 */
import { useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { usePersistedState } from "@/hooks/usePersistedState";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { matchKey } from "@shared/textKey";
import { toast } from "sonner";
import {
  BookOpen, Car, CheckCircle, ChevronRight, FileText, Gamepad2, LayoutDashboard, Layers, MessagesSquare, Play, Search, Smartphone, Sparkles,
} from "lucide-react";
import {
  NO_AREA_ID, NO_AREA_LABEL, NO_SUBAREA_LABEL, TRAINING_AREAS, TRAINING_AREA_LABELS, sameSubarea, subareaOptions, type TrainingAreaId,
} from "@shared/trainingAreas";

/** Valor da área a gravar a partir do formulário ("" = por escolher → null). */
export function areaToSave(area: string, subarea: string): { area: TrainingAreaId | typeof NO_AREA_ID | null; subarea: string | null } {
  if (!area) return { area: null, subarea: null };
  if (area === NO_AREA_ID) return { area: NO_AREA_ID, subarea: null };
  return { area: area as TrainingAreaId, subarea: subarea.trim() || null };
}

/** Valor inicial do formulário: a área gravada, a proposta, ou "" (sem proposta). */
export function areaFormValue(row: { area?: string | null; areaEffective?: string | null; subareaEffective?: string | null }): { area: string; subarea: string } {
  if (row.area === NO_AREA_ID) return { area: NO_AREA_ID, subarea: "" };
  return { area: row.areaEffective ?? "", subarea: row.subareaEffective ?? "" };
}
import type { DoneSet } from "./ContentTabs";

export const AREA_ICONS: Record<TrainingAreaId | "none", any> = {
  multipark: Smartphone, dashboard: LayoutDashboard, operacional: Car, comunicacao: MessagesSquare, none: Layers,
};

const MANUAL_TYPE_SHORT: Record<string, string> = { manual: "Manual", update: "Atualização", news: "Notícia", procedure: "Procedimento", link: "Link interativo" };

export type AreaFilter = TrainingAreaId | "all" | "none";

/** Pílula (mesmo desenho dos separadores: escolhida = azul cheio). */
function Pill({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <Button type="button" size="sm" variant={active ? "selected" : "outline"} className="h-8 rounded-full px-3 text-xs" onClick={onClick} title={title} aria-pressed={active}>
      {children}
    </Button>
  );
}

export function AreaPills({ value, onChange, counts, showNone = true }: {
  value: AreaFilter; onChange: (v: AreaFilter) => void; counts?: Partial<Record<AreaFilter, number>>; showNone?: boolean;
}) {
  const n = (k: AreaFilter) => (counts && counts[k] != null ? ` (${counts[k]})` : "");
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Área">
      <Pill active={value === "all"} onClick={() => onChange("all")}>Todas{n("all")}</Pill>
      {TRAINING_AREAS.map((a) => {
        const Icon = AREA_ICONS[a.id];
        return <Pill key={a.id} active={value === a.id} onClick={() => onChange(a.id)} title={a.hint}><Icon className="w-3.5 h-3.5" />{a.label}{n(a.id)}</Pill>;
      })}
      {showNone && (counts?.none ?? 0) > 0 && <Pill active={value === "none"} onClick={() => onChange("none")}>{NO_AREA_LABEL}{n("none")}</Pill>}
    </div>
  );
}

export function SubareaPills({ options, value, onChange }: { options: Array<{ label: string; count: number }>; value: string | null; onChange: (v: string | null) => void }) {
  if (options.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Subsecção">
      <Pill active={value == null} onClick={() => onChange(null)}>Todas as subsecções</Pill>
      {options.map((o) => <Pill key={o.label} active={value != null && sameSubarea(value, o.label)} onClick={() => onChange(o.label)}>{o.label} ({o.count})</Pill>)}
    </div>
  );
}

export function AreaBadge({ area, subarea, guessed, className }: { area: string | null | undefined; subarea?: string | null; guessed?: boolean; className?: string }) {
  if (!area || !(area in TRAINING_AREA_LABELS)) return null;
  const label = `${TRAINING_AREA_LABELS[area as TrainingAreaId]}${subarea ? ` · ${subarea}` : ""}`;
  return (
    <Badge variant="outline" className={cn("text-xs max-w-full truncate", guessed && "border-dashed text-muted-foreground", className)} title={guessed ? "Área proposta automaticamente (quem gere a formação pode confirmar ou mudar)" : undefined}>
      {label}{guessed ? " (proposta)" : ""}
    </Badge>
  );
}

/**
 * Área + subsecção nos formulários (a subsecção pode ser uma das sugeridas ou
 * outra). `area`: uma das quatro, "none" (sem área, de propósito) ou "" (por
 * escolher: a app propõe).
 */
export function AreaFields({ area, subarea, onChange, inUse, idPrefix }: {
  area: string; subarea: string; onChange: (v: { area: string; subarea: string }) => void;
  inUse?: ReadonlyArray<{ area: string | null; subarea: string | null }>; idPrefix: string;
}) {
  const real = !!area && area !== NO_AREA_ID;
  const options = subareaOptions(real ? area : null, inUse ?? []);
  const listId = `${idPrefix}-subareas`;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div><Label>Área</Label>
        <Select value={area} onValueChange={(v) => onChange({ area: v, subarea: v === NO_AREA_ID ? "" : subarea })}>
          <SelectTrigger><SelectValue placeholder="Proposta automática" /></SelectTrigger>
          <SelectContent>
            {TRAINING_AREAS.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
            <SelectItem value={NO_AREA_ID}>Sem área ({NO_AREA_LABEL})</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div><Label htmlFor={`${idPrefix}-sub`}>Subsecção</Label>
        <Input id={`${idPrefix}-sub`} list={listId} disabled={!real} maxLength={80} value={subarea} placeholder={real ? "ex.: Financeiro" : "Escolhe primeiro a área"}
          onChange={(e) => onChange({ area, subarea: e.target.value })} />
        <datalist id={listId}>{options.map((o) => <option key={o} value={o} />)}</datalist>
      </div>
    </div>
  );
}

type ReviewRow = { itemType: "manual" | "video"; id: number; title: string; area: string; subarea: string };
// (área "" = deixar por arrumar; "none" = sem área de propósito)

/** Quem gere: rever e gravar de uma vez as áreas propostas aos conteúdos antigos. */
export function AreaReviewDialog({ open, onOpenChange, items, inUse }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  items: ReadonlyArray<{ itemType: "manual" | "video"; id: number; title: string; areaEffective: string | null; subareaEffective: string | null }>;
  inUse: ReadonlyArray<{ area: string | null; subarea: string | null }>;
}) {
  const utils = trpc.useUtils();
  const initial = useMemo<ReviewRow[]>(() => items.map((i) => ({ itemType: i.itemType, id: i.id, title: i.title, area: i.areaEffective ?? "", subarea: i.subareaEffective ?? "" })), [items]);
  const [rows, setRows] = useState<ReviewRow[]>(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) { setLastInitial(initial); setRows(initial); }
  const save = trpc.training.setAreas.useMutation({
    onSuccess: (r) => {
      toast.success(`Áreas gravadas em ${r.updated} conteúdo(s)`);
      void utils.training.manuals.invalidate(); void utils.training.videos.invalidate(); void utils.training.catalog.invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Arrumar por área</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Estes conteúdos ainda não têm área gravada: a app propôs uma pelo título, pela categoria e pelo texto. Corrige o que estiver mal e grava. "Sem área" põe-nos em {NO_AREA_LABEL} de vez.</p>
        <div className="space-y-3">
          {rows.map((r, i) => (
            <div key={`${r.itemType}:${r.id}`} className="rounded-lg border p-3 space-y-2">
              <p className="text-sm font-medium flex items-center gap-2 min-w-0">
                {r.itemType === "video" ? <Play className="w-4 h-4 text-primary shrink-0" /> : <BookOpen className="w-4 h-4 text-primary shrink-0" />}
                <span className="truncate">{r.title}</span>
              </p>
              <AreaFields idPrefix={`rev-${r.itemType}-${r.id}`} area={r.area} subarea={r.subarea} inUse={inUse}
                onChange={(v) => setRows((p) => p.map((x, j) => (j === i ? { ...x, ...v } : x)))} />
            </div>
          ))}
        </div>
        <Button className="w-full" disabled={save.isPending || !rows.length}
          onClick={() => save.mutate({ items: rows.map((r) => ({ itemType: r.itemType, id: r.id, ...areaToSave(r.area, r.subarea) })) })}>
          {save.isPending ? "A gravar…" : `Gravar ${rows.length} conteúdo(s)`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

// ─── Procurar formação por tema ────────────────────────────────────────────

export interface OpenTarget { itemType: string; itemId: number }

export function TrainingFinder({ done, onOpenItem, onQuizTopic }: { done: DoneSet; onOpenItem: (t: OpenTarget) => void; onQuizTopic: (topic: string) => void }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState<string | null>(null);
  const findQ = trpc.training.findTraining.useQuery({ q: q ?? "" }, { enabled: !!q && q.length >= 2, staleTime: 5 * 60_000, retry: 0 });
  const kbOpen = trpc.knowledge.open.useMutation({ onError: (e) => toast.error(e.message) });
  const openKb = (id: number) => {
    const w = window.open("about:blank", "_blank");
    kbOpen.mutate({ id }, {
      onSuccess: (r) => {
        if (!r.url) { w?.close(); return; }
        if (/^https:/.test(r.url)) { if (w) w.location.href = r.url; else window.open(r.url, "_blank", "noopener,noreferrer"); }
        else { w?.close(); window.location.assign(r.url); }
      },
      onError: () => w?.close(),
    });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 2) { toast.error("Escreve pelo menos 2 letras."); return; }
    setQ(t.slice(0, 160));
  };
  const data = findQ.data;
  const [best, ...others] = data?.results ?? [];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2"><Search className="w-5 h-5 text-primary" />Procurar formação</CardTitle>
        <p className="text-sm text-muted-foreground">Escreve o que queres aprender e dizemos-te que formação fazer. Ex.: «fechar a caixa», «entregar um carro», «próximas reservas».</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={submit} className="flex gap-2">
          <Input className="min-w-0 flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder="O que queres aprender?" maxLength={160} aria-label="O que queres aprender?" enterKeyHint="search" />
          <Button type="submit" disabled={findQ.isFetching}><Search className="w-4 h-4" /><span className="hidden sm:inline">Procurar</span></Button>
        </form>
        {q && findQ.isFetching && <p className="text-sm text-muted-foreground">A procurar…</p>}
        {q && findQ.error && <QueryErrorNote error={findQ.error} onRetry={() => findQ.refetch()} retrying={findQ.isFetching} what="a pesquisa" />}
        {q && data && !findQ.isFetching && (
          <div className="space-y-3">
            {best ? (
              <div className="rounded-xl border border-primary bg-primary/5 p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-primary flex items-center gap-1">
                  {data.mode === "ai" && <Sparkles className="w-3.5 h-3.5" />}Faz esta formação
                </p>
                <FinderRow item={best} done={done} onOpen={onOpenItem} primary />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Não encontrei formação sobre «{data.q}». Experimenta outras palavras ou pergunta ao teu formador.</p>
            )}
            {others.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Também pode ajudar</p>
                {others.map((r) => <FinderRow key={r.key} item={r} done={done} onOpen={onOpenItem} />)}
              </div>
            )}
            {data.kb.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Na base de conhecimento</p>
                {data.kb.map((k) => (
                  <button key={k.docId} type="button" onClick={() => openKb(k.docId)} className="w-full text-left flex items-center gap-2 rounded-lg border p-2 text-sm hover:bg-accent/50 min-w-0">
                    <FileText className="w-4 h-4 text-primary shrink-0" />
                    <span className="truncate flex-1 min-w-0">{k.title}{k.section && k.section !== k.title ? ` — ${k.section}` : ""}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
              <span className="text-xs text-muted-foreground">{data.mode === "ai" ? "Sugestões escolhidas pela IA" : "Pesquisa por palavras"}</span>
              <Button size="sm" variant="outline" onClick={() => onQuizTopic(data.q)}><Gamepad2 className="w-4 h-4" />Treinar com um quiz sobre isto</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FinderRow({ item, done, onOpen, primary }: { item: any; done: DoneSet; onOpen: (t: OpenTarget) => void; primary?: boolean }) {
  const Icon = item.itemType === "video" ? Play : BookOpen;
  const isDone = done.has(`${item.itemType}:${item.id}`);
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", !primary && "rounded-lg border p-2")}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cn("flex items-center gap-2 min-w-0", primary ? "font-semibold" : "text-sm font-medium")}>
          <Icon className="w-4 h-4 text-primary shrink-0" /><span className="truncate">{item.title}</span>
          {isDone && <CheckCircle className="w-4 h-4 text-green-600 shrink-0" aria-label="Já feita" />}
        </p>
        <div className="flex flex-wrap gap-1">
          <AreaBadge area={item.area} subarea={item.subarea} />
          <Badge variant="secondary" className="text-xs">{item.itemType === "video" ? "Vídeo" : MANUAL_TYPE_SHORT[item.manualType ?? "manual"] ?? "Manual"}</Badge>
        </div>
        {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
      </div>
      <Button size="sm" variant={primary ? "selected" : "outline"} onClick={() => onOpen({ itemType: item.itemType, itemId: item.id })}>{isDone ? "Rever" : primary ? "Fazer" : "Abrir"}</Button>
    </div>
  );
}

// ─── Catálogo por área ─────────────────────────────────────────────────────

export function AreaCatalog({ done, onOpenItem }: { done: DoneSet; onOpenItem: (t: OpenTarget) => void }) {
  const catQ = trpc.training.catalog.useQuery(undefined, { staleTime: 60_000 });
  const [area, setArea] = usePersistedState<AreaFilter>("training.catalog.area", "all");
  const [sub, setSub] = useState<string | null>(null);
  const items: any[] = catQ.data ?? [];
  const counts = useMemo(() => {
    const c: Partial<Record<AreaFilter, number>> = { all: items.length, none: 0 };
    for (const i of items) { const k: AreaFilter = i.area ?? "none"; c[k] = (c[k] ?? 0) + 1; }
    return c;
  }, [items]);
  const inArea = useMemo(() => (area === "all" ? items : items.filter((i) => (i.area ?? "none") === area)), [items, area]);
  const subOptions = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const i of inArea) {
      const label = i.subarea || NO_SUBAREA_LABEL;
      const k = matchKey(label);
      const cur = m.get(k);
      if (cur) cur.count++; else m.set(k, { label, count: 1 });
    }
    return Array.from(m.values()).sort((a, b) => (a.label === NO_SUBAREA_LABEL ? 1 : b.label === NO_SUBAREA_LABEL ? -1 : a.label.localeCompare(b.label)));
  }, [inArea]);
  const shown = useMemo(() => (sub == null ? inArea : inArea.filter((i) => sameSubarea(i.subarea || NO_SUBAREA_LABEL, sub))), [inArea, sub]);
  const pick = (a: AreaFilter) => { setArea(a); setSub(null); };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2"><Layers className="w-5 h-5 text-primary" />Formação por área</CardTitle>
        <p className="text-sm text-muted-foreground">Escolhe a área e a subsecção do que queres aprender.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {catQ.error ? <QueryErrorNote error={catQ.error} onRetry={() => catQ.refetch()} retrying={catQ.isFetching} what="a formação por área" />
          : catQ.isLoading ? <p className="text-sm text-muted-foreground">A carregar…</p>
          : !items.length ? <p className="text-sm text-muted-foreground">Ainda não há vídeos nem manuais publicados.</p> : (
          <>
            <AreaPills value={area} onChange={pick} counts={counts} />
            {area === "all" ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {TRAINING_AREAS.map((a) => {
                  const list = items.filter((i) => i.area === a.id);
                  const doneN = list.filter((i) => done.has(`${i.itemType}:${i.id}`)).length;
                  const Icon = AREA_ICONS[a.id];
                  return (
                    <button key={a.id} type="button" onClick={() => pick(a.id)} className="text-left rounded-[14px] border bg-card p-3 hover:border-primary transition-colors min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0"><Icon className="w-4 h-4" /></span>
                        <span className="font-semibold">{a.label}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{list.length} conteúdo(s)</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{a.hint}</p>
                      {list.length > 0 && (
                        <div className="mt-2 flex items-center gap-2"><Progress value={(doneN * 100) / list.length} className="h-1.5 flex-1" /><span className="text-xs text-muted-foreground">{doneN}/{list.length}</span></div>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <>
                <SubareaPills options={subOptions} value={sub} onChange={setSub} />
                {shown.length === 0 ? <p className="text-sm text-muted-foreground">Ainda não há formação nesta área.</p> : (
                  <div className="space-y-2">
                    {shown.map((i) => {
                      const Icon = i.itemType === "video" ? Play : BookOpen;
                      const isDone = done.has(`${i.itemType}:${i.id}`);
                      return (
                        <div key={i.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2">
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-2 min-w-0 text-sm font-medium">
                              {isDone ? <CheckCircle className="w-4 h-4 text-green-600 shrink-0" /> : <Icon className="w-4 h-4 text-primary shrink-0" />}
                              <span className={cn("truncate", isDone && "text-muted-foreground")}>{i.title}</span>
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {sub == null && <Badge variant="outline" className="text-xs">{i.subarea || NO_SUBAREA_LABEL}</Badge>}
                              <Badge variant="secondary" className="text-xs">{i.itemType === "video" ? `Vídeo${i.durationMinutes ? ` · ${i.durationMinutes} min` : ""}` : MANUAL_TYPE_SHORT[i.manualType ?? "manual"] ?? "Manual"}</Badge>
                            </div>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => onOpenItem({ itemType: i.itemType, itemId: i.id })}>{isDone ? "Rever" : "Fazer"}</Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
