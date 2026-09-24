import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { fmtPTDateTime } from "@/lib/lisbonTime";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Eye, Plus, Radio } from "lucide-react";

// Transcrições de rádio (Zello): saiu da "Actividade Diária" para um ecrã
// próprio (/radio) — o Jorge usa-o para rever comunicações. A lista respeita a
// cidade (do condutor ou, sem condutor, de quem transcreveu).
export default function RadioPage() {
  return (
    <div className="p-6">
      <RadioTab />
    </div>
  );
}

function RadioTab() {
  const { user } = useAuth();
  // Transcrever chama a IA (custo real): o servidor exige team_leader+.
  const canTranscribe = ["team_leader", "supervisor", "admin", "super_admin"].includes(String(user?.role ?? ""));
  const [showTranscribe, setShowTranscribe] = useState(false);
  const { data: transcriptions } = trpc.operational.radio.list.useQuery();
  const { data: employees } = trpc.rh.list.useQuery();
  const { data: vehiclesList } = trpc.operational.vehicles.list.useQuery();

  const empMap = useMemo(() => {
    const m = new Map<number, string>();
    (employees || []).forEach((e: any) => m.set(e.employee.id, e.employee.fullName));
    return m;
  }, [employees]);
  const vehMap = useMemo(() => {
    const m = new Map<number, string>();
    (vehiclesList || []).forEach((v: any) => m.set(v.id, v.plate));
    return m;
  }, [vehiclesList]);

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground">Transcrições de comunicações rádio</p>
        {canTranscribe && <Button onClick={() => setShowTranscribe(true)}><Plus className="w-4 h-4 mr-1" />Nova Transcrição</Button>}
      </div>

      <div className="grid gap-4">
        {(!transcriptions || transcriptions.length === 0) ? (
          <Card><CardContent className="py-8 text-center text-muted-foreground">Sem transcrições. Carrega um áudio para começar.</CardContent></Card>
        ) : transcriptions.map((t: any) => (
          <Card key={t.id}>
            <CardContent className="p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Radio className="w-4 h-4 text-primary" />
                  <span className="text-sm text-muted-foreground">{fmtPTDateTime(t.createdAt)}</span>
                  {t.employeeId && <Badge variant="outline">{empMap.get(t.employeeId) || `#${t.employeeId}`}</Badge>}
                  {t.vehicleId && <Badge variant="secondary">{vehMap.get(t.vehicleId) || `#${t.vehicleId}`}</Badge>}
                  {t.duration && <span className="text-xs text-muted-foreground">{Math.floor(t.duration / 60)}:{String(t.duration % 60).padStart(2, "0")}</span>}
                </div>
                {t.audioUrl && <a href={t.audioUrl} target="_blank" rel="noopener"><Button size="sm" variant="outline"><Eye className="w-4 h-4 mr-1" />Áudio</Button></a>}
              </div>
              {t.summary && <p className="text-sm font-medium bg-muted/50 p-2 rounded">{t.summary}</p>}
              {t.transcription && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{t.transcription}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {showTranscribe && <TranscribeDialog employees={employees || []} vehicles={vehiclesList || []} onClose={() => setShowTranscribe(false)} />}
    </div>
  );
}

function TranscribeDialog({ employees, vehicles, onClose }: { employees: any[]; vehicles: any[]; onClose: () => void }) {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [uploading, setUploading] = useState(false);
  const utils = trpc.useUtils();
  const transcribeMut = trpc.operational.radio.transcribe.useMutation({
    onSuccess: () => { utils.operational.radio.list.invalidate(); toast.success("Transcrição concluída!"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = async () => {
    if (!audioFile) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", audioFile);
      const resp = await fetch("/api/upload", { method: "POST", body: formData });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { url } = await resp.json();
      if (!url) throw new Error("upload sem URL");
      transcribeMut.mutate({
        audioUrl: url,
        employeeId: employeeId && employeeId !== "none" ? Number(employeeId) : undefined,
        vehicleId: vehicleId && vehicleId !== "none" ? Number(vehicleId) : undefined,
        duration: undefined,
      });
    } catch {
      toast.error("Erro ao carregar áudio");
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
            <Label>Ficheiro Áudio *</Label>
            <Input type="file" accept="audio/*,.webm,.mp3,.wav,.ogg,.m4a" onChange={e => setAudioFile(e.target.files?.[0] || null)} />
          </div>
          <div><Label>Condutor</Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">N/A</SelectItem>
                {employees.map((e: any) => <SelectItem key={e.employee.id} value={String(e.employee.id)}>{e.employee.fullName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Viatura</Label>
            <Select value={vehicleId} onValueChange={setVehicleId}>
              <SelectTrigger><SelectValue placeholder="Opcional" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">N/A</SelectItem>
                {vehicles.map((v: any) => <SelectItem key={v.id} value={String(v.id)}>{v.plate} - {v.brand} {v.model}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
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
