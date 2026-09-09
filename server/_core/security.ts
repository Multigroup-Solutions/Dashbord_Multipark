import type { Request, Response, NextFunction } from "express";

/**
 * Middlewares de segurança: CORS estrito + rate limiting in-memory.
 *
 * O rate limiter é suficiente para single-instance. Para multi-instância
 * (vários pods no Railway, por ex.) troca por @upstash/ratelimit + Redis.
 */

// ─── CORS ────────────────────────────────────────────────────────────────

/**
 * CORS estrito: só permite o origin definido em FRONTEND_URL (ou no próprio
 * host do pedido se for same-origin). Bloqueia qualquer outro origin.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  const allowedList = getAllowedOrigins(req);

  if (origin && allowedList.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Dev-Login-Token"
    );
    res.setHeader("Access-Control-Max-Age", "600");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

function getAllowedOrigins(req: Request): string[] {
  const list: string[] = [];
  const env = process.env.FRONTEND_URL;
  if (env) list.push(...env.split(",").map(s => s.trim()).filter(Boolean));

  // Same-origin: aceita o próprio host do pedido.
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) list.push(`${proto}://${host}`);

  return list;
}

// ─── Rate limiting in-memory ─────────────────────────────────────────────

type Bucket = { count: number; resetAt: number };

export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  name: string;
}) {
  const buckets = new Map<string, Bucket>();

  // Limpeza periódica para evitar leaks
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }, Math.max(opts.windowMs, 60_000));
  // Não segurar o event loop em testes
  cleanupInterval.unref?.();

  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    const key = clientKey(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader(
      "RateLimit-Remaining",
      String(Math.max(0, opts.max - b.count))
    );
    res.setHeader(
      "RateLimit-Reset",
      String(Math.ceil((b.resetAt - now) / 1000))
    );
    if (b.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      res.status(429).json({
        error: "Demasiados pedidos. Tenta novamente mais tarde.",
        scope: opts.name,
      });
      return;
    }
    next();
  };
}

function clientKey(req: Request): string {
  // Usa o primeiro IP do X-Forwarded-For (Express com trust proxy trata disto
  // em req.ip). Cai para req.socket.remoteAddress.
  return (req.ip || req.socket.remoteAddress || "unknown").replace(
    /^::ffff:/,
    ""
  );
}

// ─── Upload guard ────────────────────────────────────────────────────────

export const ALLOWED_UPLOAD_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export const EXT_FROM_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

/**
 * Valida um ficheiro via magic bytes (primeiros bytes do buffer).
 * Não é perfeito mas apanha spoofing trivial de Content-Type.
 */
export function detectMimeFromMagicBytes(buf: Buffer): string | null {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return "image/png";
  // GIF: GIF87a / GIF89a
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  )
    return "image/gif";
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return "image/webp";
  // PDF: %PDF-
  if (
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  )
    return "application/pdf";
  // HEIC/HEIF: ... ftypheic / ftypheix / ftyphevc / ftypmif1 / ftypmsf1
  if (
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  ) {
    const brand = buf.slice(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "mif1", "msf1", "heis"].includes(brand))
      return "image/heic";
  }
  return null;
}
