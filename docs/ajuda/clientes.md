---
modulo: clientes
titulo: Clientes (CRM: fichas, filtros, juntar e separar)
rotas: /clientes, /clientes/rever
palavras: consentimento, contactar, ao vivo, base da multipark, clientes, cliente, crm, ficha, parceiro, parceiros, agregador, agregadores, agência, agências, parkos, comissão, percentagem, marketplace, parque parceiro, nós agregamos, conta corrente, extrato, saldo, dívida, em dívida, pago, pagamento, fim do mês, cliente pro, ficha de cliente, número de cliente, filtro, filtros, pesquisa, cidade, região, país, parque, parques usados, segmento, vip, recorrente, em risco, pro, empresa, juntar, fundir, separar, repetido, duplicado, email estranho, sem email, agregador, matrícula, carro, cor do carro, foto, iban, filtros guardados, abrir na multipark
---
# Clientes (CRM)

Cada cliente tem uma **ficha** com o nosso **n.º de cliente**. As fichas são criadas e atualizadas sozinhas a partir das reservas (a cada 15 minutos). Um cliente pode ter vários emails, telefones e carros, e ter usado vários parques.

**De onde vêm os clientes**
- As reservas são lidas **ao vivo da base de dados da Multipark**. Contam todos os nossos clientes: reservas nos nossos parques (Airpark, Redpark e Skypark) e as que vendemos noutros parques do marketplace.
- Na nossa base fica só o CRM: a ficha, os contactos, os carros, que reservas são do cliente e um **resumo** (quantas reservas, quando veio a primeira e a última vez, próxima reserva, cidades, parques, canais e parceiros). As reservas em si não se copiam: na ficha, a lista de reservas é lida na hora e cada uma abre a ficha da reserva.
- **Contactos**: email, WhatsApp e SMS vêm **ligados por defeito** para quem tem reservas (está nos termos e condições e é preciso para a recolha, a entrega e a fatura). Podem ser desligados na ficha; o que se desliga à mão não volta a ligar.

**Como uma reserva se liga a uma ficha**
- Liga-se sozinha só com **email + telefone**, **email + nome** ou **email + matrícula**. Só o email, ou só o nome, **nunca** chega.
- Sem email (ou com email de balcão/agregador), liga por **telefone + nome** ou **telefone + matrícula**.
- Tudo o resto fica como **sugestão para juntar**, para uma pessoa decidir.

**Lista** (menu **Suporte → Clientes**)
1. Na barra de pesquisa escreve e escolhe **onde procurar** (nome, email, telefone, matrícula, NIF, n.º de cliente, n.º de reserva, cor ou modelo do carro, notas). Cada opção mostra quantos clientes encontra.
2. Filtra por **Segmento**, **Cidade**, **Região**, **País**, **Parque**, **País do cliente** (pelo telefone), **Canal de origem**, **Parceiro**, **Pro ou particular** e **Avisos**. Vários valores no mesmo filtro = um **ou** outro; filtros diferentes = todos ao mesmo tempo.
3. **+ Regra** para casos específicos, ex.: *Carro › Cor é vermelho* + *Reserva › Data de saída no dia 10/09/2026* + *Ligações › Tem familiar cliente: sim*. Escolhe se tem de cumprir **todas** ou **pelo menos uma**.
4. **Filtros guardados**: guarda o filtro com um nome, partilha-o com a equipa ou escolhe **Abrir com este** para ser o teu filtro de arranque.
5. Escolhe a **ordem**, quantos mostrar por página e **Cartões** ou **Lista**.
6. Separador **Pro**: clientes Pro e empresas.

**Ficha**
- Emails, telefones (com WhatsApp), NIF e faturação, ligações (**trabalha em** uma empresa, **familiar**), origem, zona, língua, sexo e faixa etária, etiquetas e o que aceita receber (email, WhatsApp, SMS).
- Sem foto do cliente, aparece a **foto do carro**. Carrega na câmara para pôr uma foto.
- Indicadores: reservas, gasto total, **gasto por mês** (média dos últimos 12 meses), por estadia, última vinda, **parques usados**, reclamações e mensagens. Os valores em euros só aparecem a quem vê totais financeiros.
- **Linha do tempo** (reservas, cancelamentos, entregas, reclamações, críticas, perdidos e tudo o que foi alterado), **Reservas** com **Abrir na Multipark**, **Emails e WhatsApp**, **Notas** e **Registo** (quem mudou o quê e quando).
- **IBAN**: só o backoffice financeiro o vê e o altera; fica guardado cifrado e mostra só os últimos 4 dígitos.

**O cliente nas outras páginas**
- O **Histórico do cliente** (Reclamações, Perdidos & Achados, Críticas, WhatsApp) encontra a ficha pelo email, telefone ou matrícula e mostra as reservas dela (lidas ao vivo), as reclamações, os perdidos e as críticas — também pelos outros emails, telefones e carros da ficha. **Abrir ficha de cliente** vai direto à ficha.
- Os emails recebidos ligam-se sozinhos ao cliente quando o email (ou o telefone no texto) está numa ficha. O **Drive**, as **reuniões** e as **sugestões de destinatários** usam as fichas.
- **Exportar para Google Sheets** (na lista): as fichas com a pesquisa escrita e o segmento escolhido.
- Se a base da Multipark não responder, o histórico diz que as reservas estão indisponíveis (em vez de mostrar zero).

**Clientes Pro e conta corrente** (separador **Pro**)
- Os Pro pagam no fim do mês. As contas e os valores vêm da BD da Multipark e atualizam-se sozinhos de 30 em 30 minutos: reservas Pro a débito, pagamentos a crédito.
- A lista mostra quem tem **saldo em dívida** (meses já acabados por pagar) primeiro, o que já gastou **este mês** e o **pago este ano**. Carrega numa conta para abrir a ficha.
- Na ficha de um Pro aparece a **Conta corrente**: saldo em dívida, mês em curso, pago este ano, prazo médio de pagamento, os meses (pago / por pagar / em curso) e os movimentos, com **Exportar** para Excel.
- Um mês fica **pago** quando a Multipark regista o pagamento. Os pagamentos registam-se **na Multipark** (botão **Registar pagamento na Multipark**); aqui não se paga nada.
- Os valores em euros só aparecem a quem vê totais financeiros. Quem trabalha numa cidade vê só os parques dessa cidade.

**Agregadores e agências** (separador na lista de clientes)
- Os parceiros que trabalham nos nossos parques, lidos ao vivo da Multipark: tipo, percentagem que ficam em cada parque, reservas deste mês e dos últimos 12, valor e o que é **nosso** (o que fica depois da percentagem deles).
- **Agregadores**: cobram o cliente e ficam com a percentagem deles; no fim do mês mandamos-lhes o extrato e faturamos o que é nosso. **Agências**: a percentagem é nossa e vão pagando. As reservas contam pelo **mês de entrada** do carro.
- Na página do parceiro: mês a mês, últimas reservas (com **Abrir na Multipark**), clientes que vieram por eles, dados fiscais e o cartão **No CRM** (ligação ao registo nas Parcerias, contacto e notas).

**Parcerias (nós agregamos)** (separador na lista de clientes)
- Os parques que não são nossos, em que levamos clientes pelo marketplace e ficamos com uma comissão: dono, contactos, reservas e a nossa comissão, mês a mês.

**Rever fichas** (botão **Rever fichas** na lista)
- **Sugestões para juntar**: as duas fichas lado a lado, com o que coincide (telefone, matrícula, NIF, email). **Juntar** (backoffice e administração), **Trocar qual fica** ou **Descartar** (não é a mesma pessoa).
- **Emails estranhos**: fichas cujo email é de balcão, de agregador ou da casa (os domínios das nossas marcas — Multipark, Multivalet, Multibags, Multidriver, Airpark, Redpark, Skypark e Multigroup — nunca contam como cliente). **Procurar na nossa caixa** propõe o email verdadeiro: o super admin procura em todas as caixas de email; os outros só nas caixas que já veem na Comunicação e no próprio email. Sem resultado, **Retirar o email** e a ficha fica com telefone e carro.
- Quando se **separa** uma junção, as outras sugestões dessa ficha voltam a aparecer.
- **Reservas sem email**: clientes sem email que chegam nos próximos 3 dias — pedir o email à chegada e acrescentá-lo na ficha.
- **Juntas recentemente**: **Separar** repõe as duas fichas como estavam (emails, telefones, carros e reservas).

Tudo o que se faz nas fichas fica no **registo de ações**.
