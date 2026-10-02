---
modulo: projetos
titulo: Projetos e custos por projeto
rotas: /projetos, /projetos/custos
palavras: projetos, projeto, árvore, nó, nós, grupo, cidade, marca, centro de custos, orçamento, orçamento anual, budget, custos por projeto, custo do projeto, pessoal, comissões, por atribuir, desativar nó, gestor, utilização, excedido, em risco
---
# Projetos e custos por projeto

Os **Projetos** são a árvore de centros de custos: **Grupo → Cidade → Marca → Projeto**. Cada despesa, pessoa e reserva pertence a um nó, e os totais sobem pela árvore.

**Gerir a árvore** (admin)
- **Novo nó**: nome, nível, pai, cor, gestor e **Orçamento anual (€)**. O nível não muda depois de criado.
- **Mover** um nó para outro pai (não pode ir para dentro de si próprio).
- **Eliminar = desativar**: o nó sai das listas, mas o histórico continua a contar. Só o super admin apaga de vez, e só nós sem filhos e sem nada associado.

**Custos por projeto** (botão **Custos**, admin)
- Mostra o **custo realizado** de cada nó no ano ou no mês escolhido, com as **mesmas regras da Faturação**, sem IVA:
  - **Despesas**;
  - **Pessoal**: salários com subsídios, variável do RH, TSU e extras pelo ponto aprovado;
  - **Comissões** de parceiros.
- Cada nó com os de baixo dá o mesmo que a **Faturação filtrada nesse nó**. O custo de quem está numa cidade divide-se pelas marcas/projetos dessa cidade, como na Faturação.
- **Por atribuir**: despesas, pessoas e extras sem centro de custos. Entram no total, mas em nenhum nó. Para os pôr no sítio certo, corrige o centro de custos na despesa ou na ficha de RH.
- O **orçamento é anual**. Com um mês escolhido, compara-se com 1/12. Um nó sem orçamento próprio usa a soma do orçamento dos filhos.
- No período em curso, só conta o que já aconteceu (até hoje).
- **Excedido** a partir de 100% do orçamento, **atenção** a partir de 80%.
- **CSV**: cada nó com o custo próprio e o custo com os de baixo, e as parcelas (despesas com e sem IVA, salários, TSU, extras, comissões).

Se aparecer **"Não foi possível calcular os custos"**, é uma falha (por exemplo, a base de dados da Multipark em baixo, porque as comissões dependem das reservas), não "zero". Usa **Tentar de novo**.
