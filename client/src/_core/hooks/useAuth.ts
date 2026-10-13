import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo } from "react";
import { getPdaToken, markClaimed } from "@/lib/pdaDevice";
import { disablePush } from "@/lib/webPush";
import { RECENT_SEARCHES_KEY } from "@shared/globalSearch";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath = getLoginUrl() } =
    options ?? {};
  const utils = trpc.useUtils();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Fase 2: sair num PDA registado solta-o (fica livre para o próximo turno)
  const releasePda = trpc.operational.pdas.releaseOnLogout.useMutation();
  // Plano 56: os avisos no telemóvel são de todos (antes só do WhatsApp).
  const pushUnsubscribe = trpc.notifications.pushUnsubscribe.useMutation();

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      utils.auth.me.setData(undefined, null);
    },
  });

  const logout = useCallback(async () => {
    const pdaToken = getPdaToken();
    const me = meQuery.data as { id: number; pdaSession?: { tag: string } | null } | null | undefined;
    const pdaSession = me?.pdaSession ?? null;
    // Plano 56 (A2): num PDA, o logout diz que sessão este separador tem — se
    // outro separador já entrou com outra pessoa, o servidor não mexe em nada.
    const expect = me && (pdaSession || pdaToken) ? { userId: me.id, tag: pdaSession?.tag ?? null } : undefined;
    if (pdaToken && !pdaSession) {
      try { await releasePda.mutateAsync({ token: pdaToken }); } catch (err) { console.warn("[pda] soltar o PDA no logout falhou:", err); /* não impede o logout */ }
    }
    markClaimed(null);
    // 20d: as pesquisas recentes (nomes, matrículas) não ficam para quem usar o aparelho a seguir (PDAs partilhados).
    try { localStorage.removeItem(RECENT_SEARCHES_KEY); sessionStorage.clear(); } catch { /* sem storage */ }
    // Este browser deixa de receber avisos desta pessoa (chamadas, códigos de
    // entrada) — ainda com a sessão válida, para o servidor apagar a subscrição.
    // Sessão de PDA: o servidor solta o PDA e desliga os avisos dele (o browser
    // continua subscrito para quem entrar a seguir).
    if (!pdaSession) {
      try {
        const endpoint = await disablePush();
        if (endpoint) await pushUnsubscribe.mutateAsync({ endpoint });
      } catch (err) { console.warn("[push] desativar no logout falhou:", err); /* não impede o logout */ }
    }
    try {
      await logoutMutation.mutateAsync(expect ? { expect } : undefined);
    } catch (error: unknown) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        return;
      }
      throw error;
    } finally {
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [logoutMutation, releasePda, pushUnsubscribe, utils, meQuery.data]);

  const state = useMemo(() => {
    return {
      user: meQuery.data ?? null,
      loading: meQuery.isLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
    };
  }, [
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
    logoutMutation.error,
    logoutMutation.isPending,
  ]);

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutMutation.isPending) return;
    if (state.user) return;
    if (typeof window === "undefined") return;
    if (window.location.pathname === redirectPath) return;

    window.location.href = redirectPath
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    logoutMutation.isPending,
    meQuery.isLoading,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
