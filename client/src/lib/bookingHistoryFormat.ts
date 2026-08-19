// Tradutor do histórico de reservas da Multipark para linhas legíveis PT
// (pedido Jorge: o modifiedFields vinha cru — JSON com aspas, "_type":
// "snapshot", MP-STRIPE-… — ilegível nas Reclamações e Perdidos & Achados).
//
// Dois formatos na origem:
//  - CREATED  → snapshot: {"_version":2,"_type":"snapshot", campo: valor, …}
//  - UPDATE/… → diff:     {campo: {from: a, to: b}, …}

const FIELD_LABELS: Record<string, string> = {
  status: "Estado",
  bookingPrice: "Preço",
  parkingPrice: "Estacionamento",
  deliveryPrice: "Entrega",
  parkingType: "Parque",
  deliveryType: "Local de entrega",
  allocation: "Lugar",
  returnFlight: "Voo de regresso",
  departingFlight: "Voo de partida",
  arrivalFlight: "Voo de chegada",
  checkInTime: "Hora de entrada",
  checkOutTime: "Hora de saída",
  checkIn: "Entrada",
  checkOut: "Saída",
  checkInDate: "Data de entrada",
  checkOutDate: "Data de saída",
  licensePlate: "Matrícula",
  carLocation: "Localização do carro",
  row: "Fila",
  spot: "Lugar",
  garage: "Garagem",
  parkBrand: "Marca",
  city: "Cidade",
  totalPrice: "Preço total",
  paymentMethod: "Pagamento",
  hasOnlinePayment: "Pago online",
  remarks: "Observações",
  clientFirstName: "Nome",
  clientLastName: "Apelido",
  clientEmail: "Email",
  clientPhone: "Telefone",
};

const STATUS_PT: Record<string, string> = {
  BOOKED: "Reservada", PENDING: "Pendente", PENDING_PAYMENT: "Pend. pagamento",
  CONFIRMED: "Confirmada", CHECKED_IN: "Check-in", CHECKING_IN: "A entrar",
  MOVING: "Em movimento", CHECKED_OUT: "Check-out", CHECKING_OUT: "A sair",
  PENDING_CHECKOUT: "Pend. check-out", CANCELLED: "Cancelada", COMPLETED: "Concluída",
  UNCOVERED: "Descoberto", COVERED: "Coberto", DAY: "por dia",
};

// Campos técnicos que nunca interessam ao utilizador
const SKIP = new Set(["_version", "_type", "clientId", "language", "pricingType", "taxNumber", "taxAddress", "id", "updatedAt", "createdAt"]);

const isBlank = (v: unknown) =>
  v == null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

function fmtVal(key: string, v: unknown): string | null {
  if (isBlank(v)) return null;
  if (typeof v === "boolean") return v ? "sim" : "não";
  let s = String(v);
  // Datas ISO → dd/mm/aaaa hh:mm
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const p = (n: number) => String(n).padStart(2, "0");
      s = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  if (STATUS_PT[s]) s = STATUS_PT[s];
  // URLs de mapa → só a palavra "mapa"
  if (/^https?:\/\//.test(s)) return "mapa";
  if (/price$/i.test(key) && /^\d+(\.\d+)?$/.test(String(v))) s = `${v} €`;
  if (Array.isArray(v)) s = v.map((x: any) => x?.name ?? x).join(", ");
  return s;
}

/** Devolve linhas legíveis; se não for JSON, devolve o texto original. */
export function formatBookingHistoryDetails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const txt = String(raw).trim();
  if (!txt.startsWith("{")) return [txt];
  let obj: Record<string, any>;
  try { obj = JSON.parse(txt); } catch { return [txt]; }

  const lines: string[] = [];
  for (const [key, v] of Object.entries(obj)) {
    if (SKIP.has(key)) continue;
    // Pagamento Stripe: o id técnico não interessa — a confirmação sim
    if (key === "paymentIntentId") {
      const to = (v as any)?.to ?? v;
      if (typeof to === "string" && to.startsWith("pi_")) lines.push("Pagamento online confirmado");
      continue;
    }
    const label = FIELD_LABELS[key] ?? key;
    // Diff {from, to}
    if (v && typeof v === "object" && !Array.isArray(v) && ("from" in v || "to" in v)) {
      const from = fmtVal(key, (v as any).from);
      const to = fmtVal(key, (v as any).to);
      if (from === to) continue;           // sem mudança real
      if (!from && !to) continue;          // null → "" e afins
      if (!from) lines.push(`${label}: ${to}`);
      else if (!to) lines.push(`${label}: ${from} (removido)`);
      else lines.push(`${label}: ${from} → ${to}`);
      continue;
    }
    // Snapshot campo: valor
    const val = fmtVal(key, v);
    if (val != null) lines.push(`${label}: ${val}`);
  }
  return lines;
}
