/** CRM — tipos das respostas da API (router `crm`). */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";

type Out = inferRouterOutputs<AppRouter>["crm"];

export type CrmListRow = Out["list"]["rows"][number];
/** Ficha aberta (sem o caso "juntou-se a outra ficha"). */
export type CrmFile = Extract<Out["get"], { id: number }>;
export type CrmBooking = CrmFile["bookings"][number];

type Review = Out["review"];
export type CrmSuggestions = Extract<Review, { tab: "suggestions" }>["suggestions"];
export type CrmGenericEmails = Extract<Review, { tab: "generic" }>["generic"];
export type CrmUpcomingNoEmail = Extract<Review, { tab: "noEmail" }>["upcoming"][number];
export type CrmMergeEvent = Extract<Review, { tab: "merges" }>["merges"][number];

export type CrmProList = Out["proList"];
export type CrmProListRow = CrmProList["rows"][number];
export type CrmProAccount = NonNullable<Out["proAccount"]>;
export type CrmProLedgerRow = CrmProAccount["ledger"][number];

// fase 3: parceiros e parques (ao vivo da Multipark)
type Avail<T> = Extract<T, { available: true }>;
export type CrmPartnersList = Avail<Out["partnersList"]>;
export type CrmPartnerRow = CrmPartnersList["rows"][number];
export type CrmPartnerDetail = Avail<Out["partner"]>;
export type CrmParksList = Avail<Out["parksList"]>;
export type CrmParkRow = CrmParksList["rows"][number];
export type CrmParkDetail = Avail<Out["park"]>;
export type CrmMonthRow = CrmPartnerDetail["months"][number];
export type CrmRecentBooking = CrmPartnerDetail["recent"][number];

export const isCrmFile = (d: Out["get"] | undefined): d is CrmFile => !!d && typeof (d as { id?: unknown }).id === "number";
