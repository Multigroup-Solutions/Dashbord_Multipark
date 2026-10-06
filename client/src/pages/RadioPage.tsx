import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { useAuth } from "@/_core/hooks/useAuth";
import { can, seesBeyondOwn } from "@shared/access";
import { retryTransient } from "@/lib/queryRetry";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Eye, Plus, Radio } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ZelloRadioSearch } from "@/components/radio/ZelloRadioSearch";

// Transcrições de rádio (Zello): saiu da "Actividade Diária" para um ecrã
// próprio (/radio) — o Jorge usa-o para rever comunicações. A lista respeita a
// cidade (do condutor ou, sem condutor, de quem transcreveu).
// 32a: separador "Gravações do Zello" — as mensagens vêm do histórico do Zello
// (intervalo / utilizador / canal), cruzadas com o GPS e a Multipark.
export default function RadioPage() {
  return (
    <Tabs defaultValue="zello" className="mt-4">
      <TabsList>
        <TabsTrigger value="zello">Gravações do Zello</TabsTrigger>
        <TabsTrigger value="transcricoes">Transcrições</TabsTrigger>
      </TabsList>
      <TabsContent value="zello" className="mt-4"><ZelloRadioSearch /></TabsContent>
      <TabsContent value="transcricoes"><RadioTab /></TabsContent>
    </Tabs>
  );
}

const PAGE = 50;

/** "1:05" a partir de segundos. */
const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function RadioTab() {
  const { user } = useAuth();
  // Transcrever chama a IA (custo real): a mesma permissão que o servidor exige.
  const canTranscribe = !!user && can(user as any, "radio", "edit") && seesBeyondOwn(user as any, "radio");
  const [showTranscribe, setShowTranscribe] = useState(false);
  // "Ver mais": páginas de 50, das mais recentes para as mais antigas.
  const q = trpc.operational.radio.list.useInfiniteQuery(
    { limit: PAGE },
    { retry: retryTransient, getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const items = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.items), [q.data]);

  return (
    <div className="space-y-4 mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground">Transcrições de comunicações rádio</p>
        {canTranscribe && <Button onClick={() => setShowTranscribe(true)}><Plus className="w-4 h-4 mr-1" />Nova Transcrição</Button>}
      </div>

      {q.error && !q.data ? (
        <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="as transcrições" />
      ) : q.isLoading ? (
        <p className="text-sm text-muted-foreground">A carregar…</p>
      ) : (
        <div className="grid gap-4">
          {items.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">Sem transcrições. Carrega um áudio para começar.</CardContent></Card>
          ) : items.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <Radio className="w-4 h-4 text-primary" aria-hidden />
                    <span className="text-sm text-muted-foreground">{fmtPTDateTime(t.createdAt)}</span>
                    {t.employeeId != null && (
                      <Badge variant="outline" className="whitespace-normal break-words text-left" title="Condutor">
                        Condutor: {t.employeeName ?? `ficha #${t.employeeId} (já não existe)`}
                      </Badge>
                    )}
                    {t.vehicleId != null && <Badge variant="secondary" title="Viatura">{t.vehiclePlate ?? `viatura #${t.vehicleId}`}</Badge>}
                    {t.duration != null && t.duration > 0 && <span className="text-xs text-muted-foreground">{fmtDuration(t.duration)}</span>}
                  </div>
                  {t.audioUrl && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={t.audioUrl} target="_blank" rel="noopener noreferrer"><Eye className="w-4 h-4 mr-1" aria-hidden />Áudio</a>
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t.createdById == null ? "Transcrição automática (API)" : `Transcrito por ${t.createdByName ?? `conta #${t.createdById}`}`}
                </p>
                {t.summary && <p className="text-sm font-medium bg-muted/50 p-2 rounded">{t.summary}</p>}
                {t.transcription && <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{t.transcription}</p>}
              </CardContent>
            </Card>
          ))}
          {q.error && q.data && (
            <QueryErrorNote error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} what="mais transcrições" />
          )}
          {q.hasNextPage && (
            <Button variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? "A carregar…" : `Ver mais (estão ${items.length} à vista)`}
            </Button>
          )}
        </div>
      )}

      {showTranscribe && <TranscribeDialog onClose={() => setShowTranscribe(false)} />}
    </div>
  );
}

/** Duração do áudio (segundos) lida pelo browser; null se não der. */
function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    let url = "";
    let settled = false;
    try {
      url = URL.createObjectURL(file);
      const a = new Audio();
      const done = (v: number | null) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(v); };
      a.preload = "metadata";
      a.onloadedmetadata = () => done(Number.isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration) : null);
      a.onerror = () => done(null);
      setTimeout(() => done(null), 5000);
      a.src = url;
    } catch {
      if (url) URL.revokeObjectURL(url);
      resolve(null);
    }
  });
}

function TranscribeDialog({ onClose }: { onClose: () => void }) {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [uploading, setUploading] = useState(false);
  const utils = trpc.useUtils();
  // Só colaboradores ativos; a viatura só aparece se houver viaturas registadas.
  const { data: employees = [] } = trpc.rh.list.useQuery({ isActive: true }, { retry: retryTransient });
  const { data: vehiclesList = [] } = trpc.operational.vehicles.list.useQuery(undefined, { retry: false });
  const people = useMemo(
    () => (employees as any[]).map((e) => e.employee ?? e).sort((a, b) => String(a.fullName).localeCompare(String(b.fullName), "pt")),
    [employees],
  );
  const transcribeMut = trpc.operational.radio.transcribe.useMutation({
    onSuccess: () => { utils.operational.radio.list.invalidate(); toast.success("Transcrição concluída!"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = async () => {
    if (!audioFile) return;
    setUploading(true);
    try {
      const duration = await readAudioDuration(audioFile);
      const formData = new FormData();
      formData.append("file", audioFile);
      const resp = await fetch("/api/upload", { method: "POST", body: formData });
      if (!resp.ok) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${resp.status}`);
      }
      const { url } = await resp.json();
      if (!url) throw new Error("o envio não devolveu o ficheiro");
      transcribeMut.mutate({
        audioUrl: url,
        employeeId: employeeId && employeeId !== "none" ? Number(employeeId) : undefined,
        vehicleId: vehicleId && vehicleId !== "none" ? Number(vehicleId) : undefined,
        duration: duration ?? undefined,
      });
    } catch (e: any) {
      toast.error(`Erro ao carregar o áudio: ${e?.message ?? "falhou"}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Transcrever Áudio de Rádio</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="radio-audio">Ficheiro Áudio *</Label>
            <Input id="radio-audio" type="file" accept="audio/*,.webm,.mp3,.wav,.ogg,.m4a" onChange={e => setAudioFile(e.target.files?.[0] || null)} />
            <p className="text-xs text-muted-foreground mt-1">Até 4 MB.</p>
          </div>
          <div><Label>Condutor</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Sem condutor</SelectItem>
                {people.map((e: any) => <SelectItem key={e.id} value={String(e.id)}>{e.fullName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {(vehiclesList as any[]).length > 0 && (
            <div><Label>Viatura</Label>
              <Select value={vehicleId} onValueChange={setVehicleId}>
                <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sem viatura</SelectItem>
                  {(vehiclesList as any[]).map((v: any) => <SelectItem key={v.id} value={String(v.id)}>{v.plate} - {v.brand} {v.model}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!audioFile || uploading || transcribeMut.isPending} onClick={handleSubmit}>
            {uploading || transcribeMut.isPending ? "A processar..." : "Transcrever"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
