/**
 * Pedido de disponibilidade por WhatsApp logo a seguir a APROVAR uma
 * candidatura do site (Leads de Extras → Candidaturas do site → Aprovar, caixa
 * "Enviar pedido de disponibilidade").
 *
 * Não tem caminho de envio próprio: usa o MESMO `sendBroadcast` da página
 * Disponibilidades (`whatsapp.sendBroadcast`) e do pedido automático
 * (`extrasAutomation.sendAvailabilityRequest`), com a mensagem
 * `DEFAULT_WHATSAPP_TEMPLATE_ID` ("Pedido de disponibilidade"). O nome e a
 * língua do template vêm do registo por cidade (shared/driverTemplates.ts,
 * mensagem AVAILABILITY) — nunca daqui, nunca Lisboa por omissão.
 *
 * Regras:
 *  - Corre DEPOIS da aprovação e NUNCA lança: a aprovação fica sempre feita e
 *    o resultado (enviado / não enviado + motivo) volta ao ecrã.
 *  - Cidade do template = a cidade escolhida no diálogo. Se a ficha ficou
 *    noutra cidade (ficha existente com outro centro de custos, que a
 *    aprovação não move), não se envia: o pedido faz-se na Disponibilidades.
 *  - Mesmas proteções do envio da página: STOP, "Não enviar WhatsApp",
 *    número sem WhatsApp, o mesmo template nas últimas 24 h (D32).
 */
import { availabilityRangeError, availabilityRangeLabel } from "../shared/availabilityWeek";
import { mondayOfDay } from "../shared/taskRules";
import { CITY_LABELS, type CityKey } from "../shared/city";
import { driverCityFrom, driverCityLabel, driverTemplate, type City } from "../shared/driverTemplates";
import { DEFAULT_WHATSAPP_TEMPLATE_ID } from "../shared/whatsappTemplate";
import { normalizePhoneE164 } from "../shared/phone";
import type { BroadcastRecipient } from "./whatsappBroadcast";

/** Intervalo pedido no diálogo (dias ISO, dentro de uma semana segunda–domingo). */
export interface ApplicationAvailabilityRange {
  from: string;
  to: string;
}

export interface ApplicationAvailabilityOutcome {
  sent: boolean;
  /** Porque não foi enviado (texto para o utilizador); null quando foi. */
  reason: string | null;
  /** Cidade do template usada (ou que se ia usar). */
  city: City | null;
  /** Texto do {{semana}}: "semana de 13/10 a 19/10". */
  weekLabel: string;
  /** Difusão criada (auditoria); null quando nem se chegou a enviar. */
  broadcastId: number | null;
}

/** Ficha do extra tal como a vê o envio (mesma leitura do broadcast). */
export interface ApprovedExtraContact {
  phone: string | null;
}

export type CityDecision = { ok: true; city: City } | { ok: false; reason: string };

/**
 * Cidade do template para o pedido. PURA.
 *
 * `employeeCity` = cidade DERIVADA da ficha depois da aprovação
 * (server/employeeCity.ts); `chosenCity` = a escolhida no diálogo. Só diverge
 * quando a ficha já existia noutra cidade e não foi movida — aí não se escolhe
 * por ninguém.
 */
export function decideRequestCity(employeeCity: CityKey | null, chosenCity: CityKey): CityDecision {
  if (employeeCity && employeeCity !== chosenCity) {
    return {
      ok: false,
      reason: `a ficha ficou em ${CITY_LABELS[employeeCity]} (não foi movida para ${CITY_LABELS[chosenCity]}). Envia o pedido na página Disponibilidades.`,
    };
  }
  const city = driverCityFrom(chosenCity);
  if (!city) return { ok: false, reason: `${CITY_LABELS[chosenCity]} não tem templates de WhatsApp.` };
  if (!driverTemplate(city, "AVAILABILITY")) {
    return { ok: false, reason: `${driverCityLabel(city)} ainda não tem template de pedido de disponibilidade.` };
  }
  return { ok: true, city };
}

/** O número da ficha serve para WhatsApp? Motivo legível quando não. PURA. */
export function contactPhoneProblem(contact: ApprovedExtraContact): string | null {
  const raw = (contact.phone ?? "").trim();
  if (!raw) return "a ficha não tem telemóvel. Acrescenta-o na ficha e envia o pedido na página Disponibilidades.";
  if (!normalizePhoneE164(raw)) {
    return `o telemóvel da ficha (“${raw}”) não é um número válido para WhatsApp. Corrige-o na ficha e envia o pedido na página Disponibilidades.`;
  }
  return null;
}

/** Resultado do único destinatário do envio → enviado ou motivo. PURA. */
export function recipientOutcome(recipient: BroadcastRecipient | undefined): { sent: boolean; reason: string | null } {
  if (!recipient) return { sent: false, reason: "o envio não devolveu resultado para este extra." };
  switch (recipient.status) {
    case "sent":
      return { sent: true, reason: null };
    case "invalid_phone":
      return { sent: false, reason: "o telemóvel da ficha não é válido para WhatsApp." };
    default:
      return { sent: false, reason: recipient.error || "a Meta recusou o envio." };
  }
}

/** Código do envio (≤ 33 antes do sufixo da cidade): repetir a aprovação retoma, não duplica. PURA. */
export function applicationSendKey(applicationId: number, range: ApplicationAvailabilityRange): string {
  return `apv${applicationId}:${range.from}:${range.to}`;
}

/**
 * Envia o pedido de disponibilidade ao extra acabado de aprovar. Nunca lança.
 */
export async function sendApplicationAvailabilityRequest(opts: {
  applicationId: number;
  employeeId: number;
  chosenCity: CityKey;
  range: ApplicationAvailabilityRange;
  createdById: number;
}): Promise<ApplicationAvailabilityOutcome> {
  const { applicationId, employeeId, chosenCity, range, createdById } = opts;
  const weekLabel = availabilityRangeLabel(range.from, range.to);
  const notSent = (reason: string, city: City | null = null): ApplicationAvailabilityOutcome => {
    console.warn(`[candidaturas] pedido de disponibilidade da candidatura #${applicationId} (ficha ${employeeId}) não enviado: ${reason}`);
    return { sent: false, reason, city, weekLabel, broadcastId: null };
  };

  const rangeProblem = availabilityRangeError(range.from, range.to);
  if (rangeProblem) return notSent(rangeProblem);

  try {
    // Cidade primeiro: uma ficha que ficou noutra cidade recebe o motivo certo
    // (a leitura seguinte está limitada às cidades do pedido e não a veria).
    const { resolveCitiesForEmployeeIds } = await import("./employeeCity");
    const employeeCity = (await resolveCitiesForEmployeeIds([employeeId])).get(employeeId)?.city ?? null;
    const decision = decideRequestCity(employeeCity, chosenCity);
    if (!decision.ok) return notSent(decision.reason);
    const city = decision.city;

    // Mesma leitura do envio (só extras ativos, no alcance de cidades do pedido):
    // quem não está aqui também não seria encontrado pelo `sendBroadcast`.
    const { listActiveEmployeesByIds } = await import("./extrasAvailability");
    const [extra] = await listActiveEmployeesByIds([employeeId]);
    if (!extra) {
      return notSent("a ficha não é de um extra ativo nesta cidade (função ou centro de custos). Envia o pedido na página Disponibilidades.", city);
    }
    const phoneProblem = contactPhoneProblem(extra);
    if (phoneProblem) return notSent(phoneProblem, city);

    const { sendBroadcast } = await import("./whatsappBroadcast");
    let summary;
    try {
      summary = await sendBroadcast({
        templateId: DEFAULT_WHATSAPP_TEMPLATE_ID,
        cityByEmployee: { [employeeId]: city },
        bodyParam2: weekLabel,
        // O link do formulário (quando o template tem botão) abre esta semana.
        weekStart: mondayOfDay(range.from),
        note: `Pedido de disponibilidade ao aprovar a candidatura #${applicationId}`,
        createdById,
        sendKey: applicationSendKey(applicationId, range),
        // Igual ao envio da página: o mesmo template não volta antes de 24 h.
        blockRecentSameTemplate: true,
      });
    } catch (err: any) {
      // Validação do envio (WhatsApp por configurar, template por aprovar na Meta…).
      return notSent(err?.message || "erro no envio WhatsApp.", city);
    }
    const out = recipientOutcome(summary.recipients[0]);
    if (!out.sent) {
      console.warn(`[candidaturas] pedido de disponibilidade da candidatura #${applicationId} (ficha ${employeeId}) não enviado: ${out.reason}`);
    }
    return { sent: out.sent, reason: out.reason, city, weekLabel, broadcastId: summary.broadcastId ?? null };
  } catch (err: any) {
    return notSent(`erro inesperado (${err?.message || err}).`);
  }
}
