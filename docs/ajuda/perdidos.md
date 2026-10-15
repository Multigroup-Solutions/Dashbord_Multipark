---
modulo: perdidos
grupo: Suporte
pagina: perdidos
titulo: Perdidos e Achados
rotas: /perdidos-achados
palavras: perdidos, achados, por confirmar, criado pela ia, perdido por email, é um perdido, não é um perdido, marcar como devolvido, como foi devolvido, data da devolução, parado há, perdido, objeto, item, esquecido, encontrado, devolução, devolver, entregar ao cliente, cruzamento de condutores, documentos, eletrónica, acessórios, correspondências, sem cidade, prazo, lembretes, arquivar, arquivados, tirar do arquivo, eliminar, pontos, avisar cliente, quem mexeu no carro
---
# Perdidos e Achados

Objetos esquecidos pelos clientes nos carros.

**Registar**
1. Menu **Suporte → Perdidos e Achados** → **Novo Registo**.
2. Procura a reserva (nº de reserva, matrícula, email ou nome): os dados do cliente e a matrícula são preenchidos sozinhos.
3. Escolhe o tipo (documentos, eletrónica, acessórios…) e descreve o objeto. Guarda.
- Ao gravar, a reserva liga-se sozinha **só** com a matrícula, o email ou o telefone iguais (o nome não chega: há homónimos). Uma ref. escrita à mão nunca é trocada por outra.
- Quem só vê a sua cidade e não escolhe o projeto: o caso fica na cidade dessa pessoa. Os casos **Sem cidade** só os vê quem vê todas as cidades.

**Por email**
- Os emails para **perdidos@** criam o caso sozinhos (como sempre).
- **Noutras caixas** (info@, reservas@, alterações…), com o interruptor **"IA: objetos perdidos que chegam às caixas vão para os Perdidos e Achados"** (Definições → Automações; **desligado por omissão**): a IA lê cada email pelo sentido e, quando alguém diz que deixou, perdeu ou esqueceu um objeto (mesmo no meio de um elogio ou de outro pedido), abre o caso aqui (origem IA) ou junta o email ao caso **aberto** do mesmo cliente. A conversa vai para a caixa **Perdidos** da Comunicação, **por ler**. As respostas do cliente nessa conversa juntam-se ao mesmo caso.
- Com **certeza média** o caso nasce **"Por confirmar (IA)"** (selo no cartão, aviso roxo no caso): **É um perdido** confirma; **Não é um perdido** arquiva com o motivo (nada se apaga). Quando a IA diz que o objeto aparece em qualquer parte do email (mesmo de passagem), o caso abre pelo menos "Por confirmar".
- No quadro, **Por confirmar (IA) (n)** (ao lado de "Sem cidade") mostra só esses. Os casos criados pela IA têm o selo **IA**.
- Um **parceiro** (agência, hotel — contacto das Parcerias) que escreve em nome de um cliente só abre o caso com o interruptor **"IA: reclamações e perdidos que um parceiro manda em nome de um cliente abrem o caso"** (desligado por omissão); ligado, nasce sempre "Por confirmar" e o email do parceiro não fica como o do cliente.
- Uma conversa já ligada a um perdido (à mão ou pelo próprio caso) junta as mensagens seguintes a esse perdido — nunca abre outro.
- No caso fica uma nota interna "Criado pela IA" com a caixa, o motivo e a certeza. **Nunca se escreve ao cliente** — avisá-lo é sempre uma pessoa (**Avisar cliente**). Quem vê a caixa **Perdidos** recebe o aviso de email novo (como num email que chega diretamente).
- A mesma matrícula de outro cliente nunca junta o email ao caso dele. Um email novo do mesmo cliente só se junta a um perdido aberto há **menos de 14 dias** (a mesma viagem) e sem outra reserva/matrícula; um perdido antigo ainda aberto não "engole" um objeto novo.
- Um caso **"Por confirmar (IA)"** que alguém arquivou ("Não é um perdido") não volta com a resposta seguinte do cliente.

**Tratar**
- Quadro por estados: Novo → Investigação → Encontrado → Devolvido/Fechado. Os convertidos ficam em Fechado e não se movem.
- **Prazo**: os dias de **Definições → Prazo dos perdidos e achados** (7 por omissão) desde o registo, ou o prazo da **Atribuição** (conta até ao fim do dia escolhido). Fora do prazo, a cidade e o responsável recebem um lembrete (uma vez por dia) e conta em **Em atraso**.
- **Parado há N dias**: âmbar a ~3/7 do prazo (3 dias com 7), vermelho quando passa o prazo.
- **Mensagens** ficam no caso (nota interna ou não). Ao cliente só chega o que enviares com **Avisar cliente** (email de perdidos@).
- **Possíveis correspondências** (perdido ↔ achado): confirmar deixa uma nota nos dois casos; uma confirmada continua visível depois de o caso fechar. Contactar o cliente é sempre uma pessoa.
- **Devolvido** obriga a dizer **como foi devolvido** (em mãos, correio, entrega ao domicílio ou outro — com **Outro** escreve-se como foi) e **a data**: no quadro, no estado do caso e em **Marcar como Devolvido** abre-se uma janela para isso. Num caso Devolvido não dá para apagar o método nem a data.
- **Devolução**: onde estava, quem encontrou, como foi devolvido, data e **foto da entrega** (uma foto nova não apaga a anterior).
- No cartão "Dados da Reserva", **Abrir ficha da reserva** mostra tudo sobre a reserva, lido em tempo real da Multipark.
- Se afinal é uma reclamação, **Converter em Reclamação** (admin).

## Condutores do caso (team leader e acima)
- **Quem mexeu no carro**: agentes da Multipark com ações na matrícula, ligados à ficha pela conta do agente (nunca pelo nome); ações de sistema/API não contam.
- **Anexar** leva a ficha da pessoa; **Tirar** pede confirmação, anula os pontos por confirmar e fica registado.
- **Pontos a um condutor**: quem gere o caso propõe (só a uma ficha anexada); **só um supervisor (ou acima) confirma**, e nunca quem os propôs. Aos 3 pontos confirmados o login da pessoa fica bloqueado. Só dá para anexar e propor pontos a pessoas das tuas cidades.
- **Cruzamento de condutores** mostra quem aparece em vários casos. Se o período tiver histórico a mais, diz que o resultado está incompleto.

**Arquivar (em vez de eliminar)**
- **Arquivar** (admin) pede o motivo. O caso sai das listas, contadores, lembretes e cruzamento; os pontos por confirmar são anulados. Nada é apagado, nem os ficheiros.
- **Arquivados** mostra-os; no caso, **Tirar do arquivo** devolve-o.

**Quando a leitura falha**
- Lista, caso, fotos, mensagens, reserva, histórico, condutores, correspondências e cruzamento mostram **"Não foi possível carregar…"** com **Tentar de novo**. Com a Multipark em baixo, aparece "indisponível", nunca "não corresponde a nenhuma reserva" ou "sem histórico".

**Quem pode**
- **CSV** (leva contactos do cliente): só quem pode exportar.
- Condutores e extras **não veem** os Perdidos e Achados — nem os casos em que estão envolvidos. Só a partir de team leader.
- O **responsável** do caso só pode ser team leader ou acima. Um responsável antigo abaixo disso aparece marcado "(abaixo de team leader — troca)".
