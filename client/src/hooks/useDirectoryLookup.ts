// Diretório da empresa (Google Workspace) para as linhas visíveis de uma
// lista (Utilizadores, RH): foto, cargo, departamento e telefone por email.
// Só a página atual (≤ 200 emails); sem acesso → mapa vazio (a lista fica igual).
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";

export type DirectoryInfo = { photoUrl: string | null; jobTitle: string | null; department: string | null; phone: string | null };

export function useDirectoryLookup(emails: Array<string | null | undefined>): Record<string, DirectoryInfo> {
  const list = useMemo(() => Array.from(new Set(emails.map((e) => String(e ?? "").trim().toLowerCase()).filter((e) => e.includes("@")))).sort().slice(0, 200), [emails]);
  const q = trpc.contacts.directory.lookup.useQuery({ emails: list }, { enabled: list.length > 0, staleTime: 10 * 60_000, retry: false });
  return q.data ?? {};
}

export const directoryInfoFor = (map: Record<string, DirectoryInfo>, email: string | null | undefined): DirectoryInfo | null =>
  email ? map[String(email).trim().toLowerCase()] ?? null : null;
