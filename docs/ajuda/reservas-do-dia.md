---
modulo: reservas_operacoes
titulo: Reservas do dia (entradas e saídas)
rotas: /operacoes
palavras: lista de reservas, lista do dia, entradas e saídas, movimentos do dia, entradas, saídas, recolhas, entregas, check-in, check-out, parque, airpark, redpark, skypark, marketplace, direto, origem, canal, parceiro, agregador, agência, classificação dos parques, firebaseBrand, voo, eta, lugar, garagem, cancelada, multipark
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
- Mostra o n.º da reserva, o cliente, a matrícula e o carro, o estado (Reservada, A dar entrada, Estacionada, Em movimento, A preparar saída, A entregar, Entregue, Cancelada), o voo com a hora prevista (**ETA**) quando existe, o tipo de entrega, os extras, o **canal** (Direto, Parceiro ou Marketplace), a garagem e o lugar, e o valor (com o que falta pagar).
- Clicar numa linha abre a ficha da reserva.

**Grupos (operação)**
- Primeiro os **parques nossos**: Airpark, Redpark e Skypark em Lisboa, Porto e Faro, cada um no seu bloco (por exemplo "Airpark Lisboa").
- Um parque é **nosso** quando a **marca** é Airpark, Redpark ou Skypark **e** a **cidade** é Lisboa, Porto ou Faro. A marca vem do campo *firebaseBrand* do parque na BD da Multipark (sem ligar a maiúsculas, acentos ou espaços); se estiver vazio, do nome do parque. A cidade vem do campo cidade do parque; se estiver vazio, do nome.
- Depois um só bloco **Marketplace** com todos os outros parques.
- Nos parques nossos contam **todas** as reservas para a operação (recolha e entrega), seja qual for o canal.

**Canal (contabilidade): Direto, Parceiro ou Marketplace**
- **Marketplace**: o parque **não é nosso**, ou a reserva tem origem **Marketplace** (mesmo num parque nosso).
- **Parceiro**: num parque nosso, a reserva veio por um **parceiro** — mostra o nome e o tipo (agência, agregador ou parceiro) — ou pela API / painel de um parceiro. Se não houver parceiro ligado mas foi cobrada por um agregador (Parkvia, Parkos, Parkflow, outro), também conta como Parceiro.
- **Direto**: tudo o resto nos parques nossos (site, formulário, telefone, manual, app).
- O selo diz **Direto**, **Parceiro · nome do parceiro** ou **Marketplace**; por baixo aparece o porquê.

**Classificação dos parques**
- O botão **Classificação dos parques** (no topo) abre a lista de todos os parques do teu âmbito com o nome, a marca (*firebaseBrand*), a cidade, o tipo de listagem (na plataforma / diretório — só informativo), o estado e a classificação calculada (**Nosso · marca + cidade** ou **Marketplace**) com o porquê. Serve para confirmar que as regras estão certas. É só de leitura.

**Contadores e filtros**
- No topo: **entradas**, **saídas** (com as que ainda estão por fazer), **canceladas**, as entradas/saídas por **canal** (Direto, Parceiro, Marketplace) e as de cada grupo. Clicar num contador (ou num canal) filtra.
- Filtros: **Entradas / Saídas / Todas**, **parque**, **estado** (por omissão sem as canceladas) e **pesquisa** pelo n.º da reserva, matrícula ou nome do cliente.

**Se aparecer "Reservas indisponíveis"**, a base de dados da Multipark não respondeu. Tenta de novo daqui a pouco.

Cada pessoa só vê os parques das suas cidades.

**Sincronização**: deixou de haver a página Sincronização e o botão "Reparar período". O estado das reservas recebidas pelo webhook está em **Definições → Estado do sistema**.
