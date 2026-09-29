// Google Picker (opcional): escolher um ficheiro do Drive dá à app acesso SÓ
// a esse ficheiro (drive.file). Precisa de VITE_GOOGLE_PICKER_API_KEY (chave
// de browser restrita ao domínio e à Picker API) e VITE_GOOGLE_PICKER_APP_ID
// (n.º do projeto Google Cloud). Sem isto — ou se o servidor não conseguir um
// token só com drive.file — fica o "colar o link".
import { useCallback, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export interface PickedFile { id: string; name: string; mimeType: string | null; url: string | null }

const API_KEY = (import.meta.env.VITE_GOOGLE_PICKER_API_KEY as string | undefined) ?? "";
const APP_ID = (import.meta.env.VITE_GOOGLE_PICKER_APP_ID as string | undefined) ?? "";
export const pickerConfigured = !!API_KEY && !!APP_ID;

let loading: Promise<void> | null = null;
function loadPickerApi(): Promise<void> {
  const w = window as any;
  if (w.google?.picker) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const done = () => w.gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("picker")) });
    if (w.gapi?.load) { done(); return; }
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.async = true;
    s.onload = done;
    s.onerror = () => { loading = null; reject(new Error("Não foi possível carregar o Google Picker.")); };
    document.head.appendChild(s);
  });
  return loading;
}

export function useGooglePicker() {
  const tokenMut = trpc.googleDrive.pickerToken.useMutation();
  const [busy, setBusy] = useState(false);
  const open = useCallback(async (o: { kind?: "any" | "spreadsheet"; title?: string } = {}): Promise<PickedFile | null> => {
    if (!pickerConfigured) return null;
    setBusy(true);
    try {
      const [tok] = await Promise.all([tokenMut.mutateAsync(), loadPickerApi()]);
      if (!tok?.token) {
        toast.message("Escolher do Drive indisponível — cola o link do ficheiro.");
        return null;
      }
      const g = (window as any).google;
      const view = o.kind === "spreadsheet" ? new g.picker.View(g.picker.ViewId.SPREADSHEETS) : new g.picker.DocsView().setIncludeFolders(false);
      // Diálogos modais (Radix) bloqueiam cliques fora deles: liberta enquanto o Picker está aberto.
      const prevPointer = document.body.style.pointerEvents;
      document.body.style.pointerEvents = "auto";
      return await new Promise<PickedFile | null>((resolve) => {
        const picker = new g.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(tok.token)
          .setDeveloperKey(API_KEY)
          .setAppId(APP_ID)
          .setLocale("pt-PT")
          .setTitle(o.title ?? "Escolher do Google Drive")
          .setCallback((data: any) => {
            const action = data?.[g.picker.Response.ACTION];
            if (action === g.picker.Action.PICKED) {
              const doc = data[g.picker.Response.DOCUMENTS]?.[0];
              document.body.style.pointerEvents = prevPointer;
              resolve(doc ? { id: String(doc[g.picker.Document.ID]), name: String(doc[g.picker.Document.NAME] ?? ""), mimeType: doc[g.picker.Document.MIME_TYPE] ?? null, url: doc[g.picker.Document.URL] ?? null } : null);
            } else if (action === g.picker.Action.CANCEL) {
              document.body.style.pointerEvents = prevPointer;
              resolve(null);
            }
          })
          .build();
        picker.setVisible(true);
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Não foi possível abrir o Google Picker.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [tokenMut]);
  return { open, busy, available: pickerConfigured };
}
