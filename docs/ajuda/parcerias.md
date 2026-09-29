---
modulo: parcerias
titulo: Parcerias (parceiros, parques, Pró e avenças)
rotas: /parcerias, /parcerias/tipo/:tipo
palavras: parcerias, parceiros, parceiro, agregador, agregadores, agência, agências, agência de viagens, parkos, parclick, parkvia, looking4parking, comissão, taxa, percentagem, valor devido, nosso, parques, parque, terceiros, marketplace, comissão gravada, taxa do parque, pro, pró, avença, avenças, contrato, acordo, notas, contacto, registo, faturação de parceiros
---
# Parcerias

Menu **Financeiro → Parcerias**. Os parceiros, os parques e as reservas vêm **ao vivo da BD da Multipark** (só leitura). Os **nossos registos** (contrato, notas, contactos) ficam na nossa BD.

**Separadores**
- **Parceiros** — agências de viagens e agregadores dos **nossos** parques. Por parceiro: tipo, parques e a **taxa** de cada um (percentagem ou valor fixo, como está na Multipark), reservas, valor e **nosso** (o valor devido gravado na reserva — o parceiro fica com o resto), **este mês** e **últimos 12 meses**. O mês é o da **entrada do carro** (hora de Lisboa); canceladas e pendentes não contam. "*n* sem devido" = reservas sem o valor devido gravado na Multipark.
  - **Ficha no CRM** abre a página do parceiro em Clientes (detalhe mensal e últimas reservas).
  - **Registo**: liga o parceiro a um registo nosso (**Ligar a registo…**), cria um novo já preenchido (**Criar**), edita-o (lápis) ou desliga-o. A ligação é só pelo **ID do parceiro na Multipark** — nada de nomes nem "aliases".
- **Parques** — **Nossos** (reservas do mês, quantas vieram de parceiros, valor) e **Terceiros (marketplace)**: parques de outros em que **nós somos o marketplace**. Só contam as reservas que nós lhes levámos; o **nosso** é a **comissão gravada em cada reserva na Multipark** (cada parque tem a sua taxa — 25 %, menos nos parques de rua…) e o parque fica com o resto. A coluna **Taxa** mostra a nossa taxa efetiva no mês. **Ficha no CRM** abre a página do parque.
- **Pró e avenças** — **só informativo** (não é contabilidade): por cliente Pro e por avença, reservas a **entrar** (mês da entrada) e a **sair** (mês da saída), este mês e últimos 12 meses. Carrega numa linha para ver mês a mês. A conta corrente dos Pro está no CRM (**Conta no CRM**).
- **Faturação** — o que há a faturar por registo nosso no período. Contam as reservas **concluídas com saída no período**. Registos com a etiqueta **Multipark** usam os números de lá: parceiros → o **nosso** gravado em cada reserva (o valor devido; "*n* sem devido gravado" = reservas sem esse valor, o a faturar pode estar incompleto); **Pro** → o preço das reservas Pro que saíram; **avenças** → o preço do plano na Multipark pelos meses do período. Os registos só nossos (operacionais, hotéis, campanhas…) seguem a nossa taxa ou avença. Por baixo, **Marketplace**: por parque de terceiros, o valor, a parte do parque, o **nosso** (comissão gravada) e a taxa — não entra no total de cima. Carrega numa linha para o detalhe do tipo.
- **Fecho do mês** — como uma caixa, parceiro a parceiro: as reservas de parceiros **concluídas com saída no mês** na **Multipark** (agora) contra a **nossa memória do webhook** (o último retrato de cada reserva que nos chegou). Compara o número de reservas, o valor, o **nosso** (devido) e as **faturas** emitidas; carrega numa linha para ver as diferenças reserva a reserva: *Não chegou pelo webhook*, *Saída não chegou pelo webhook*, *Na nossa cópia saiu, na Multipark não* (cancelada, outro mês…), *Parceiro diferente*, *Valor diferente*, *Nosso (devido) diferente*, *Sem devido gravado*, *Sem fatura emitida*.
  - **Comparar agora** refaz a comparação do mês escolhido; corre também sozinha todas as manhãs (06:40), para o mês corrente e o anterior.
  - **Fechar** congela o parceiro nesse mês (a comparação automática já não lhe mexe). Com diferenças, é obrigatório escrever porquê. **Reabrir** só administradores.
  - A memória do webhook começa a **28/09/2026 19:23**: as saídas antes disso não têm nada nosso para comparar e aparecem como "antes da memória do webhook" (não contam como diferença).
  - Avisos (sino e email) de diferenças **novas**: liga em Definições → Automações "Parceiros: avisar diferenças no fecho do mês".
- **Análise** — reservas e receita por campanha no período.
- **Registos** — os nossos registos: acordo de faturação (contrato), comissão, NIF, **notas** e **contacto** (nome, email, telefone — só para quem tem contacto). **Por configurar** = registos sem dados gravados.

**Ligar à Multipark** (cartão no topo dos Registos; aplicar só administradores)
- A Multipark é a fonte: **parceiros** (agências e agregadores, com a taxa por parque), **clientes Pro** e **avenças** ficam cada um preso a **um** registo nosso pelo id de lá.
- **Ver o que muda** não grava nada. Mostra: **Ligar** (pelo id já gravado ou pelo nome, com a nossa taxa de hoje ao lado da da Multipark), **Criar** (existem lá e não temos registo), **À mão** (mais de um registo nosso com o mesmo nome — escolhe qual) e **Arquivar** (registos de agências, agregadores, Pros e avenças sem par na Multipark — desmarca os que são só nossos).
- **Aplicar** liga, cria e arquiva. Arquivado **nunca é apagado**: fica em **Arquivados**, com **Repor**. O que desmarcaste (ou repuseste) fica marcado como "só nosso" e não volta a ser proposto.
- Ligado à Multipark = etiqueta **Multipark**: o **tipo, a comissão e a avença deixam de se editar aqui** (mudam-se lá; o formulário mostra o que lá está). NIF, contactos, acordo de faturação e notas continuam nossos.
- Os **agentes** de cada parceiro (o utilizador da empresa na Multipark) ficam ligados à parceria sozinhos — deixam de aparecer em RH → Ligações.
- Depois da primeira vez, liga em **Definições → Automações** "Parcerias: manter ligadas à Multipark todos os dias" (05:40).
- A **Faturação** usa os números da Multipark nos registos ligados (ver Faturação acima).

**Notas**
- Os valores em euros e as taxas só aparecem a quem vê totais financeiros.
- Quem tem acesso só a algumas cidades vê só os parques (e parceiros desses parques) dessas cidades.
- Se a BD da Multipark não responder, aparece um aviso e a tab Parceiros mostra só os nossos registos de agências e agregadores.
- Os parceiros já não se "sincronizam" nem se "inferem": saíram o botão **Sincronizar parceiros da API** e a página **Associar métodos de pagamento**.
