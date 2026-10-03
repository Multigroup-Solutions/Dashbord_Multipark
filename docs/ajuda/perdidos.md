---
modulo: perdidos
titulo: Perdidos e Achados
rotas: /perdidos-achados
palavras: perdidos, achados, marcar como devolvido, como foi devolvido, data da devolução, parado há, perdido, objeto, item, esquecido, encontrado, devolução, devolver, entregar ao cliente, cruzamento de condutores, documentos, eletrónica, acessórios, correspondências, sem cidade, prazo, lembretes, arquivar, arquivados, tirar do arquivo, eliminar, pontos, avisar cliente, quem mexeu no carro
---
# Perdidos e Achados

Objetos esquecidos pelos clientes nos carros.

**Registar**
1. Menu **Suporte → Perdidos e Achados** → **Novo Registo**.
2. Procura a reserva (nº de reserva, matrícula, email ou nome): os dados do cliente e a matrícula são preenchidos sozinhos.
3. Escolhe o tipo (documentos, eletrónica, acessórios…) e descreve o objeto. Guarda.
- Ao gravar, a reserva liga-se sozinha **só** com a matrícula, o email ou o telefone iguais (o nome não chega: há homónimos). Uma ref. escrita à mão nunca é trocada por outra.
- Quem só vê a sua cidade e não escolhe o projeto: o caso fica na cidade dessa pessoa. Os casos **Sem cidade** só os vê quem vê todas as cidades.

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

**Condutores do caso** (team leader e acima)
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
