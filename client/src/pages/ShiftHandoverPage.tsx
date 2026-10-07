import { useState, useEffect, useMemo } from "react";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { trpc } from "@/lib/trpc";
import { UniDateNav } from "@/components/DateRangeNav";
import { ShiftExpensesCard } from "@/components/ShiftExpensesCard";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePersistedState } from "@/hooks/usePersistedState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { ClipboardCheck, History, BarChart3, Radio, Loader2, Sun, Moon, CheckCircle2, XCircle, AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { useTableSort, Th } from "@/components/SortableTable";
import { fmtPTDate } from "@/lib/lisbonTime";
import { Plus, Trash2 } from "lucide-react";
import {
  CLOTHING_LABELS,
  CLOTHING_MAX_ITEMS,
  CLOTHING_MAX_QTY,
  CLOTHING_SIZES,
  CLOTHING_TYPES,
  summarizeClothingItems,
  type ClothingItem,
  type ClothingSize,
  type ClothingType,
} from "@shared/clothing";
import { addDays, lisbonDayOf } from "@shared/lisbonDay";
import {
  HANDOVER_CITY_LABELS,
  HANDOVER_EDIT_WINDOW_MINUTES,
  allowedHandoverCities,
  canEditOldHandover,
  defaultHandoverCity,
  findPersonShift,
  maxHandoverDate,
  operationalShift,
  type HandoverCity,
  type HandoverShift,
} from "@shared/shiftHandover";
import {
  COMPLIANCE_LABELS,
  HANDOVER_CITY_FIELDS,
  MATERIAL_EXCEPTION_LABELS,
  SHIFT_LABELS,
  materialExceptionsFor,
  isHandoverItem,
  mergeCarryOver,
  previousShiftOf,
  shiftSince,
  withNoteItems,
  type ComplianceStatus,
  type MaterialException,
  type MaterialExceptionItem,
  type OpenItem,
} from "@shared/shiftHandoverAuto";
import { AiSummaryBox, OpenItemsEditor, ShiftHandoverDraftPanel } from "@/components/ShiftHandoverDraftPanel";
import { fmtHours, stoppedHours, workedHours } from "@shared/dayWorkSummary";
import HandoverRepeatsCard from "@/components/aiOps/HandoverRepeatsCard";
import { ShiftHandoverLiveState } from "@/components/ShiftHandoverLiveState";
import { Checkbox } from "@/components/ui/checkbox";

// ─── PASSAGEM DE TURNO (pedido do Jorge, 2026-08-06) ─────────────────────────
// Os team leaders preenchem o checklist no fim do turno; o supervisor consulta
// o histórico e tem um resumo do dia (condutores, carros, tempos, atrasos).
// Dia e turno por omissão = turno operacional em Lisboa (a noite 15h–03h é do
// dia em que começa), nunca o relógio do browser.

import { can, roleRank } from "@shared/access";
const CITY_LABELS: Record<string, string> = HANDOVER_CITY_LABELS;
const LAST_CITY_KEY = "mp.handover.lastCity";

/** Cidade da página: só as do centro de custos; uma → essa, várias → a última usada. */
function useHandoverCity(): {
  city: HandoverCity | null; allowed: HandoverCity[]; setCity: (c: HandoverCity) => void; loading: boolean;
  error: { message: string } | null; retry: () => void; retrying: boolean;
} {
  const { data: access, isLoading, error, refetch, isFetching } = trpc.permissions.myCityAccess.useQuery();
  const allowed = allowedHandoverCities(access);
  const [lastUsed, setLastUsed] = useState<string | null>(() => {
    // 20d: o link do calendário/aviso (?city=porto) manda; senão, a última usada.
    try { return new URLSearchParams(window.location.search).get("city") || localStorage.getItem(LAST_CITY_KEY); } catch { return null; }
  });
  const city = defaultHandoverCity(allowed, lastUsed);
  const setCity = (c: HandoverCity) => {
    setLastUsed(c);
    try { localStorage.setItem(LAST_CITY_KEY, c); } catch { /* armazenamento indisponível */ }
  };
  return { city, allowed, setCity, loading: isLoading, error: error ?? null, retry: () => { void refetch(); }, retrying: isFetching };
}

function CitySelect({ city, allowed, onChange }: { city: HandoverCity | null; allowed: HandoverCity[]; onChange: (c: HandoverCity) => void }) {
  if (allowed.length <= 1) return <p className="h-9 flex items-center text-sm">📍 {city ? CITY_LABELS[city] : "—"}</p>;
  return (
    <Select value={city ?? undefined} onValueChange={(v) => onChange(v as HandoverCity)}>
      <SelectTrigger className="w-32 h-9"><SelectValue /></SelectTrigger>
      <SelectContent>
        {allowed.map((c) => <SelectItem key={c} value={c}>📍 {CITY_LABELS[c]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

// ─── Campos numéricos (texto + inputMode, vírgula PT aceite) ─────────────────
type NumRule = { int?: boolean; min?: number; max?: number };
/** `{ value }` (null quando vazio) ou `{ error }` com a mensagem a mostrar. */
function parseNumField(raw: string, rule: NumRule): { value: number | null; error?: string } {
  const s = raw.trim().replace(/\s/g, "").replace(",", ".");
  if (s === "") return { value: null };
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { value: null, error: "Escreve só números (ex.: 12,50)" };
  const n = Number(s);
  if (rule.int && !Number.isInteger(n)) return { value: null, error: "Tem de ser um número inteiro" };
  if (rule.min != null && n < rule.min) return { value: null, error: rule.min === 0 ? "Não pode ser negativo" : `Mínimo ${rule.min}` };
  if (rule.max != null && n > rule.max) return { value: null, error: `Máximo ${rule.max}` };
  return { value: n };
}

const NUM_RULES = {
  carsForCovered: { int: true, min: 0 },
  frontPouchValue: { min: 0, max: 1_000_000 },
  terminalPouchValue: { min: 0, max: 1_000_000 },
  ticketsExpensesPaid: { min: 0, max: 1_000_000 },
  mbRolls: { int: true, min: 0 },
  mbRollsInPouch: { int: true, min: 0 },
  pensInPouch: { int: true, min: 0 },
  mbBattery: { int: true, min: 0, max: 100 },
} satisfies Record<string, NumRule>;
type NumField = keyof typeof NUM_RULES;

export default function ShiftHandoverPage() {
  const { user } = useAuth();
  // "Resumo do dia": supervisor e acima (o team leader preenche e lê, mas não o vê).
  const isSupervisor = can(user, "passagem_resumo_dia", "view");
  // Preencher, gerar o resumo e "Recebi" pedem a edição (o servidor exige o mesmo).
  const canEdit = can(user, "passagem_turno", "edit");
  // Passagens com mais de 24h: a MESMA regra do servidor.
  const canEditOld = canEditOldHandover(user);
  const [tab, setTab] = usePersistedState("handover.tab", "preencher");
  const cityState = useHandoverCity();

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <p className="text-muted-foreground text-sm">Checklist de fim de turno (team leaders) e resumo do dia (supervisão)</p>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="preencher"><ClipboardCheck className="w-4 h-4 mr-1" />Preencher</TabsTrigger>
          <TabsTrigger value="aovivo"><Radio className="w-4 h-4 mr-1" />Estado do parque (ao vivo)</TabsTrigger>
          <TabsTrigger value="historico"><History className="w-4 h-4 mr-1" />Histórico</TabsTrigger>
          {isSupervisor && <TabsTrigger value="dashboard"><BarChart3 className="w-4 h-4 mr-1" />Resumo do dia</TabsTrigger>}
        </TabsList>
        {cityState.loading ? <p className="text-sm text-muted-foreground mt-4">A carregar…</p> : cityState.error ? (
          <div className="mt-4"><QueryErrorNote error={cityState.error} onRetry={cityState.retry} retrying={cityState.retrying} what="as tuas cidades" /></div>
        ) : !cityState.city ? (
          <Card className="mt-4"><CardContent className="p-8 text-center text-muted-foreground">Sem cidade atribuída — pede a um administrador para associar o teu centro de custos.</CardContent></Card>
        ) : (
          <>
            {/* Fica montado ao mudar de separador: o que se escreveu não se perde. */}
            <TabsContent value="preencher" forceMount className="data-[state=inactive]:hidden">
              <HandoverForm cityState={cityState as CityState} canEdit={canEdit} canEditOld={canEditOld} userId={user?.id ?? null} />
            </TabsContent>
            <TabsContent value="aovivo">
              <ShiftHandoverLiveState
                city={(cityState as CityState).city}
                citySelect={<div><Label className="text-xs mb-1 block">Cidade</Label><CitySelect city={cityState.city} allowed={cityState.allowed} onChange={cityState.setCity} /></div>}
              />
            </TabsContent>
            <TabsContent value="historico"><HandoverHistory cityState={cityState as CityState} userId={user?.id ?? null} canEdit={canEdit} /></TabsContent>
            {isSupervisor && <TabsContent value="dashboard"><SupervisorDashboard cityState={cityState as CityState} /></TabsContent>}
          </>
        )}
      </Tabs>
    </div>
  );
}

type CityState = { city: HandoverCity; allowed: HandoverCity[]; setCity: (c: HandoverCity) => void };

// ─── FORMULÁRIO ──────────────────────────────────────────────────────────────
const EMPTY_FORM = {
  carsForCovered: "", chargedUntilDate: "", cashClosedInSafe: null as boolean | null,
  checkoutCashDone: null as boolean | null, frontPouchValue: "", terminalPouchValue: "",
  ticketsExpensesPaid: "", mbRolls: "", mbRollsInPouch: "", pensInPouch: "",
  mbBattery: "", pdasCharged: null as boolean | null, notes: "",
};
type FormState = typeof EMPTY_FORM;

function formFromRecord(existing: any): FormState {
  if (!existing) return EMPTY_FORM;
  const str = (v: any) => (v != null ? String(Number(v)).replace(".", ",") : "");
  return {
    carsForCovered: str(existing.carsForCovered),
    chargedUntilDate: existing.chargedUntilDate ?? "",
    cashClosedInSafe: existing.cashClosedInSafe == null ? null : !!existing.cashClosedInSafe,
    checkoutCashDone: existing.checkoutCashDone == null ? null : !!existing.checkoutCashDone,
    frontPouchValue: str(existing.frontPouchValue),
    terminalPouchValue: str(existing.terminalPouchValue),
    ticketsExpensesPaid: str(existing.ticketsExpensesPaid),
    mbRolls: str(existing.mbRolls),
    mbRollsInPouch: str(existing.mbRollsInPouch),
    pensInPouch: str(existing.pensInPouch),
    mbBattery: str(existing.mbBattery),
    pdasCharged: existing.pdasCharged == null ? null : !!existing.pdasCharged,
    notes: existing.notes ?? "",
  };
}

function HandoverForm({ cityState, canEdit, canEditOld, userId }: { cityState: CityState; canEdit: boolean; canEditOld: boolean; userId: number | null }) {
  const utils = trpc.useUtils();
  const { allowed } = cityState;
  // A cidade do formulário é dele: mudar a cidade noutro separador não deita
  // fora o que está por gravar (só segue a da página quando não há alterações).
  const [city, setCityLocal] = useState<HandoverCity>(cityState.city);
  // Turno operacional em Lisboa (01:30 → noite do dia anterior). 20d: o link do
  // calendário (?date=AAAA-MM-DD) abre esse dia, se não for no futuro.
  const maxDate = maxHandoverDate();
  const [date, setDate] = useState(() => {
    try {
      const d = new URLSearchParams(window.location.search).get("date");
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= maxDate) return d;
    } catch { /* sem URL */ }
    return operationalShift().date;
  });
  const [shift, setShift] = useState<HandoverShift>(() => operationalShift().shift);

  // Alterações por gravar: os setters "de quem escreve" marcam; os efeitos
  // (carregar o registo, juntar pendentes) usam os *Raw e não contam.
  const [dirty, setDirty] = useState(false);
  const touch = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { setDirty(true); fn(...a); };
  const [f, setFRaw] = useState<FormState>(EMPTY_FORM);
  const setF = touch(setFRaw);
  // Fardamento: linhas em rascunho (qty como texto enquanto se escreve). O
  // "Número de fardas" antigo deixou de se pedir (e saiu da API): o servidor
  // já não mexe no valor dos registos anteriores a 2026-09-09.
  const [clothing, setClothingRaw] = useState<ClothingDraftRow[]>([]);
  const setClothing = touch(setClothingRaw);
  // Material simplificado: "Material OK?" + exceções (canetas/rolos/bateria).
  const [materialOk, setMaterialOkRaw] = useState<boolean | null>(null);
  const setMaterialOk = touch(setMaterialOkRaw);
  const [materialExc, setMaterialExcRaw] = useState<MaterialExceptionItem[]>([]);
  const setMaterialExc = touch(setMaterialExcRaw);
  // Pendentes que passam de turno (carry-over) e resumo IA.
  const [openItems, setOpenItemsRaw] = useState<OpenItem[]>([]);
  const setOpenItems = touch(setOpenItemsRaw);
  const [aiText, setAiText] = useState<string | null>(null);
  const [carriedKey, setCarriedKey] = useState<string | null>(null);
  // Gravar mesmo sem conseguir ler os pendentes do turno anterior (escolha explícita).
  const [saveWithoutPrev, setSaveWithoutPrev] = useState(false);
  const cityFields = HANDOVER_CITY_FIELDS[city];

  useEffect(() => {
    if (!dirty && cityState.city !== city) setCityLocal(cityState.city);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityState.city]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  /** Mudar de dia/turno/cidade ou recarregar deita fora o que não foi gravado: pergunta antes. */
  const okToDiscard = () => !dirty || window.confirm("Tens alterações por gravar nesta passagem. Se mudares agora, perdes-as. Continuar?");

  // Turno atual ou o que acabou agora: só nesses o rascunho (que é de AGORA)
  // entra na passagem. Num turno antigo herdam-se só os pendentes da passagem anterior.
  const op = operationalShift();
  const opPrev = previousShiftOf(op);
  const recent = (date === op.date && shift === op.shift) || (date === opPrev.date && shift === opPrev.shift);
  const since = shiftSince({ date, shift });

  // Carrega o registo existente do (dia, turno, cidade) ANTES de deixar
  // escrever: os campos ficam bloqueados até a leitura acabar, e só se
  // preenchem uma vez por chave (um refetch não apaga o que se escreveu).
  const formKey = `${date}|${shift}|${city}`;
  const existingQ = trpc.shiftHandover.list.useQuery({ from: date, to: date, city });
  const existing = (existingQ.data ?? []).find((h: any) => h.shift === shift && h.city === city) as any;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // Versão carregada — vai no save (lock otimista). Não se lê do `existing`
  // vivo: senão um refetch "aceitava" silenciosamente a edição de outra pessoa.
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<any>(null);
  useEffect(() => {
    if (loadedKey === formKey || !existingQ.isSuccess || existingQ.isFetching) return;
    setFRaw(formFromRecord(existing));
    setClothingRaw(((existing?.clothingItems ?? []) as ClothingItem[]).map(toDraftRow));
    setLoadedVersion(existing ? Number(existing.version ?? 1) : null);
    setLoaded(existing ?? null);
    setMaterialOkRaw(existing?.materialOk == null ? null : !!existing.materialOk);
    setMaterialExcRaw((existing?.materialExceptions ?? []) as MaterialExceptionItem[]);
    // 44b: só PDAs e notas (os de outros tipos gravados antes ficam na BD, sem aparecer).
    setOpenItemsRaw(((existing?.openItems ?? []) as OpenItem[]).filter(isHandoverItem));
    setAiText(existing?.aiSummary ?? null);
    setCarriedKey(null);
    setSaveWithoutPrev(false);
    setDirty(false);
    setLoadedKey(formKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey, loadedKey, existingQ.isSuccess, existingQ.isFetching, existingQ.dataUpdatedAt]);
  const loading = loadedKey !== formKey;
  const reload = () => { setLoadedKey(null); existingQ.refetch(); };

  // Resumo automático (rascunho) do turno — só leitura (pede a edição).
  const draftQ = trpc.shiftHandover.draft.useQuery({ date, shift, city }, { enabled: canEdit, staleTime: 60_000, refetchOnWindowFocus: false });
  const draft = draftQ.data ?? null;
  // Pendentes (1× por chave):
  // - turno atual / que acabou: os da passagem anterior + os abertos de agora, juntos aos já gravados;
  // - turno antigo e passagem nova: só os da passagem anterior (o "agora" não é desse turno);
  // - turno antigo já gravado: fica como foi gravado.
  useEffect(() => {
    if (loading || !draft || draftQ.isFetching || carriedKey === formKey) return;
    if (recent) {
      setOpenItemsRaw((cur) => mergeCarryOver({ previous: [], draft: draft.carryOver as OpenItem[], current: cur, currentSince: since }));
      // Carros p/ toldo: pré-preenchido com o número automático (continua editável).
      if (draft.coveredCars && !(draft.failed ?? []).includes("covered cars")) {
        setFRaw((prev) => (prev.carsForCovered === "" ? { ...prev, carsForCovered: String(draft.coveredCars!.count) } : prev));
      }
    } else if (!loaded) {
      setOpenItemsRaw((cur) => mergeCarryOver({ previous: (draft.previous?.openItems ?? []) as OpenItem[], draft: [], draftKinds: [], current: cur, currentSince: since }));
    }
    setCarriedKey(formKey);
  }, [loading, draft, draftQ.isFetching, carriedKey, formKey, recent, loaded, since]);

  const ai = trpc.shiftHandover.aiSummary.useMutation({
    onSuccess: (r) => {
      setAiText(r.aiSummary);
      toast.success(r.saved ? "Resumo gerado e guardado na passagem" : "Resumo gerado (não ficou guardado: ao gravar a passagem é gerado de novo)");
    },
    onError: (e) => toast.error(e.message),
  });
  const ack = trpc.shiftHandover.ack.useMutation({
    onSuccess: async () => { toast.success("Passagem confirmada (Recebi)"); await utils.shiftHandover.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const save = trpc.shiftHandover.save.useMutation({
    onSuccess: async () => {
      // D7: grava logo; o resumo (IA), o aviso e o email ao turno seguinte seguem dentro de momentos
      toast.success("Passagem de turno guardada — o resumo e o aviso ao turno seguinte seguem dentro de momentos");
      await utils.shiftHandover.draft.invalidate();
      // Recarrega o registo gravado (nova versão) antes de permitir nova edição.
      await utils.shiftHandover.list.invalidate();
      setLoadedKey(null);
      // e outra vez quando o resumo da IA já deve estar guardado
      setTimeout(() => { void utils.shiftHandover.list.invalidate(); }, 15_000);
    },
    onError: (e) => {
      if (e.data?.code === "CONFLICT") toast.error(e.message, { action: { label: "Recarregar", onClick: reload }, duration: 15000 });
      else toast.error(e.message);
    },
  });

  const numErrors = Object.fromEntries(
    (Object.keys(NUM_RULES) as NumField[]).map((k) => [k, parseNumField(f[k], NUM_RULES[k]).error]),
  ) as Record<NumField, string | undefined>;
  const hasNumErrors = Object.values(numErrors).some(Boolean);
  const numVal = (k: NumField) => parseNumField(f[k], NUM_RULES[k]).value;
  const dateTooLate = date > maxDate;
  const lockedOld = !!loaded && !canEditOld && loaded.createdAt != null
    && (Date.now() - new Date(loaded.createdAt).getTime()) / 60_000 > HANDOVER_EDIT_WINDOW_MINUTES;

  // Passagem nova: os pendentes do turno anterior TÊM de estar na lista antes
  // de gravar (senão o turno seguinte herda a lista sem eles e perdem-se).
  const carryPending = canEdit && !loaded && !draftQ.isError && carriedKey !== formKey;
  const prevUnknown = canEdit && !loaded && (draftQ.isError || (draft?.failed ?? []).includes("previous"));

  const NumInput = ({ k, label, decimal }: { k: NumField; label: string; decimal?: boolean }) => (
    <div>
      <Label className="text-xs" htmlFor={`ho-${k}`}>{label}</Label>
      <Input
        id={`ho-${k}`}
        type="text"
        inputMode={decimal ? "decimal" : "numeric"}
        autoComplete="off"
        value={f[k]}
        onChange={(e) => setF((prev) => ({ ...prev, [k]: e.target.value }))}
        aria-invalid={!!numErrors[k]}
        className={numErrors[k] ? "border-red-400" : undefined}
      />
      {numErrors[k] && <p className="text-[11px] text-red-600 mt-0.5">{numErrors[k]}</p>}
    </div>
  );

  const YesNo = ({ value, onChange, label }: { value: boolean | null; onChange: (v: boolean) => void; label: string }) => (
    <div className="flex items-center justify-between gap-2 border rounded-lg p-2.5">
      <span className="text-sm min-w-0">{label}</span>
      <div className="flex gap-1 shrink-0" role="group" aria-label={label}>
        <Button type="button" size="sm" variant={value === true ? "selected" : "outline"} className="h-7 px-2.5" aria-pressed={value === true} onClick={() => onChange(true)}>Sim</Button>
        <Button type="button" size="sm" variant={value === false ? "destructive" : "outline"} className="h-7 px-2.5" aria-pressed={value === false} onClick={() => onChange(false)}>Não</Button>
      </div>
    </div>
  );

  const blockedReason = loading ? "A carregar o registo…"
    : dateTooLate ? "Não é possível registar passagens para depois de amanhã"
    : lockedOld ? "Passaram mais de 24h — só um supervisor pode alterar"
    : carryPending ? "A juntar os pendentes do turno anterior…"
    : prevUnknown && !saveWithoutPrev ? "Não foi possível ler os pendentes do turno anterior — tenta de novo ou confirma que gravas sem eles"
    : hasNumErrors ? "Há valores inválidos" : hasIncompleteClothingRow(clothing) ? "Há peças de fardamento sem quantidade válida" : undefined;

  const prev = draft?.previous ?? null;
  // "Recebi": quem pode preencher, e nunca quem entregou ou editou essa passagem.
  const canAck = (h: { createdById?: number | null; filledById?: number | null }) =>
    canEdit && userId != null && h.createdById !== userId && h.filledById !== userId;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs mb-1 block">Dia</Label><UniDateNav date={date} onChange={(d) => { if (okToDiscard()) setDate(d); }} /></div>
          <div>
            <Label className="text-xs mb-1 block">Turno</Label>
            <div className="flex gap-1">
              <Button type="button" size="sm" variant={shift === "morning" ? "selected" : "outline"} aria-pressed={shift === "morning"} onClick={() => { if (shift !== "morning" && okToDiscard()) setShift("morning"); }}><Sun className="w-3.5 h-3.5 mr-1" />Manhã</Button>
              <Button type="button" size="sm" variant={shift === "night" ? "selected" : "outline"} aria-pressed={shift === "night"} onClick={() => { if (shift !== "night" && okToDiscard()) setShift("night"); }}><Moon className="w-3.5 h-3.5 mr-1" />Noite</Button>
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Cidade</Label>
            <CitySelect city={city} allowed={allowed} onChange={(c) => { if (c !== city && okToDiscard()) { setCityLocal(c); cityState.setCity(c); } }} />
          </div>
          {loading && !existingQ.isError && <Badge variant="outline" className="mb-1 gap-1"><Loader2 className="w-3 h-3 animate-spin" />A carregar…</Badge>}
          {!loading && loaded && (
            <Badge variant="outline" className="mb-1 whitespace-normal break-words text-left">
              criada por {loaded.createdByName ?? loaded.filledByName ?? "?"}
              {loaded.filledByName && loaded.filledByName !== (loaded.createdByName ?? loaded.filledByName) ? ` · última edição: ${loaded.filledByName}` : ""}{canEdit ? " — a editar" : ""}
            </Badge>
          )}
          {!loading && loaded?.ackAt && <Badge variant="outline" className="mb-1 whitespace-normal break-words text-left border-emerald-300 text-emerald-700">Recebida por {loaded.ackByName ?? "?"}</Badge>}
          {dirty && !loading && <Badge variant="outline" className="mb-1 border-amber-300 text-amber-700">por gravar</Badge>}
          {!loading && <Button type="button" size="sm" variant="ghost" className="mb-0.5" onClick={() => { if (okToDiscard()) reload(); }} title="Recarregar o registo guardado" aria-label="Recarregar o registo guardado"><RefreshCw className="w-3.5 h-3.5" /></Button>}
        </div>
        {existingQ.isError && loading && (
          <div className="mt-2"><QueryErrorNote error={existingQ.error} onRetry={reload} retrying={existingQ.isFetching} what="o registo deste turno (não se pode preencher sem saber se já existe)" /></div>
        )}
        {dateTooLate && <p className="text-xs text-red-600 mt-2">Não é possível registar passagens de turno para depois de amanhã.</p>}
        {lockedOld && <p className="text-xs text-amber-700 mt-2">Esta passagem foi criada há mais de 24h — só um supervisor a pode alterar.</p>}
        {!canEdit && <p className="text-xs text-muted-foreground mt-2">Só consulta: a tua conta não preenche passagens de turno.</p>}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Passagem que este turno recebeu — "Recebi" do team leader que entra */}
        {prev && (
          <div className="border rounded-lg p-3 space-y-1 bg-blue-50/40 dark:bg-blue-950/20">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-medium">Passagem recebida — {SHIFT_LABELS[prev.shift]} {fmtPTDate(prev.date)}{prev.authorName ? ` · por ${prev.authorName}` : ""}</p>
              {prev.acked ? <Badge variant="outline" className="border-emerald-300 text-emerald-700">Recebida por {prev.ackByName ?? "?"}</Badge>
                : canAck(prev) ? (
                  <Button type="button" size="sm" disabled={ack.isPending} onClick={() => ack.mutate({ id: prev.id, city })}>
                    {ack.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1" />}Recebi
                  </Button>
                ) : <Badge variant="outline">à espera do "Recebi"</Badge>}
            </div>
            {(prev.missingShifts ?? 0) > 0 && (
              <p className="text-xs text-amber-700">É a última passagem que houve: {prev.missingShifts === 1 ? "o turno entre essa e este não fez passagem" : `os ${prev.missingShifts} turnos entre essa e este não fizeram passagem`}. Os pendentes vêm dela.</p>
            )}
            {prev.aiSummary ? <p className="text-sm whitespace-pre-line">{prev.aiSummary}</p> : prev.notes ? <p className="text-sm text-muted-foreground whitespace-pre-line">{prev.notes}</p> : null}
            {prev.openItems.length > 0 && <p className="text-xs text-amber-700">{prev.openItems.length} pendente(s) por resolver — estão na lista "Pendentes" abaixo.</p>}
          </div>
        )}
        {canEdit && (draftQ.isError
          ? <QueryErrorNote error={draftQ.error} onRetry={() => draftQ.refetch()} retrying={draftQ.isFetching} what="o resumo automático do turno" />
          : <ShiftHandoverDraftPanel draft={draft} loading={draftQ.isFetching} onRefresh={() => draftQ.refetch()} past={!recent} />)}
        {prevUnknown && (
          <div role="alert" className="border border-amber-300 bg-amber-50/70 dark:bg-amber-950/20 rounded-lg p-3 space-y-2 text-sm">
            <p className="font-medium text-amber-800 dark:text-amber-200 flex items-center gap-1"><AlertTriangle className="w-4 h-4" />Não foi possível ler os pendentes do turno anterior</p>
            <p className="text-xs">Se gravares agora, os pendentes da passagem anterior que não estão na lista abaixo não passam ao turno seguinte (continuam na passagem anterior). Tenta de novo daqui a pouco.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" variant="outline" onClick={() => draftQ.refetch()} disabled={draftQ.isFetching}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1 ${draftQ.isFetching ? "animate-spin" : ""}`} />Tentar de novo
              </Button>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={saveWithoutPrev} onCheckedChange={(v) => setSaveWithoutPrev(!!v)} />
                Gravar mesmo assim, sem os pendentes do turno anterior
              </label>
            </div>
          </div>
        )}
        <HandoverRepeatsCard city={city} />
        <fieldset disabled={loading || !canEdit} className="space-y-4 disabled:opacity-60">
          {/* Operação */}
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Operação</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {cityFields.coveredCars && NumInput({ k: "carsForCovered", label: "Carros p/ toldo" })}
            <div><Label className="text-xs" htmlFor="ho-chargedUntil">Carregamentos feitos até (dia)</Label><Input id="ho-chargedUntil" type="date" value={f.chargedUntilDate} onChange={(e) => setF({ ...f, chargedUntilDate: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <YesNo label="Fecho de caixa no cofre" value={f.cashClosedInSafe} onChange={(v) => setF({ ...f, cashClosedInSafe: v })} />
            <YesNo label="Caixa de check-out feita" value={f.checkoutCashDone} onChange={(v) => setF({ ...f, checkoutCashDone: v })} />
          </div>

          {/* Valores */}
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Valores</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {NumInput({ k: "frontPouchValue", label: "Valor bolsa do front (€)", decimal: true })}
            {cityFields.terminalPouch && NumInput({ k: "terminalPouchValue", label: "Valor bolsa terminal (€)", decimal: true })}
          </div>
          {/* 29d: as despesas do turno lançam-se aqui, uma a uma, com o talão — entram nas Despesas e abatem à caixa do dia.
              O total vai para "Tickets/despesas pagos" da passagem. */}
          <ShiftExpensesCard date={date} shift={shift} city={city} canEdit={canEdit}
            onTotal={(t) => setF((prev) => (t > 0 && prev.ticketsExpensesPaid !== String(t) ? { ...prev, ticketsExpensesPaid: String(t) } : prev))} />

          {/* Material */}
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Material</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <YesNo label="Material OK? (canetas, rolos, bateria MB)" value={materialOk} onChange={(v) => { setMaterialOk(v); if (v) setMaterialExc([]); }} />
            <YesNo label="PDAs carregados a 100%" value={f.pdasCharged} onChange={(v) => setF({ ...f, pdasCharged: v })} />
          </div>
          {materialOk === false && (
            <div className="border rounded-lg p-2.5 space-y-1.5">
              <p className="text-xs text-muted-foreground">O que falta / está mal?</p>
              {materialExceptionsFor(city).map((code) => {
                const cur = materialExc.find((x) => x.code === code);
                return (
                  <div key={code} className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-sm min-w-0 sm:min-w-[14rem]">
                      <Checkbox
                        checked={!!cur}
                        onCheckedChange={(v) => setMaterialExc((l) => (v ? [...l, { code: code as MaterialException, note: null }] : l.filter((x) => x.code !== code)))}
                      />
                      {MATERIAL_EXCEPTION_LABELS[code]}
                    </label>
                    {cur && (
                      <Input className="h-8 flex-1 min-w-[10rem]" maxLength={200} placeholder="detalhe (opcional)" aria-label={`Detalhe: ${MATERIAL_EXCEPTION_LABELS[code]}`} value={cur.note ?? ""}
                        onChange={(e) => setMaterialExc((l) => l.map((x) => (x.code === code ? { ...x, note: e.target.value } : x)))} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <details className="border rounded-lg">
            <summary className="px-3 py-2 text-xs text-muted-foreground cursor-pointer select-none">Contagens detalhadas (opcional)</summary>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 pt-0">
              {NumInput({ k: "mbRolls", label: "Rolos de MB" })}
              {cityFields.terminalPouch && NumInput({ k: "mbRollsInPouch", label: "Rolos MB na bolsa do terminal" })}
              {cityFields.terminalPouch && NumInput({ k: "pensInPouch", label: "Canetas na bolsa do terminal" })}
              {NumInput({ k: "mbBattery", label: "Bateria do MB (%)" })}
            </div>
          </details>

          {/* Fardamento — peças com quantidade e tamanho (Jorge, 2026-09-09) */}
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fardamento</p>
          <ClothingEditor rows={clothing} onChange={setClothing} />
          {loaded?.uniformsCount != null && clothing.length === 0 && (
            <p className="text-xs text-muted-foreground">Registo antigo: {loaded.uniformsCount} farda(s) (sem tamanhos). Adiciona as peças acima para detalhar.</p>
          )}

          {/* Notas */}
          <div>
            <Label className="text-xs" htmlFor="ho-notes">Observações / notas</Label>
            <Textarea id="ho-notes" rows={3} maxLength={2000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Tudo o que o turno seguinte precisa de saber… (linhas começadas por '- ' passam a pendentes)" />
          </div>

          {/* Pendentes que passam de turno */}
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Pendentes para o turno seguinte</p>
          <OpenItemsEditor items={openItems} onChange={setOpenItems} currentSince={since} />

          <AiSummaryBox
            text={aiText}
            available={canEdit && !lockedOld}
            pending={ai.isPending}
            onGenerate={() => ai.mutate({ date, shift, city, notes: f.notes || null, openItems })}
          />

          {canEdit && (
            <Button
              className="w-full gap-2"
              disabled={save.isPending || !!blockedReason}
              title={blockedReason}
              onClick={() => save.mutate({
                handoverDate: date, shift, city,
                expectedVersion: loadedVersion,
                carsForCovered: numVal("carsForCovered"),
                chargedUntilDate: f.chargedUntilDate || null,
                cashClosedInSafe: f.cashClosedInSafe,
                checkoutCashDone: f.checkoutCashDone,
                frontPouchValue: numVal("frontPouchValue"),
                terminalPouchValue: numVal("terminalPouchValue"),
                ticketsExpensesPaid: numVal("ticketsExpensesPaid"),
                mbRolls: numVal("mbRolls"),
                mbRollsInPouch: numVal("mbRollsInPouch"),
                pensInPouch: numVal("pensInPouch"),
                mbBattery: numVal("mbBattery"),
                pdasCharged: f.pdasCharged,
                materialOk,
                materialExceptions: materialOk === false ? materialExc.map((x) => ({ code: x.code, note: x.note?.trim() || null })) : [],
                clothingItems: draftRowsToItems(clothing),
                notes: f.notes || null,
                openItems: withNoteItems(openItems, f.notes, since),
              })}
            >
              {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {loaded ? "Atualizar passagem de turno" : "Guardar passagem de turno"}
            </Button>
          )}
          {canEdit && blockedReason && !loading && <p className="text-[11px] text-muted-foreground text-center -mt-2">{blockedReason}</p>}
        </fieldset>
      </CardContent>
    </Card>
  );
}

// ─── FARDAMENTO (peças + tamanhos) ──────────────────────────────────────────
interface ClothingDraftRow { key: number; type: ClothingType; size: ClothingSize; qty: string }
let clothingRowSeq = 0;
const toDraftRow = (it: ClothingItem): ClothingDraftRow => ({ key: ++clothingRowSeq, type: it.type, size: it.size, qty: String(it.qty) });
const newDraftRow = (): ClothingDraftRow => ({ key: ++clothingRowSeq, type: "casaco", size: "M", qty: "1" });
const rowQty = (r: ClothingDraftRow) => (/^\s*\d+\s*$/.test(r.qty) ? parseInt(r.qty, 10) : NaN);
const isValidQty = (r: ClothingDraftRow) => rowQty(r) >= 1 && rowQty(r) <= CLOTHING_MAX_QTY;
const hasIncompleteClothingRow = (rows: ClothingDraftRow[]) => rows.some((r) => !isValidQty(r));
/** Linhas válidas → itens para gravar; sem linhas → `[]` (limpa o que estava). */
const draftRowsToItems = (rows: ClothingDraftRow[]): ClothingItem[] =>
  rows.filter(isValidQty).map((r) => ({ type: r.type, size: r.size, qty: rowQty(r) }));
const typeLabel = (t: ClothingType) => CLOTHING_LABELS[t].one.charAt(0).toUpperCase() + CLOTHING_LABELS[t].one.slice(1);
/** Histórico: resumo das peças; registos antigos só têm o número de fardas. */
const clothingCell = (h: any): string => {
  const items = (h.clothingItems ?? []) as ClothingItem[];
  if (items.length) return summarizeClothingItems(items);
  return h.uniformsCount != null ? `${h.uniformsCount} farda(s)` : "";
};

function ClothingEditor({ rows, onChange }: { rows: ClothingDraftRow[]; onChange: (rows: ClothingDraftRow[]) => void }) {
  const update = (key: number, patch: Partial<ClothingDraftRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: number) => onChange(rows.filter((r) => r.key !== key));
  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-xs text-muted-foreground">Sem peças registadas neste turno.</p>}
      {rows.map((r) => {
        const bad = !isValidQty(r);
        return (
          <div key={r.key} className="grid grid-cols-[1fr_1fr_5rem_auto] gap-2 items-end">
            <div>
              <Label className="text-xs">Peça</Label>
              <Select value={r.type} onValueChange={(v) => update(r.key, { type: v as ClothingType })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLOTHING_TYPES.map((t) => <SelectItem key={t} value={t}>{typeLabel(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Tamanho</Label>
              <Select value={r.size} onValueChange={(v) => update(r.key, { size: v as ClothingSize })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLOTHING_SIZES.map((sz) => <SelectItem key={sz} value={sz}>{sz}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Qtd.</Label>
              <Input type="text" inputMode="numeric" className={`h-9${bad ? " border-red-400" : ""}`} value={r.qty} onChange={(e) => update(r.key, { qty: e.target.value })} aria-invalid={bad} title={bad ? `Quantidade entre 1 e ${CLOTHING_MAX_QTY}` : undefined} />
            </div>
            <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label="Remover peça" onClick={() => remove(r.key)}>
              <Trash2 className="w-4 h-4 text-muted-foreground" />
            </Button>
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button type="button" variant="outline" size="sm" disabled={rows.length >= CLOTHING_MAX_ITEMS} onClick={() => onChange([...rows, newDraftRow()])}>
          <Plus className="w-4 h-4 mr-1" />Adicionar peça
        </Button>
        {rows.length > 0 && !hasIncompleteClothingRow(rows) && (
          <span className="text-xs text-muted-foreground">{summarizeClothingItems(draftRowsToItems(rows))}</span>
        )}
      </div>
    </div>
  );
}

// ─── HISTÓRICO ───────────────────────────────────────────────────────────────
function HandoverHistory({ cityState, userId, canEdit }: { cityState: CityState; userId: number | null; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const ack = trpc.shiftHandover.ack.useMutation({
    onSuccess: async () => { toast.success("Passagem confirmada (Recebi)"); await utils.shiftHandover.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const { city, allowed, setCity } = cityState;
  const [days, setDays] = useState(14);
  // Dias de Lisboa (não o relógio/UTC do browser)
  const from = addDays(lisbonDayOf(Date.now()), -days);
  const listQ = trpc.shiftHandover.list.useQuery({ from, city });
  const data = listQ.data ?? [];
  const YN = ({ v }: { v: any }) => v == null ? <span className="text-muted-foreground">—</span> : v ? <CheckCircle2 className="w-4 h-4 text-green-600 inline" aria-label="Sim" /> : <XCircle className="w-4 h-4 text-red-600 inline" aria-label="Não" />;
  // "Recebi": quem pode preencher, e nunca quem entregou ou editou essa passagem.
  const canAck = (h: any) => canEdit && userId != null && h.createdById !== userId && h.filledById !== userId;
  const openOf = (h: any) => ((h.openItems ?? []) as OpenItem[]).filter(isHandoverItem);
  const author = (h: any) => (
    <>{h.createdByName ?? h.filledByName ?? "—"}{h.filledByName && h.createdByName && h.filledByName !== h.createdByName ? <span className="text-muted-foreground"> (editado por {h.filledByName})</span> : null}</>
  );
  const ackCell = (h: any, size: "sm" | "card") => h.ackAt
    ? <span className="text-emerald-700" title={String(h.ackAt)}>✓ {size === "card" ? "Recebida por " : ""}{h.ackByName ?? "?"}</span>
    : canAck(h)
      ? <Button type="button" size="sm" variant="outline" className="h-7" disabled={ack.isPending} onClick={() => ack.mutate({ id: h.id, city: h.city })}>Recebi</Button>
      : <span className="text-muted-foreground">{size === "card" ? "Por receber" : "—"}</span>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <CitySelect city={city} allowed={allowed} onChange={setCity} />
        <Label className="text-xs">Últimos</Label>
        <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v))}>
          <SelectTrigger className="w-28 h-8" aria-label="Período"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[7, 14, 30, 60].map((n) => <SelectItem key={n} value={String(n)}>{n} dias</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {listQ.isLoading ? <p className="text-sm text-muted-foreground">A carregar…</p> : listQ.isError ? (
        <QueryErrorNote error={listQ.error} onRetry={() => listQ.refetch()} retrying={listQ.isFetching} what="o histórico de passagens" />
      ) : data.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Sem passagens de turno registadas neste período</CardContent></Card>
      ) : (
        <>
          {/* Telemóvel: um cartão por passagem (a tabela tem 16 colunas). */}
          <div className="md:hidden space-y-2">
            {data.map((h: any) => {
              const items = openOf(h);
              const open = items.filter((i) => !i.resolved);
              return (
                <Card key={h.id}>
                  <CardContent className="p-3 space-y-1.5 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium">{fmtPTDate(h.handoverDate)} · {h.shift === "morning" ? "☀️ Manhã" : "🌙 Noite"} · {CITY_LABELS[h.city] ?? h.city}</p>
                      <div className="shrink-0 text-xs">{ackCell(h, "card")}</div>
                    </div>
                    <p className="text-xs text-muted-foreground">Por {author(h)}</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <span>Cofre <YN v={h.cashClosedInSafe} /></span>
                      <span>Caixa check-out <YN v={h.checkoutCashDone} /></span>
                      <span>Bolsa front: {h.frontPouchValue != null ? `${Number(h.frontPouchValue).toFixed(2).replace(".", ",")} €` : "—"}</span>
                      <span>PDAs 100% <YN v={h.pdasCharged} /></span>
                      {h.carsForCovered != null && <span>Toldo: {h.carsForCovered}</span>}
                      {clothingCell(h) && <span className="col-span-2 break-words">Fardamento: {clothingCell(h)}</span>}
                    </div>
                    {items.length > 0 && <p className={`text-xs ${open.length ? "text-amber-700" : "text-muted-foreground"}`}>Pendentes: {open.length} abertos / {items.length}</p>}
                    {(h.notes || h.aiSummary) && <p className="text-xs text-muted-foreground whitespace-pre-line line-clamp-3">{h.notes ?? h.aiSummary}</p>}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="p-2">Dia</th>
                  <th className="p-2">Turno</th>
                  <th className="p-2">Cidade</th>
                  <th className="p-2 text-right">Toldo</th>
                  <th className="p-2 text-center">Cofre</th>
                  <th className="p-2 text-center">Caixa de check-out</th>
                  <th className="p-2 text-right">Bolsa front</th>
                  <th className="p-2 text-right">Bolsa term.</th>
                  <th className="p-2 text-right">Rolos</th>
                  <th className="p-2 text-right">Bat. MB</th>
                  <th className="p-2 text-center">PDAs 100%</th>
                  <th className="p-2">Fardamento</th>
                  <th className="p-2">Preenchido por</th>
                  <th className="p-2">Notas</th>
                  <th className="p-2">Pendentes</th>
                  <th className="p-2">Recebida</th>
                </tr>
              </thead>
              <tbody>
                {data.map((h: any) => (
                  <tr key={h.id} className="border-b hover:bg-muted/30">
                    <td className="p-2 font-mono text-xs">{h.handoverDate}</td>
                    <td className="p-2">{h.shift === "morning" ? "☀️ Manhã" : "🌙 Noite"}</td>
                    <td className="p-2 text-xs">{CITY_LABELS[h.city] ?? h.city}</td>
                    <td className="p-2 text-right tabular-nums">{h.carsForCovered ?? "—"}</td>
                    <td className="p-2 text-center"><YN v={h.cashClosedInSafe} /></td>
                    <td className="p-2 text-center"><YN v={h.checkoutCashDone} /></td>
                    <td className="p-2 text-right tabular-nums">{h.frontPouchValue != null ? `${Number(h.frontPouchValue).toFixed(2)}€` : "—"}</td>
                    <td className="p-2 text-right tabular-nums">{h.terminalPouchValue != null ? `${Number(h.terminalPouchValue).toFixed(2)}€` : "—"}</td>
                    <td className="p-2 text-right tabular-nums">{h.mbRolls ?? "—"}{h.mbRollsInPouch != null ? ` (+${h.mbRollsInPouch})` : ""}</td>
                    <td className="p-2 text-right tabular-nums">{h.mbBattery != null ? `${h.mbBattery}%` : "—"}</td>
                    <td className="p-2 text-center"><YN v={h.pdasCharged} /></td>
                    <td className="p-2 text-xs max-w-[220px] truncate" title={clothingCell(h)}>{clothingCell(h) || "—"}</td>
                    <td className="p-2 text-xs">{author(h)}</td>
                    <td className="p-2 text-xs text-muted-foreground max-w-[200px] truncate" title={h.aiSummary ?? h.notes ?? ""}>{h.notes ?? (h.aiSummary ? "✨ resumo IA" : "—")}</td>
                    <td className="p-2 text-xs tabular-nums" title={openOf(h).filter((i) => !i.resolved).map((i) => i.text).join("\n")}>
                      {openOf(h).length ? `${openOf(h).filter((i) => !i.resolved).length} abertos / ${openOf(h).length}` : "—"}
                    </td>
                    <td className="p-2 text-xs">{ackCell(h, "sm")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── RESUMO DO DIA (supervisor+) ────────────────────────────────────────────
function SupervisorDashboard({ cityState }: { cityState: CityState }) {
  const { city, allowed, setCity } = cityState;
  // Dia operacional (03:00 → 03:00): de madrugada ainda é o dia anterior.
  const [date, setDate] = useState(() => operationalShift().date);
  const dashQ = trpc.shiftHandover.supervisorDashboard.useQuery({ date, city });
  const data = dashQ.data;
  // 44b: horas trabalhadas (ponto; sem ele, Zello ligado) e tempo parado (Zello ligado sem andar).
  const people = useMemo(() => ((data?.people ?? []) as any[]).map((p) => {
    const w = workedHours(p);
    return { ...p, workedH: w.hours, workedSrc: w.source, stoppedH: stoppedHours(p) };
  }), [data]);
  const peopleSort = useTableSort(people);
  const complianceQ = trpc.shiftHandover.compliance.useQuery({ date, city });

  // Pelo id do funcionário; só sem id se cai no nome (e na cidade).
  const shiftOf = (employeeId: number | null, name: string) => {
    const a = findPersonShift((data?.shifts ?? []) as any[], { employeeId, name }, city);
    return a ? (a.shift === "morning" ? "☀️" : "🌙") : "";
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2 flex-wrap">
        <div><Label className="text-xs mb-1 block">Dia</Label><UniDateNav date={date} onChange={setDate} /></div>
        <div><Label className="text-xs mb-1 block">Cidade</Label><CitySelect city={city} allowed={allowed} onChange={setCity} /></div>
        <p className="text-[11px] text-muted-foreground pb-2">Dia operacional: 03:00 → 03:00 do dia seguinte (inclui o turno da noite)</p>
      </div>
      {dashQ.isLoading ? <p className="text-sm text-muted-foreground">A carregar…</p> : dashQ.isError ? (
        <QueryErrorNote error={dashQ.error} onRetry={() => dashQ.refetch()} retrying={dashQ.isFetching} what="o resumo do dia" />
      ) : !data ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Base de dados indisponível — sem resumo do dia.</CardContent></Card>
      ) : (
        <>
          {data.timingsTruncated && (
            <p className="text-xs text-amber-700">Dia com movimentos a mais para ler de uma vez: os tempos de entrega e de recolha são só de uma parte do dia.</p>
          )}
          {/* KPIs do dia */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Card className="p-3"><p className="text-xs text-muted-foreground">Recolhas</p><p className="text-xl font-bold text-emerald-700">{data.totals.checkins}</p></Card>
            <Card className="p-3"><p className="text-xs text-muted-foreground">Entregas</p><p className="text-xl font-bold text-blue-700">{data.totals.checkouts}</p></Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />Pendente→Entrega</p>
              <p className="text-xl font-bold">{data.delivery.avgMins} min</p>
              <p className="text-[11px] text-muted-foreground">máx {data.delivery.maxMins} · {data.delivery.count} medidas</p>
            </Card>
            <Card className={`p-3 ${data.delivery.over30 > 0 ? "border-red-300 bg-red-50/50" : ""}`}>
              <p className="text-xs text-muted-foreground">Entregas &gt;15/&gt;30 min</p>
              <p className="text-xl font-bold"><span className="text-amber-700">{data.delivery.over15}</span> / <span className="text-red-700">{data.delivery.over30}</span></p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground">Recolhas atrasadas &gt;15min</p>
              <p className="text-xl font-bold text-amber-700">{data.pickup.over15}</p>
              <p className="text-[11px] text-muted-foreground">desvio médio {data.pickup.avgDelayMins} min</p>
            </Card>
            <Card className={`p-3 ${data.complaintsToday > 0 ? "border-amber-300 bg-amber-50/50" : ""}`}>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><AlertTriangle className="w-3 h-3" />Reclamações do dia</p>
              <p className="text-xl font-bold">{data.complaintsToday}</p>
            </Card>
          </div>

          {/* Cumprimento das passagens de turno */}
          {complianceQ.isError
            ? <QueryErrorNote error={complianceQ.error} onRetry={() => complianceQ.refetch()} retrying={complianceQ.isFetching} what="o cumprimento das passagens" />
            : <HandoverCompliance data={complianceQ.data} loading={complianceQ.isLoading} />}

          {/* Piores entregas */}
          {data.delivery.worst.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Entregas mais lentas do dia (pendente → entregue)</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {data.delivery.worst.map((w: any) => (
                  <Badge key={w.booking} variant="outline" className={`text-xs ${w.mins > 30 ? "border-red-300 text-red-700" : w.mins > 15 ? "border-amber-300 text-amber-700" : ""}`}>
                    {w.mins} min{w.agent ? ` · ${w.agent}` : ""}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Condutores do dia */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Quem trabalhou — {fmtPTDate(date)}</CardTitle>
              <p className="text-[11px] text-muted-foreground">Horas = as do ponto (com "~" quando não há picagens e é o tempo com o Zello ligado). Parado = com o Zello ligado mas sem andar.</p>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <Th k="name" label="Pessoa" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <th className="p-2">Turno</th>
                      <Th k="checkins" label="Recolhas" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="checkouts" label="Entregas" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="movements" label="Movs" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="totalActions" label="Total" align="right" className="font-bold" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="workedH" label="Horas" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="totalKm" label="Km" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                      <Th k="stoppedH" label="Parado" align="right" sortKey={peopleSort.sortKey} sortDir={peopleSort.sortDir} onToggle={peopleSort.toggle} />
                    </tr>
                  </thead>
                  <tbody>
                    {(peopleSort.sorted as any[]).map((p) => (
                      <tr key={p.key} className="border-b hover:bg-muted/30">
                        <td className="p-2 font-medium">{p.kind === "parceiro" ? "🤝 " : p.kind === "por_ligar" ? "⚠ " : ""}{p.name}</td>
                        <td className="p-2">{shiftOf(p.employeeId, p.name)}</td>
                        <td className="p-2 text-right text-emerald-700 tabular-nums">{p.checkins || ""}</td>
                        <td className="p-2 text-right text-blue-700 tabular-nums">{p.checkouts || ""}</td>
                        <td className="p-2 text-right tabular-nums">{p.movements || ""}</td>
                        <td className="p-2 text-right font-bold tabular-nums">{p.totalActions || ""}</td>
                        <td className="p-2 text-right tabular-nums" title={p.workedSrc === "zello" ? "Sem picagens: tempo com o Zello ligado" : p.workedSrc === "ponto" ? "Horas do ponto" : undefined}>
                          {fmtHours(p.workedH)}{p.workedSrc === "zello" ? <span className="text-muted-foreground"> ~</span> : null}
                        </td>
                        <td className="p-2 text-right tabular-nums">{p.totalKm > 0 ? `${p.totalKm} km` : "—"}</td>
                        <td className="p-2 text-right tabular-nums" title="Com o Zello ligado mas sem andar">{fmtHours(p.stoppedH)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Cumprimento das passagens (Resumo do dia) ──────────────────────────────
const COMPLIANCE_TONE: Record<ComplianceStatus, string> = {
  pending: "text-muted-foreground",
  missing: "border-red-300 text-red-700 bg-red-50/60",
  late: "border-amber-300 text-amber-700 bg-amber-50/60",
  on_time: "border-emerald-300 text-emerald-700",
  confirmed: "border-emerald-400 text-emerald-800 bg-emerald-50/60",
};

function HandoverCompliance({ data, loading }: {
  data: { day: Array<{ date: string; shift: HandoverShift; city: string; status: ComplianceStatus; late: boolean; ackByName: string | null; authorName: string | null; cashDiff: number | null; reminded: boolean }>; percent30: number | null; expected30: number } | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm">Passagens de turno</CardTitle>
          {data?.percent30 != null && (
            <Badge variant="outline" className={data.percent30 >= 90 ? "border-emerald-300 text-emerald-700" : data.percent30 >= 70 ? "border-amber-300 text-amber-700" : "border-red-300 text-red-700"}>
              {data.percent30}% a tempo nos últimos 30 dias ({data.expected30} turnos)
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? <p className="text-sm text-muted-foreground">A carregar…</p> : !data?.day.length ? (
          <p className="text-sm text-muted-foreground">Sem turnos escalados nem passagens neste dia.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.day.map((r) => (
              <div key={`${r.shift}-${r.city}`} className="border rounded-lg px-3 py-2 text-xs space-y-1 min-w-[12rem]">
                <p className="font-medium">{r.shift === "morning" ? "☀️ Manhã" : "🌙 Noite"} · {CITY_LABELS[r.city] ?? r.city}</p>
                <Badge variant="outline" className={COMPLIANCE_TONE[r.status]}>{COMPLIANCE_LABELS[r.status]}{r.status === "confirmed" && r.late ? " · entregue atrasada" : ""}</Badge>
                {r.authorName && <p className="text-muted-foreground">por {r.authorName}{r.ackByName ? ` · recebida por ${r.ackByName}` : ""}</p>}
                {r.cashDiff != null && <p className={r.cashDiff < 0 ? "text-red-700" : "text-amber-700"}>Caixa vs passagem anterior: {r.cashDiff > 0 ? "+" : ""}{r.cashDiff.toFixed(2).replace(".", ",")} €</p>}
                {r.reminded && <p className="text-muted-foreground">lembrete enviado</p>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
