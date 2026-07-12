/**
 * Tokens single-use do formulário externo de disponibilidades (Fase 4).
 *
 * JWT HS256 via `jose` (mesmo mecanismo do sdk de sessão), mas com secret
 * DEDICADO (`AVAILABILITY_FORM_TOKEN_SECRET`) para poder ser rodado
 * independentemente do JWT_SECRET de sessão. Payload: `{ employeeId, weekStart }`
 * + `jti` (nanoid) + expiração 14 dias.
 *
 * Single-use (ajuste #4 do Jorge): o `jti` é persistido em `availability_form_tokens`
 * e o submit consome-o de forma atómica (UPDATE ... WHERE usedAt IS NULL). O GET
 * /context valida mas NÃO consome.
 *
 * As peças puras (sign/verify de assinatura, avaliação do estado do jti,
 * extração de affectedRows) são exportadas para teste sem BD.
 */
import { SignJWT, jwtVerify } from "jose";
import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./db";
import { availabilityFormTokens } from "../drizzle/schema";

export const FORM_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 dias

function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function getSecret(): Uint8Array {
  const s = process.env.AVAILABILITY_FORM_TOKEN_SECRET;
  if (!s) throw new Error("AVAILABILITY_FORM_TOKEN_SECRET não configurado.");
  return new TextEncoder().encode(s);
}

// ─── Assinatura (puro, sem BD) ──────────────────────────────────────────────

export async function signFormToken(
  employeeId: number,
  weekStart: string,
  jti: string,
  secret: Uint8Array,
  ttlMs: number = FORM_TOKEN_TTL_MS,
): Promise<string> {
  const exp = Math.floor((Date.now() + ttlMs) / 1000);
  return new SignJWT({ employeeId, weekStart })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setJti(jti)
    .setExpirationTime(exp)
    .sign(secret);
}

export type SignatureResult =
  | { ok: true; employeeId: number; weekStart: string; jti: string }
  | { ok: false; reason: "expired" | "invalid" };

export async function verifyFormTokenSignature(token: string, secret: Uint8Array): Promise<SignatureResult> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const employeeId = (payload as any).employeeId;
    const weekStart = (payload as any).weekStart;
    const jti = payload.jti;
    if (typeof employeeId !== "number" || typeof weekStart !== "string" || typeof jti !== "string") {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, employeeId, weekStart, jti };
  } catch (err: any) {
    if (err?.code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}

// ─── Estado do jti persistido (puro) ────────────────────────────────────────

export type TokenRowState = "ok" | "used" | "unknown";

export function evaluateTokenRow(row: { usedAt: string | null } | undefined | null): TokenRowState {
  if (!row) return "unknown";
  return row.usedAt ? "used" : "ok";
}

/** Extrai affectedRows de um resultado de UPDATE do drizzle/mysql2 (puro). */
export function extractAffectedRows(res: unknown): number {
  const header: any = Array.isArray(res) ? res[0] : res;
  return Number(header?.affectedRows ?? 0);
}

// ─── I/O ────────────────────────────────────────────────────────────────────

export type FormTokenError = "invalid" | "expired" | "used";

export type VerifyResult =
  | { ok: true; employeeId: number; weekStart: string; jti: string }
  | { ok: false; error: FormTokenError };

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface IssuedToken {
  token: string;
  jti: string;
  link: string | null; // {AVAILABILITY_FORM_URL}?token=... quando a env existe
}

/** Emite um token: assina o JWT e persiste o jti. */
export async function issueAvailabilityFormToken(
  db: Db,
  employeeId: number,
  weekStart: string,
): Promise<IssuedToken> {
  const secret = getSecret();
  const jti = nanoid(24);
  const token = await signFormToken(employeeId, weekStart, jti, secret);
  const expiresAt = new Date(Date.now() + FORM_TOKEN_TTL_MS).toISOString().slice(0, 19).replace("T", " ");
  await db.insert(availabilityFormTokens).values({ jti, employeeId, weekStart, expiresAt });

  const base = process.env.AVAILABILITY_FORM_URL;
  const link = base ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : null;
  return { token, jti, link };
}

/** Valida assinatura + estado do jti (SEM consumir). */
export async function verifyAvailabilityFormToken(db: Db, token: string): Promise<VerifyResult> {
  const secret = getSecret();
  const sig = await verifyFormTokenSignature(token, secret);
  if (!sig.ok) return { ok: false, error: sig.reason };

  const rows = await db
    .select({ usedAt: availabilityFormTokens.usedAt })
    .from(availabilityFormTokens)
    .where(eq(availabilityFormTokens.jti, sig.jti))
    .limit(1);
  const state = evaluateTokenRow(rows[0]);
  if (state === "unknown") return { ok: false, error: "invalid" };
  if (state === "used") return { ok: false, error: "used" };
  return { ok: true, employeeId: sig.employeeId, weekStart: sig.weekStart, jti: sig.jti };
}

/**
 * Consome o token de forma atómica: UPDATE ... WHERE usedAt IS NULL. Devolve
 * true só se conseguiu marcar (affectedRows === 1) — à prova de duplo-submit
 * concorrente.
 */
export async function consumeAvailabilityFormToken(db: Db, jti: string): Promise<boolean> {
  const res = await db
    .update(availabilityFormTokens)
    .set({ usedAt: nowStr() })
    .where(and(eq(availabilityFormTokens.jti, jti), isNull(availabilityFormTokens.usedAt)));
  return extractAffectedRows(res) === 1;
}
