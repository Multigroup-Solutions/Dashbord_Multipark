import type {
  CrmBooking,
  CrmCustomer,
  CrmDetail,
  CrmFilters,
  CrmList,
} from "@shared/crm";
// Deliberately fictional. These fixtures never call the dashboard or Multipark APIs.
const today = "2026-09-24T10:00:00Z";
const people = [
  "Mariana Costa",
  "João Ferreira",
  "Sofia Almeida",
  "Rui Martins",
  "Beatriz Sousa",
  "Pedro Lopes",
  "Leonor Santos",
  "Miguel Ribeiro",
];
const counts = [8, 5, 3, 1, 2, 1, 4, 2];
export const demoDetails: CrmDetail[] = people.map((name, i) => {
  const completed = counts[i];
  const bookings: CrmBooking[] = Array.from({ length: completed }, (_, n) => ({
    externalId: `demo-${i}-${n}`,
    number: `DEMO-${1200 + i * 10 + n}`,
    name,
    status: "CHECKED_OUT",
    city: "Porto",
    park: i % 2 ? "Redpark Porto" : "Airpark Porto",
    checkIn: `2026-${String(9 - n).padStart(2, "0")}-${String(10 + i).padStart(2, "0")}T09:00:00Z`,
    checkOut: `2026-${String(9 - n).padStart(2, "0")}-${String(14 + i).padStart(2, "0")}T16:00:00Z`,
    plate: `DEMO-${i + 1}`,
    value: 35 + i * 3 + n * 2,
    currency: "EUR",
  }));
  if (i === 3) bookings[0].checkIn = "2025-12-03T09:00:00Z";
  if (i === 0)
    bookings.unshift({
      ...bookings[0],
      externalId: "demo-future",
      number: "DEMO-1418",
      checkIn: "2026-10-12T09:00:00Z",
      checkOut: "2026-10-17T16:00:00Z",
      status: "CONFIRMED",
      value: 52,
    });
  if (i === 0)
    bookings.push({
      ...bookings[1],
      externalId: "demo-cancelled",
      number: "DEMO-1000",
      status: "CANCELLED",
      value: 99,
    });
  const stays = bookings
    .filter(b => b.status === "CHECKED_OUT")
    .sort((a, b) => a.checkIn!.localeCompare(b.checkIn!));
  const total = stays.reduce((sum, b) => sum + b.value!, 0);
  const first = stays[0].checkIn,
    last = stays.at(-1)!.checkIn;
  const customer: CrmCustomer = {
    key: String(i + 1).repeat(64),
    email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
    name: i === 7 ? "Contacto com vários nomes" : name,
    nameCount: i === 7 ? 2 : 1,
    needsReview: i === 7,
    bookingCount: bookings.length,
    completed,
    cancelled: i === 0 ? 1 : 0,
    upcoming: i === 0 ? 1 : 0,
    visitsLastYear: completed,
    firstVisit: first,
    lastVisit: last,
    nextVisit: i === 0 ? "2026-10-12T09:00:00Z" : null,
    averageGapDays:
      completed > 1
        ? Math.round(
            (Date.parse(last!) - Date.parse(first!)) /
              86400000 /
              (completed - 1)
          )
        : null,
    stayValue: total,
    averageValue: total / completed,
    currency: "EUR",
    missingAmounts: 0,
  };
  return {
    customer,
    bookings,
    bookingPage: 1,
    bookingTotal: bookings.length,
    canViewMoney: true,
    monthly: stays.map(b => ({
      month: b.checkIn!.slice(0, 7),
      visits: 1,
      value: b.value,
      currency: b.currency,
    })),
    contacts: [
      { name, phone: "Contacto fictício" },
      ...(i === 7 ? [{ name: "Outro nome no mesmo email", phone: null }] : []),
    ],
    vehicles: [
      {
        plate: `DEMO-${i + 1}`,
        brand: "Viatura de demonstração",
        model: null,
        bookings: bookings.length,
      },
    ],
    interactions:
      i === 0
        ? [
            {
              id: "review-demo",
              kind: "review",
              title: "Avaliação: 5/5",
              status: "respondida",
              date: "2026-09-15T10:00:00Z",
              href: "#demo-interacoes",
            },
          ]
        : [],
    interactionsTruncated: false,
  };
});
export function demoList(filters: CrmFilters): CrmList {
  const search = filters.search.trim().toLowerCase();
  let items = demoDetails
    .filter(
      d =>
        !search ||
        [
          d.customer.name,
          d.customer.email,
          ...d.vehicles.map(v => v.plate),
        ].some(v => v.toLowerCase().includes(search))
    )
    .map(d => d.customer);
  items = items.filter(
    c =>
      filters.segment === "all" ||
      (filters.segment === "returning" && c.completed >= 2 && !c.needsReview) ||
      (filters.segment === "first_visit" && c.completed === 1) ||
      (filters.segment === "review" && c.needsReview) ||
      (filters.segment === "inactive" &&
        c.lastVisit &&
        Date.parse(c.lastVisit) <
          Date.parse(today) - filters.inactiveDays * 86400000 &&
        !c.nextVisit)
  );
  if (filters.recentDays)
    items = items.filter(
      c =>
        c.lastVisit &&
        Date.parse(c.lastVisit) >=
          Date.parse(today) - filters.recentDays! * 86400000
    );
  items.sort((a, b) =>
    filters.sort === "visits"
      ? b.completed - a.completed
      : filters.sort === "value"
        ? (b.stayValue ?? 0) - (a.stayValue ?? 0)
        : (b.lastVisit ?? "").localeCompare(a.lastVisit ?? "")
  );
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
    canViewMoney: true,
    asOf: today,
    overview: {
      contacts: demoDetails.length,
      returning: demoDetails.filter(
        d => d.customer.completed >= 2 && !d.customer.needsReview
      ).length,
      review: 1,
      missingEmailBookings: 3,
      latestSync: today,
    },
  };
}
