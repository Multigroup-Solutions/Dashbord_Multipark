/**
 * Recrutamento — emails recebidos em recursos-humanos@.
 *
 * Extraído do HRPage (aba Recrutamento) e partilhado: rende no RH e no hub de
 * gestão da página Disponibilidade. Melhorias sobre a versão original (que só
 * permitia responder): abrir o email completo, ver/descarregar anexos
 * recebidos, notas internas por candidato e anexos na resposta.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Mail, Users, Phone, Calendar, Paperclip, StickyNote, X, Loader2, Eye } from "lucide-react";
import { toast } from "sonner";

type InboundAttachment = { filename?: string; contentType?: string; size?: number; url?: string };
type ReplyAttachment = { filename: string; url: string };

function parseAttachments(json: string | null | undefined): InboundAttachment[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function fmtSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function RecruitmentSection() {
  const { data: emails = [], isLoading, refetch } = trpc.rh.recruitmentEmails.useQuery();
  const [detail, setDetail] = useState<any | null>(null);
  const [replyFor, setReplyFor] = useState<any | null>(null);
  const [replyTo, setReplyTo] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [includeLink, setIncludeLink] = useState(true);
  const [replyFiles, setReplyFiles] = useState<ReplyAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");

  const reply = trpc.rh.replyRecruitment.useMutation({
    onSuccess: (r: any) => {
      toast.success(r?.inviteLink ? "Resposta enviada com link de registo" : "Resposta enviada");
      setReplyFor(null);
      setReplyBody("");
      setReplyFiles([]);
    },
    onError: (e) => toast.error(e.message || "Falha ao enviar"),
  });

  const saveNotes = trpc.rh.setRecruitmentNotes.useMutation({
    onSuccess: () => {
      toast.success("Notas guardadas");
      refetch();
    },
    onError: (e) => toast.error(e.message || "Falha ao guardar notas"),
  });

  const sync = trpc.admin.runEmailInbound.useMutation({
    onSuccess: (r: any) => {
      if (!r.configured) toast.error("IMAP não configurado no servidor");
      else toast.success(`Sincronização: ${r.created} criados, ${r.skipped} ignorados`);
      refetch();
    },
    onError: (e) => toast.error(e.message || "Falha na sincronização"),
  });

  const openDetail = (e: any) => {
    setDetail(e);
    setNotesDraft(e.notes ?? "");
  };

  const openReply = (e: any) => {
    setReplyFor(e);
    setReplyTo(e.clientEmail || e.fromEmail || "");
    setReplySubject(`Re: ${e.subject || "Candidatura"}`);
    setReplyBody("");
    setIncludeLink(true);
    setReplyFiles([]);
  };

  const handleReplyFiles = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = "";
    if (!files.length) return;
    if (replyFiles.length + files.length > 5) {
      toast.error("Máximo 5 anexos por resposta");
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 4 * 1024 * 1024) {
          toast.error(`"${file.name}" excede 4 MB (limite do servidor)`);
          continue;
        }
        const fd = new FormData();
        fd.append("file", file, file.name);
        const resp = await fetch("/api/upload", { method: "POST", body: fd });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const { url, error } = await resp.json();
        if (!url) throw new Error(error || "sem URL");
        setReplyFiles((prev) => [...prev, { filename: file.name, url }]);
      }
    } catch (err: any) {
      toast.error(`Erro ao carregar anexo: ${err?.message ?? "falha"}`);
    } finally {
      setUploading(false);
    }
  };

  if (isLoading) return <div className="text-center py-12 text-muted-foreground">A carregar emails de recrutamento...</div>;
  if (!emails.length)
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Mail className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p>Sem emails de recrutamento.</p>
        <p className="text-xs mt-1">Reencaminha um email para <b>recursos-humanos@multipark.pt</b> e aparece aqui.</p>
        <Button className="mt-4" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <Mail className="w-4 h-4 mr-2" />{sync.isPending ? "A sincronizar…" : "Sincronizar emails agora"}
        </Button>
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{emails.length} email(s) recebido(s)</p>
        <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <Mail className="w-4 h-4 mr-2" />{sync.isPending ? "A sincronizar…" : "Sincronizar emails"}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {emails.map((e: any) => {
          const atts = parseAttachments(e.attachmentsJson);
          return (
            <Card key={e.id} className="cursor-pointer hover:bg-accent/40 transition-colors" onClick={() => openDetail(e)}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{e.subject || "(sem assunto)"}</span>
                      {e.taskId ? <Badge variant="secondary">Tarefa #{e.taskId}</Badge> : null}
                      {atts.length > 0 && (
                        <Badge variant="outline" className="gap-1"><Paperclip className="w-3 h-3" />{atts.length}</Badge>
                      )}
                      {e.notes && (
                        <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700"><StickyNote className="w-3 h-3" />notas</Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
                      <span className="flex items-center gap-1"><Users className="w-3 h-3" />{e.clientName || e.fromName || "Desconhecido"}</span>
                      {(e.clientEmail || e.fromEmail) && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{e.clientEmail || e.fromEmail}</span>}
                      {e.clientPhone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{e.clientPhone}</span>}
                      {e.receivedAt && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{String(e.receivedAt).slice(0, 16)}</span>}
                    </div>
                    {e.bodyText && <p className="text-sm mt-2 line-clamp-2 text-muted-foreground whitespace-pre-wrap">{e.bodyText.slice(0, 300)}</p>}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <Button size="sm" variant="outline" onClick={(ev) => { ev.stopPropagation(); openDetail(e); }}>
                      <Eye className="w-4 h-4 mr-1" />Abrir
                    </Button>
                    <Button size="sm" onClick={(ev) => { ev.stopPropagation(); openReply(e); }} disabled={!(e.clientEmail || e.fromEmail)}>
                      <Mail className="w-4 h-4 mr-1" />Responder
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Detalhe: email completo + anexos + notas ── */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="pr-6">{detail?.subject || "(sem assunto)"}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1"><Users className="w-3 h-3" />{detail.clientName || detail.fromName || "Desconhecido"}</span>
                {(detail.clientEmail || detail.fromEmail) && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{detail.clientEmail || detail.fromEmail}</span>}
                {detail.clientPhone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{detail.clientPhone}</span>}
                {detail.receivedAt && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{String(detail.receivedAt).slice(0, 16)}</span>}
              </div>

              {(() => {
                const atts = parseAttachments(detail.attachmentsJson);
                if (!atts.length) return null;
                return (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Anexos recebidos</Label>
                    <div className="flex flex-wrap gap-2">
                      {atts.map((a, i) =>
                        a.url ? (
                          <a key={i} href={a.url} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-sm border rounded-md px-2 py-1 hover:bg-accent">
                            <Paperclip className="w-3 h-3" />{a.filename || "anexo"}{a.size ? ` (${fmtSize(a.size)})` : ""}
                          </a>
                        ) : (
                          <span key={i} className="inline-flex items-center gap-1 text-sm border rounded-md px-2 py-1 text-muted-foreground" title="Email antigo — o ficheiro não foi guardado na altura da receção">
                            <Paperclip className="w-3 h-3" />{a.filename || "anexo"}{a.size ? ` (${fmtSize(a.size)})` : ""} · não guardado
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                );
              })()}

              <div className="border rounded-md p-3 bg-muted/30 text-sm whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                {detail.bodyText || "(sem corpo)"}
              </div>

              <div className="space-y-1">
                <Label className="flex items-center gap-1"><StickyNote className="w-4 h-4 text-amber-600" />Notas internas</Label>
                <textarea
                  className="w-full min-h-[80px] rounded-md border p-2 text-sm"
                  placeholder="Ex.: já liguei, tem carta desde 2020, disponível fins de semana…"
                  value={notesDraft}
                  onChange={(ev) => setNotesDraft(ev.target.value)}
                />
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" disabled={saveNotes.isPending || notesDraft === (detail.notes ?? "")}
                    onClick={() => saveNotes.mutate({ id: detail.id, notes: notesDraft })}>
                    {saveNotes.isPending ? "A guardar…" : "Guardar notas"}
                  </Button>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>Fechar</Button>
            <Button onClick={() => { const d = detail; setDetail(null); openReply(d); }} disabled={!(detail?.clientEmail || detail?.fromEmail)}>
              <Mail className="w-4 h-4 mr-2" />Responder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Resposta (com anexos) ── */}
      <Dialog open={!!replyFor} onOpenChange={(o) => !o && setReplyFor(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Responder candidatura</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Para</Label><Input value={replyTo} onChange={(ev) => setReplyTo(ev.target.value)} /></div>
            <div><Label>Assunto</Label><Input value={replySubject} onChange={(ev) => setReplySubject(ev.target.value)} /></div>
            <div>
              <Label>Mensagem</Label>
              <textarea className="w-full min-h-[160px] rounded-md border p-2 text-sm" value={replyBody}
                onChange={(ev) => setReplyBody(ev.target.value)} placeholder="Escreve a resposta…" />
            </div>
            <div className="space-y-1">
              <Label>Anexos (máx. 5, 4 MB cada)</Label>
              <div className="flex flex-wrap gap-2">
                {replyFiles.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 text-sm border rounded-md px-2 py-1">
                    <Paperclip className="w-3 h-3" />{f.filename}
                    <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => setReplyFiles((prev) => prev.filter((_, j) => j !== i))}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <label className="cursor-pointer">
                  <input type="file" multiple className="hidden" onChange={handleReplyFiles} />
                  <Button type="button" variant="outline" size="sm" asChild>
                    <span>{uploading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Paperclip className="w-4 h-4 mr-1" />}{uploading ? "A carregar…" : "Anexar ficheiro"}</span>
                  </Button>
                </label>
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={includeLink} onChange={(ev) => setIncludeLink(ev.target.checked)} />
              <span>
                Incluir <strong>link de registo</strong> — cria a conta do candidato e adiciona o link à mensagem
                (ele entra com o Google e fica utilizador).
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplyFor(null)}>Cancelar</Button>
            <Button
              onClick={() => reply.mutate({
                to: replyTo, subject: replySubject, body: replyBody, fromAlias: replyFor?.alias,
                includeRegisterLink: includeLink,
                candidateName: replyFor?.clientName || replyFor?.fromName || undefined,
                origin: window.location.origin,
                attachments: replyFiles.length ? replyFiles : undefined,
              })}
              disabled={reply.isPending || uploading || !replyTo || !replyBody}>
              <Mail className="w-4 h-4 mr-2" />{reply.isPending ? "A enviar…" : "Enviar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
