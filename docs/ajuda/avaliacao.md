---
modulo: avaliacao
titulo: Avaliação (dia e 4 semanas)
rotas: /avaliacao, /avaliacao-operacional
palavras: avaliação, avaliação operacional, avaliação individual, avaliação do dia, ranking, pontuação, pontos da avaliação, movimentos do agente, levar ao parque, histórico do agente, buscar histórico, 4 semanas, recalcular, contestação, contestar, ajuste da avaliação, avaliações dos clientes
---
# Avaliação

A avaliação dos condutores e extras está numa só página: menu **Pessoas → Avaliação**. Tem dois separadores principais, **Dia** e **4 semanas**. Tem também **A minha avaliação** e, para quem gere, **Contestações**.

**De onde vêm os números**
- **Movimentos**: quem mexeu em que reserva, quando e em que fase. São lidos **em tempo real da base de dados da Multipark**: o histórico da app (recolha, movimento, pedido de entrega, entrega, cancelamento, alterações), o condutor que ficou registado no check-in e no check-out da reserva, as ocorrências que criou ou resolveu e as avaliações dos clientes nas reservas que fez. Não se copia nada.
- **GPS** (onde deixaram os carros e por onde andaram): continua a vir do **Zello**, guardado no dashboard.
- **Ponto, escala do Extras Dia, reclamações, alertas de velocidade e penalizações**: vêm do dashboard.
- A ligação entre o agente da app Multipark e a ficha do colaborador é a do RH (o agente ligado à ficha).
- A **Atividade do Dia** (menu Operacional, `/operacional`) lê as ações da mesma forma, **ao vivo** da BD da Multipark (dia civil de Lisboa, 00h–24h). Só os dias antes de 2 de março de 2026 vêm da cópia antiga guardada no dashboard. Se a BD da Multipark não responder, a página mostra um aviso amarelo e usa essa cópia antiga, que já não é atualizada (os dias recentes aparecem sem ações).

**Não há nada para ir buscar à mão.** Os botões "Buscar histórico" e "Buscar" desapareceram: abrir um dia calcula-o logo, e todas as noites o dashboard recalcula sozinho as últimas 4 semanas.

**Separador Dia**
- Escolhe o dia. Conta o **dia operacional**, das 03h às 03h de Lisboa: manhã das 03h às 15h e noite das 15h às 03h.
- Aparece a equipa escalada no Extras Dia, por turno, com o team leader em destaque. Para cada pessoa vês as ações por tipo, os pontos, o custo e as ações por hora.
- Por baixo de cada pessoa há um resumo: reservas em que mexeu, a hora da primeira e da última ação, check-ins e check-outs assinados, ocorrências criadas e resolvidas e, quando houver, as avaliações dos clientes.
- A seta abre a **lista de movimentos** do dia, com a hora, a fase (check-in, movimento, check-out), a ação, a reserva (abre a ficha), a matrícula, o parque e o que mudou. Abre também o **GPS do Zello** desse dia: km, tempo em movimento, velocidade máxima, excessos e o link do trajeto.
- Clicar nos pontos abre o detalhe das regras. Com ficha, é o mesmo detalhe das 4 semanas, com ajustes e contestações.
- O lápis ao lado do agente muda o nome de agente associado à ficha.
- **CSV** exporta o dia.

**Separador 4 semanas**
- Abre nas **últimas 4 semanas**. Podes escolher outro período.
- **Ranking** por pontos, com a vista **Por hora**. Clicar no nome abre a ficha e clicar nos pontos abre o detalhe.
- **Movimentos na BD da Multipark**: tabela por pessoa, lida no momento, com ações, check-ins, movimentos, check-outs, reservas, check-ins/check-outs assinados, ocorrências, avaliações dos clientes e a última ação. Mostra no máximo 62 dias de cada vez.
- **Recalcular** (supervisor ou acima) volta a calcular o período já. Um período grande pode ficar a meio e o resto fica para o recálculo automático da noite.

**Se aparecer um aviso amarelo**, a base de dados da Multipark não respondeu. O dia calcula-se na mesma com a cópia de movimentos que o dashboard ainda tem, que pode estar incompleta. Tenta de novo daqui a pouco.

**Como se contam os movimentos**
- Recolha = check-in feito. Entrega = check-out feito. Movimento = mudança de parque ou de lugar.
- **Levar ao parque** é o primeiro movimento depois de uma recolha, na mesma reserva, e vale mais pontos.
- **Entrega atrasada** é uma entrega feita mais de 15 minutos depois de o cliente a pedir, e conta como atraso.
- Início da recolha, pedido de entrega, início da entrega, alterações e criações aparecem na lista e contam como ações, mas não dão pontos.

**Quem vê o quê**: o separador Dia é para supervisores (da sua cidade) e para cima. O separador 4 semanas é para frontoffice e para cima. Cada pessoa com ficha vê **A minha avaliação**. Todos veem só os dados das suas cidades. O link antigo `/avaliacao-operacional` abre o separador Dia.
