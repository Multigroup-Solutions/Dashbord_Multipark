---
modulo: reservas_operacoes
titulo: Reservas do dia (entradas e saídas)
rotas: /operacoes
palavras: lista de reservas, lista do dia, entradas e saídas, movimentos do dia, entradas, saídas, recolhas, entregas, check-in, check-out, parque, airpark, redpark, skypark, marketplace, direto, origem, parceiro, agregador, voo, eta, lugar, garagem, cancelada, multipark
---
# Reservas do dia

Uma só lista com as **entradas** (check-in) e as **saídas** (check-out) de **um dia**. Os dados vêm **em tempo real** da base de dados da Multipark: não se copia nada e não é preciso sincronizar.

**Onde**
- Menu **Operações → Reservas & Operações**, aba **Reservas do dia**.
- Os endereços antigos (`/multipark/reservas`, `/multipark/entradas`, `/multipark/saidas`…) e as abas antigas Reservas, Recolhas, Entregas e Cancelados abrem esta lista.

**O dia**
- Abre **sempre no dia de hoje** (hora de Lisboa) e carrega só esse dia, por isso é rápida.
- **◀ ▶** mudam de dia, o calendário escolhe outro dia e **Hoje** volta a hoje.
- No dia de hoje a lista atualiza-se sozinha a cada minuto. **Atualizar** lê de novo na hora.

**Cada linha**
- É um movimento: **Entrada** (seta para baixo, a verde) ou **Saída** (seta para cima, a laranja), com a hora. Uma reserva que entra e sai no mesmo dia aparece duas vezes.
- Mostra o n.º da reserva, o cliente, a matrícula e o carro, o estado (Reservada, A dar entrada, Estacionada, Em movimento, A preparar saída, A entregar, Entregue, Cancelada), o voo com a hora prevista (**ETA**) quando existe, o tipo de entrega, os extras, a **origem**, a garagem e o lugar, e o valor (com o que falta pagar).
- Clicar numa linha abre a ficha da reserva.

**Grupos**
- Primeiro os **parques nossos**: Airpark, Redpark e Skypark em Lisboa, Porto e Faro, cada um no seu bloco (por exemplo "Airpark Lisboa").
- Depois um só bloco **Marketplace** com todos os outros parques.
- Nos parques nossos contam **todas** as reservas para a operação (recolha e entrega), venham de onde vierem.

**Origem: Direto ou Marketplace**
- **Marketplace**: a reserva veio por um parceiro, agregador ou agência (Parkvia, Parkos, agências…), por uma origem de terceiros ou foi cobrada por um agregador. Para a contabilidade conta como marketplace, **mesmo num parque nosso**.
- **Direto**: site, formulário, telefone, manual, app.
- Por baixo do selo aparece o nome do parceiro ou a origem.

**Contadores e filtros**
- No topo: **entradas**, **saídas** (com as que ainda estão por fazer), **canceladas** e as entradas/saídas de cada grupo. Clicar num contador filtra.
- Filtros: **Entradas / Saídas / Todas**, **parque**, **estado** (por omissão sem as canceladas) e **pesquisa** pelo n.º da reserva, matrícula ou nome do cliente.

**Se aparecer "Reservas indisponíveis"**, a base de dados da Multipark não respondeu. Tenta de novo daqui a pouco.

Cada pessoa só vê os parques das suas cidades.

**Sincronização**: deixou de haver a página Sincronização e o botão "Reparar período". O estado das reservas recebidas pelo webhook está em **Definições → Estado do sistema**.
