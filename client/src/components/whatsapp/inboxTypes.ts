/** Inbox WhatsApp — tipos das respostas da API (router `whatsapp`). */
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";

type Out = inferRouterOutputs<AppRouter>["whatsapp"];

/** Linha da lista de conversas. */
export type InboxConversation = Out["conversations"]["list"][number];
/** Conversa aberta (cabeçalho + mensagens). */
export type InboxThread = Out["messages"]["byConversation"];
/** Uma mensagem da conversa aberta. */
export type InboxMessage = InboxThread["messages"][number];
