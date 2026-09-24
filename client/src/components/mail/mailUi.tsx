// Peças pequenas partilhadas pela Comunicação (email).
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { MAIL_BRAND_LABELS, MAIL_LINK_LABELS, isMailBrand, type MailLinkType } from "@shared/mail";

/** Data da BD (UTC "YYYY-MM-DD HH:MM:SS") → Date. */
export function dbDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** HH:MM hoje, senão DD/MM (lista). */
export function listTime(s: string | null | undefined, now = Date.now()): string {
  const d = dbDate(s);
  if (!d) return "";
  const t = new Date(now);
  const same = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  return same ? d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
}

export function fullTime(s: string | null | undefined): string {
  const d = dbDate(s);
  return d ? d.toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" }) : "";
}

/** "há 3 h" / "há 2 d". */
export function waitingLabel(s: string | null | undefined, now = Date.now()): string {
  const d = dbDate(s);
  if (!d) return "";
  const m = Math.max(0, Math.round((now - d.getTime()) / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export function BrandChip({ brand }: { brand: string | null | undefined }) {
  if (!brand || !isMailBrand(brand)) return null;
  return <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">{MAIL_BRAND_LABELS[brand]}</span>;
}

export function LinkChip({ type, id }: { type: string; id: string }) {
  const label = MAIL_LINK_LABELS[type as MailLinkType] ?? type;
  const short = type === "client" ? id : type === "booking" ? id.slice(0, 10) : `#${id}`;
  return <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] font-normal max-w-[180px] truncate">{label} {short}</Badge>;
}

/** Onde abrir o registo ligado (null = sem página própria). */
export const MAIL_LINK_HREF: Record<MailLinkType, (id: string) => string | null> = {
  client: (id) => `/clientes?email=${encodeURIComponent(id)}`,
  booking: () => null,
  complaint: (id) => `/reclamacoes?id=${encodeURIComponent(id)}`,
  lost_found: (id) => `/perdidos-achados/caso/${encodeURIComponent(id)}`,
  incident: (id) => `/ocorrencias?id=${encodeURIComponent(id)}`,
};

/**
 * HTML do email num iframe SANDBOX (sem scripts; o servidor já o limpou e
 * bloqueou as imagens remotas). Altura ajustada ao conteúdo.
 */
export function EmailHtmlFrame({ doc }: { doc: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(120);
  useEffect(() => { setH(120); }, [doc]);
  const measure = () => {
    try {
      const el = ref.current?.contentDocument?.documentElement;
      if (el) setH(Math.min(4000, Math.max(60, el.scrollHeight + 8)));
    } catch { /* sem acesso → altura fixa */ }
  };
  return (
    <iframe
      ref={ref}
      title="Conteúdo do email"
      srcDoc={doc}
      // Sem allow-scripts: nenhum script corre. allow-same-origin só para medir a altura.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={measure}
      className="w-full border-0 bg-white rounded-md"
      style={{ height: h }}
    />
  );
}
