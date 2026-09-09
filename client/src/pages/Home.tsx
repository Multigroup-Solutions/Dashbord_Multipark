import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import {
  ParkingCircle,
  BarChart3,
  Receipt,
  Shield,
  Loader2,
  Car,
  Users,
} from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function Home() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && user) {
      setLocation("/dashboard");
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
            <div
              className="h-8 w-8 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: "#1E5BFF" }}
            >
              <ParkingCircle className="h-5 w-5 text-white" />
            </div>
            <div className="flex flex-col leading-none">
              <span className="font-extrabold text-lg tracking-tight">
                MULTIPARK
              </span>
              <span className="text-[10px] font-bold tracking-widest text-primary">
                BACKOFFICE
              </span>
            </div>
          </div>
          <Button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            className="rounded-lg"
          >
            Entrar
          </Button>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex items-center">
        <div className="container py-24">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary border border-primary/20 rounded-full px-4 py-1.5 text-sm font-semibold mb-6">
              <Shield className="h-3.5 w-3.5" />
              Plataforma de Gestão Multipark
            </div>
            <h1 className="text-5xl font-extrabold tracking-tight text-foreground mb-6 leading-tight">
              Uma única plataforma
              <br />
              <span className="text-primary">para gerir tudo.</span>
            </h1>
            <p className="text-xl text-muted-foreground mb-10 leading-relaxed max-w-2xl">
              Reservas, recolhas, entregas, frota, pessoas e caixa —
              centralizado, em tempo real, para toda a operação do Grupo
              Multipark.
            </p>
            <div className="flex flex-wrap gap-4">
              <Button
                size="lg"
                onClick={() => {
                  window.location.href = getLoginUrl();
                }}
                className="rounded-lg shadow-lg"
              >
                Aceder à plataforma
              </Button>
            </div>
          </div>

          {/* Feature tiles no estilo Multipark */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-20">
            {[
              { icon: Car, title: "Operacional", desc: "Recolhas, entregas e movimentos em tempo real." },
              { icon: Receipt, title: "Backoffice", desc: "Reservas, caixa e pesquisa global." },
              { icon: Users, title: "Pessoas", desc: "RH, formação e avaliações." },
              { icon: BarChart3, title: "Gestão", desc: "KPIs, faturação e parcerias." },
            ].map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border-2 border-primary/30 bg-card p-6 flex flex-col items-center text-center gap-3 hover:-translate-y-0.5 hover:shadow-lg transition-all"
              >
                <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <f.icon className="h-6 w-6 text-primary" strokeWidth={1.75} />
                </div>
                <h3 className="font-bold uppercase tracking-wide text-sm text-primary">
                  {f.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className="border-t py-6">
        <div className="container text-center text-sm text-muted-foreground">
          © {new Date().getFullYear()} Multipark — Grupo Multipark
        </div>
      </footer>
    </div>
  );
}
