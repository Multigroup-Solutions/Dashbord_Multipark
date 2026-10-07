---
modulo: reservas_operacoes
titulo: Reservas, Recolhas, Entregas e Cancelados (listas por período)
rotas: /operacoes
palavras: dashboard das operações, número diferente, pendentes, compras por acabar, reservas criadas, lista de reservas por período, recolhas, entregas, cancelados, canceladas, cancelamentos, cancelamento, motivo do cancelamento, reembolso, quem cancelou, período, comparar, período anterior, por parque, canal, direto, parceiro, marketplace, falta pagar, csv, multipark, toldo, toldos, coberto, tipo de lugar
---
# Reservas, Recolhas, Entregas e Cancelados

Quatro listas por **período**, nas **Operações → Reservas & Operações**, ao lado de "Reservas do dia". Os dados vêm **em tempo real** da base de dados da Multipark (não se copia nada).

**As quatro listas**
- **Reservas**: reservas **criadas** no período (pela data de criação), incluindo as que entretanto foram canceladas.
- **Recolhas**: reservas com **recolha (check-in)** no período, sem as canceladas.
- **Entregas**: reservas com **entrega (check-out)** no período, sem as canceladas.
- **Cancelados**: reservas **canceladas** no período, pela **data do cancelamento**. Cada linha mostra também as datas de recolha e entrega da reserva, o **motivo** (e as observações), o **reembolso** (não, pedido ou reembolsado, com o valor) e **quem cancelou** (o último movimento de cancelamento da reserva). As canceladas sem registo de cancelamento na Multipark aparecem pela última alteração da reserva, com **≈** (data aproximada).
- O tipo de lugar **Toldo** é o antigo "coberto" (o carro fica sob toldo); Descoberto, Interior e VIP ficam iguais. Na Multipark o produto continua a chamar-se COVERED.
- As **compras online por pagar** (reserva "Pendente": o cliente começou a compra no site e ainda não pagou) **contam** nas listas e nos números, como nas Reservas do dia, na Passagem de turno e no Extras Dia: o carro vem na mesma. Saem sozinhas quando a Multipark as passa a recolhidas ou canceladas. Na Faturação e no Financeiro continuam de fora.

**O período**
- Abre **em hoje** (hora de Lisboa) — ou no período do Dashboard, quando se chega lá a partir de um cartão.
- Atalhos: **Hoje**, **Ontem**, **Amanhã**, **7 dias** (os últimos sete, com hoje) e **Este mês**. Também se escolhe **De** / **Até** no calendário, e **◀ ▶** andam um período para trás ou para a frente.
- Máximo **62 dias** de cada vez.
- O período, o parque, o canal e a pesquisa ficam iguais ao mudar entre as quatro listas.

**Contadores e comparação**
- O total do período e a diferença para o **período anterior com a mesma duração** (por exemplo, hoje contra ontem, ou estes 7 dias contra os 7 anteriores). Nos cancelados, subir aparece a vermelho.
- Valores **com IVA**: valor, pago e falta pagar. Nas Reservas, os valores são só das **não canceladas**, e diz-se quantas já foram canceladas e o valor.
- Recolhas e Entregas: quantas estão **feitas** e quantas **por fazer**.
- Cancelados: valor cancelado, quantas com **reembolso** (e o valor reembolsado) e a contagem por **motivo**.
- Por **canal** (Direto, Parceiro, Marketplace — clicar filtra), por grupo (Airpark/Redpark/Skypark × cidade e Marketplace) e **por parque**, sempre com o período anterior ao lado.

**Porque é que o número é diferente do Dashboard?**
- O **Dashboard** (primeira aba) conta só os **parques nossos**; as listas mostram **todos os parques das tuas cidades**, também os Marketplace. Nos Cancelados, o Dashboard também deixa de fora os de **data aproximada (≈)**.
- Sem filtros, a lista diz por baixo dos contadores **"No Dashboard das Operações: N"** — é esse o número do cartão, para o mesmo período.
- Clicar num cartão do Dashboard abre a lista **no mesmo período** do Dashboard (se tiver até 62 dias; senão a lista fica no período que tinha).

**Filtros e tabela**
- Filtros: **parque**, **estado** (Reservas: não canceladas / canceladas; Recolhas: recolhidas / por recolher; Entregas: entregues / por entregar; Cancelados: com / sem reembolso) e **pesquisa** pelo n.º da reserva, matrícula (com ou sem traços), nome ou email do cliente.
- A tabela mostra 200 linhas de cada vez (**Anterior** / **Seguinte**), das mais recentes para as mais antigas. Clicar numa linha abre a ficha da reserva.
- **CSV** descarrega a lista com os filtros (até 2000 linhas).

**Se aparecer "indisponíveis" ou "Erro a carregar"**, a base de dados da Multipark não respondeu: não há números (nunca aparecem zeros a fingir). Carrega em **Atualizar** daqui a pouco.

**O Dashboard (primeira aba)**
- Cartões **Reservas criadas**, **Recolhas**, **Entregas** e **Cancelamentos no período**, a percentagem de cancelamento e os gráficos por cidade ou parque. Conta só os **parques nossos**, com as compras online por pagar. Basta ter acesso aos painéis: não é preciso ver os totais financeiros (o painel só mostra contagens).
- Se a Multipark não responder, aparece **"Não foi possível ler as reservas da Multipark"** com **Tentar de novo**, em vez de cartões a zero. Enquanto carrega, os cartões mostram **…**.

Cada pessoa só vê os parques das suas cidades.
