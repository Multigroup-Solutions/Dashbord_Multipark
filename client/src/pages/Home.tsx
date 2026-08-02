import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { ACCESS_DENIED_MSG, AUTH_DENIED_PARAM, AUTH_DENIED_VALUE } from "@shared/const";
import { Building2, BarChart3, Receipt, Shield, Loader2, ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function Home() {
  const { user, loading, error } = useAuth();
  const [, setLocation] = useLocation();

  // Acesso recusado — MESMA mensagem em todos os casos (conta desativada,
  // desconhecida, ou registada sem acesso). Duas origens possíveis:
  //   1. redirect do callback OAuth  → ?auth=denied
  //   2. cookie válida de conta entretanto desativada → auth.me devolve 403
  const deniedByRedirect =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get(AUTH_DENIED_PARAM) === AUTH_DENIED_VALUE;
  const accessDenied = deniedByRedirect || error?.message === ACCESS_DENIED_MSG;

  useEffect(() => {
    if (!loading && user) {
      // user/extra/frontoffice nunca aterram na dashboard principal
      const role = (user as any).role ?? "user";
      if (["user", "extra"].includes(role)) setLocation("/rh");
      else if (role === "frontoffice") setLocation("/despesas");
      else setLocation("/dashboard");
    }
  }, [user, loading, setLocation]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (user) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur sticky top-0 z-50">
        <div className="container flex items-center justify-between h-16">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
              <Building2 className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="font-bold text-xl tracking-tight">Dashboard Multipark</span>
          </div>
          <Button onClick={() => { window.location.href = getLoginUrl(); }}>
            Entrar
          </Button>
        </div>
      </header>

      {/* Acesso recusado — mensagem única, ver ACCESS_DENIED_MSG */}
      {accessDenied && (
        <div className="container pt-6">
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200"
          >
            <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
            <span>{ACCESS_DENIED_MSG}</span>
          </div>
        </div>
      )}

      {/* Hero */}
      <main className="flex-1 flex items-center">
        <div className="container py-12 sm:py-24">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 bg-accent/20 text-accent-foreground border border-accent/30 rounded-full px-4 py-1.5 text-sm font-medium mb-6">
              <Shield className="h-3.5 w-3.5" />
              Plataforma de Gestão Empresarial
            </div>
            <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-foreground mb-6 leading-tight">
              Gestão inteligente{" "}
              <span className="text-primary">para o Grupo Multipark</span>
            </h1>
            <p className="text-base sm:text-xl text-muted-foreground mb-10 leading-relaxed max-w-2xl">
              Controla despesas, recursos humanos, projetos e muito mais numa única plataforma.
              Com extração automática de faturas por IA e relatórios em tempo real.
            </p>
            <div className="flex flex-wrap gap-4">
              <Button
                size="lg"
                onClick={() => { window.location.href = getLoginUrl(); }}
                className="shadow-lg"
              >
                Aceder à plataforma
              </Button>
            </div>
          </div>

          {/* Feature cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-20">
            {[
              {
                icon: Receipt,
                title: "Gestão de Despesas",
                desc: "Digitaliza faturas com a câmara e extrai dados automaticamente com IA.",
              },
              {
                icon: BarChart3,
                title: "Dashboards em Tempo Real",
                desc: "Visualiza gastos por dia, semana e mês, por projeto e por utilizador.",
              },
              {
                icon: Shield,
                title: "Controlo de Acessos",
                desc: "Permissões granulares por role: Super Admin, Admin, Team Leader e mais.",
              },
            ].map((f) => (
              <div
                key={f.title}
                className="bg-card border rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold text-foreground mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className="border-t py-6">
        <div className="container text-center text-sm text-muted-foreground">
          © {new Date().getFullYear()} Dashboard Multipark — Grupo Multipark
        </div>
      </footer>
    </div>
  );
}
