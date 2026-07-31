import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CalendarCheck, Sun, Moon, CheckCircle2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { AvailabilitySection, CandidaturasSection } from "@/pages/ExtrasDiaPage";
import { RecruitmentSection } from "@/components/RecruitmentSection";
import { Mail } from "lucide-react";

type DayState = {
  day: string;
  label: string;
  morning: boolean;
  night: boolean;
  fromHour: number | null;
  toHour: number | null;
  note: string | null;
};

function useWeekParam(fallback: string): string {
  return useMemo(() => {
    const q = new URLSearchParams(window.location.search).get("week");
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : fallback;
  }, [fallback]);
}

// Dois modos na mesma rota (pedido do Jorge, jul 2026):
//   - extra (e restantes não-gestão): marca a PRÓPRIA disponibilidade;
//   - backoffice e acima: hub de gestão — matriz de disponibilidades +
//     envio email/WhatsApp + candidaturas do site (saíram da Extras Dia,
//     que estava demasiado cheia). Quem é gestão não marca disponibilidade.
const MANAGEMENT_ROLES = new Set(["backoffice", "team_leader", "supervisor", "admin", "super_admin"]);

export default function DisponibilidadePage() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (MANAGEMENT_ROLES.has(user?.role ?? "")) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarCheck className="h-6 w-6 text-primary" />
            Disponibilidades
          </h1>
          <p className="text-sm text-muted-foreground">
            Quem está disponível, pedidos por email/WhatsApp e candidaturas do site.
          </p>
        </div>
        <AvailabilitySection />
        <CandidaturasSection />
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2 mb-3">
            <Mail className="h-5 w-5 text-primary" />
            Recrutamento (recursos-humanos@)
          </h2>
          <RecruitmentSection />
        </div>
      </div>
    );
  }

  return <MyAvailability />;
}

function MyAvailability() {
  const hints = trpc.extrasAvailability.weekHints.useQuery();
  const fallbackWeek = hints.data?.next ?? "";
  const weekStart = useWeekParam(fallbackWeek);

  const myWeek = trpc.extrasAvailability.myWeek.useQuery(
    { weekStart },
    { enabled: !!weekStart },
  );

  const [days, setDays] = useState<DayState[]>([]);
  const [savedOnce, setSavedOnce] = useState(false);

  useEffect(() => {
    if (myWeek.data) setDays(myWeek.data.days);
  }, [myWeek.data]);

  const save = trpc.extrasAvailability.setMyWeek.useMutation({
    onSuccess: () => {
      setSavedOnce(true);
      toast.success("Disponibilidade guardada. Obrigado!");
      myWeek.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  function patch(idx: number, p: Partial<DayState>) {
    setDays((prev) => prev.map((d, i) => (i === idx ? { ...d, ...p } : d)));
  }

  if (!weekStart || hints.isLoading || myWeek.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (myWeek.error) {
    return (
      <div className="max-w-md mx-auto py-12 px-4">
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <div className="text-4xl">🔒</div>
            <p className="text-muted-foreground">{myWeek.error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const anyMarked = days.some((d) => d.morning || d.night || d.fromHour != null);

  return (
    <div className="max-w-2xl mx-auto py-6 px-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarCheck className="h-5 w-5 text-primary" />
            A minha disponibilidade
          </CardTitle>
          <CardDescription>
            Semana de {myWeek.data?.weekStart} a {myWeek.data?.weekEnd}. Marca os dias e turnos
            em que podes trabalhar. Podes também indicar horas específicas.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="space-y-3">
        {days.map((d, idx) => {
          const active = d.morning || d.night || d.fromHour != null;
          return (
            <Card key={d.day} className={active ? "border-primary/50" : undefined}>
              <CardContent className="py-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{d.label}</span>
                  {savedOnce && active && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                </div>
                <div className="flex gap-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Switch
                      checked={d.morning}
                      onCheckedChange={(v) => patch(idx, { morning: v })}
                    />
                    <Sun className="h-4 w-4 text-amber-500" />
                    <span className="text-sm">Manhã (03h–15h)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Switch
                      checked={d.night}
                      onCheckedChange={(v) => patch(idx, { night: v })}
                    />
                    <Moon className="h-4 w-4 text-indigo-500" />
                    <span className="text-sm">Noite (15h–03h)</span>
                  </label>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Label className="text-xs text-muted-foreground">Horas (opcional):</Label>
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    placeholder="das"
                    className="w-20 h-8"
                    value={d.fromHour ?? ""}
                    onChange={(e) =>
                      patch(idx, { fromHour: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                  <span className="text-muted-foreground">→</span>
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    placeholder="às"
                    className="w-20 h-8"
                    value={d.toHour ?? ""}
                    onChange={(e) =>
                      patch(idx, { toHour: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                  <Input
                    placeholder="Nota (opcional)"
                    className="flex-1 min-w-[140px] h-8"
                    value={d.note ?? ""}
                    onChange={(e) => patch(idx, { note: e.target.value || null })}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="sticky bottom-4 flex justify-end">
        <Button
          size="lg"
          className="shadow-lg"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              weekStart,
              days: days.map((d) => ({
                day: d.day,
                morning: d.morning,
                night: d.night,
                fromHour: d.fromHour,
                toHour: d.toHour,
                note: d.note,
              })),
            })
          }
        >
          {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {anyMarked ? "Guardar disponibilidade" : "Guardar (sem disponibilidade)"}
        </Button>
      </div>
    </div>
  );
}
