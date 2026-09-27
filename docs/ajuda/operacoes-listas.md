---
modulo: reservas_operacoes
titulo: Reservas, Recolhas, Entregas e Cancelados (listas por período)
rotas: /operacoes
palavras: reservas criadas, lista de reservas por período, recolhas, entregas, cancelados, canceladas, cancelamentos, cancelamento, motivo do cancelamento, reembolso, quem cancelou, período, comparar, período anterior, por parque, canal, direto, parceiro, marketplace, falta pagar, csv, multipark
---
# Reservas, Recolhas, Entregas e Cancelados

Quatro listas por **período**, nas **Operações → Reservas & Operações**, ao lado de "Reservas do dia". Os dados vêm **em tempo real** da base de dados da Multipark (não se copia nada).

**As quatro listas**
- **Reservas**: reservas **criadas** no período (pela data de criação), incluindo as que entretanto foram canceladas.
- **Recolhas**: reservas com **recolha (check-in)** no período, sem as canceladas.
- **Entregas**: reservas com **entrega (check-out)** no período, sem as canceladas.
- **Cancelados**: reservas **canceladas** no período, pela **data do cancelamento**. Cada linha mostra também as datas de recolha e entrega da reserva, o **motivo** (e as observações), o **reembolso** (não, pedido ou reembolsado, com o valor) e **quem cancelou** (o último movimento de cancelamento da reserva). As canceladas sem registo de cancelamento na Multipark aparecem pela última alteração da reserva, com **≈** (data aproximada).

**O período**
- Abre **sempre em hoje** (hora de Lisboa).
- Atalhos: **Hoje**, **Ontem**, **Amanhã**, **7 dias** (os últimos sete, com hoje) e **Este mês**. Também se escolhe **De** / **Até** no calendário, e **◀ ▶** andam um período para trás ou para a frente.
- Máximo **62 dias** de cada vez.
- O período, o parque, o canal e a pesquisa ficam iguais ao mudar entre as quatro listas.

**Contadores e comparação**
- O total do período e a diferença para o **período anterior com a mesma duração** (por exemplo, hoje contra ontem, ou estes 7 dias contra os 7 anteriores). Nos cancelados, subir aparece a vermelho.
- Valores **com IVA**: valor, pago e falta pagar. Nas Reservas, os valores são só das **não canceladas**, e diz-se quantas já foram canceladas e o valor.
- Recolhas e Entregas: quantas estão **feitas** e quantas **por fazer**.
- Cancelados: valor cancelado, quantas com **reembolso** (e o valor reembolsado) e a contagem por **motivo**.
- Por **canal** (Direto, Parceiro, Marketplace — clicar filtra), por grupo (Airpark/Redpark/Skypark × cidade e Marketplace) e **por parque**, sempre com o período anterior ao lado.

**Filtros e tabela**
- Filtros: **parque**, **estado** (Reservas: não canceladas / canceladas; Recolhas: recolhidas / por recolher; Entregas: entregues / por entregar; Cancelados: com / sem reembolso) e **pesquisa** pelo n.º da reserva, matrícula (com ou sem traços), nome ou email do cliente.
- A tabela mostra 200 linhas de cada vez (**Anterior** / **Seguinte**), das mais recentes para as mais antigas. Clicar numa linha abre a ficha da reserva.
- **CSV** descarrega a lista com os filtros (até 2000 linhas).

**Se aparecer "indisponíveis"**, a base de dados da Multipark não respondeu. Tenta de novo daqui a pouco.

Cada pessoa só vê os parques das suas cidades.
