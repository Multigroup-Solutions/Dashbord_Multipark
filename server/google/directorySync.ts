/**
 * Diretório da empresa (People API `listDirectoryPeople`, perfis do domínio)
 * → cache `google_directory_people`. Uma leitura completa por dia dentro do
 * cron google-sync; resumível (pageToken guardado a cada página) para caber
 * nos 45 s. No fim de uma leitura completa: quem não apareceu fica apagado
 * (deletedAt) e as linhas são ligadas às contas/fichas pelo email.
 *
 * Motor sem BD nem rede (DirectoryStore + PeopleApiLike) — testável.
 */
import { DIRECTORY_REFRESH_HOURS, mapDirectoryPerson, type DirectoryPersonRow } from "../../shared/contacts";
import type { PeopleApiLike } from "./peopleApi";

export interface DirectoryState {
  pageToken: string | null;
  runStartedMs: number | null;
  lastFullSyncAt: string | null;
}

export interface DirectoryStore {
  getState(): Promise<DirectoryState>;
  saveState(patch: Partial<DirectoryState> & { lastRunAt?: string | null; lastError?: string | null; peopleCount?: number }): Promise<void>;
  upsertPeople(rows: readonly DirectoryPersonRow[], runMs: number): Promise<void>;
  /** Fecha a corrida: apaga os não vistos, liga a contas/fichas; devolve quantos ficaram. */
  finishRun(runMs: number): Promise<number>;
}

export interface DirectorySyncResult { pages: number; upserted: number; skipped: number; done: boolean; count: number | null }

/** Está na altura de ler o diretório? (a meio de uma corrida, ou passou o intervalo) PURA. */
export function directoryDue(s: Pick<DirectoryState, "pageToken" | "lastFullSyncAt">, nowMs: number, hours = DIRECTORY_REFRESH_HOURS): boolean {
  if (s.pageToken) return true;
  if (!s.lastFullSyncAt) return true;
  const t = Date.parse(`${String(s.lastFullSyncAt).replace(" ", "T")}Z`);
  return !Number.isFinite(t) || nowMs - t >= hours * 3_600_000;
}

const sqlNow = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export async function syncDirectory(api: PeopleApiLike, store: DirectoryStore, opts: { deadlineAt: number; now?: () => number; pageSize?: number }): Promise<DirectorySyncResult> {
  const now = opts.now ?? Date.now;
  const out: DirectorySyncResult = { pages: 0, upserted: 0, skipped: 0, done: false, count: null };
  const st = await store.getState();
  let pageToken = st.pageToken;
  const runMs = pageToken && st.runStartedMs ? st.runStartedMs : now();
  if (!pageToken) await store.saveState({ runStartedMs: runMs });
  for (let i = 0; i < 200; i++) {
    if (now() > opts.deadlineAt - 3_000) break;
    const page = await api.listDirectory({ pageToken, pageSize: opts.pageSize ?? 500 });
    out.pages++;
    const rows: DirectoryPersonRow[] = [];
    for (const p of page.people) {
      const r = mapDirectoryPerson(p);
      if (!r || r.deleted) { out.skipped++; continue; }
      rows.push(r);
    }
    if (rows.length) await store.upsertPeople(rows, runMs);
    out.upserted += rows.length;
    pageToken = page.nextPageToken;
    if (!pageToken) {
      out.count = await store.finishRun(runMs);
      await store.saveState({ pageToken: null, runStartedMs: null, lastFullSyncAt: sqlNow(now()), lastRunAt: sqlNow(now()), lastError: null, peopleCount: out.count });
      out.done = true;
      return out;
    }
    await store.saveState({ pageToken, runStartedMs: runMs, lastRunAt: sqlNow(now()) });
  }
  return out;
}
