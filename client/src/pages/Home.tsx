// Login novo (Multipark Design System · ui_kits/dashboard/LoginScreen):
// painel dividido — formulário à esquerda com o logo real, painel navy com
// gradiente e números do grupo à direita. Lógica de auth intacta.
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { ACCESS_DENIED_MSG, AUTH_DENIED_PARAM, AUTH_DENIED_VALUE } from "@shared/const";
import { Loader2, ShieldAlert } from "lucide-react";
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
    <div className="min-h-screen flex bg-white">
      {/* ── Formulário ── */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-[380px]">
          <img src="/multipark-logo.png" alt="Multipark" className="h-8 mb-9" />

          <h1 className="font-display font-bold text-3xl text-[#0c1f3f] mb-2">Bem-vindo de volta</h1>
          <p className="text-[15px] text-slate-500 leading-snug mb-7">
            Entra com a tua conta Google do grupo para acederes ao backoffice.
          </p>

          {accessDenied && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 mb-5"
            >
              <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
              <span>{ACCESS_DENIED_MSG}</span>
            </div>
          )}

          <Button
            size="lg"
            className="w-full h-11 text-[15px] font-semibold shadow-sm"
            onClick={() => { window.location.href = getLoginUrl(); }}
          >
            <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" aria-hidden>
              <path fill="currentColor" d="M21.35 11.1H12v3.2h5.3c-.5 2.5-2.6 3.9-5.3 3.9a5.9 5.9 0 1 1 0-11.8c1.5 0 2.8.5 3.8 1.5l2.4-2.4A9.4 9.4 0 0 0 12 2.6a9.4 9.4 0 1 0 0 18.8c5.4 0 9-3.8 9-9.2 0-.7-.1-1.4-.25-2.1Z"/>
            </svg>
            Entrar com Google
          </Button>

          <div className="flex items-center text-center text-slate-400 text-xs my-6 before:content-[''] before:flex-1 before:h-px before:bg-slate-200 after:content-[''] after:flex-1 after:h-px after:bg-slate-200">
            <span className="px-3.5">acesso reservado à equipa</span>
          </div>

          <p className="text-[13px] text-slate-400 leading-relaxed">
            Sem acesso? Fala com a administração para te associarem à tua ficha de colaborador.
          </p>
        </div>
      </div>

      {/* ── Painel de marca (navy) ── */}
      <div className="hidden lg:flex flex-1 relative overflow-hidden flex-col justify-center p-14 text-white bg-gradient-to-br from-[#0e2957] to-[#081226]">
        <div
          className="absolute -right-28 -top-28 w-[380px] h-[380px] rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(0,85,210,.45), transparent 70%)" }}
        />
        <img src="/multipark-logo-white.png" alt="" className="h-[26px] w-auto self-start mb-10 relative" />
        <div className="relative">
          <div className="font-display font-bold text-xs tracking-[.18em] uppercase text-[#8fb3f5]">
            Plataforma interna
          </div>
          <h2 className="font-display font-extrabold text-[34px] leading-[1.15] mt-3 mb-4 max-w-[13ch]">
            Toda a operação num só lugar
          </h2>
          <p className="text-[15px] leading-relaxed text-white/[.78] max-w-[38ch] m-0">
            Reservas, condutores, ponto com GPS, extras, faturação e parcerias —
            em tempo real, nas 3 cidades.
          </p>
          <div className="flex gap-9 mt-11">
            {[
              ["3", "Cidades"],
              ["70+", "Parceiros"],
              ["350+", "Condutores"],
            ].map(([n, l]) => (
              <div key={l}>
                <b className="font-display font-extrabold text-[28px] block">{n}</b>
                <span className="text-xs text-white/70 uppercase tracking-[.08em]">{l}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="absolute bottom-6 left-14 text-xs text-white/50 font-normal">
          © {new Date().getFullYear()} Grupo Multipark
        </div>
      </div>
    </div>
  );
}
