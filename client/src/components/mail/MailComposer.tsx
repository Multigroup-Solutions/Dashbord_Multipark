// Editor de email: responder / responder a todos / reencaminhar / novo.
// Envia pela API do Gmail como o alias certo ("Enviar como" verificado no
// servidor — erro claro se o alias não estiver configurado). Contactos do
// CRM ao escrever, assinatura por marca, anexos (via /api/upload) e rascunho IA.
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Loader2, Paperclip, Send, Sparkles, X } from "lucide-react";

export type ComposeMode = "reply" | "replyAll" | "forward" | "new";

export interface ComposeDefaults {
  fromOptions: string[];
  defaultFrom: string | null;
  replyTo: string[];
  replyAllCc: string[];
  subject: string;
  signature: string;
}

type Upload = { key: string; filename: string; contentType: string; size: number };

const splitList = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** Campo de destinatários com sugestões do CRM/conversas (lista separada por vírgulas). */
function RecipientsInput({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [focus, setFocus] = useState(false);
  const last = value.split(/[,;]/).pop()?.trim() ?? "";
  const q = trpc.mail.contacts.useQuery({ q: last }, { enabled: focus && last.length >= 2 && !last.includes(" "), staleTime: 30_000 });
  const pick = (email: string) => {
    const parts = value.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
    parts.pop();
    onChange([...parts, email].join(", ") + ", ");
  };
  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <Label className="text-xs w-10 shrink-0 text-muted-foreground">{label}</Label>
        <Input value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)} className="h-8 text-sm" placeholder="email@exemplo.pt" inputMode="email" />
      </div>
      {focus && (q.data?.length ?? 0) > 0 && (
        <div className="absolute z-50 left-12 right-0 mt-1 bg-popover border rounded-md shadow-md max-h-56 overflow-auto">
          {q.data!.map((c) => (
            <button key={c.email} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c.email)}
              className="w-full text-left px-2 py-1.5 text-xs hover:bg-accent">
              <span className="font-medium">{c.name ?? c.email}</span>
              {c.name && <span className="text-muted-foreground"> · {c.email}</span>}
              <span className="ml-1 text-[10px] text-muted-foreground">{c.source === "crm" ? "cliente" : "email"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MailComposer({
  mode, threadId, mailbox, defaults, onSent, onCancel, canAi,
}: {
  mode: ComposeMode;
  threadId?: number | null;
  /** Para "new": chave da caixa ou "me". */
  mailbox?: string | null;
  defaults: ComposeDefaults;
  onSent: (r: { threadId: number }) => void;
  onCancel: () => void;
  canAi?: boolean;
}) {
  const initialTo = mode === "reply" || mode === "replyAll" ? defaults.replyTo.join(", ") : "";
  const [from, setFrom] = useState(defaults.defaultFrom ?? defaults.fromOptions[0] ?? "");
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(mode === "replyAll" ? defaults.replyAllCc.join(", ") : "");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(mode === "replyAll" && defaults.replyAllCc.length > 0);
  const [subject, setSubject] = useState(mode === "new" ? "" : mode === "forward" ? `Fwd: ${defaults.subject.replace(/^\s*((re|fwd?|enc)\s*:\s*)+/i, "")}` : "");
  const sig = defaults.signature ? `\n\n--\n${defaults.signature}` : "";
  const [body, setBody] = useState(sig);
  const [files, setFiles] = useState<Upload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [includeOriginal, setIncludeOriginal] = useState(true);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setTimeout(() => { bodyRef.current?.focus(); bodyRef.current?.setSelectionRange(0, 0); }, 0); }, []);

  const send = trpc.mail.send.useMutation({
    onSuccess: (r) => { toast.success("Email enviado."); onSent(r); },
    onError: (e) => toast.error(e.message, { duration: 10_000 }),
  });
  const ai = trpc.mail.threads.aiDraft.useMutation({
    onSuccess: (r) => { setBody(`${r.text}${sig}`); toast.success("Rascunho da IA no editor — revê antes de enviar."); },
    onError: (e) => toast.error(e.message),
  });

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list).slice(0, 10)) {
        if (f.size > 4 * 1024 * 1024) { toast.error(`${f.name}: máximo 4 MB por ficheiro.`); continue; }
        const fd = new FormData();
        fd.append("file", f);
        const r = await fetch("/api/upload", { method: "POST", body: fd, credentials: "include" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.key) { toast.error(j.error || `Falha a carregar ${f.name}.`); continue; }
        setFiles((prev) => [...prev, { key: j.key, filename: f.name, contentType: f.type || "application/octet-stream", size: f.size }]);
      }
    } finally { setUploading(false); }
  }

  const title = useMemo(() => ({ reply: "Responder", replyAll: "Responder a todos", forward: "Reencaminhar", new: "Nova mensagem" }[mode]), [mode]);
  const canSend = !send.isPending && !uploading && splitList(`${to},${cc},${bcc}`).length > 0 && body.trim().length > 0 && (mode !== "new" || subject.trim().length > 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">{title}</div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCancel} aria-label="Fechar editor"><X className="h-4 w-4" /></Button>
      </div>
      {defaults.fromOptions.length > 0 && (
        <div className="flex items-center gap-2">
          <Label className="text-xs w-10 shrink-0 text-muted-foreground">De</Label>
          {defaults.fromOptions.length > 1 ? (
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>{defaults.fromOptions.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
            </Select>
          ) : <span className="text-sm">{from}</span>}
        </div>
      )}
      <RecipientsInput label="Para" value={to} onChange={setTo} autoFocus={mode === "new" || mode === "forward"} />
      {showCc ? (
        <>
          <RecipientsInput label="Cc" value={cc} onChange={setCc} />
          <RecipientsInput label="Bcc" value={bcc} onChange={setBcc} />
        </>
      ) : (
        <button type="button" className="text-xs text-primary ml-12" onClick={() => setShowCc(true)}>+ Cc/Bcc</button>
      )}
      {(mode === "new" || mode === "forward") && (
        <div className="flex items-center gap-2">
          <Label className="text-xs w-10 shrink-0 text-muted-foreground">Assunto</Label>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-8 text-sm" maxLength={300} />
        </div>
      )}
      <Textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="text-sm min-h-[160px]" placeholder="Escreve a mensagem…" />
      {mode === "forward" && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={includeOriginal} onCheckedChange={setIncludeOriginal} /> Incluir os anexos da mensagem original
        </label>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f.key} className="inline-flex items-center gap-1 text-xs border rounded px-1.5 py-0.5">
              <Paperclip className="h-3 w-3" />{f.filename}
              <button type="button" onClick={() => setFiles((p) => p.filter((x) => x.key !== f.key))} aria-label={`Remover ${f.filename}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!canSend} onClick={() => send.mutate({
          mode, threadId: threadId ?? null, mailbox: mailbox ?? null, from: from || null,
          to: splitList(to), cc: splitList(cc), bcc: splitList(bcc), subject: subject.trim() || null, body,
          attachments: files.map(({ key, filename, contentType }) => ({ key, filename, contentType })),
          includeOriginalAttachments: mode === "forward" ? includeOriginal : undefined,
        })}>
          {send.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}Enviar
        </Button>
        <label className="inline-flex">
          <input type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          <span className="inline-flex items-center h-8 px-2.5 text-xs border rounded-md cursor-pointer hover:bg-accent">
            {uploading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Paperclip className="h-3.5 w-3.5 mr-1" />}Anexar
          </span>
        </label>
        {canAi && threadId && mode !== "new" && mode !== "forward" && (
          <Button size="sm" variant="outline" disabled={ai.isPending} onClick={() => ai.mutate({ id: threadId })}>
            {ai.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}Rascunho IA
          </Button>
        )}
        {mode !== "new" && <span className="text-[11px] text-muted-foreground ml-auto">A mensagem anterior segue citada.</span>}
      </div>
    </div>
  );
}
