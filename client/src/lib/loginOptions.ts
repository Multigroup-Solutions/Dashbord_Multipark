/**
 * Plano 56: "Entrar com email e código" ligado? O servidor diz (auth.options);
 * aqui fica a última resposta conhecida neste aparelho, para o `getLoginUrl`
 * (síncrono) mandar para a página de entrada em vez de ir direto à Google.
 * Sem resposta conhecida → como antes (Google). Tudo em try/catch: em modo
 * privado o storage pode falhar.
 */
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";

const KEY = "mp.codeLogin";
let cached: boolean | null = null;

export function codeLoginCached(): boolean {
  if (cached != null) return cached;
  try { cached = localStorage.getItem(KEY) === "1"; } catch { cached = false; }
  return cached;
}

export function rememberCodeLogin(on: boolean): void {
  cached = on;
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* sem storage */ }
}

/** O interruptor (e guarda-o para o getLoginUrl). `undefined` enquanto carrega. */
export function useCodeLoginOption(): { codeLogin: boolean | undefined; resendAfterSec: number; googleOnPdas: boolean } {
  const q = trpc.auth.options.useQuery(undefined, { staleTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false });
  useEffect(() => {
    if (q.data) rememberCodeLogin(q.data.codeLogin);
  }, [q.data]);
  return {
    codeLogin: q.data ? q.data.codeLogin : q.isError ? false : undefined,
    resendAfterSec: q.data?.resendAfterSec ?? 60,
    // A2: o Google aparece nos PDAs registados? (sem resposta → sim, como hoje)
    googleOnPdas: q.data?.googleOnPdas ?? true,
  };
}
