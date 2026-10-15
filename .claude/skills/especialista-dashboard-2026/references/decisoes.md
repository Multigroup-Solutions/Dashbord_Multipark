# Decisões do Jorge

Antes de lhe perguntar alguma coisa, vê aqui. As já tomadas **não se voltam a perguntar**; as em aberto implementam-se com a opção mais segura atrás de definição/interruptor e listam-se no fim do relatório.

## Processo
- Auditor adversarial "nível bancário"; **≥ 90 faz merge sem perguntar** (14 out 2026); planos ≥ 95 antes de programar; até 5 rondas, senão vem ao Jorge.
- "Com o design Multipark, não te esqueças": seguir os componentes e o estilo das páginas existentes.
- Lançamento do Multis por página "imaculado, sem falhas" antes de 1 nov 2026.
- Quando ele diz "não precisas do auditor" / "só traz a informação": só pesquisa e resposta.

## Já decididas (não perguntar)
**Dados e leituras**
- Nada se apaga em dados de negócio; nunca apagar webhook nem `multipark_bookings`.
- Reservas leem a BD da Multipark ao vivo; a cópia local só como recurso ou para histórico antes de 2 mar 2026.
- Produção só se lê quando ele pede nessa conversa (salvo as leituras de configuração de `regras.md` §12).

**Caixa** (fora do MPV; ativação ainda por aprovar — ver abaixo)
- Tolerância 0,01 €; condutor entrega ao líder no próprio dia (validação até às 6 h), líder ao back office no dia seguinte; fatura em 48 h só com NIF, as outras no fim do mês; só Faturação → gerir fecha casos; Stripe/Viva/InvoiceExpress desligados por omissão; o "era" começa no preço inicial do histórico (`booking_initial_prices`).

**PDAs / Zello**
- Só por QR; cidade fixa por PDA; nome no Zello "PDA 12 · Nome" (interruptor); alertas "sem PDA/Zello" só do operacional (sino ao TL de serviço + supervisor; WhatsApp aos administradores da cidade com cópia ao Jorge; desligados por omissão).

**Identidade e contas**
- Uma pessoa = uma ficha, vários logins e vários agentes. Agentes "system"/"api"/teste/formulário nunca se ligam a fichas; agentes de agências/parceiros ligam-se às parcerias.
- Juntar contas/fichas: a que sai fica desativada, nunca apagada.
- Conta Google errada noutra pessoa (caso Tiago/Carlos Jesus): **mover a identidade Google** (`identityLinks.moveGoogleAccount`), não juntar contas — o histórico fica com quem o fez.

**CRM**
- Junta sozinho só o óbvio (mesmo nome + mesmo telefone/email/NIF; nunca empresas; matrícula sozinha não chega); o resto vai a Rever fichas; separar desfaz e não volta a juntar.

**Operação / Pessoas**
- Uma entrega conta para quem marca "em entrega" (quem leva o carro) — não mexer nessa atribuição.
- Condutores e Agentes: só supervisor, back office, admin e super admin (módulo `condutores_agentes`); Desempenho só super admin. Movimentos ≠ mudanças de lugar (mostrados à parte).
- Team leaders nas listas = só quem tem permissões de TL.
- Despesas: pagar/dar como paga só admin e super admin; centros de custo Multipark, Lisboa, Porto, Faro e Marketplace; escolher funcionário só TL para cima; categorias com acentos certos (inclui sinistros).
- Centro de custos é obrigatório para todos (mesmo admin); sem ele só se vê o próprio. Valores globais sem cidade (faturas, avenças) numa consulta por cidade: "Indisponível", nunca 0 nem atribuídos à cidade; cidades fora do alcance não aparecem (`docs/CIDADES-E-FICHA-2026-09-15.md`).
- Avaliação: velocidade conta acima de 120 km/h, sem tolerância (`DEFAULT_SPEED_RULE`); atraso ≥ 5 min = −5 para quem tem horário (escala do Extras-Dia ou horário fixo), máx. 1 por dia; o GPS conta no máximo 1 excesso por dia (−10).

**Ponto e férias (plano 63; PRs #392, #395, #397, #416)**
- Modo do ponto por pessoa (horário fixo, isenção, sempre em serviço), com histórico "a partir de" e motivo interno (atrás de `PONTO_MODOS`, desligado).
- No horário (ativo, sem interruptor): "Pôr folga" em vez de apagar; dispensar uma possível falta pede motivo e cria a ausência; possível falta no Extras-Dia de um funcionário (não extra) = 0 pontos para o bloqueio das 3 faltas, o extra continua com 1 (`extraDiaNoShowPoints`); horário só com folgas = sem horário (176 h) na folha.
- Fins de semana por rotação, com exceções por data e folga de compensação (atrás de `FINS_DE_SEMANA`, desligado); nunca mexe no passado.
- Férias: basta uma aprovação, recusa sempre com motivo, ninguém aprova as suas, as do super admin aprovam-se sozinhas; extras avisam "Não vou estar" sem aprovação; os leitores (folha, avaliação, faltas) só contam ausências aprovadas; mês fechado não muda (atrás de `FERIAS_MAPA`, desligado).

**PDAs e telemóveis (plano 56; #364, #368, #374)**
- PDAs sem Google (entrada com código ao superior), sessão do PDA acaba na saída do ponto; QR só TL para cima — atrás de `ENTRAR_COM_CODIGO` (desligado); `GOOGLE_NOS_PDAS` está ligado por omissão, por isso hoje os PDAs ainda entram com Google.
- Terminal: 1 pessoa por cidade, cada pessoa num só terminal (`PONTO_TERMINAL`).
- Telemóveis pessoais à parte dos PDAs partilhados (Perfil → Este telemóvel).

**Caixa (#370)**
- Caixa → Confirmação reserva a reserva: o team leader declara, o João conta e fecha, o Jorge aprova ou recusa; diferença > 30 € = amarelo + aviso, > 70 € = também email; registo só acréscimo com selo; segregação (quem declarou não fecha, quem mexeu não aprova).

**Clientes**
- Nada é enviado ao cliente sem aprovação; um rascunho que fale em reembolsos, descontos ou vouchers é deitado fora (`docs/ia.md`).

**IA / Multis**
- Experimentar o Argon (`gemini-4-argon`) só num grupo piloto; o resto no modelo mais barato.
- OCR das faturas fica no Flash/lite.
- Críticas 5★: o modelo barato chega ("mais tontinho"); publicar só atrás de interruptor e com salvaguardas.
- Extras Dia: proposta 11:00, confirmar e chamar 15:00 (omissões no código; em produção `extras.autoConfirm` estava gravado como desligado a 15 out 2026 — confirma em `settings.values.list`).
- Remover leituras de IA a dobrar (críticas, emails).
- Caixa fica fora do plano do Multis.

## Em aberto (perguntar no fim, nunca bloquear)
| # | Pergunta | Prazo |
|---|---|---|
| D1 | Quem entra no piloto do Multis além do Jorge? + 60 perguntas reais (Jorge + 2 TL) | 21 out 2026 |
| D2 | Teto € do Multis no Argon (piloto: 10 €/dia, 3 €/pessoa; e depois do lançamento). Sem aprovação do Argon para todos → todos no lite | 22 out 2026 |
| D4b | Dia mexido à mão na hora da confirmação: confirmar (omissão) / não confirmar e avisar / só se a última mudança > 30 min (`extras.manualEditAtConfirm`) | 20 out 2026 |
| D4c | A quem vão os lembretes do Extras Dia por cidade e dias (`extras.reminderRecipients`); depois ligar `EXTRAS_REMINDERS` e `EXTRAS_SCHEDULE_ALERTS` | 20 out 2026 |
| D5 | "Chamar melhor": mudar o texto do aviso de trabalho aos extras? | — |
| D6 / D6b | Ligar `REVIEW_AUTO_PUBLISH_5STAR` (precisa de `AI_REVIEW_AUTO_DRAFTS`) e `GBP_WINDSOR_REPLY` | antes de ligar |
| D7 | Formação: o Multis é o tutor, ou fica o tutor próprio? | — |
| D8 | Pontos "em entrega" 3 / "entrega" 2 (fora do MPV) | — |
| D9 | Tirar o "apanha tudo" da caixa Críticas e correr a Limpeza (Críticas → Limpeza) | — |
| D10 | O utilizador "Multipark SA" (info@) precisa de sincronizar o Gmail? | — |
| D11 | Respostas às críticas antigas só em lote, com botão e custo à vista? | — |
| D12 | Abrir o Multis a todos: sex 30 out ou seg 2 nov? | antes do go/no-go (29 out) |
| D13 | Documentos do RH lidos pelo AI Studio de 1 a 8 out (antes do portão UE): registar como incidente RGPD? | 18 out 2026 |
| — | `REVIEWS_DEDUP`: precisa de 10–20 emails reais da Google antes de ligar | — |
| — | Candidatos na caixa RH contam como "colaboradores" no W1? (hoje contam) | — |
| — | "Completar com quem respondeu" às 14:30 (`EXTRAS_COMPLETE_BEFORE_CONFIRM`) | — |
| — | Caixa: `CASH_STRIPE_CHECK`, `STRIPE_READ_KEY`, permissões do João, modo sombra | — |

Quando uma decisão for tomada, move-a para "Já decididas" (com a data) no mesmo PR em que a implementas.
