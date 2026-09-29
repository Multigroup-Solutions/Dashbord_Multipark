/**
 * tRPC `search.*` — pesquisa global da paleta (Ctrl/Cmd+K). Qualquer pessoa
 * com sessão; cada fonte aplica o seu próprio acesso e o âmbito de cidade
 * (server/globalSearch.ts). A pesquisa nunca é registada (pode ter dados pessoais).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { withOverrides } from "./_core/access";
import { SEARCH_MAX_CHARS } from "../shared/globalSearch";

export const searchRouter = router({
  global: protectedProcedure
    .input(z.object({ q: z.string().max(SEARCH_MAX_CHARS * 2) }))
    .query(async ({ ctx, input }) => {
      const { getDb } = await import("./db");
      const d = await getDb();
      if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Base de dados indisponível." });
      const { globalSearch } = await import("./globalSearch");
      const user = withOverrides(ctx.user);
      return globalSearch(d as any, { id: user.id, role: user.role, name: user.name, accessOverrides: user.accessOverrides ?? null }, { q: input.q });
    }),
});
