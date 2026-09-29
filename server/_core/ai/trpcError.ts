/** Erro da IA → TRPCError com mensagem genérica PT-PT (nunca o detalhe do fornecedor). */
import { TRPCError } from "@trpc/server";
import { aiUserMessage, isAiError } from "./errors";

export function aiTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  const message = aiUserMessage(err);
  if (!isAiError(err)) return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
  switch (err.code) {
    case "disabled":
    case "not_configured":
    case "budget":
      return new TRPCError({ code: "PRECONDITION_FAILED", message });
    case "rate_limited":
      return new TRPCError({ code: "TOO_MANY_REQUESTS", message });
    case "timeout":
      return new TRPCError({ code: "TIMEOUT", message });
    case "unsupported":
      return new TRPCError({ code: "BAD_REQUEST", message });
    default:
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
  }
}
