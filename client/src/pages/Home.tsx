// Login novo (Multipark Design System · ui_kits/dashboard/LoginScreen):
// painel dividido — formulário à esquerda com o logo real, painel navy com
// gradiente e números do grupo à direita.
// Plano 56 (A1): com "Entrar com email e código" ligado, o formulário passa a
// Email + Palavra-passe, "Pedir código" (o código vai ao TL e ao supervisor de
// serviço) e "Cria a tua palavra-passe"; o botão Google continua. O passo fica
// no endereço (?passo=codigo / ?passo=nova-palavra-passe). Desligado: igual a antes.
// A2: num PDA registado (token do aparelho validado no servidor) o Google sai
// com GOOGLE_NOS_PDAS desligado, o Chrome não guarda nada (autocomplete off /
// new-password / one-time-code) e a entrada leva o token (sessão de PDA).
import { useAuth } from "@/_core/hooks/useAuth";
import { can, roleRank } from "@shared/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getGoogleLoginUrl } from "@/const";
import { ACCESS_DENIED_MSG, AUTH_DENIED_PARAM, AUTH_DENIED_VALUE } from "@shared/const";
import { CODE_REQUESTED_MSG, LOGIN_CODE, PASSWORD_MIN, canUsePassword, cleanCode, passwordProblem } from "@shared/loginCode";
import { googleShownOnDevice } from "@shared/pdaSession";
import { safeReturnPath } from "@shared/loginReturn";
import { KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { getPdaToken } from "@/lib/pdaDevice";
import { useCodeLoginOption } from "@/lib/loginOptions";

type Step = "entrar" | "codigo" | "nova-palavra-passe";
const STEPS: Step[] = ["entrar", "codigo", "nova-palavra-passe"];
const EMAIL_KEY = "mp.login.email";
const CODE_MSG_KEY = "mp.login.codeMsg";

function readStep(): Step {
  if (typeof window === "undefined") return "entrar";
  const p = new URLSearchParams(window.location.search).get("passo");
  return (STEPS as string[]).includes(p ?? "") ? (p as Step) : "entrar";
}

/** Para onde voltar depois de entrar (`?next=`, só caminhos desta app). */
function nextFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return safeReturnPath(new URLSearchParams(window.location.search).get("next"));
}

/** O passo no endereço (o "voltar" do browser regressa ao passo anterior). */
function useLoginStep(): [Step, (s: Step, opts?: { replace?: boolean }) => void] {
  const [step, setStepState] = useState<Step>(readStep);
  useEffect(() => {
    const onPop = () => setStepState(readStep());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const setStep = useCallback((s: Step, opts?: { replace?: boolean }) => {
    const params = new URLSearchParams(window.location.search);
    if (s === "entrar") params.delete("passo"); else params.set("passo", s);
    params.delete(AUTH_DENIED_PARAM);
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (opts?.replace) window.history.replaceState(null, "", url); else window.history.pushState(null, "", url);
    setStepState(s);
  }, []);
  return [step, setStep];
}

const readEmail = () => { try { return sessionStorage.getItem(EMAIL_KEY) ?? ""; } catch { return ""; } };
const saveEmail = (v: string) => { try { sessionStorage.setItem(EMAIL_KEY, v); } catch { /* sem storage */ } };
/** A mensagem do pedido de código (o TL/supervisor, o email, ou "pede ao TL"). */
const readCodeMsg = () => { try { return sessionStorage.getItem(CODE_MSG_KEY) || CODE_REQUESTED_MSG; } catch { return CODE_REQUESTED_MSG; } };
const saveCodeMsg = (v: string | null | undefined) => { try { sessionStorage.setItem(CODE_MSG_KEY, v || CODE_REQUESTED_MSG); } catch { /* sem storage */ } };
/** Num PDA (partilhado) o email não fica para a pessoa seguinte. */
const forgetLoginSteps = () => { try { sessionStorage.removeItem(EMAIL_KEY); sessionStorage.removeItem(CODE_MSG_KEY); } catch { /* sem storage */ } };

/**
 * A2: este aparelho é um PDA registado? (o servidor valida o token; o pedido
 * vai no corpo, nunca no endereço). `undefined` enquanto pergunta.
 */
function usePdaDevice(token: string | null, codeLogin: boolean | undefined): { registered: boolean; google: boolean } | undefined {
  const check = trpc.auth.pda.device.useMutation();
  const [state, setState] = useState<{ registered: boolean; google: boolean } | undefined>(() => (token ? undefined : { registered: false, google: true }));
  useEffect(() => {
    if (!token) { setState({ registered: false, google: true }); return; }
    if (codeLogin === undefined) return;
    if (!codeLogin) { setState({ registered: false, google: true }); return; }
    let alive = true;
    check.mutateAsync({ deviceToken: token })
      .then((r) => { if (alive) setState({ registered: r.registered, google: r.google }); })
      // sem resposta: mostra o Google (nunca deixar o PDA sem forma de entrar)
      .catch(() => { if (alive) setState({ registered: false, google: true }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, codeLogin]);
  return state;
}

export default function Home() {
  const { user, loading, error } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { codeLogin, resendAfterSec } = useCodeLoginOption();
  const [step, setStep] = useLoginStep();
  const pdaToken = getPdaToken();
  const pdaDevice = usePdaDevice(pdaToken, codeLogin);
  const onPda = !!pdaToken;
  const showGoogle = !pdaDevice || googleShownOnDevice({ registeredPda: pdaDevice.registered, codeLogin: !!codeLogin, googleOnPdas: pdaDevice.google });

  // Acesso recusado — MESMA mensagem em todos os casos (conta desativada,
  // desconhecida, ou registada sem acesso). Duas origens possíveis:
  //   1. redirect do callback OAuth  → ?auth=denied
  //   2. cookie válida de conta entretanto desativada → auth.me devolve 403
  const deniedByRedirect =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get(AUTH_DENIED_PARAM) === AUTH_DENIED_VALUE;
  const accessDenied = deniedByRedirect || error?.message === ACCESS_DENIED_MSG;
  // 20d: o servidor não respondeu ≠ "não tens sessão" (não manda logo para a Google).
  const sessionCheckFailed = !!error && error.message !== ACCESS_DENIED_MSG;

  /** Depois de entrar: o `next`, senão o ecrã do papel. */
  const goHome = useCallback((role: string | null | undefined, canDash: boolean) => {
    const next = nextFromUrl();
    if (next) { window.location.replace(next); return; }
    // user/extra/condutor vão para a ficha; team leader (sem Dashboards) para as Tarefas
    // 20d: replace — o "voltar" do browser não regressa a esta página de passagem.
    if (roleRank(role ?? "user") < roleRank("team_leader")) setLocation("/rh", { replace: true });
    else if (!canDash) setLocation("/tarefas", { replace: true });
    else setLocation("/dashboard", { replace: true });
  }, [setLocation]);

  useEffect(() => {
    // Plano 56: logo a seguir ao código fica no "Cria a tua palavra-passe".
    if (!loading && user && !(step === "nova-palavra-passe" && canUsePassword((user as any).role))) {
      goHome((user as any).role ?? "user", can(user as any, "dashboards", "view"));
    }
  }, [user, loading, step, goHome]);

  if (loading || (!user && (codeLogin === undefined || (codeLogin && onPda && pdaDevice === undefined)))) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const choosingPassword = !!user && step === "nova-palavra-passe" && canUsePassword((user as any).role);
  if (user && !choosingPassword) return null;

  const alerts = (
    <>
      {accessDenied && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 mb-5"
        >
          <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
          <span>{ACCESS_DENIED_MSG}</span>
        </div>
      )}
      {sessionCheckFailed && !accessDenied && (
        <div role="alert" className="flex flex-wrap items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 mb-5">
          <span className="min-w-0 flex-1">Não foi possível verificar a sessão (o servidor não respondeu). Se já tinhas entrado, tenta de novo antes de voltar a entrar.</span>
          <Button size="sm" variant="outline" onClick={() => utils.auth.me.invalidate()}>Tentar de novo</Button>
        </div>
      )}
    </>
  );

  const googleButton = (variant: "default" | "outline") => (
    <Button
      size="lg"
      variant={variant}
      className="w-full h-11 text-[15px] font-semibold shadow-sm"
      onClick={() => { window.location.href = getGoogleLoginUrl(nextFromUrl()); }}
    >
      <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" aria-hidden>
        <path fill="currentColor" d="M21.35 11.1H12v3.2h5.3c-.5 2.5-2.6 3.9-5.3 3.9a5.9 5.9 0 1 1 0-11.8c1.5 0 2.8.5 3.8 1.5l2.4-2.4A9.4 9.4 0 0 0 12 2.6a9.4 9.4 0 1 0 0 18.8c5.4 0 9-3.8 9-9.2 0-.7-.1-1.4-.25-2.1Z"/>
      </svg>
      Entrar com Google
    </Button>
  );

  let form: ReactNode;
  if (choosingPassword) {
    form = <ChoosePassword name={(user as any)?.name ?? null} email={(user as any)?.email ?? null}
      onDone={() => goHome((user as any).role, can(user as any, "dashboards", "view"))} />;
  } else if (!codeLogin) {
    // ENTRAR_COM_CODIGO desligado: como sempre (só Google).
    form = (
      <>
        <p className="text-[15px] text-slate-500 leading-snug mb-7">
          Entra com a tua conta Google do grupo para acederes ao backoffice.
        </p>
        {alerts}
        {googleButton("default")}
        <div className="flex items-center text-center text-slate-400 text-xs my-6 before:content-[''] before:flex-1 before:h-px before:bg-slate-200 after:content-[''] after:flex-1 after:h-px after:bg-slate-200">
          <span className="px-3.5">acesso reservado à equipa</span>
        </div>
        <p className="text-[13px] text-slate-400 leading-relaxed">
          Sem acesso? Fala com a administração para te associarem à tua ficha de colaborador.
        </p>
      </>
    );
  } else if (step === "codigo") {
    form = <EnterCode resendAfterSec={resendAfterSec} onPda={onPda} onBack={() => setStep("entrar")}
      onDone={async (needsPassword) => {
        if (needsPassword) setStep("nova-palavra-passe", { replace: true });
        await utils.auth.me.invalidate();
        if (!needsPassword) window.location.replace(nextFromUrl() ?? "/");
      }} />;
  } else {
    form = (
      <>
        <p className="text-[15px] text-slate-500 leading-snug mb-6">Entra com o teu email.</p>
        {alerts}
        <EmailPassword onPda={onPda} onCodeRequested={() => setStep("codigo")} />
        {showGoogle ? (
          <>
            <div className="flex items-center text-center text-slate-400 text-xs my-6 before:content-[''] before:flex-1 before:h-px before:bg-slate-200 after:content-[''] after:flex-1 after:h-px after:bg-slate-200">
              <span className="px-3.5">ou</span>
            </div>
            {googleButton("outline")}
            <p className="text-[12.5px] text-slate-400 leading-relaxed mt-4">
              {pdaDevice?.registered
                ? "Neste PDA, team leaders e supervisores também entram com código (sem palavra-passe)."
                : "Team leaders, supervisores e escritório entram com Google."}
            </p>
          </>
        ) : (
          <p className="text-[12.5px] text-slate-400 leading-relaxed mt-6">
            Neste PDA entra-se com o email. Team leaders e supervisores: pede o código (sem palavra-passe).
          </p>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen flex bg-white">
      {/* ── Formulário ── */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-8">
        <div className="w-full max-w-[380px]">
          <img src="/multipark-logo.png" alt="Multipark" className="h-8 mb-9" />

          <h1 className="font-display font-bold text-3xl text-[#0c1f3f] mb-2">
            {choosingPassword ? "Cria a tua palavra-passe" : step === "codigo" && codeLogin ? "Código de entrada" : "Bem-vindo de volta"}
          </h1>
          {form}
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

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="text-sm text-red-700 rounded-lg border border-red-200 bg-red-50 px-3 py-2">{message}</p>;
}

/** Email + Palavra-passe + Entrar, e "Primeira vez ou esqueceste-te? Pedir código". */
function EmailPassword({ onCodeRequested, onPda }: { onCodeRequested: () => void; onPda: boolean }) {
  const [email, setEmail] = useState(readEmail);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const login = trpc.auth.password.login.useMutation();
  const request = trpc.auth.code.request.useMutation();
  const busy = login.isPending || request.isPending;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    saveEmail(email.trim());
    try {
      const r = await login.mutateAsync({ email: email.trim(), password, next: nextFromUrl(), pdaToken: getPdaToken() });
      if (onPda) forgetLoginSteps();
      window.location.replace(r.next ?? "/");
    } catch (x: any) {
      setErr(x?.message ?? "Não foi possível entrar.");
      setPassword("");
    }
  };

  const askCode = async () => {
    setErr(null);
    const e = email.trim();
    if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(e)) { setErr("Escreve primeiro o teu email e depois carrega em \"Pedir código\"."); return; }
    saveEmail(e);
    try {
      const r = await request.mutateAsync({ email: e, pdaToken: getPdaToken() });
      saveCodeMsg(r.message);
      onCodeRequested();
    } catch (x: any) {
      setErr(x?.message ?? "Não foi possível pedir o código.");
    }
  };

  return (
    // A2: no PDA (partilhado) o Chrome não guarda nem sugere o email/palavra-passe de ninguém.
    <form onSubmit={submit} className="space-y-4" autoComplete={onPda ? "off" : "on"}>
      <div className="space-y-1.5">
        <Label htmlFor="login-email">Email</Label>
        <Input id="login-email" type="email" inputMode="email" autoComplete={onPda ? "off" : "username"} autoCapitalize="none" spellCheck={false}
          className="h-11 text-[15px]" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@gmail.com" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="login-password">Palavra-passe</Label>
        <Input id="login-password" type="password" autoComplete={onPda ? "new-password" : "current-password"} className="h-11 text-[15px]"
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <FormError message={err} />
      <Button type="submit" size="lg" className="w-full h-11 text-[15px] font-semibold" disabled={busy || !email.trim() || !password}>
        {login.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}Entrar
      </Button>
      <button type="button" onClick={askCode} disabled={busy}
        className="w-full text-center text-sm text-primary underline underline-offset-2 disabled:opacity-60">
        {request.isPending ? "A pedir o código…" : "Primeira vez ou esqueceste-te? Pedir código"}
      </button>
    </form>
  );
}

/** O código de 6 algarismos (teclado numérico, aceita colar). */
function EnterCode({ resendAfterSec, onBack, onDone, onPda }: { resendAfterSec: number; onBack: () => void; onDone: (needsPassword: boolean) => Promise<void>; onPda: boolean }) {
  const email = readEmail();
  const [message, setMessage] = useState(readCodeMsg);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(() => Date.now() + resendAfterSec * 1000);
  const [now, setNow] = useState(Date.now());
  const verify = trpc.auth.code.verify.useMutation();
  const request = trpc.auth.code.request.useMutation();

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => { if (!email) onBack(); }, [email, onBack]);

  const left = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const r = await verify.mutateAsync({ email, code, next: nextFromUrl(), pdaToken: getPdaToken() });
      if (onPda) forgetLoginSteps();
      await onDone(r.needsPassword);
    } catch (x: any) {
      setErr(x?.message ?? "Não foi possível entrar.");
      setCode("");
    }
  };
  const again = async () => {
    setErr(null);
    try {
      const r = await request.mutateAsync({ email, pdaToken: getPdaToken() });
      saveCodeMsg(r.message);
      setMessage(r.message || CODE_REQUESTED_MSG);
      setWaitUntil(Date.now() + resendAfterSec * 1000);
    } catch (x: any) {
      setErr(x?.message ?? "Não foi possível pedir outro código.");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" autoComplete="off">
      <div role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
        {message}
      </div>
      <p className="text-[13px] text-slate-500 [overflow-wrap:anywhere]">
        Para <b>{email}</b> · <button type="button" className="text-primary underline underline-offset-2" onClick={onBack}>Mudar</button>
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="login-code">Código de 6 algarismos</Label>
        <Input id="login-code" inputMode="numeric" pattern="[0-9 ]*" autoComplete="one-time-code" autoFocus
          className="h-12 text-center text-2xl tracking-[.3em] font-semibold" value={code} placeholder="000000"
          onChange={(e) => setCode(cleanCode(e.target.value).slice(0, LOGIN_CODE.length))} />
        <p className="text-xs text-slate-500">Vale {LOGIN_CODE.minutes} minutos e só funciona neste aparelho.</p>
      </div>
      <FormError message={err} />
      <Button type="submit" size="lg" className="w-full h-11 text-[15px] font-semibold" disabled={verify.isPending || code.length !== LOGIN_CODE.length}>
        {verify.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}Entrar
      </Button>
      <Button type="button" variant="outline" className="w-full" disabled={left > 0 || request.isPending} onClick={again}>
        {left > 0 ? `Pedir outro código (daqui a ${left} s)` : request.isPending ? "A pedir…" : "Pedir outro código"}
      </Button>
    </form>
  );
}

/** "Cria a tua palavra-passe" logo a seguir ao código (com "Agora não"). */
function ChoosePassword({ name, email, onDone }: { name: string | null; email: string | null; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const set = trpc.auth.password.set.useMutation();
  const problem = pw ? passwordProblem(pw, { name, email }) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (problem) { setErr(problem); return; }
    if (pw !== pw2) { setErr("As duas palavras-passe não são iguais."); return; }
    try {
      await set.mutateAsync({ password: pw });
      onDone();
    } catch (x: any) {
      setErr(x?.message ?? "Não foi possível guardar.");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" autoComplete="off">
      <p className="text-[15px] text-slate-500 leading-snug">
        Assim, da próxima vez entras só com o email e a palavra-passe (sem pedir código).
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="new-password">Palavra-passe nova</Label>
        <Input id="new-password" type="password" autoComplete="new-password" className="h-11 text-[15px]" value={pw} onChange={(e) => setPw(e.target.value)} />
        <p className={`text-xs ${problem ? "text-amber-700" : "text-slate-500"}`}>
          {problem ?? `Pelo menos ${PASSWORD_MIN} caracteres. Não uses o teu nome nem datas (como o dia de anos).`}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-password-2">Repete a palavra-passe</Label>
        <Input id="new-password-2" type="password" autoComplete="new-password" className="h-11 text-[15px]" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </div>
      <FormError message={err} />
      <Button type="submit" size="lg" className="w-full h-11 text-[15px] font-semibold" disabled={set.isPending || !pw || !pw2}>
        {set.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />}Guardar
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onDone}>Agora não</Button>
      <p className="text-xs text-slate-400">Sem palavra-passe, da próxima vez pedes outro código.</p>
    </form>
  );
}
