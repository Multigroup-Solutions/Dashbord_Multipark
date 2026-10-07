// Candidaturas do site ("Be a Driver") — saiu da ExtrasDiaPage para os Leads
// de Extras (P3 lote 17g-4).
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, CheckCircle2, ChevronDown, ChevronRight, RotateCcw, Users, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cityKeyFromText, matchCityKey } from "@shared/city";
import { QueryErrorNote } from "@/components/QueryErrorNote";
import { ContactAvatar } from "@/components/whatsapp/ContactAvatar";
import { ViewToggle } from "@/components/ViewToggle";
import { useViewPref } from "@/hooks/useViewPref";

// ─── Candidaturas de condutores vindas do website multidriver ────────────────
// Novas candidaturas do formulário "Be a Driver" chegam via /api/v1 e ficam
// aqui para revisão. Aprovar cria (ou liga a) um employee extra com o mesmo
// email — a partir daí o extra aparece nos candidatos e na disponibilidade.

const APP_STATUS: Record<string, { label: string; className: string }> = {
  new: { label: "Nova", className: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  reviewed: { label: "Pronta", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  approved: { label: "Aprovada", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  rejected: { label: "Rejeitada", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

// Rende nos Leads de Extras, junto dos leads e do recrutamento (Jorge, 2 out
// 2026: "fica tudo junto nas leads"). Antes vivia na Disponibilidade.
export function CandidaturasSection() {
  const [statusFilter, setStatusFilter] = useState<string>("new");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // D46: cartões ou lista (por omissão: cartões no telemóvel, lista no PC).
  const [view, setView] = useViewPref("candidaturas", "auto");

  // refetchInterval: candidaturas chegam do site a qualquer hora — o badge
  // "N novas" tem de atualizar com a página aberta, sem reload.
  const list = trpc.driverApplications.list.useQuery({
    status: statusFilter === "all" ? null : (statusFilter as any),
  }, { refetchInterval: 60_000 });
  const newCount = trpc.driverApplications.list.useQuery({ status: "new" }, { refetchInterval: 60_000 });

  // ── Aprovar = escolher a cidade (centro de custos) onde o extra fica ──────
  // `projects.list` já vem limitado às cidades a que quem aprova tem acesso
  // (utilizador de Lisboa só vê Lisboa); aqui ficam só os nós `level='city'`,
  // com o mesmo aspeto do "Centro de Custos" da ficha de RH. Sem centro de
  // custos o extra só era visível a quem tem acesso a todas as cidades.
  const projects = trpc.projects.list.useQuery();
  const cityProjects = useMemo(
    () =>
      (projects.data ?? [])
        .filter((p: any) => p.level === "city")
        .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), "pt")),
    [projects.data],
  );
  const [approveFor, setApproveFor] = useState<null | { id: number; fullName: string; email: string; city: string | null }>(null);
  const [approveProjectId, setApproveProjectId] = useState<string>("");
  // 18b: a pessoa já teve ficha desativada → mostra o motivo e só reativa com confirmação.
  const [reactivateAsk, setReactivateAsk] = useState<null | { appId: number; projectId: number; employeeId: number; fullName: string; reason: string }>(null);

  /** Abre o diálogo com a cidade da candidatura pré-selecionada (quando se reconhece). */
  function openApprove(a: { id: number; fullName: string; email: string; city: string | null }) {
    const key = cityKeyFromText(a.city);
    const match = key ? cityProjects.find((p: any) => matchCityKey(p.name) === key) : undefined;
    setApproveProjectId(match ? String(match.id) : cityProjects.length === 1 ? String(cityProjects[0].id) : "");
    setApproveFor(a);
  }

  const approve = trpc.driverApplications.approve.useMutation({
    onSuccess: (r, vars) => {
      if (!r.ok) {
        setReactivateAsk({ appId: vars.id, projectId: vars.projectId, ...r.needsConfirm });
        setApproveFor(null);
        return;
      }
      setReactivateAsk(null);
      const cc = r.costCenter;
      const who = r.employeeCreated ? "extra criado" : "ligada a extra existente";
      if (cc.outcome === "kept_existing") {
        toast.warning(
          `Candidatura aprovada — ${who}. A ficha já estava em ${cc.existingProjectName} e mantém-se lá (não foi movida para ${cc.projectName}).`,
        );
      } else {
        toast.success(`Candidatura aprovada — ${who}, alocado a ${cc.projectName}.`);
      }
      setApproveFor(null);
      list.refetch();
      newCount.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const setStatus = trpc.driverApplications.setStatus.useMutation({
    onSuccess: () => {
      list.refetch();
      newCount.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  /**
   * 41d (Jorge: "não conseguimos tirar nada daí… não dá para cancelar"): cada
   * mudança de estado tem "Desfazer" (volta ao estado anterior). "Pronta" tira
   * das Novas sem aprovar nem rejeitar; "Repor" volta a Nova.
   */
  const changeStatus = (a: { id: number; status: string }, status: "new" | "reviewed" | "rejected") => {
    const from = (a.status === "reviewed" || a.status === "rejected" ? a.status : "new") as "new" | "reviewed" | "rejected";
    setStatus.mutate({ id: a.id, status }, {
      onSuccess: () => {
        const msg = status === "rejected" ? "Candidatura rejeitada (o lead dela fica «Sem interesse»)." : status === "reviewed" ? "Marcada como pronta — saiu das Novas." : "Voltou às Novas.";
        toast.success(msg, { action: { label: "Desfazer", onClick: () => setStatus.mutate({ id: a.id, status: from }) } });
      },
    });
  };

  const apps = list.data ?? [];
  const pending = newCount.data?.length ?? 0;

  // A BD guarda em UTC sem "Z" (18b: antes lia-se como hora local e o dia podia trocar).
  const fmtWhen = (s: string) => {
    const iso = s.includes("T") ? s : s.replace(" ", "T");
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
    return isNaN(d.getTime()) ? s : d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Lisbon" });
  };

  // D46: as mesmas ações e detalhes na lista e nos cartões.
  const appActions = (a: any) => (
    <>
      {a.status !== "approved" && (
        <Button
          size="sm"
          variant="outline"
          className="border-emerald-600 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950 mr-1"
          disabled={approve.isPending}
          onClick={() => openApprove({ id: a.id, fullName: a.fullName, email: a.email, city: a.city ?? null })}
        >
          <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Aprovar
        </Button>
      )}
      {a.status !== "rejected" && a.status !== "approved" && (
        <Button
          size="sm"
          variant="outline"
          className="border-red-300 text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
          disabled={setStatus.isPending}
          onClick={() => changeStatus(a, "rejected")}
        >
          <XCircle className="h-3.5 w-3.5 mr-1" /> Rejeitar
        </Button>
      )}
      {a.status === "new" && (
        <Button size="sm" variant="outline" className="ml-1" disabled={setStatus.isPending} title="Já vi: sai das Novas sem aprovar nem rejeitar (Repor devolve-a)"
          onClick={() => changeStatus(a, "reviewed")}>
          <Check className="h-3.5 w-3.5 mr-1" /> Pronta
        </Button>
      )}
      {(a.status === "reviewed" || a.status === "rejected") && (
        <Button size="sm" variant="ghost" className="ml-1" disabled={setStatus.isPending} title="Volta às Novas"
          onClick={() => changeStatus(a, "new")}>
          <RotateCcw className="h-3.5 w-3.5 mr-1" /> Repor
        </Button>
      )}
    </>
  );
  const appDetails = (a: any) => {
    const payload = (a.payload ?? {}) as Record<string, unknown>;
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1 text-xs">
        {a.nif && <div><span className="text-muted-foreground">NIF:</span> {a.nif}</div>}
        {a.country && <div><span className="text-muted-foreground">País:</span> {a.country}</div>}
        {a.drivingExperience && <div><span className="text-muted-foreground">Experiência:</span> {a.drivingExperience}</div>}
        {a.expectedHourlyRate && <div><span className="text-muted-foreground">€/h esperado:</span> {a.expectedHourlyRate}</div>}
        {a.howDidYouKnow && <div><span className="text-muted-foreground">Como conheceu:</span> {a.howDidYouKnow}</div>}
        {a.employeeId && <div><span className="text-muted-foreground">Employee:</span> #{a.employeeId}</div>}
        {Object.entries(payload)
          .filter(([, v]) => v != null && v !== "" && (typeof v !== "object" || Array.isArray(v)))
          .map(([k, v]) => (
            <div key={k}>
              <span className="text-muted-foreground">{k}:</span>{" "}
              {Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Sim" : "Não") : String(v)}
            </div>
          ))}
      </div>
    );
  };

  return (
    <Card className="border-emerald-200">
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-emerald-600" />
            Candidaturas do site (Be a Driver)
            {pending > 0 && (
              <Badge className="bg-blue-600 text-white hover:bg-blue-600">{pending} nova{pending > 1 ? "s" : ""}</Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
          <ViewToggle value={view} onChange={setView} />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">Novas</SelectItem>
              <SelectItem value="reviewed">Prontas (vistas)</SelectItem>
              <SelectItem value="approved">Aprovadas</SelectItem>
              <SelectItem value="rejected">Rejeitadas</SelectItem>
              <SelectItem value="all">Todas</SelectItem>
            </SelectContent>
          </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {list.error && <QueryErrorNote error={list.error} onRetry={() => list.refetch()} retrying={list.isFetching} what="as candidaturas" />}
        {list.isLoading && <div className="text-sm text-muted-foreground">A carregar candidaturas...</div>}
        {list.isSuccess && apps.length === 0 && (
          <div className="text-sm text-muted-foreground py-2">
            Sem candidaturas {statusFilter !== "all" ? `com estado "${APP_STATUS[statusFilter]?.label ?? statusFilter}"` : ""}.
          </div>
        )}
        {apps.length > 0 && view === "cards" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {apps.map((a: any) => {
              const st = APP_STATUS[a.status] ?? APP_STATUS.new;
              const expanded = expandedId === a.id;
              return (
                <div key={a.id} className="rounded-lg border bg-card p-3 space-y-2">
                  <div className="flex items-start gap-3">
                    <ContactAvatar name={a.fullName} className="h-12 w-12 text-base shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium break-words">{a.fullName}</div>
                      <div className="flex flex-wrap items-center gap-1 mt-0.5">
                        <Badge variant="outline" className={st.className}>{st.label}</Badge>
                        {a.submissionCount > 1 && <span className="text-xs text-muted-foreground">{a.submissionCount}× submetida</span>}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-0.5 text-xs text-muted-foreground">
                    {a.email && <div className="break-all">{a.email}</div>}
                    {a.phone && <div>{a.phone}</div>}
                    <div>{a.city ?? "Sem cidade"} · recebida {fmtWhen(a.lastSubmittedAt)}</div>
                  </div>
                  {expanded && <div className="rounded-md bg-muted/30 p-2">{appDetails(a)}</div>}
                  <div className="flex flex-wrap items-center justify-between gap-1 pt-1 border-t">
                    <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setExpandedId(expanded ? null : a.id)}>
                      {expanded ? <ChevronDown className="h-3.5 w-3.5 mr-1" /> : <ChevronRight className="h-3.5 w-3.5 mr-1" />}Detalhes
                    </Button>
                    <div className="flex flex-wrap justify-end">{appActions(a)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {apps.length > 0 && view === "list" && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs uppercase text-muted-foreground">
                  <th className="text-left py-2 px-2 w-6"></th>
                  <th className="text-left py-2 px-2">Nome</th>
                  <th className="text-left py-2 px-2">Email</th>
                  <th className="text-left py-2 px-2">Telefone</th>
                  <th className="text-left py-2 px-2">Cidade</th>
                  <th className="text-left py-2 px-2">Recebida</th>
                  <th className="text-left py-2 px-2">Estado</th>
                  <th className="text-right py-2 px-2">Ações</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a: any) => {
                  const st = APP_STATUS[a.status] ?? APP_STATUS.new;
                  const expanded = expandedId === a.id;
                  return (
                    <Fragment key={a.id}>
                      <tr className="border-b hover:bg-muted/40">
                        <td className="py-2 px-2">
                          <button
                            className="text-muted-foreground"
                            onClick={() => setExpandedId(expanded ? null : a.id)}
                            title={expanded ? "Fechar detalhes" : "Ver detalhes"}
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        </td>
                        <td className="py-2 px-2 font-medium">
                          {a.fullName}
                          {a.submissionCount > 1 && (
                            <span className="ml-1 text-xs text-muted-foreground">({a.submissionCount}× submetida)</span>
                          )}
                        </td>
                        <td className="py-2 px-2 break-all">{a.email}</td>
                        <td className="py-2 px-2">{a.phone ?? "—"}</td>
                        <td className="py-2 px-2">{a.city ?? "—"}</td>
                        <td className="py-2 px-2 whitespace-nowrap">{fmtWhen(a.lastSubmittedAt)}</td>
                        <td className="py-2 px-2">
                          <Badge variant="outline" className={st.className}>{st.label}</Badge>
                        </td>
                        <td className="py-2 px-2 text-right whitespace-nowrap">
                          {appActions(a)}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b bg-muted/20">
                          <td colSpan={8} className="py-3 px-4">
                            {appDetails(a)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      {/* ── Dialog: aprovar candidatura + cidade (centro de custos) ─────────── */}
      <Dialog open={approveFor != null} onOpenChange={(open) => { if (!open && !approve.isPending) setApproveFor(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              Aprovar {approveFor?.fullName}
            </DialogTitle>
            <DialogDescription>
              Cria (ou liga a) a ficha de extra com o email <span className="font-medium">{approveFor?.email}</span> e
              aloca-a à cidade escolhida — é o mesmo "Centro de Custos" da ficha de RH.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label>Centro de Custos (cidade) *</Label>
            <Select value={approveProjectId} onValueChange={setApproveProjectId} disabled={approve.isPending}>
              <SelectTrigger className={!approveProjectId ? "border-amber-400" : undefined}>
                <SelectValue placeholder={projects.isLoading ? "A carregar cidades…" : "Escolher cidade..."} />
              </SelectTrigger>
              <SelectContent>
                {cityProjects.map((p: any) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    <span className="inline-flex items-center gap-2">
                      <Badge variant="outline" className="text-[11px] bg-blue-100 text-blue-700 border-blue-200">Cidade</Badge>
                      {p.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {approveFor?.city && (
              <p className="text-xs text-muted-foreground">
                Na candidatura escreveu <span className="font-medium">“{approveFor.city}”</span>
                {cityKeyFromText(approveFor.city) ? " — pré-selecionada, confirma ou muda." : " — não corresponde a nenhuma cidade operacional, escolhe tu."}
              </p>
            )}
            {!projects.isLoading && cityProjects.length === 0 && (
              <p className="text-xs text-amber-700">
                Não tens nenhuma cidade disponível para alocar (verifica o teu centro de custos).
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Sem cidade, o extra só ficaria visível a quem tem acesso a todas as cidades. Uma ficha que já exista com
              centro de custos não é movida — muda-se na ficha, se for preciso.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveFor(null)} disabled={approve.isPending}>
              Cancelar
            </Button>
            <Button
              className="bg-emerald-700 hover:bg-emerald-800 text-white"
              disabled={!approveProjectId || approve.isPending || !approveFor}
              onClick={() => approveFor && approve.mutate({ id: approveFor.id, projectId: Number(approveProjectId) })}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" />
              {approve.isPending ? "A aprovar…" : "Aprovar e alocar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Já teve ficha (desativada): reativar só com confirmação (18b) ───── */}
      <Dialog open={reactivateAsk != null} onOpenChange={(open) => { if (!open && !approve.isPending) setReactivateAsk(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Esta pessoa já teve ficha</DialogTitle>
            <DialogDescription>
              {reactivateAsk?.fullName || "A ficha"} (#{reactivateAsk?.employeeId}) foi desativada por «{reactivateAsk?.reason}».
              Aprovar a candidatura volta a ativá-la: aparece na disponibilidade e pode ser escalada.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReactivateAsk(null)} disabled={approve.isPending}>Não reativar</Button>
            <Button
              className="bg-emerald-700 hover:bg-emerald-800 text-white"
              disabled={approve.isPending || !reactivateAsk}
              onClick={() => reactivateAsk && approve.mutate({ id: reactivateAsk.appId, projectId: reactivateAsk.projectId, confirmReactivate: true })}
            >
              <CheckCircle2 className="h-4 w-4 mr-2" /> {approve.isPending ? "A reativar…" : "Reativar e aprovar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
