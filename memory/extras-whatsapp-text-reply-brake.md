# Extras-Dia: travão das respostas escritas ao aviso de escala

## Summary
Regras que impedem uma resposta escrita no WhatsApp de confirmar ou recusar o turno errado quando `EXTRAS_AVAILABILITY_AUTO_REPLY` está ligado. O selo "avisado" não passa a "confirmou" porque `EXTRAS_AUTOMATION` = false desde 16 out desliga também a resposta automática; o Jorge vai ligar só esta última, e a resposta escrita vai para o último pedido da pessoa, mesmo de um dia já passado.

## Related
- `whatsapp-integration.md` — webhook, difusão de templates e registo `shared/driverTemplates.ts`.
- `rh-auditoria-fase1.md` — origem do classificador de respostas (`server/availabilityReply.ts`).

## Changelog
### 2026-11-08 — Fase 1: travão (sem interruptor novo)
**Type**: feature
**Scope**: `server/availabilityReply.ts`, `server/extrasAutomation.ts` (`handleWhatsappReplyInner`), `server/extrasTravaoRespostas.test.ts`, `server/rhRules.test.ts`, `server/whatsappFixes.test.ts`, `docs/ajuda/extras-dia.md`, `docs/ajuda/whatsapp.md`, `docs/ia-inventario.md`
**What**:
- Classificador: "o máximo", "no máximo", "tentar" e "posso" com hora passam a `unclear`; `isExplicitShiftConfirm` (pura) só aceita "confirmo" sem negação, condição, hora, pergunta, adiamento nem menção à disponibilidade.
- `shiftTextReplyBlock` (pura): aviso de dia passado sempre travado; pedido de disponibilidade depois do aviso travado salvo "Confirmo". Corre antes da IA e de `flagAvailabilityForReview`; travada = `{ action: "none" }`.
- `availabilitySentAfterNotice` procura em `whatsapp_messages` (conversas da ficha + a desta mensagem): a difusão manual não fica em `availability_request_log`. Erro de BD = travada.
- "Confirmo" com último pedido que não serve vai para `openShiftNoticeFor` (aviso de hoje em diante, 10 dias, sem linha em `whatsapp_request_answers`); sem nenhum segue como hoje.
**Why**: há 3 semanas sem respostas registadas; ligar o interruptor sem isto aplicaria respostas a turnos passados ou a pedidos de disponibilidade.
**Notes**:
- `sentAt` lê-se com `CAST(sentAt AS CHAR) AS sentAtText` e volta à BD como texto: o mysql2 devolve TIMESTAMP como `Date` nas consultas cruas. Evita a ida e volta por um `Date`.
- O dia é o de calendário de Lisboa, não o operacional (03h–03h): uma resposta à 01h ao turno da noite de ontem fica travada.
- O classificador é partilhado com o email (`jobs/emailInboundSync.ts`): mais respostas pouco claras dão IA ou tarefa "A CONFIRMAR", nunca marcação.
- Fechado na mesma fase: "só às" passa a `unclear`; num aviso, leitura da IA "disponível" com `fromHour`/`toHour` não confirma, vai para `flagAvailabilityForReview` (sino). Sem horas confirma como antes; pedidos da semana e de um dia não mudam.
- Por tratar: não há forma de marcar confirmação à mão no ecrã (só `applyShiftNoticeAnswer` escreve `confirmedAt`); "Confirmo" num turno de que a pessoa já foi tirada marca o aviso e responde "Fica confirmado" (já acontecia com o último pedido). "Confirmado" fica para a fase 3.
