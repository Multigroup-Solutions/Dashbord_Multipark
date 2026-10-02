---
modulo: servicos
titulo: Serviços
rotas: /servicos
palavras: serviços, servicos, serviços extra, lavagem, lavagens, carregamento elétrico, carregamento, valet, flexível, dar baixa, feito, pendente, reabrir, feito por, feito na app multipark, tarefa do serviço
---
# Serviços

Menu **Operações → Serviços**: os serviços extra das reservas (lavagens, carregamentos elétricos, valet…) no período escolhido, com totais por tipo e por parque. Lidos **ao vivo** da base da Multipark (reservas não canceladas com saída no período, só das tuas cidades).

1. Filtra por **tipo** e **estado** (Feito / Pendente). As marcas operacionais a 0 € (ex.: "No pay") ficam escondidas por omissão.
2. Clica numa linha (ou carrega em Enter) para abrir a **ficha da reserva**.
3. **Dar baixa e reabrir** (team leaders, supervisores e quem edita Serviços): clica no estado.
   - Fica guardado na app, por linha de serviço. Por baixo do estado aparece **quem** e **quando**: "Feito por Ana · 02/10/2026 14:32".
   - O serviço está **feito** se estiver feito na app Multipark **ou** se lhe deres baixa aqui.
   - Se foi feito na app Multipark, aparece **"Feito na app Multipark"** e só se reabre lá: aqui não dá para reabrir.
   - Dar baixa **fecha logo a tarefa** desse serviço (também no Google Tarefas). Reabrir o serviço não reabre a tarefa: reabre-a à mão em **Tarefas**, se for preciso.
   - Condutores e extras veem o estado, mas não o mudam.
4. Quando o serviço gerou uma tarefa, aparece o botão **Tarefa** ao lado do nome (**Tarefa ✓** se já está concluída): abre-a em **Tarefas**.
5. **CSV** descarrega a lista filtrada. A data de saída é o dia de Lisboa e há a coluna **Feito por**.

**Limites e falhas**
- A leitura traz até 5000 serviços por período. Se chegar a esse teto, aparece o aviso para encurtares o período.
- Se a base da Multipark não responder, aparece **"Não foi possível carregar os serviços"** com **Tentar de novo**, em vez de "Sem serviços extra neste período".

**Tarefas automáticas dos serviços**
- Em **Definições → Parâmetros → Serviços → tarefas** (admin) escolhe-se, por cidade e por tipo de serviço, se cada reserva com esse serviço gera uma tarefa e quem é o responsável (opcional).
- A tarefa tem prazo na **saída do carro** e é atribuída a esse responsável e sempre aos **team leaders do turno da saída e do turno anterior**.
- A tarefa nasce **quando a reserva chega** (webhook da Multipark) se a saída for nas próximas **72 horas**, e vai logo para o **Google Tarefas** dos responsáveis. Saídas mais longe: a tarefa nasce na volta das 18:00 quando a saída entra nas 48 h seguintes. Se a reserva mudar (hora de saída, serviço retirado, cancelada), a tarefa acompanha no próximo webhook. Compras online por acabar (reserva ainda "pendente") não geram tarefa.
- Se o webhook falhar a criar ou mudar a tarefa (BD lenta, erro), a reserva fica para repetir **de hora a hora** (até 10 vezes) — já não se perde.
- Todos os dias às **18:00** há uma volta de segurança (saídas das próximas 48 horas; junta os team leaders que entretanto ficaram na escala). Com o interruptor **"Serviços: aviso das tarefas de amanhã"** ligado (Definições → Automações; desligado por omissão), os **team leaders e supervisores da cidade** recebem a seguir o aviso (sino e email) com a lista das tarefas das saídas do dia seguinte — mesmo que a Multipark esteja em baixo.
- Uma tarefa por serviço: duas chegadas da mesma reserva ao mesmo tempo já não criam a tarefa duas vezes.
- A tarefa fecha sozinha quando o serviço é marcado como feito (na Multipark ou aqui, ao dar baixa), quando o serviço sai da reserva ou quando a reserva é cancelada.
