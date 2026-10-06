/**
 * P3 lote 30a — O dia da caixa (Jorge, 6 out 2026): "a caixa é para ser
 * fechada às 03 da manhã, quando acaba o turno da noite, ou seja, em n+1".
 *
 * A caixa do dia D vai de D 03:00 a D+1 03:00 (hora de RELÓGIO de Lisboa) —
 * o mesmo dia operacional dos turnos (manhã 03–15, noite 15–03). O que se
 * recebe às 01:30 de dia 7 ainda é da caixa de dia 6. PURO (cliente e servidor).
 */
import { OPERATIONAL_DAY_START_HOUR, addDays, operationalDayOf, operationalDayRangeUtc } from "./lisbonDay";

/** Hora (Lisboa) a que a caixa do dia anterior fecha. */
export const CASH_DAY_CLOSE_HOUR = OPERATIONAL_DAY_START_HOUR;

/** Intervalo UTC [start, end) da caixa do dia `day`: day 03:00 → day+1 03:00 (Lisboa). */
export const cashDayRangeUtc = (day: string) => operationalDayRangeUtc(day);

/** Caixa em curso num instante (antes das 03:00 → ainda é a do dia anterior). */
export const currentCashDay = (now: Date | number = Date.now()): string => operationalDayOf(typeof now === "number" ? now : now.getTime());

/** Última caixa já fechada (a de ontem depois das 03:00; a de anteontem antes). */
export const lastClosedCashDay = (now: Date | number = Date.now()): string => addDays(currentCashDay(now), -1);

/** A caixa do dia `day` já fechou (passou das 03:00 de day+1)? */
export const isCashDayClosed = (day: string, now: number = Date.now()): boolean => now >= cashDayRangeUtc(day).endMs;

const dm = (day: string) => `${Number(day.slice(8, 10))}/${Number(day.slice(5, 7))}`;
const hh = `${String(CASH_DAY_CLOSE_HOUR).padStart(2, "0")}:00`;

/** "6/10 03:00 → 7/10 03:00". */
export const cashDayWindowLabel = (day: string): string => `${dm(day)} ${hh} → ${dm(addDays(day, 1))} ${hh}`;

/** "às 03:00 de 7/10" (quando fecha a caixa de `day`). */
export const cashDayClosesAtLabel = (day: string): string => `às ${hh} de ${dm(addDays(day, 1))}`;
