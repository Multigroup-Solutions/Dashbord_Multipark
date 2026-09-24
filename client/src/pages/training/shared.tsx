import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { CheckCircle, XCircle } from "lucide-react";

export const ROLE_HIERARCHY: Record<string, number> = { user: 0, extra: 1, frontoffice: 2, backoffice: 3, team_leader: 4, supervisor: 5, admin: 6, super_admin: 7 };
export const atLeast = (role: string | undefined | null, min: string) => (ROLE_HIERARCHY[role ?? ""] ?? -1) >= (ROLE_HIERARCHY[min] ?? 0);

// ─── Níveis de carreira (estrutura do Jorge, 2026-08-05) ─────────────────────
export const CAREER_TRACKS: Array<{ key: string; label: string; color: string; barColor: string; levels: string[] }> = [
  { key: "condutor", label: "Condutor", color: "bg-blue-100 text-blue-800", barColor: "bg-blue-500", levels: ["condutor_1", "condutor_2", "condutor_3", "condutor_4"] },
  { key: "terminal", label: "Terminal", color: "bg-emerald-100 text-emerald-800", barColor: "bg-emerald-500", levels: ["terminal_1", "terminal_2", "terminal_3", "terminal_4"] },
  { key: "front", label: "Front", color: "bg-rose-100 text-rose-800", barColor: "bg-rose-500", levels: ["front_1", "front_2", "front_3", "front_4"] },
  { key: "chefia", label: "Chefia", color: "bg-purple-100 text-purple-800", barColor: "bg-purple-500", levels: ["team_leader", "supervisor"] },
];
export const CAREER_LEVEL_LABELS: Record<string, string> = {
  condutor_1: "Condutor N1", condutor_2: "Condutor N2", condutor_3: "Condutor N3", condutor_4: "Condutor N4",
  terminal_1: "Terminal N1", terminal_2: "Terminal N2", terminal_3: "Terminal N3", terminal_4: "Terminal N4",
  front_1: "Front N1", front_2: "Front N2", front_3: "Front N3", front_4: "Front N4",
  team_leader: "Team Leader", supervisor: "Supervisor",
  // legacy (exames antigos ainda não migrados mostram na mesma)
  extra: "Condutor N1", condutor: "Condutor N1", senior: "Condutor N3",
};
export const CAREER_LEVEL_COLORS: Record<string, string> = Object.fromEntries(CAREER_TRACKS.flatMap((t) => t.levels.map((l) => [l, t.color])));
export const ALL_CAREER_LEVELS = CAREER_TRACKS.flatMap((t) => t.levels);
export const CITY_OPTIONS = [{ id: "lisboa", label: "Lisboa" }, { id: "porto", label: "Porto" }, { id: "faro", label: "Faro" }] as const;
export const TARGET_ROLES = [
  { id: "extra", label: "Extra" }, { id: "condutor", label: "Condutor" }, { id: "terminal", label: "Terminal" },
  { id: "front", label: "Front" }, { id: "team_leader", label: "Team Leader" },
];
export const ITEM_TYPE_LABELS: Record<string, string> = { video: "Vídeo", manual: "Manual", exam: "Exame", quiz: "Quiz" };
export const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  assigned: { label: "Por começar", cls: "bg-slate-100 text-slate-700" },
  in_progress: { label: "Em curso", cls: "bg-blue-100 text-blue-800" },
  completed: { label: "Concluída", cls: "bg-green-100 text-green-800" },
  overdue: { label: "Em atraso", cls: "bg-red-100 text-red-700" },
};

// Converte URLs de YouTube/Vimeo em URL de embed — o vídeo abre DENTRO da app.
export function videoEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com") {
      const id = u.searchParams.get("v");
      if (id) return `https://www.youtube-nocookie.com/embed/${id}`;
      const shorts = u.pathname.match(/^\/shorts\/([\w-]+)/);
      if (shorts) return `https://www.youtube-nocookie.com/embed/${shorts[1]}`;
    }
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      if (id) return `https://www.youtube-nocookie.com/embed/${id}`;
    }
    if (host === "vimeo.com") {
      const id = u.pathname.match(/\/(\d+)/)?.[1];
      if (id) return `https://player.vimeo.com/video/${id}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ficheiro de vídeo direto (mp4/webm/mov) — tocável num <video> com eventos de progresso. */
export function isDirectVideo(url: string): boolean {
  return /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(url);
}

/** Abre o anexo de um manual por URL ASSINADA (pedida no clique). */
export function useOpenManualFile() {
  const utils = trpc.useUtils();
  return useCallback(async (manualId: number) => {
    // Abre já a janela (evita o bloqueador de pop-ups) e só depois navega.
    const w = window.open("about:blank", "_blank");
    try {
      const { url } = await utils.training.manualFileUrl.fetch({ id: manualId });
      if (!url) { w?.close(); toast.error("Este manual não tem ficheiro."); return; }
      if (w) w.location.href = url; else window.location.href = url;
    } catch (e: any) {
      w?.close();
      toast.error(e?.message ?? "Não foi possível abrir o ficheiro.");
    }
  }, [utils]);
}

/**
 * Upload de um anexo: multipart para /api/upload (autenticado); se o endpoint
 * não estiver disponível e o ficheiro for pequeno, cai no uploadManualFile
 * (base64 por tRPC).
 */
export function useUploadTrainingFile() {
  const uploadB64 = trpc.training.uploadManualFile.useMutation();
  return useCallback(async (file: File): Promise<{ url: string; key: string; fileName: string; mimeType: string }> => {
    if (file.size > 4 * 1024 * 1024) throw new Error("Ficheiro demasiado grande (máx 4MB)");
    const mimeType = file.type || "application/octet-stream";
    const fd = new FormData();
    fd.append("file", file);
    const resp = await fetch("/api/upload", { method: "POST", body: fd, credentials: "include" });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({} as any));
      if (data?.url) return { url: data.url, key: data.key, fileName: file.name, mimeType };
    }
    if (resp.status === 401) throw new Error("Sessão expirada — volta a entrar.");
    if (file.size <= 3 * 1024 * 1024) {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      return uploadB64.mutateAsync({ fileName: file.name, fileBase64: b64, mimeType });
    }
    throw new Error(`Upload falhou (HTTP ${resp.status})`);
  }, [uploadB64]);
}

// ─── Confirmação (AlertDialog) ─────────────────────────────────────────────

interface ConfirmOpts { title: string; description?: ReactNode; confirmLabel?: string; destructive?: boolean }

/** `const [confirm, confirmUi] = useConfirm(); if (await confirm({...})) …` */
export function useConfirm(): [(o: ConfirmOpts) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => { resolver.current = resolve; setOpts(o); }), []);
  const close = (v: boolean) => { resolver.current?.(v); resolver.current = null; setOpts(null); };
  const ui = (
    <AlertDialog open={!!opts} onOpenChange={(o) => { if (!o) close(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
          {opts?.description && <AlertDialogDescription asChild><div>{opts.description}</div></AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>Cancelar</AlertDialogCancel>
          <AlertDialogAction className={opts?.destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined} onClick={() => close(true)}>
            {opts?.confirmLabel ?? "Confirmar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return [confirm, ui];
}

// ─── Formulário de pergunta (quiz / exame) ─────────────────────────────────

export interface QuestionFormValue {
  question: string; optionA: string; optionB: string; optionC: string; optionD: string;
  correctOption: "A" | "B" | "C" | "D"; explanation: string; difficulty?: "easy" | "medium" | "hard"; points?: string;
}
export const emptyQuestion = (): QuestionFormValue => ({ question: "", optionA: "", optionB: "", optionC: "", optionD: "", correctOption: "A", explanation: "", difficulty: "medium", points: "10" });
export const questionFrom = (q: any): QuestionFormValue => ({
  question: q.question ?? "", optionA: q.optionA ?? "", optionB: q.optionB ?? "", optionC: q.optionC ?? "", optionD: q.optionD ?? "",
  correctOption: q.correctOption ?? "A", explanation: q.explanation ?? "", difficulty: q.difficulty ?? "medium", points: String(q.points ?? 10),
});

export function QuestionDialog({ open, onOpenChange, title, initial, withDifficulty, pending, onSave }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; initial: QuestionFormValue; withDifficulty?: boolean; pending?: boolean;
  onSave: (v: QuestionFormValue) => void;
}) {
  const [f, setF] = useState<QuestionFormValue>(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  if (initial !== lastInitial) { setLastInitial(initial); setF(initial); }
  const set = (k: keyof QuestionFormValue) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Pergunta</Label><Textarea rows={2} value={f.question} onChange={set("question")} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(["A", "B", "C", "D"] as const).map((k) => (
              <div key={k}><Label>Opção {k}</Label><Input value={f[`option${k}`]} onChange={set(`option${k}`)} /></div>
            ))}
          </div>
          <div className={`grid grid-cols-1 gap-3 ${withDifficulty ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            <div><Label>Resposta correta</Label>
              <Select value={f.correctOption} onValueChange={(v) => setF((p) => ({ ...p, correctOption: v as any }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["A", "B", "C", "D"].map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {withDifficulty && (
              <div><Label>Dificuldade</Label>
                <Select value={f.difficulty} onValueChange={(v) => setF((p) => ({ ...p, difficulty: v as any }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="easy">Fácil</SelectItem><SelectItem value="medium">Médio</SelectItem><SelectItem value="hard">Difícil</SelectItem></SelectContent>
                </Select>
              </div>
            )}
            <div><Label>Pontos</Label><Input type="number" value={f.points} onChange={set("points")} /></div>
          </div>
          <div><Label>Explicação (mostrada depois de submeter)</Label><Textarea value={f.explanation} onChange={set("explanation")} /></div>
          <Button className="w-full" disabled={pending || !f.question || !f.optionA || !f.optionB || !f.optionC || !f.optionD} onClick={() => onSave(f)}>Guardar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Revisão depois de submeter (correta/explicação) ───────────────────────

export function AnswerReview({ review }: { review: Array<{ questionId: number; question: string; options: Record<string, string>; yourAnswer: string | null; correctOption: string; correct: boolean; explanation: string | null }> }) {
  if (!review?.length) return null;
  return (
    <div className="space-y-3 text-left">
      <h3 className="font-semibold">Revisão das respostas</h3>
      {review.map((r, i) => (
        <div key={r.questionId} className={`rounded-lg border p-3 ${r.correct ? "border-green-200 bg-green-50/50" : "border-red-200 bg-red-50/50"}`}>
          <p className="font-medium text-sm flex items-start gap-2">
            {r.correct ? <CheckCircle className="w-4 h-4 text-green-600 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />}
            <span>{i + 1}. {r.question}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {r.yourAnswer ? (
              <Badge variant="outline" className={r.correct ? "border-green-400" : "border-red-400"}>A tua: {r.yourAnswer}. {r.options[r.yourAnswer]}</Badge>
            ) : <Badge variant="outline" className="border-red-400">Sem resposta</Badge>}
            {!r.correct && <Badge className="bg-green-100 text-green-800">Correta: {r.correctOption}. {r.options[r.correctOption]}</Badge>}
          </div>
          {r.explanation && <p className="mt-2 text-xs text-muted-foreground">{r.explanation}</p>}
        </div>
      ))}
    </div>
  );
}
