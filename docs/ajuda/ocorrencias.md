---
modulo: ocorrencias
titulo: Ocorrências
rotas: /ocorrencias
palavras: ocorrência, ocorrências, incidente, chave errada, combustível, mal estacionado, vidro aberto, gravidade, prioridade, origem, multipark, app multipark, envolvimento, confirmar envolvimento, resolver, descartar, converter em reclamação
---
# Ocorrências

Problemas reportados na operação (chave errada, combustível, mal estacionado, vidro aberto…).

**De onde vêm** (coluna **Origem**)
- **Multipark**: as ocorrências registadas pelos agentes na app Multipark. São lidas **ao vivo** da base de dados da Multipark, sem importar nada. Aqui são **só de leitura**: para as resolver ou editar, usa a app Multipark (botão **Ver na Multipark**).
- **Email**: criadas a partir dos emails de ocorrências.
- **API**: importadas por integração externa.
- **Manual**: registadas aqui no dashboard.
- Se a base de dados da Multipark estiver indisponível, aparece um aviso e a lista mostra só as do dashboard.

**Procurar**
- Filtra por estado, gravidade, origem e datas, ou pesquisa pelo **n.º da reserva** ou pela **matrícula**.
- Com a Multipark disponível, também dá para filtrar pelo **parque** e pelo **tipo** da app (esses filtros escondem as do dashboard).
- A Multipark mostra 50 de cada vez: **Carregar mais da Multipark** traz as seguintes.

**Registar**
1. Menu **Suporte → Ocorrências** → **Nova Ocorrência**.
2. Escolhe o tipo e a gravidade, a matrícula (ou escolhe a reserva e a matrícula é preenchida) e escreve a **Descrição** (obrigatória).
3. Guarda.

**Tratar** (Team Leader e acima; só as do dashboard)
- Estados: Aberta → Em Investigação → Resolvida, ou Descartada ("não é ocorrência / sem fundamento").
- **Confirmar envolvimento** do condutor: só assim conta na avaliação dele. **Retirar confirmação** anula.
- **Resolver**: descreve como foi resolvida.
- Se o cliente reclamou, **Converter em Reclamação**; se é um objeto, converter em Perdidos. A ocorrência fica fechada e ligada.

Condutores e extras só veem as ocorrências do dashboard em que estão envolvidos.
