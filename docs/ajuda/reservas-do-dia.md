---
modulo: reservas_operacoes
titulo: Reservas do dia (entradas e saídas)
rotas: /operacoes
palavras: parques não operados, não operado, parques que não operamos, top parking, check-in park, lista de reservas, lista do dia, entradas e saídas, movimentos do dia, entradas, saídas, recolhas, entregas, check-in, check-out, parque, parques, airpark, redpark, skypark, outros parques, parques que a operação não faz, excluir parque, firebaseBrand, voo, eta, lugar, garagem, cancelada, pendente, compra por acabar, multipark
---
# Reservas do dia

Uma só lista com as **entradas** (check-in) e as **saídas** (check-out) de **um dia**. Os dados vêm **em tempo real** da base de dados da Multipark: não se copia nada e não é preciso sincronizar.

**Onde**
- Menu **Operações → Reservas & Operações**, aba **Reservas do dia**.
- Ao lado ficam as listas por período **Reservas**, **Recolhas**, **Entregas** e **Cancelados** (ver a ajuda "Reservas, Recolhas, Entregas e Cancelados").

**O dia**
- Abre **sempre no dia de hoje** (hora de Lisboa) e carrega só esse dia, por isso é rápida.
- **◀ ▶** mudam de dia, o calendário escolhe outro dia e **Hoje** volta a hoje.
- No dia de hoje a lista atualiza-se sozinha a cada minuto. **Atualizar** lê de novo na hora.

**Cada linha**
- É um movimento: **Entrada** (seta para baixo, a verde) ou **Saída** (seta para cima, a laranja), com a hora. Uma reserva que entra e sai no mesmo dia aparece duas vezes.
- Mostra o n.º da reserva, o cliente, a matrícula e o carro, o estado (Reservada, A dar entrada, Estacionada, Em movimento, A preparar saída, A entregar, Entregue, Cancelada), o voo com a hora prevista (**ETA**) quando existe, o tipo de entrega, os extras, a garagem e o lugar, e o valor (com o que falta pagar).
- Clicar numa linha abre a ficha da reserva.

**Que parques aparecem**
- A lista é só da **operação**: estão as entradas e saídas de **todos os parques** da base de dados da Multipark (das tuas cidades), porque a operação recolhe e entrega os carros de todos.
- A exceção são os **Parques que a operação não faz**: um admin escolhe-os em **Definições → Parâmetros → Operação (GPS / Zello / parques)** (a lista de parques é lida da Multipark na hora). Esses parques não aparecem aqui (nem na previsão e nos blocos do Extras-Dia, nem no estado ao vivo da Passagem de turno). Quando há parques de fora, aparece uma nota por cima da lista.
- Além desses, ficam **sempre de fora os parques que não operamos** (lista do dono, pelo nome exato): Top Parking (Lisboa e Porto), Elite Park and Detail, Easy Park Estacionamento, Prime Park, Check-in Park, Estacionamento Quinta do Lamberg, Top Park, Aeroporto Park, Airport Villa Parking, Boeing Park, Bruno Miguel Gomes Taboada, Deluxe Park, Easy Parking, Fast Park, Go Park, Green Parking, Guard Park, Jet Park, Jorge Taboada, K Meetings, Low Cost Parking, Orange Parking, Park and Fly, Parking Terminal 1, Ricardo Maria e Smart Park. Nas Definições aparecem marcados como **não operado** e não se desmarcam; se algum nome da lista não existir na BD da Multipark, aparece um aviso.
- A divisão Direto / Parceiro / Marketplace é da **contabilidade** e não aparece nesta lista.

**Grupos: um por parque**
- Cada parque tem o seu bloco, com o nome no cabeçalho e as contagens de entradas e saídas.
- Primeiro as nossas marcas, por **marca + cidade**: Airpark, Redpark e Skypark em Lisboa, depois no Porto, depois em Faro (por exemplo "Airpark Lisboa"). Se uma marca tiver mais do que um parque na mesma cidade, ficam no mesmo bloco e aparece a coluna **Parque**.
- A marca vem do campo *firebaseBrand* do parque na BD da Multipark (sem ligar a maiúsculas, acentos ou espaços); se estiver vazio, do nome do parque. A cidade vem do campo cidade do parque; se estiver vazio, do nome.
- Depois todos os **outros parques**, cada um no seu bloco com o nome do parque, por ordem alfabética.

**Contadores e filtros**
- No topo: **entradas**, **saídas** (com as que ainda estão por fazer), **canceladas** e as entradas/saídas de cada parque. Clicar num contador filtra.
- As **compras online por pagar** (estado **Pendente**: o cliente começou a compra no site e ainda não pagou) **contam** nas entradas e nas saídas: o carro vem na mesma. Saem sozinhas quando a Multipark as passa a recolhidas ou canceladas. Quando há alguma, aparece por baixo dos contadores **"Destas, N são compras online por pagar"**: clicar mostra só essas (e clicar de novo volta à lista normal). Na Faturação e no Financeiro continuam de fora.
- Filtros: **Entradas / Saídas / Todas**, **parque**, **estado** (por omissão **sem canceladas nem pendentes**; "Todas" mostra tudo) e **pesquisa** pelo n.º da reserva, matrícula ou nome do cliente.

**Se aparecer "Reservas indisponíveis" ou "Erro a carregar as reservas"**, a base de dados da Multipark não respondeu. Carrega em **Atualizar** daqui a pouco.

Cada pessoa só vê os parques das suas cidades.

**Sincronização**: deixou de haver a página Sincronização e o botão "Reparar período". O estado das reservas recebidas pelo webhook está em **Definições → Estado do sistema**.
