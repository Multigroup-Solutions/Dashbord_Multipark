/**
 * Links do Google Drive na conta certa (Jorge, 14 out 2026: "abre um drive
 * qualquer" — com várias contas Google no browser abria a pessoal).
 *
 * O menu abre o Drive com `window.open` logo no clique (sem esperar por nada,
 * senão o browser bloqueia o separador), por isso o id do Shared Drive e o
 * email ficam guardados aqui de antemão: o layout chama `useDriveLinkContext`
 * e `driveUrl()` só lê o que já cá está. Sem dados, cai na lista dos Drives
 * partilhados (e sem email, sem `authuser`).
 */
import { useEffect, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { driveAuthEmail, googleDriveUrl, type GoogleDriveView } from "@shared/drive";

export type DriveLinkContext = { email: string | null; sharedDriveId: string | null };

const cached: DriveLinkContext = { email: null, sharedDriveId: null };

/** URL do Drive para abrir já, com o que está em cache (Shared Drive da empresa por omissão). */
export function driveUrl(view: GoogleDriveView = "shared"): string {
  return googleDriveUrl(view, cached);
}

/**
 * Vai buscar (em cache, 1 h) o id do Shared Drive e o email Google da pessoa e
 * guarda-os para o menu. Num aparelho partilhado (PDA), a resposta de quem
 * esteve antes nunca serve a quem entra a seguir: só conta a do próprio userId.
 */
export function useDriveLinkContext(user: { id: number; email?: string | null } | null | undefined): DriveLinkContext {
  const q = trpc.googleDrive.sharedDriveLink.useQuery(undefined, {
    enabled: !!user, staleTime: 60 * 60_000, retry: false, refetchOnWindowFocus: false,
  });
  const mine = q.data && user && q.data.userId === user.id ? q.data : null;
  const stale = !!q.data && !!user && q.data.userId !== user.id;
  useEffect(() => { if (stale && !q.isFetching) void q.refetch(); }, [stale, q.isFetching]); // eslint-disable-line react-hooks/exhaustive-deps
  const email = user ? driveAuthEmail(mine?.googleEmail, user.email) : null;
  const sharedDriveId = mine?.sharedDriveId ?? null;
  useEffect(() => { cached.email = email; cached.sharedDriveId = sharedDriveId; }, [email, sharedDriveId]);
  return useMemo(() => ({ email, sharedDriveId }), [email, sharedDriveId]);
}
