---
modulo: servicos
titulo: Serviços
rotas: /servicos
palavras: serviços, servicos, serviços extra, lavagem, lavagens, carregamento elétrico, carregamento, valet, flexível, dar baixa, feito, pendente, tarefa do serviço
---
# Serviços

Menu **Operações → Serviços**: os serviços extra das reservas (lavagens, carregamentos elétricos, valet…) no período escolhido, com totais por tipo e por parque.

1. Filtra por **tipo** e **estado** (Feito / Pendente). As marcas operacionais a 0 € (ex.: "No pay") ficam escondidas por omissão.
2. Clica numa linha para ver a reserva. Clica no estado para **dar baixa** (ou reabrir).
3. Quando o serviço gerou uma tarefa, aparece o botão **Tarefa** ao lado do nome (**Tarefa ✓** se já está concluída): abre-a em **Tarefas**.

**Tarefas automáticas dos serviços**
- Em **Definições → Parâmetros → Serviços → tarefas** (admin) escolhe-se, por cidade e por tipo de serviço, se cada reserva com esse serviço gera uma tarefa e quem é o responsável (opcional).
- A tarefa tem prazo na **saída do carro** e é atribuída a esse responsável e sempre aos **team leaders do turno da saída e do turno anterior**.
- A verificação corre de 15 em 15 minutos, para as saídas das próximas 48 horas. A tarefa fecha sozinha quando a Multipark marca o serviço como feito, quando o serviço sai da reserva ou quando a reserva é cancelada.
