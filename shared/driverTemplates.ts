/**
 * Registo dos templates WhatsApp dos motoristas extra, POR CIDADE — fonte única
 * de verdade para o NOME e a LÍNGUA de cada envio (cliente e servidor).
 *
 * Regras:
 *  - Nenhum componente nem job escreve nomes de template à mão: pede ao registo
 *    `driverTemplate(cidade, mensagem)`.
 *  - A língua do envio vem SEMPRE daqui. `pt_PT` ≠ `pt_BR` ≠ `pt` para a Meta;
 *    uma língua errada devolve o erro 132001.
 *  - Acrescentar uma cidade = acrescentar UMA entrada a `DRIVER_TEMPLATES`. O
 *    tipo `City`, o seletor da UI e o reconhecimento da cidade dos motoristas
 *    derivam desta tabela. Uma cidade pode ter só ALGUMAS mensagens (Faro): as
 *    que faltam não se enviam a essa cidade, nunca caem para as de Lisboa.
 *  - Nunca se assume Lisboa em silêncio: sem cidade resolvida não há template
 *    (`driverCityFrom` devolve null e quem chama tem de pedir a cidade).
 *
 * As chaves são as de `shared/city.ts` em maiúsculas (LISBOA ↔ lisboa), o que
 * mantém um só vocabulário de cidades na app.
 */
import { CITY_LABELS, matchCityKey, type CityKey } from "./city";

/**
 * WORK_NOTICE = proposta de turno; o motorista aceita e recebe CONFIRMED_SHIFT
 * (com o mesmo texto do turno). O botão "Preciso de alterar" do CONFIRMED_SHIFT
 * marca o turno como "alteração pedida" (server/extrasAutomation.ts).
 */
export type DriverMessage = "RECRUITMENT" | "ADDRESS_RULES" | "WORK_NOTICE" | "AVAILABILITY" | "CONFIRMED_SHIFT";

/**
 * Nomes REAIS dos parâmetros do body (formato NAMED), por papel:
 * `recipient` = primeiro nome do motorista, `shared` = valor escrito no diálogo
 * (dia ou semana). `null` = template sem parâmetros de body.
 */
export interface DriverTemplateParams {
  recipient: string;
  shared: string;
}

export interface DriverTemplateRef {
  /** Nome EXATO aprovado no WhatsApp Manager. */
  name: string;
  /** Código de língua Meta da tradução aprovada. */
  language: string;
  /**
   * Só quando este template usa nomes de parâmetros diferentes do padrão da
   * mensagem (`DEFAULT_PARAMS`).
   */
  params?: DriverTemplateParams | null;
}

/** Parâmetros por mensagem — iguais em todas as cidades salvo `params` na entrada. */
export const DEFAULT_PARAMS: Record<DriverMessage, DriverTemplateParams | null> = {
  RECRUITMENT: null,
  ADDRESS_RULES: null,
  WORK_NOTICE: { recipient: "customer_name", shared: "day" },
  AVAILABILITY: { recipient: "customer_name", shared: "week_date" },
  CONFIRMED_SHIFT: { recipient: "customer_name", shared: "shift" },
};

export const DRIVER_TEMPLATES = {
  // Lisboa: aviso e disponibilidade são os templates de EQUIPA (UTILITY, pt_PT,
  // aprovados 2026-10-02, com botões "Confirmo"/"Não posso" no aviso); os de
  // recrutamento e morada continuam os antigos em pt_BR (Jorge, 2026-10-07).
  LISBOA: {
    RECRUITMENT: { name: "seja_motorista", language: "pt_BR" },
    ADDRESS_RULES: { name: "morada_e_regras", language: "pt_BR" },
    WORK_NOTICE: { name: "driver_shift_notice", language: "pt_PT" },
    AVAILABILITY: { name: "driver_availability", language: "pt_PT" },
    CONFIRMED_SHIFT: { name: "turno_confirmado_lisboa", language: "pt_PT" },
  },
  PORTO: {
    RECRUITMENT: { name: "seja_motorista_porto", language: "pt_PT" },
    ADDRESS_RULES: { name: "morada_e_regras_porto", language: "pt_PT" },
    WORK_NOTICE: { name: "aviso_de_trabalho_porto", language: "pt_PT" },
    AVAILABILITY: { name: "disponibilidade_extras_porto", language: "pt_PT" },
    CONFIRMED_SHIFT: { name: "turno_confirmado_porto", language: "pt_PT" },
  },
  // Faro ainda sem templates próprios (Jorge, 2026-10-07): só os de equipa
  // GENÉRICOS (sem morada), como até aqui. Recrutamento, morada e regras e
  // turno confirmado não se enviam a Faro até haver os de Faro.
  FARO: {
    WORK_NOTICE: { name: "driver_shift_notice", language: "pt_PT" },
    AVAILABILITY: { name: "driver_availability", language: "pt_PT" },
  },
} satisfies Partial<Record<Uppercase<CityKey>, Partial<Record<DriverMessage, DriverTemplateRef>>>>;

/** Cidades com templates de motoristas (Lisboa, Porto; Faro quando tiver entrada). */
export type City = keyof typeof DRIVER_TEMPLATES;

export const DRIVER_CITIES = Object.keys(DRIVER_TEMPLATES) as City[];

export function isDriverCity(value: unknown): value is City {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DRIVER_TEMPLATES, value);
}

export function driverCityLabel(city: City): string {
  return CITY_LABELS[city.toLowerCase() as CityKey];
}

/**
 * Cidade do registo a partir de qualquer forma usada na app: chave de
 * `shared/city.ts` ("lisboa"), chave da escala ("lisbon"), chave do registo
 * ("PORTO") ou nome livre ("Porto", "Lisboa - Aeroporto"). PURA.
 *
 * Devolve null quando a cidade não é reconhecida OU não está no registo:
 * nunca um palpite. Se a cidade tem a mensagem certa vê-se com `driverTemplate`.
 */
export function driverCityFrom(raw: string | null | undefined): City | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isDriverCity(trimmed)) return trimmed;
  const key = trimmed.toLowerCase() === "lisbon" ? "lisboa" : matchCityKey(trimmed);
  if (!key) return null;
  const upper = key.toUpperCase();
  return isDriverCity(upper) ? upper : null;
}

export interface ResolvedDriverTemplate {
  city: City;
  message: DriverMessage;
  name: string;
  language: string;
  params: DriverTemplateParams | null;
}

/** Template desta mensagem nesta cidade, ou null se a cidade não o tem (ex.: Faro sem morada). */
export function driverTemplate(city: City, message: DriverMessage): ResolvedDriverTemplate | null {
  const ref = (DRIVER_TEMPLATES[city] as Partial<Record<DriverMessage, DriverTemplateRef>>)[message];
  if (!ref) return null;
  return {
    city,
    message,
    name: ref.name,
    language: ref.language,
    params: ref.params !== undefined ? ref.params : DEFAULT_PARAMS[message],
  };
}

/** A cidade tem template para esta mensagem? PURA. */
export function hasDriverTemplate(city: City, message: DriverMessage): boolean {
  return driverTemplate(city, message) !== null;
}

/** Cidades com template para esta mensagem, pela ordem do registo. PURA. */
export function citiesWithTemplate(message: DriverMessage): City[] {
  return DRIVER_CITIES.filter((c) => hasDriverTemplate(c, message));
}

/**
 * Entrada do registo com este nome de template. Um nome só se repete entre
 * cidades para a MESMA mensagem (Faro reutiliza os genéricos de Lisboa), por
 * isso a mensagem é sempre a certa; a cidade é a primeira que o usa.
 */
export function findDriverTemplateByName(name: string): ResolvedDriverTemplate | undefined {
  for (const city of DRIVER_CITIES) {
    for (const message of Object.keys(DRIVER_TEMPLATES[city]) as DriverMessage[]) {
      const tpl = driverTemplate(city, message);
      if (tpl?.name === name) return tpl;
    }
  }
  return undefined;
}

// ─── Agrupamento por cidade (envio em lote) ─────────────────────────────────

/**
 * Escolha de cidade no diálogo: uma cidade para todos, ou "AUTO" = a cidade de
 * cada destinatário (os que não têm cidade recebem `missingCity`, que tem de
 * ser escolhida explicitamente).
 */
export type CityChoice = City | "AUTO";

export interface CityPlan {
  /** Grupos por cidade, pela ordem do registo, sem grupos vazios. */
  groups: { city: City; ids: number[] }[];
  /** Destinatários que ainda não têm cidade — o envio fica bloqueado. */
  missing: number[];
}

/**
 * Distribui os destinatários pelas cidades. PURA — é o mesmo cálculo que dá as
 * contagens do diálogo e o mapa enviado ao servidor.
 */
export function planCityGroups(
  recipients: readonly { id: number; city: City | null }[],
  choice: CityChoice | null,
  missingCity: City | null,
  /** Cidades com template para esta mensagem; omitido = todas. */
  available: readonly City[] = DRIVER_CITIES,
): CityPlan {
  const ok = (c: City | null): City | null => (c && available.includes(c) ? c : null);
  const byCity = new Map<City, number[]>();
  const missing: number[] = [];
  for (const r of recipients) {
    // A cidade do destinatário só conta se tiver template para esta mensagem
    // (ex.: um lead de Faro no recrutamento fica por atribuir).
    const city = choice && choice !== "AUTO" ? ok(choice) : choice === "AUTO" ? ok(r.city) ?? ok(missingCity) : null;
    if (!city) {
      missing.push(r.id);
      continue;
    }
    byCity.set(city, [...(byCity.get(city) ?? []), r.id]);
  }
  const groups = DRIVER_CITIES.filter((c) => byCity.has(c)).map((city) => ({ city, ids: byCity.get(city)! }));
  return { groups, missing };
}

/** Mapa id → cidade a partir de um plano (o que o servidor recebe). */
export function cityMapFromPlan(plan: CityPlan): Record<number, City> {
  const out: Record<number, City> = {};
  for (const g of plan.groups) for (const id of g.ids) out[id] = g.city;
  return out;
}
