---
modulo: despesas
titulo: Despesas
rotas: /despesas, /despesas/dashboard
palavras: nota de crédito, notas de crédito, nc, devolução, reembolso, abatida, por receber, despesa, despesas, eliminar, eliminadas, repor, fatura, factura, comprovativo, recibo, fornecedor, nif, extrair com ia, marcar como paga, pagamento, vencimento, centro de custos, exportar excel, resumo, comparar períodos, recorrentes, despesas fixas, renda, anúncios, fatura do google, fatura da meta, período de consumo, falta a fatura, sem fatura, anexar fatura, contabilista, zip, export mensal, faturas do mês, mandar à contabilista
---
# Despesas

Registo de faturas e despesas da empresa.

**Registar uma despesa**
1. Menu **Financeiro → Despesas** → **Nova Despesa**.
2. Carrega a fatura (foto ou PDF) e carrega em **Extrair com IA**: fornecedor, valor, datas e NIF são preenchidos. Confirma sempre os valores.
3. Escolhe o **Centro de custos**, a categoria e o método de pagamento. **Guardar Despesa**.
4. Se a fatura parecer emitida pela Multipark a um cliente, a aplicação avisa — não é uma despesa. Se o nº de documento (ou o ficheiro) já existir noutra despesa, também avisa.

**Lista**
- Abre na **semana atual**. Muda o período com as setas, ou liga **Todo o histórico** para procurar em tudo.
- Filtra por estado, categoria e (admin) quem inseriu. O **centro de custos** é o filtro do topo da aplicação.
- Os cartões **Total / Pendente / Pago / Em atraso** somam o que a lista mostra; as canceladas ficam fora do total.
- Clica numa despesa para ver o comprovativo, os dados e o histórico de alterações.

**Gerir (admin)**
- Na linha: **Marcar como paga** (fica paga hoje), **Editar** (valores, datas, estado, data de pagamento) e, só o super admin, **Eliminar**.
- **Eliminar** (só o super admin): a despesa desaparece das listas, dos totais, da Faturação e das exportações, mas **fica guardada** com a fatura. O super admin vê-as ligando **Eliminadas** nos filtros e pode **Repor**. Uma despesa recorrente eliminada não volta a ser lançada nesse mês.
- Só o super admin pode tirar o "pago" a uma despesa já paga.
- Em **Mais ações** (⋯): **Comparar períodos**, **Exportar Excel**, **Para a contabilista (ZIP do mês)**, **Despesas recorrentes** (modelos lançados todos os meses, no dia de cada um) e **Categorias, IVA e margem**.
- **Remover** um modelo recorrente desativa-o e tira-o da lista: deixa de lançar despesas, e as que já lançou ficam como estão. Para só pausar, tira o visto em **ativo**.

**Despesas fixas (recorrentes)**
- Cada modelo lança **uma despesa por mês, no dia indicado** (o processo diário corre de madrugada). Se o processo falhar uns dias, apanha-as no dia seguinte; as do mês anterior que tenham ficado por lançar também.
- Um modelo **novo** (ou reativado, ou com outro dia) lança logo a deste mês se o dia já passou — não espera pelo mês que vem.
- Cada modelo diz o que aconteceu este mês: "lança a 8/10", "lançada a 8/10 · falta a fatura" (com **Anexar**) ou "com fatura". O lápis edita o modelo; as despesas já lançadas ficam como estão.
- A despesa lançada aparece na lista com **"Falta a fatura · fixa"** até anexares a fatura.

**Falta a fatura**
- Qualquer despesa sem fatura (não cancelada) mostra **"Falta a fatura"** e o botão 📎 para a anexar (abre a edição).
- No topo aparece **"Faltam N fatura(s) nas despesas deste mês"** com **Ver as que faltam**; o filtro **Sem fatura** mostra só essas.
- O **Exportar Excel** traz uma folha **"Sem fatura"** com as que ainda faltam — é a lista para fechar com a contabilista.

**Notas de crédito**
- Quando uma fatura (já paga ou não) tem uma **nota de crédito** do fornecedor (ex.: devolveram parte das peças): na linha da fatura, botão **Nota de crédito** (ícone da folha com o menos) — também no detalhe da fatura.
- Pões o **valor** (positivo), a **data** e o **n.º da NC**, o **motivo**, o **estado** e juntas o **PDF/fotografia** da NC.
  - **Por receber**: o fornecedor ainda devolve o dinheiro. **Recebida**: o dinheiro já voltou. **Abatida**: descontada noutra fatura do mesmo fornecedor.
- A NC fica como **documento próprio**, ligado à fatura, com valor **negativo** (a verde) e o selo "Nota de crédito · fatura …". A fatura **não muda**: mostra por baixo do valor "NC −X € · líquido Y €".
- Nunca passa do que falta creditar na fatura (somando todas as NC dela). Uma NC não leva outra NC; faturas canceladas ou eliminadas não levam NC.
- Nos totais (lista, Financeiro, Anual, custos por projeto) a NC **desconta no mês da data da NC**. Não entra nos pagamentos pendentes nem em atraso.
- Para mudar o valor, a data, o n.º, o estado ou o documento de uma NC: **Editar** na própria NC (quem gere as despesas, ou quem a lançou). Eliminar é como nas outras despesas (fica guardada).
- Para a contabilista, a NC vai no ZIP com **NC_** no início do nome do ficheiro e "Nota de crédito" na coluna **Tipo** da folha.

**Para a contabilista (ZIP do mês)**
1. Em **Mais ações** (⋯) → **Para a contabilista (ZIP do mês)**, escolhe o **mês** (por omissão o mês passado) e carrega em **Gerar ZIP**.
2. Sai o ficheiro **contabilidade-AAAA-MM.zip** com:
   - a pasta **faturas/** com o ficheiro de cada fatura do mês (pela **data da fatura**, sem as canceladas), com nome que se lê: data, fornecedor, nº do documento, valor e o nº da despesa (ex.: `2026-09-03_Google-Ireland-Limited_FT-123_1100.00EUR_#7.pdf`);
   - a folha **faturas-AAAA-MM.xlsx** só com as datas e o que identifica cada fatura: data da fatura, data de pagamento, fornecedor, NIF, nº do documento, valor e o nome do ficheiro. As despesas do mês **sem fatura** aparecem na folha **"Sem fatura"**.
3. Nada é enviado sozinho: descarregas e mandas tu à contabilista. Respeita o filtro de centro de custos que tiveres escolhido.
4. Uma fatura com mais de 3 MB, ou que não se consiga ler, fica de fora e aparece em **FALTAM-NO-ZIP.txt** (abre-se pela despesa na app).
5. Precisa de Despesas → exportar e de ver os totais. Fica registado em Logs quem exportou que mês.
- Separador **Resumo**: total do ano, pendentes e em atraso (de sempre), pago no ano, despesas dos últimos 6 meses, por categoria (este mês) e os pagamentos dos próximos 7 dias. Despesas com data futura não entram nos totais do mês nem do ano.

**Exportar e comparar**: supervisores, frontoffice, backoffice e admin — com os mesmos filtros e o mesmo alcance da lista.

Quem vê o quê: condutores só as próprias despesas; team leaders as suas e as da equipa (sem totais); supervisores as suas e as do seu centro de custos; frontoffice, backoffice e admin todas. Com a restrição de totais financeiros, cada pessoa só vê as que registou.

Se aparecer **"Não foi possível carregar"**, é uma falha (base de dados ou permissão), não "zero despesas": usa **Tentar de novo**.

**Faturas do Google / Meta (anúncios)**
- Quando o fornecedor é o Google ou a Meta (pelo nome ou pelo NIF), o formulário pede o **período de consumo** (de / até) — a fatura costuma cobrir os 60 a 90 dias anteriores.
- Na **Faturação**, nesses dias, o gasto dos anúncios (Google Ads / Meta) é **trocado pelo valor da fatura**. Até a fatura chegar, conta o gasto das plataformas.
- Sem período, a fatura **não conta** (fica o gasto) e aparece um aviso — abre-a e indica o período.
- No topo da lista aparece **"Anúncios no período"**: o que entra como despesa de marketing por projeto (fatura ou gasto à espera da fatura).
