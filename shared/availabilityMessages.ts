// Mensagens-tipo dos pedidos de disponibilidade (pedido do Jorge 2026-08-06).
// UM builder para email E WhatsApp: o email usa subject+lines+cta; o WhatsApp
// usa text() como {{2}} do template Meta. Todos terminam com "Inscreve-te".

export type AvailabilityMessageKind = "week" | "day_shift" | "day_hours" | "day_range";

export type AvailabilityMessageParams = {
  kind: AvailabilityMessageKind;
  /** Rótulo humano da semana (ex.: "11/08 a 17/08") — kind=week */
  weekLabel?: string;
  /** Rótulo humano do dia (ex.: "amanhã (07/08)") — kinds de dia */
  dateLabel?: string;
  /** Turno — kind=day_shift */
  shift?: "morning" | "afternoon" | "night";
  /** Horas — kind=day_range */
  fromHour?: number;
  toHour?: number;
  /** Nota livre opcional (vai no fim, antes do CTA) */
  note?: string | null;
};

const SHIFT_LABELS: Record<string, string> = {
  morning: "da manhã",
  afternoon: "da tarde",
  night: "da noite",
};

export const AVAILABILITY_KINDS: Array<{ id: AvailabilityMessageKind; label: string }> = [
  { id: "week", label: "Semana inteira (o clássico)" },
  { id: "day_shift", label: "Dia + turno (Estás disponível…?)" },
  { id: "day_hours", label: "Dia (Que horas podes fazer?)" },
  { id: "day_range", label: "Dia + horas certas (Preciso de condutor das X às Y)" },
];

export function buildAvailabilityMessage(p: AvailabilityMessageParams): {
  subject: string;
  lines: string[]; // parágrafos do corpo (sem o CTA)
  cta: string;     // texto do botão/última linha
  text: string;    // versão texto único (WhatsApp {{2}} / plain-text)
} {
  const day = p.dateLabel ?? "amanhã";
  let subject = "";
  let lines: string[] = [];

  switch (p.kind) {
    case "day_shift": {
      const shift = SHIFT_LABELS[p.shift ?? "morning"] ?? "da manhã";
      subject = `Estás disponível ${day} no turno ${shift}?`;
      lines = [
        `Estás disponível para trabalhar ${day} no turno ${shift}?`,
        "Se sim, marca já a tua disponibilidade — é meio minuto.",
      ];
      break;
    }
    case "day_hours": {
      subject = `Que horas podes fazer ${day}?`;
      lines = [
        `Precisamos de reforço ${day}. Que horas podes fazer?`,
        "Marca as horas em que estás disponível — é meio minuto.",
      ];
      break;
    }
    case "day_range": {
      const from = p.fromHour ?? 8;
      const to = p.toHour ?? 20;
      subject = `Preciso de um condutor ${day} das ${from}h às ${to}h`;
      lines = [
        `Preciso de um condutor ${day} das ${from}h às ${to}h.`,
        `Podes fazer este horário? Basta marcares disponível das ${from}h às ${to}h.`,
      ];
      break;
    }
    case "week":
    default: {
      const week = p.weekLabel ?? "a próxima semana";
      subject = `Disponibilidade — semana de ${week}`;
      lines = [
        `Indica a tua disponibilidade para a semana de ${week} (dias e horas).`,
        "É rápido: abre o link no telemóvel.",
      ];
      break;
    }
  }

  if (p.note?.trim()) lines.push(p.note.trim());
  const cta = "Inscreve-te 👉";
  const text = [...lines, cta].join(" ");
  return { subject, lines, cta, text };
}
