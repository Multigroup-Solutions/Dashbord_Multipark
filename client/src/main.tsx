import { trpc } from "@/lib/trpc";
import { AUTH_DENIED_PARAM, AUTH_DENIED_VALUE, UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { currentPath, getLoginUrl } from "./const";
import "./index.css";

const queryClient = new QueryClient();

// 20d: versão nova publicada com a app aberta — um pedaço antigo já não existe.
// Recarrega UMA vez (senão o ErrorBoundary mostra "Há uma versão nova").
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    try {
      if (sessionStorage.getItem("mp.reloadedForNewVersion")) return;
      sessionStorage.setItem("mp.reloadedForNewVersion", "1");
    } catch { /* sem storage: tenta na mesma */ }
    event.preventDefault();
    window.location.reload();
  });
}

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;
  // 20d: acabou de ser recusada a entrada (?auth=denied) — mandar para a
  // Google outra vez fazia um ciclo (recusado → entrada → 401 → Google…).
  if (new URLSearchParams(window.location.search).get(AUTH_DENIED_PARAM) === AUTH_DENIED_VALUE) return;

  // a sessão caiu: entra e volta à página onde estavas
  window.location.href = getLoginUrl(currentPath());
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
