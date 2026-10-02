---
modulo: despesas
titulo: Despesas
rotas: /despesas, /despesas/dashboard
palavras: despesa, despesas, fatura, factura, comprovativo, recibo, fornecedor, nif, extrair com ia, marcar como paga, pagamento, vencimento, centro de custos, exportar excel, resumo, comparar períodos, recorrentes
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
- Só o super admin pode tirar o "pago" a uma despesa já paga.
- Em **Mais ações** (⋯): **Comparar períodos**, **Exportar Excel**, **Despesas recorrentes** (modelos lançados todos os meses pelo processo diário) e **Categorias, IVA e margem**.
- Separador **Resumo**: total do ano, pendentes e em atraso (de sempre), pago no ano, despesas dos últimos 6 meses, por categoria (este mês) e os pagamentos dos próximos 7 dias. Despesas com data futura não entram nos totais do mês nem do ano.

**Exportar e comparar**: supervisores, frontoffice, backoffice e admin — com os mesmos filtros e o mesmo alcance da lista.

Quem vê o quê: condutores só as próprias despesas; team leaders as suas e as da equipa (sem totais); supervisores as suas e as do seu centro de custos; frontoffice, backoffice e admin todas. Com a restrição de totais financeiros, cada pessoa só vê as que registou.

Se aparecer **"Não foi possível carregar"**, é uma falha (base de dados ou permissão), não "zero despesas": usa **Tentar de novo**.
