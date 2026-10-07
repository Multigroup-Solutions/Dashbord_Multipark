---
modulo: disponibilidade
titulo: Disponibilidade
rotas: /disponibilidade
palavras: custo pago, custo previsto, ponto em falta, menos 98, candidatura primeiro turno, cobertura 7 dias, parados 90 dias, faltas por extra, responderam, pesquisar, pesquisa por nome, só extras, ordem da lista, cidade escolhida, disponibilidade, disponível, marcar disponibilidade, semana, manhã, noite, horas, métricas dos extras, pedido de disponibilidade, segunda-feira, link do email, histórico da disponibilidade
---
# Disponibilidade

Onde os extras dizem em que dias e turnos podem trabalhar. A gestão usa-a para escalar no Extras-Dia.

**Marcar a tua disponibilidade** (extras)
1. Menu **Operações → Disponibilidade** (ou o link que recebes por WhatsApp/email).
2. A página abre na **próxima semana** (segunda a domingo, dias de Lisboa). O link do email ou do WhatsApp abre a semana desse pedido.
3. Para cada dia marca **Manhã (03h–15h)** e/ou **Noite (15h–03h)**. Podes também indicar horas e uma nota.
   - As horas são as **desse dia do calendário**: "das 18h às 03h" na segunda = segunda à noite até às 03h de terça. "Das 00h às 03h" na terça é a madrugada de terça, ou seja, **a noite de segunda** para a escala.
   - Com as duas horas (das/às), valem as horas e não os turnos. Só uma hora sem turno: "das X" vale até às 03h; "até às Y" vale a partir das 03h.
4. Carrega em **Guardar disponibilidade**. Se não puderes nenhum dia, usa **Guardar (sem disponibilidade)**.
5. Podes voltar e alterar enquanto a semana não começar.
- Cada vez que guardas, a semana é substituída de uma vez (nunca fica a meio).
- Fica registado quem mudou e o que estava antes.
- Funciona mesmo que a tua ficha ainda não tenha centro de custos.
- Se a leitura falhar, aparece **"Não foi possível carregar…"** com **Tentar de novo**.

**Gestão** (backoffice e acima)
- A mesma página mostra a matriz das disponibilidades **só dos extras** (função "extra"), por cidade. Os funcionários não aparecem aqui.
- Com uma **cidade escolhida em cima** (o botão do pino), só aparece essa cidade. Com "todas", escolhes nos botões Lisboa / Porto / Faro / Sem cidade.
- A lista vem por esta ordem: **disponíveis primeiro**, depois **sem resposta**, depois **indisponíveis** (e por nome), com uma linha a separar cada estado. Carregar no título de uma coluna reordena.
- **Pesquisar**: escreve parte do nome (ou do número). Quem **começa** pelo que escreveste vem primeiro ("ana" → Ana Sousa antes de Mariana Costa).
- Daqui envias o pedido de disponibilidade por email/WhatsApp e vês as **Métricas dos extras**. As **Candidaturas do site** e o **Recrutamento** estão nos **Leads de Extras**.
- O pedido vai para os extras escolhidos na tabela; sem escolha, para todos os extras ativos. **Nunca vai para funcionários** (nem o pedido, nem os avisos de escala).
- O **pedido automático** (quinta) e o **lembrete** (sábado, só a quem não respondeu) vão só aos extras **com cidade**. Quem está em "Sem cidade" não recebe: primeiro o RH define a cidade na ficha (há uma tarefa para isso). Enviar à mão, escolhendo na tabela, continua possível.
- Quem tem **"Não enviar WhatsApp"** ou **"Não enviar email"** na ficha aparece com a etiqueta **sem WA** / **sem email** / **nada** e não recebe o pedido nesse canal (o resultado do envio conta-os à parte).
- O link do email é sempre o endereço da app.
- A semana começa sempre à segunda-feira.
- Marcar a disponibilidade por alguém também fica registado, com o que estava antes.
- No Extras-Dia, "Preencher com disponíveis" usa estas marcações.
- Na matriz, um dia com horas mostra as **horas reais** (ex.: "18h–01h" de um slot do site) em vez do sol/lua. O filtro "disponível das X às Y", a proposta automática e o Extras-Dia leem as marcações da mesma forma (pelo calendário): quem marcou a madrugada de terça conta para a noite de segunda.

**Métricas dos extras** (por baixo, na gestão)
- O que quer dizer cada número também está no ecrã, em **O que quer dizer cada número?** (e ao passar o rato num quadrado).
- **Responderam (próxima semana):** dos extras ativos das tuas cidades, quantos já responderam ao pedido de disponibilidade da próxima semana.
- **Custo previsto (escala):** horas escaladas no Extras Dia no período × tarifa do nível. Os team leaders não contam (o salário já os paga). Inclui o dia de hoje e as escalas por confirmar.
- **Custo pago (ponto):** horas do ponto dos extras (check-outs aprovados, ou ok sem [SUSPEITO]) × tarifa. É a mesma conta da Faturação.
  - Compara-se com a escala **até ontem**, porque o ponto de hoje ainda falta.
  - Se as horas picadas forem menos de 60 % das escaladas, aparece um aviso a amarelo e não se mostra a percentagem. Um "−98 %" não era poupança: era ponto que os extras não picaram.
- **Candidatura → 1.º turno:** dias, em mediana, entre a candidatura aprovada (últimos 180 dias) e o primeiro check-in no ponto.
- **Cobertura dos próximos 7 dias:** por dia, as horas-condutor que a previsão diz serem precisas (pelas entregas e recolhas) contra as horas já escaladas.
- **Faltas por extra:** faltas ao Extras Dia no período, confirmadas e por rever (as possíveis faltas que o RH ainda tem de validar).
- **Parados há mais de 90 dias:** extras ativos sem trabalho (ponto, escala ou movimentos na Multipark) há mais de 90 dias. Quem nunca trabalhou conta desde que a ficha foi criada. Admins podem **Desativar** daqui.
