/** Disponibilidade dos extras — tipos das respostas da API (router `extrasAvailability`). */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";

type Out = inferRouterOutputs<AppRouter>["extrasAvailability"];

export type AvailabilityOverview = Out["overview"];
export type OverviewExtra = AvailabilityOverview["extras"][number];
export type AvailabilityDayHeader = AvailabilityOverview["dayHeaders"][number];
/** Linha da grelha: o extra da overview + a última vez que trabalhou ("" = nunca). */
export type AvailabilityRow = OverviewExtra & { lastWorked: string };
