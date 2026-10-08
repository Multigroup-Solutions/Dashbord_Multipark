---
modulo: reservas_operacoes
titulo: Ficha da reserva
rotas: /reserva
palavras: telefonar ao cliente, escrever email ao cliente, ficha da reserva, detalhe da reserva, estado da reserva, fases, check-in, check-out, voo, ETA, vídeo, assinatura, anexos, histórico, linha do tempo, GPS, lugar, garagem, alocação, caixa, pagamentos, fatura, cancelamento, reembolso, serviços extra, chat, emails, ocorrências, avaliação, marketplace, parceiro, direto, canal, agência, agregador, parque nosso, conferência, era, é, webhook, preço mudou, correção de caixa
---
# Ficha da reserva

Tudo sobre uma reserva num só sítio, lido **em tempo real** da base de dados da Multipark. Nada é copiado para o dashboard: o que muda na app Multipark aparece logo aqui.

**Abrir**
- Em **Reclamações** e **Perdidos e Achados**, no cartão "Dados da Reserva", carrega em **Abrir ficha da reserva**.
- Ou vai a **/reserva** e escreve o **n.º da reserva** (ex.: 29484), o id da Multipark ou a referência do parceiro.
- O mesmo n.º pode existir em parques diferentes: nesse caso aparece a lista para escolheres a reserva certa.
- O antigo "Inspecionar reserva" (/multipark/inspect) abre agora esta ficha.

**O que mostra**
- **Cabeçalho**: n.º, estado, parque, entrada e saída, voos com a hora prevista atualizada (ETA), tipo de entrega, o **canal** para a contabilidade (**Direto**, **Parceiro · nome do parceiro** com o tipo — agência, agregador ou parceiro — ou **Marketplace**) e a origem (com a comissão do parceiro), a classificação do parque (**Parque nosso · marca + cidade** ou **Parque Marketplace · operado por nós / não operado**, e o tipo de listagem), preço (e o preço na criação, se mudou), valor pago e método. Por baixo, a hora de cada fase: a entrar, em movimento, à espera de saída, à espera da bagagem, a sair.
- **Cliente**: nome, email, telefone, NIF e língua, com **Ligar**, **WhatsApp** e **Email** (o email sai pela caixa **info**, se puderes escrever nela). Num cliente anonimizado não aparecem. Se o email existir nos nossos Clientes aparece **Ver ficha do cliente (CRM)**.
- **Outra pessoa entrega/levanta** (quando a reserva tem): nome, telefone e email dessa pessoa, cada uma com os mesmos botões **Ligar**, **WhatsApp** e **Email**.
- **Viatura**: matrícula, marca, modelo, cor, km, autonomia e quem fez a entrada e a saída.
- **Provas**: vídeo do check-in, assinaturas de entrada e saída e anexos. Os vídeos e anexos com link abrem diretamente. Os que estão guardados dentro da app mostram **abrir na app Multipark**. As assinaturas só são carregadas quando carregas em **Mostrar assinaturas**.
- **Linha do tempo** (abre ao clicar): cada ação sobre a reserva, com quem, quando, em que aparelho, o que mudou (**antes → depois**) e o estado nesse momento. Quando a ação tem GPS aparece o link **mapa**. O percurso real dos condutores está nos dados do Zello. O histórico da Multipark só existe desde 2 mar 2026.
- **Onde está o carro**: n.º, alocação, garagem (com o mapa, se existir) e lugar.
- **Contas**: as linhas da conta (estacionamento, valet, serviços, taxas, descontos), cada pagamento com a hora e o método, as faturas (InvoiceExpress, emitida ou não), o cancelamento com o motivo e o reembolso, e a caixa: condutor validou, dinheiro conferido e caixa fechada, com quem e quando.
- **Conferência (era / é)** (abre ao clicar; só para quem tem a Faturação e vê os totais financeiros): lado a lado, o **1.º webhook**, o **último webhook** e a **Multipark agora** para o estado, entrada e saída, preço, preço original, soma das linhas, pago, pagamentos, métodos, origem do pagamento, desconto, campanha, parceiro (devido e pago), pro e caixa. O que mudou fica a vermelho. Por cima, as divergências com o motivo (as mesmas da **Faturação → Correção de caixa**). Por baixo, os webhooks recebidos e as alterações de dinheiro da História da Multipark (quem, quando, **antes → depois**). O webhook é só o aviso: quando chega, o dashboard vai logo à base de dados da Multipark buscar a reserva toda (preços, desconto, campanha, parceiro, pro, caixa, linhas de preço e pagamentos) e guarda esse retrato numa linha nova. Se a base da Multipark não responder na hora, fica o que o webhook trouxe e o dashboard volta a ler nas 48 h seguintes. O "era" só existe para reservas com webhooks desde 28 set 2026.
- **Serviços extra**: nome, preço, se já foi feito e o preço da tabela do parque quando é diferente.
- **Comunicação** (abre ao clicar): o chat da app com o cliente e os emails enviados pela app Multipark.
- **Ocorrências e avaliação**: as ocorrências registadas na app para esta reserva (abrem em Ocorrências) e a avaliação do cliente. As ocorrências só aparecem a team leaders e acima.
- **Os nossos casos**: as reclamações e os perdidos e achados do dashboard ligados a esta reserva, com link para cada um.

**Se aparecer um aviso amarelo**, a base de dados da Multipark não respondeu ou falta uma parte (por exemplo, a lista de pagamentos). O resto da ficha continua visível. Tenta de novo daqui a pouco.

**Se aparecer um aviso vermelho "Não foi possível carregar"** numa secção, o pedido falhou (por exemplo, sem rede). Essa secção não está vazia: carrega em **Tentar de novo** ali mesmo; o resto da ficha continua visível.

**Preço e pagamento**: o cabeçalho e as **Contas** mostram o que a Multipark tem **agora**. Os números da Faturação continuam a vir do retrato guardado pelo webhook (ver **Conferência (era / é)**).

Tem acesso quem vê as reservas (Reservas & Operações), e cada um só vê as reservas dos parques das suas cidades. As reclamações e os perdidos só aparecem a quem tem acesso a esses módulos.

Os parques nossos (marca + cidade) são reconhecidos com as mesmas regras que agrupam as **Reservas do dia**. A cidade do parque é a gravada ou uma terra à volta (Prior Velho, Moscavide → Lisboa; Maia → Porto…); só sem cidade gravada vale o nome do parque, e por fim a morada. O canal (Direto / Parceiro / Marketplace) é da contabilidade e não aparece na lista Reservas do dia.
