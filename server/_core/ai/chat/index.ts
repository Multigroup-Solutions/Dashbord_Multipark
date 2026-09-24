/**
 * Núcleo reutilizável de chat (sem nada da interface da equipa):
 *   runChatTurn   um turno (limites → histórico → ajuda → runAi com ferramentas → guardar)
 *   store         conversas na BD (canal + dono; 30 dias)
 *   retrieval     ajuda por palavras-chave (sem IA)
 *   tools         registo de ferramentas só de leitura
 *   history       últimos N turnos + resumo extrativo
 * Ver README.md (secção "Chat") para o chat público.
 */
export { runChatTurn, CHAT_MESSAGES, type ChatTurnInput, type ChatTurnResult, type ChatFailure, type ChatLimits } from "./engine";
export * from "./store";
export * from "./retrieval";
export * from "./tools";
export * from "./history";
