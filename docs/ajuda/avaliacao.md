---
modulo: avaliacao
titulo: Avaliação (dia e 4 semanas)
rotas: /avaliacao, /avaliacao-operacional
palavras: avaliação, acidente, acidente confirmado, menos 6000, avaliação operacional, avaliação individual, avaliação do dia, ranking, pontuação, pontos da avaliação, movimentos do agente, levar ao parque, histórico do agente, buscar histórico, 4 semanas, recalcular, contestação, contestar, ajuste da avaliação, avaliações dos clientes, equipa do team leader, avaliação semanal
---
# Avaliação

A avaliação dos condutores e extras está numa só página: menu **Pessoas → Avaliação**. Tem dois separadores principais, **Dia** e **4 semanas**. Tem também **A minha avaliação** e, para quem gere, **Contestações**.

**De onde vêm os números**
- **Movimentos**: quem mexeu em que reserva, quando e em que fase. São lidos **em tempo real da base de dados da Multipark**: o histórico da app (recolha, movimento, pedido de entrega, entrega, cancelamento, alterações), o condutor que ficou registado no check-in e no check-out da reserva, as ocorrências que criou ou resolveu e as avaliações dos clientes nas reservas que fez. Não se copia nada.
- **GPS** (onde deixaram os carros e por onde andaram): continua a vir do **Zello**, guardado no dashboard.
- **Ponto, escala do Extras Dia, reclamações, alertas de velocidade e penalizações**: vêm do dashboard.
- A ligação entre o agente da app Multipark e a ficha do colaborador é a do RH (o agente ligado à ficha).
- A **Atividade do Dia** (menu Operacional, `/operacional`) lê as ações da mesma forma, **ao vivo** da BD da Multipark (dia civil de Lisboa, 00h–24h). Só os dias antes de 2 de março de 2026 vêm da cópia antiga guardada no dashboard. Se a BD da Multipark não responder, a página mostra um aviso amarelo e usa essa cópia antiga, que já não é atualizada (os dias recentes aparecem sem ações).

**Não há nada para ir buscar à mão.** Todas as noites o dashboard recalcula sozinho as últimas 4 semanas.
- **Abrir um dia só mostra o que está guardado.** Não recalcula nem grava nada. Por cima aparece quando foi calculado.
- Para recalcular já, quem gere a avaliação usa **Recalcular este dia** (separador Dia) ou **Recalcular** (separador 4 semanas).
- Um dia que ainda não foi calculado diz isso mesmo, em vez de mostrar zeros.

**Separador Dia**
- Escolhe o dia. Conta o **dia operacional**, das 03h às 03h de Lisboa: manhã das 03h às 15h e noite das 15h às 03h.
- Aparece a equipa escalada no Extras Dia, por turno, com o team leader em destaque. Para cada pessoa vês as ações por tipo, os pontos, o custo e as ações por hora.
- Por baixo de cada pessoa há um resumo: reservas em que mexeu, a hora da primeira e da última ação, check-ins e check-outs assinados, ocorrências criadas e resolvidas e, quando houver, as avaliações dos clientes.
- A seta abre a **lista de movimentos** do dia, com a hora, a fase (check-in, movimento, check-out), a ação, a reserva (abre a ficha), a matrícula, o parque e o que mudou. Abre também o **GPS do Zello** desse dia: km, tempo em movimento, velocidade máxima, excessos e o link do trajeto.
- Clicar nos pontos abre o detalhe das regras. Com ficha, é o mesmo detalhe das 4 semanas, com ajustes e contestações.
- O lápis ao lado do agente muda o nome de agente associado à ficha. Só aparece a quem gere o RH.
- **CSV** exporta o dia.

**Separador 4 semanas**
- Abre nas **últimas 4 semanas**. Podes escolher outro período.
- **Ranking** por pontos, com a vista **Por hora**. Clicar no nome abre a ficha e clicar nos pontos abre o detalhe.
- **Movimentos na BD da Multipark**: tabela por pessoa, lida no momento, com ações, check-ins, movimentos, check-outs, reservas, check-ins/check-outs assinados, ocorrências, avaliações dos clientes e a última ação. Mostra no máximo 62 dias de cada vez.
- **Recalcular** (quem gere a avaliação) volta a calcular o período já. Um período grande pode ficar a meio e o resto fica para o recálculo automático da noite.

**Se aparecer um aviso amarelo**, a base de dados da Multipark não respondeu.
- O que está gravado **não é mexido**: nem o recálculo da noite nem o **Recalcular** gravam por cima. Antes podiam pôr zeros nos dias bons.
- O **Recalcular** avisa que nada foi recalculado. Tenta de novo daqui a pouco.
- Se uma leitura falhar, aparece **"Não foi possível carregar…"** com **Tentar de novo**, nunca "sem dados".

**Como se contam os movimentos**
- Recolha = check-in feito. Entrega = check-out feito. Movimento = mudança de parque ou de lugar.
- **Levar ao parque** é o primeiro movimento depois de uma recolha, na mesma reserva, e vale mais pontos.
- **Entrega atrasada** é uma entrega feita mais de 15 minutos depois de o cliente a pedir, e conta como atraso.
- Início da recolha, pedido de entrega, início da entrega, alterações e criações aparecem na lista e contam como ações, mas não dão pontos.

**Quem vê o quê**
São as permissões de Definições → Permissões, iguais no ecrã e no servidor, com as permissões por utilizador.
- **Dia**: supervisores, da sua cidade, e para cima.
- **4 semanas**: team leaders, só a **sua equipa** (condutores e extras abaixo deles, e eles próprios), supervisores, front e backoffice e a administração.
- **Recalcular, ajustar e decidir contestações**: supervisores, front e backoffice e a administração. Ninguém ajusta nem decide a sua própria avaliação.
- **A minha avaliação**: cada pessoa com ficha. Funciona mesmo sem centro de custos.
- Todos veem só os dados das suas cidades.
- O link antigo `/avaliacao-operacional` abre o separador Dia.

**Acidentes: −6000 pontos**
- Um acidente conta **−6000** pontos a quem conduzia, no dia operacional da ocorrência.
- Só contam os acidentes **a partir de 3 de outubro de 2026**. Os antigos não contam: nem as ocorrências antigas do dashboard, nem ajustes de acidentes em dias anteriores.
- Só conta depois de um **team leader** (ou acima) o confirmar na ocorrência, em **Operacional → Ocorrências**: abre a ocorrência, em **Foi um acidente?** escolhe quem conduzia e confirma.
- A sugestão são as pessoas das últimas ações nessa reserva antes da ocorrência.
- O team leader só confirma acidentes da sua equipa. Ninguém confirma um acidente seu.
- **Desfazer** (com o motivo) tira os pontos. A confirmação fica no histórico, com quem a desfez e porquê.
- Esse dia recalcula-se sozinho logo a seguir.

**Pontos que não se repetem**: uma penalização ligada a uma reclamação ou a um alerta de velocidade não volta a contar se essa reclamação ou esse alerta já contam noutro dia.

**Fichas juntas**: quando duas fichas da mesma pessoa são juntas, a que sai deixa de contar para ligar agentes pelo nome.

**Avaliação semanal antiga**: já não se gera, nem pela app nem sozinha à segunda-feira. As semanas gravadas ficam como histórico. O **Painel de Pessoas** mostra o mesmo ranking desta página, dos últimos 7 dias.
