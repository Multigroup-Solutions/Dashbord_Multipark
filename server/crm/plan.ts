/**
 * CRM — decisão de um lote de reservas (PURO, sem BD; testado em plan.test.ts).
 *
 * Recebe as reservas do lote e o retrato das fichas candidatas que já existem
 * (as que partilham email, telefone ou matrícula com alguma reserva do lote) e
 * devolve o que gravar: fichas novas, ligações reserva → ficha e os emails,
 * telefones e carros a acrescentar. As fichas novas deste lote também contam
 * como candidatas para as reservas seguintes do mesmo lote (ids negativos até
 * serem gravadas).
 */
import {
  decideLink, emailKey, isGenericEmail, nameKey, nifKey, phoneKey, plateKey,
  type Candidate, type LinkRule, type Observation,
} from "../../shared/crmIdentity";

export interface BookingRow {
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  nif: string | null;
  plate: string | null;
  brand: string | null;
  model: string | null;
  color: string | null;
  vehicleType: string | null;
  partnerId: string | null;
  partnerName: string | null;
  pro: boolean;
  origin: string | null;
  /** quando a reserva foi feita (ou, sem isso, a entrada) — "visto em" */
  seenAt: string | null;
}

export interface ExistingClient extends Candidate {
  displayName: string | null;
}

export interface NewClient {
  tempId: number;
  syncKey: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  nif: string | null;
  isPro: boolean;
  originPartnerId: string | null;
  originPartnerName: string | null;
  originChannel: string | null;
  seenAt: string | null;
}

export interface ClientTouch {
  /** id real (>0) ou temporário (<0) */
  clientId: number;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  nif: string | null;
  isPro: boolean;
  seenAt: string | null;
}

export interface BatchPlan {
  newClients: NewClient[];
  links: { bookingExternalId: string; clientId: number; rule: LinkRule | "new" | "kept" }[];
  emails: { clientId: number; email: string; generic: boolean; seenAt: string | null }[];
  phones: { clientId: number; phone: string; seenAt: string | null }[];
  vehicles: { clientId: number; plate: string; plateDisplay: string; brand: string | null; model: string | null; color: string | null; vehicleType: string | null; seenAt: string | null }[];
  /** fichas existentes tocadas (para completar dados em falta e recalcular métricas) */
  touched: ClientTouch[];
  stats: { rows: number; kept: number; linked: number; created: number; genericEmails: number; noIdentity: number };
}

const clean = (s: string | null | undefined, max = 255) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

export function fullName(first: string | null, last: string | null): string | null {
  return clean([first, last].filter(Boolean).join(" "));
}

/**
 * @param rows reservas do lote
 * @param generic emails genéricos (balcão, agregadores, domínios da casa)
 * @param existingLinks reserva já ligada → ficha (não se volta a decidir)
 * @param candidates fichas existentes que partilham identificadores com o lote
 */
export function planBatch(
  rows: BookingRow[],
  generic: Set<string>,
  existingLinks: Map<string, number>,
  candidates: ExistingClient[],
): BatchPlan {
  const plan: BatchPlan = {
    newClients: [], links: [], emails: [], phones: [], vehicles: [], touched: [],
    stats: { rows: rows.length, kept: 0, linked: 0, created: 0, genericEmails: 0, noIdentity: 0 },
  };
  const byId = new Map<number, ExistingClient>();
  const byEmail = new Map<string, Set<number>>();
  const byPhone = new Map<string, Set<number>>();
  const byPlate = new Map<string, Set<number>>();
  const add = (m: Map<string, Set<number>>, k: string, id: number) => {
    if (!k) return;
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    s.add(id);
  };
  const index = (c: ExistingClient) => {
    byId.set(c.id, c);
    c.emails.forEach((e) => add(byEmail, e, c.id));
    c.phones.forEach((p) => add(byPhone, p, c.id));
    c.plates.forEach((p) => add(byPlate, p, c.id));
  };
  candidates.forEach(index);

  const touched = new Map<number, ClientTouch>();
  const seenKeys = { email: new Set<string>(), phone: new Set<string>(), plate: new Set<string>() };
  let temp = 0;

  for (const r of rows) {
    const name = fullName(r.firstName, r.lastName) ?? "";
    const email = emailKey(r.email);
    const emailGeneric = !!email && (generic.has(email) || isGenericEmail(email));
    if (emailGeneric) plan.stats.genericEmails++;
    const o: Observation = { email, emailGeneric, phone: phoneKey(r.phone), plate: plateKey(r.plate), name };

    let clientId: number;
    let rule: LinkRule | "new" | "kept";
    const kept = existingLinks.get(r.externalId);
    if (kept) {
      clientId = kept;
      rule = "kept";
      plan.stats.kept++;
    } else {
      const ids = new Set<number>();
      if (o.email && !o.emailGeneric) byEmail.get(o.email)?.forEach((id) => ids.add(id));
      if (o.phone) byPhone.get(o.phone)?.forEach((id) => ids.add(id));
      if (o.plate) byPlate.get(o.plate)?.forEach((id) => ids.add(id));
      const d = decideLink(o, [...ids].map((id) => byId.get(id)!).filter(Boolean));
      if (d.clientId != null) {
        clientId = d.clientId;
        rule = d.rule!;
        plan.stats.linked++;
      } else {
        temp -= 1;
        clientId = temp;
        rule = "new";
        plan.stats.created++;
        if (!o.email && !o.phone && !o.plate) plan.stats.noIdentity++;
        const nc: NewClient = {
          tempId: temp, syncKey: `bk:${r.externalId}`.slice(0, 160),
          displayName: clean(name), firstName: clean(r.firstName, 128), lastName: clean(r.lastName, 128),
          primaryEmail: o.email && !o.emailGeneric ? o.email : null, primaryPhone: o.phone || null,
          nif: nifKey(r.nif) || null, isPro: r.pro,
          originPartnerId: clean(r.partnerId, 128), originPartnerName: clean(r.partnerName), originChannel: clean(r.origin, 64),
          seenAt: r.seenAt,
        };
        plan.newClients.push(nc);
        index({ id: temp, displayName: nc.displayName, names: name ? [name] : [], emails: [], phones: [], plates: [], lastSeen: r.seenAt });
      }
    }
    plan.links.push({ bookingExternalId: r.externalId, clientId, rule });

    // identificadores que a reserva traz → ficha (e ficam candidatos no resto do lote)
    const c = byId.get(clientId);
    if (c) {
      if (name && !c.names.some((n) => nameKey(n) === nameKey(name))) c.names.push(name);
      if (r.seenAt && String(r.seenAt) > String(c.lastSeen ?? "")) c.lastSeen = r.seenAt;
    }
    const k = (x: string) => `${clientId}|${x}`;
    if (o.email && !seenKeys.email.has(k(o.email))) {
      seenKeys.email.add(k(o.email));
      plan.emails.push({ clientId, email: o.email, generic: o.emailGeneric, seenAt: r.seenAt });
      if (c && !o.emailGeneric && !c.emails.includes(o.email)) { c.emails.push(o.email); add(byEmail, o.email, clientId); }
    }
    if (o.phone && !seenKeys.phone.has(k(o.phone))) {
      seenKeys.phone.add(k(o.phone));
      plan.phones.push({ clientId, phone: o.phone, seenAt: r.seenAt });
      if (c && !c.phones.includes(o.phone)) { c.phones.push(o.phone); add(byPhone, o.phone, clientId); }
    }
    if (o.plate && !seenKeys.plate.has(k(o.plate))) {
      seenKeys.plate.add(k(o.plate));
      plan.vehicles.push({
        clientId, plate: o.plate, plateDisplay: clean(r.plate, 32) ?? o.plate,
        brand: clean(r.brand, 64), model: clean(r.model, 96), color: clean(r.color, 48), vehicleType: clean(r.vehicleType, 24),
        seenAt: r.seenAt,
      });
      if (c && !c.plates.includes(o.plate)) { c.plates.push(o.plate); add(byPlate, o.plate, clientId); }
    }
    if (clientId > 0) {
      const t = touched.get(clientId) ?? { clientId, displayName: null, firstName: null, lastName: null, nif: null, isPro: false, seenAt: null };
      t.displayName ??= clean(name);
      t.firstName ??= clean(r.firstName, 128);
      t.lastName ??= clean(r.lastName, 128);
      t.nif ??= nifKey(r.nif) || null;
      t.isPro = t.isPro || r.pro;
      if (r.seenAt && String(r.seenAt) > String(t.seenAt ?? "")) t.seenAt = r.seenAt;
      touched.set(clientId, t);
    }
  }
  plan.touched = [...touched.values()];
  return plan;
}
