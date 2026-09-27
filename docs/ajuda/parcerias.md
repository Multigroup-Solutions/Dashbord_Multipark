---
modulo: parcerias
titulo: Parcerias (parceiros, parques, Pró e avenças)
rotas: /parcerias, /parcerias/tipo/:tipo
palavras: parcerias, parceiros, parceiro, agregador, agregadores, agência, agências, agência de viagens, parkos, parclick, parkvia, looking4parking, comissão, taxa, percentagem, valor devido, nosso, parques, parque, terceiros, marketplace, 80/20, 20%, pro, pró, avença, avenças, contrato, acordo, notas, contacto, registo, faturação de parceiros
---
# Parcerias

Menu **Financeiro → Parcerias**. Os parceiros, os parques e as reservas vêm **ao vivo da BD da Multipark** (só leitura). Os **nossos registos** (contrato, notas, contactos) ficam na nossa BD.

**Separadores**
- **Parceiros** — agências de viagens e agregadores dos **nossos** parques. Por parceiro: tipo, parques e a **taxa** de cada um (percentagem ou valor fixo, como está na Multipark), reservas, valor e **nosso** (o valor devido gravado na reserva — o parceiro fica com o resto), **este mês** e **últimos 12 meses**. O mês é o da **entrada do carro** (hora de Lisboa); canceladas e pendentes não contam. "*n* sem devido" = reservas sem o valor devido gravado na Multipark.
  - **Ficha no CRM** abre a página do parceiro em Clientes (detalhe mensal e últimas reservas).
  - **Registo**: liga o parceiro a um registo nosso (**Ligar a registo…**), cria um novo já preenchido (**Criar**), edita-o (lápis) ou desliga-o. A ligação é só pelo **ID do parceiro na Multipark** — nada de nomes nem "aliases".
- **Parques** — **Nossos** (reservas do mês, quantas vieram de parceiros, valor) e **Terceiros (marketplace)**: parques de outros em que **nós somos o marketplace**. Só contam as reservas que nós lhes levámos; o valor divide-se **80 % para o parque e 20 % para nós** (regra única, a tornar configurável por parque). A comissão gravada na Multipark aparece ao lado só para comparar. **Ficha no CRM** abre a página do parque.
- **Pró e avenças** — **só informativo** (não é contabilidade): por cliente Pro e por avença, reservas a **entrar** (mês da entrada) e a **sair** (mês da saída), este mês e últimos 12 meses. Carrega numa linha para ver mês a mês. A conta corrente dos Pro está no CRM (**Conta no CRM**).
- **Faturação** — o que há a faturar por registo nosso no período (comissões das reservas concluídas ou avença rateada). Carrega numa linha para o detalhe do tipo.
- **Análise** — reservas e receita por campanha no período.
- **Registos** — os nossos registos: acordo de faturação (contrato), comissão, NIF, **notas** e **contacto** (nome, email, telefone — só para quem tem contacto). **Por configurar** = registos sem dados gravados.

**Notas**
- Os valores em euros e as taxas só aparecem a quem vê totais financeiros.
- Quem tem acesso só a algumas cidades vê só os parques (e parceiros desses parques) dessas cidades.
- Se a BD da Multipark não responder, aparece um aviso e a tab Parceiros mostra só os nossos registos de agências e agregadores.
- Os parceiros já não se "sincronizam" nem se "inferem": saíram o botão **Sincronizar parceiros da API** e a página **Associar métodos de pagamento**.
