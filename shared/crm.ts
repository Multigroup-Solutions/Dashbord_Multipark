export type CrmSegment =
  | "all"
  | "returning"
  | "first_visit"
  | "inactive"
  | "review";
export type CrmSort = "recent" | "visits" | "value";
export interface CrmCustomer {
  key: string;
  email: string;
  name: string;
  nameCount: number;
  bookingCount: number;
  completed: number;
  cancelled: number;
  upcoming: number;
  visitsLastYear: number;
  firstVisit: string | null;
  lastVisit: string | null;
  nextVisit: string | null;
  averageGapDays: number | null;
  stayValue: number | null;
  averageValue: number | null;
  currency: string | null;
  missingAmounts: number;
  needsReview: boolean;
}
export interface CrmFilters {
  search: string;
  segment: CrmSegment;
  sort: CrmSort;
  page: number;
  inactiveDays: number;
  recentDays?: number;
  projectId?: number;
}
export interface CrmOverview {
  contacts: number;
  returning: number;
  review: number;
  missingEmailBookings: number;
  latestSync: string | null;
}
export interface CrmList {
  items: CrmCustomer[];
  total: number;
  page: number;
  pageSize: number;
  overview: CrmOverview;
  canViewMoney: boolean;
  asOf: string;
}
export interface CrmBooking {
  externalId: string;
  number: string | null;
  name: string;
  status: string | null;
  city: string | null;
  park: string | null;
  checkIn: string | null;
  checkOut: string | null;
  plate: string | null;
  value: number | null;
  currency: string | null;
}
export interface CrmInteraction {
  id: string;
  kind: "complaint" | "lost" | "review";
  title: string;
  status: string | null;
  date: string | null;
  href: string;
}
export interface CrmDetail {
  customer: CrmCustomer;
  bookings: CrmBooking[];
  bookingPage: number;
  bookingTotal: number;
  monthly: Array<{
    month: string;
    visits: number;
    value: number | null;
    currency: string | null;
  }>;
  contacts: Array<{ name: string; phone: string | null }>;
  vehicles: Array<{
    plate: string;
    brand: string | null;
    model: string | null;
    bookings: number;
  }>;
  interactions: CrmInteraction[];
  interactionsTruncated: boolean;
  canViewMoney: boolean;
}
export const CRM_PAGE_SIZE = 25;
export const CRM_SEGMENTS: Record<CrmSegment, string> = {
  all: "Todos os clientes",
  returning: "Recorrentes",
  first_visit: "Uma estadia",
  inactive: "Sem visita recente",
  review: "Identidade a validar",
};
/** Email is a contact key for this read-only review. Never erase dots or +tags. */
export function normalizeCrmEmail(
  value: string | null | undefined
): string | null {
  const email = value?.trim().toLowerCase();
  return email &&
    email.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}
export function isCrmCompleted(status: string | null): boolean {
  return status?.trim().toUpperCase() === "CHECKED_OUT";
}
export function isCrmCancelled(status: string | null): boolean {
  return /^CANCEL/.test(status?.trim().toUpperCase() ?? "");
}
