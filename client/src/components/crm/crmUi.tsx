/**
 * CRM — peças visuais partilhadas pela lista, ficha e "Rever fichas"
 * (desenho aprovado 27 set 2026: _design canvas "Clientes").
 */
import { getAppTimeZone } from "@/lib/lisbonTime";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export const SEGMENT_LABEL: Record<string, string> = {
  new: "Novo", recurring: "Recorrente", vip: "VIP", at_risk: "Em risco", partner: "Via parceiro", pro: "Pro",
};

const SEGMENT_CLASS: Record<string, string> = {
  vip: "bg-[#0e2957] text-white dark:bg-[#1f6be0]",
  recurring: "bg-secondary text-secondary-foreground",
  new: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  pro: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  at_risk: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  partner: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
};

/** Etiqueta redonda do desenho (22 px, 11 px bold). */
export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-bold", className)}>
      {children}
    </span>
  );
}

export function SegmentPill({ id }: { id: string }) {
  return <Pill className={SEGMENT_CLASS[id] ?? "bg-muted text-foreground"}>{SEGMENT_LABEL[id] ?? id}</Pill>;
}

/** O segmento principal de uma ficha (um só, para o cartão). */
export function mainSegment(segments: string[], isPro: boolean): string | null {
  if (isPro) return "pro";
  for (const s of ["vip", "at_risk", "recurring", "new", "partner"]) if (segments.includes(s)) return s;
  return null;
}

export const ALERT_CLASS = "text-amber-700 dark:text-amber-300";

// ─── Cores dos carros (nomes em PT e EN, como vêm das reservas) ────────────
const CAR_COLORS: [RegExp, string][] = [
  [/preto|black|negro/i, "#111827"],
  [/branc|white/i, "#f8fafc"],
  [/cinz|gr[ae]y|grafite|graphite/i, "#94a3b8"],
  [/prat|silver/i, "#cbd5e1"],
  [/vermelh|red|bord[eô]|burgund/i, "#c1121f"],
  [/azul|blue|navy/i, "#1d4ed8"],
  [/verde|green/i, "#15803d"],
  [/amarel|yellow/i, "#eab308"],
  [/laranj|orange/i, "#ea580c"],
  [/castanh|brown|marrom/i, "#78350f"],
  [/beg|beige|creme|cream/i, "#d6c7a1"],
  [/dourad|gold/i, "#b59410"],
  [/rox|purple|violet|lil[aá]s/i, "#7c3aed"],
  [/rosa|pink/i, "#ec4899"],
];
export function carColorHex(color: string | null | undefined): string | null {
  if (!color) return null;
  for (const [re, hex] of CAR_COLORS) if (re.test(color)) return hex;
  return null;
}

export function ColorSwatch({ color, className }: { color: string | null | undefined; className?: string }) {
  const hex = carColorHex(color);
  return (
    <span
      title={color ?? "cor desconhecida"}
      className={cn("inline-block h-3 w-3 shrink-0 rounded-[3px] border border-black/15", !hex && "bg-[repeating-linear-gradient(45deg,#e2e8f0_0_2px,#fff_2px_4px)]", className)}
      style={hex ? { background: hex } : undefined}
    />
  );
}

/** Silhueta de carro do desenho, pintada com a cor do carro. */
export function CarGlyph({ color, className }: { color?: string | null; className?: string }) {
  const fill = carColorHex(color) ?? "#94a3b8";
  return (
    <svg viewBox="0 0 84 50" fill="none" className={className} aria-hidden>
      <path d="M8 34c0-5 3-8 8-9l10-12c2-2 4-3 7-3h18c3 0 5 1 7 3l9 11c6 1 10 4 10 10v5H8z" fill={fill} stroke="rgba(0,0,0,.12)" />
      <path d="M30 14h22l7 10H23z" fill="#dbeafe" />
      <circle cx="24" cy="40" r="7" fill="#0c1f3f" />
      <circle cx="62" cy="40" r="7" fill="#0c1f3f" />
    </svg>
  );
}

export function initialsOf(name: string | null | undefined): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/**
 * Foto do cliente; sem foto, a do carro; sem nenhuma, as iniciais (ou o
 * desenho do carro na cor dele, com `carFallback`).
 */
export function ClientAvatar({ name, photoUrl, carPhotoUrl, carColor, vip, size = 44, carFallback = false, className }: {
  name: string | null | undefined; photoUrl?: string | null; carPhotoUrl?: string | null; carColor?: string | null;
  vip?: boolean; size?: number; carFallback?: boolean; className?: string;
}) {
  const src = photoUrl || carPhotoUrl || null;
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size / 3)) };
  if (src) {
    return <img src={src} alt="" style={style} className={cn("shrink-0 rounded-full object-cover", className)} loading="lazy" />;
  }
  if (carFallback) {
    return (
      <span style={style} className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary", className)}>
        <CarGlyph color={carColor} className="w-3/4" />
      </span>
    );
  }
  return (
    <span
      style={style}
      className={cn("flex shrink-0 items-center justify-center rounded-full font-display font-bold",
        vip ? "bg-[#0e2957] text-white dark:bg-[#1f6be0]" : "bg-secondary text-primary", className)}
    >
      {initialsOf(name)}
    </span>
  );
}

// ─── Números e datas ────────────────────────────────────────────────────────
export const eur = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: digits, minimumFractionDigits: 0 });

export const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("pt-PT"));

/** "YYYY-MM-DD HH:MM:SS" (UTC, como vem da API) → Date. */
export function utcDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
}

const shortFmt = new Map<string, Intl.DateTimeFormat>();
function fmtWith(key: string, opts: Intl.DateTimeFormatOptions) {
  const tz = getAppTimeZone();
  const k = key + tz;
  let f = shortFmt.get(k);
  if (!f) { f = new Intl.DateTimeFormat("pt-PT", { timeZone: tz, ...opts }); shortFmt.set(k, f); }
  return f;
}

/** "10 set" (ou "10 set 2024" noutro ano). */
export function shortDate(s: string | null | undefined): string {
  const d = utcDate(s);
  if (!d) return "—";
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return fmtWith(sameYear ? "dm" : "dmy", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" })
    .format(d).replace(/\./g, "").replace(/ de /g, " ");
}

/** "mar 2019" */
export function monthYear(s: string | null | undefined): string {
  const d = utcDate(s);
  if (!d) return "—";
  return fmtWith("my", { month: "short", year: "numeric" }).format(d).replace(/\./g, "").replace(/ de /g, " ");
}

export function shortDateTime(s: string | null | undefined): string {
  const d = utcDate(s);
  if (!d) return "—";
  return `${shortDate(s)}, ${fmtWith("hm", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d)}`;
}

/** "há 17 dias" / "daqui a 3 dias". */
export function relDays(s: string | null | undefined): string {
  const d = utcDate(s);
  if (!d) return "";
  const days = Math.round((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "hoje";
  if (days === 1) return "ontem";
  if (days === -1) return "amanhã";
  if (days < 0) return `daqui a ${-days} dias`;
  if (days < 60) return `há ${days} dias`;
  if (days < 730) return `há ${Math.round(days / 30.44)} meses`;
  return `há ${Math.floor(days / 365.25)} anos`;
}

export const BOOKING_STATUS: Record<string, { label: string; className: string }> = {
  BOOKED: { label: "Reservada", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200" },
  PENDING: { label: "Pendente", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200" },
  PENDING_PAYMENT: { label: "Pend. pagamento", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200" },
  CONFIRMED: { label: "Confirmada", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200" },
  CHECKED_IN: { label: "No parque", className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" },
  CHECKING_IN: { label: "A entrar", className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" },
  MOVING: { label: "Em movimento", className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" },
  CHECKING_OUT: { label: "A sair", className: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200" },
  PENDING_CHECKOUT: { label: "Pend. check-out", className: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200" },
  CHECKED_OUT: { label: "Entregue", className: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200" },
  COMPLETED: { label: "Concluída", className: "bg-muted text-foreground" },
  CANCELLED: { label: "Cancelada", className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200" },
};

export function BookingStatusPill({ status }: { status: string | null | undefined }) {
  const key = String(status ?? "").toUpperCase();
  const s = BOOKING_STATUS[key] ?? (key.includes("CANCEL") ? BOOKING_STATUS.CANCELLED : null);
  return <Pill className={s?.className ?? "bg-muted text-muted-foreground"}>{s?.label ?? (status || "—")}</Pill>;
}

/** Rótulo pequeno em maiúsculas (".lbl" do desenho). */
export function Lbl({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-[11px] font-bold uppercase tracking-[0.05em] text-muted-foreground", className)}>{children}</span>;
}

/** Telefone E.164 → "+351 912 345 678" (só para mostrar). */
export function fmtPhone(p: string | null | undefined): string {
  if (!p) return "—";
  const m = p.match(/^\+351(\d{3})(\d{3})(\d{3})$/);
  if (m) return `+351 ${m[1]} ${m[2]} ${m[3]}`;
  return p;
}

/** Link de WhatsApp para um número E.164. */
export const waLink = (p: string) => `https://wa.me/${p.replace(/\D/g, "")}`;

// ─── Cartões (35a: todos os separadores do CRM em cartões ou lista) ─────────
/** Número pequeno de um cartão: rótulo em cima, valor em baixo. */
export function CardKpi({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="text-[10px] font-bold uppercase text-muted-foreground">{label}</div>
      <div className="font-bold tabular-nums">{value}</div>
    </div>
  );
}

/** Grelha dos cartões — a mesma dos Clientes. */
export const CARD_GRID = "grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4";
/** Caixa de um cartão clicável — a mesma dos Clientes. */
export const CARD_BOX = "flex flex-col gap-2.5 rounded-[10px] border bg-card p-3.5 text-left text-foreground transition-shadow hover:shadow-[0_6px_20px_rgba(12,31,63,.08)]";

