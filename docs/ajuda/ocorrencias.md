---
modulo: ocorrencias
titulo: Ocorrências
rotas: /ocorrencias
palavras: ocorrência, ocorrências, incidente, vidro aberto, carro aberto, acidente, atraso, prioridade, multipark, app multipark, resolver, resolvida, parque, matrícula, reserva, ocorrência antiga, csv, indisponível, tentar de novo
---
# Ocorrências

As ocorrências registadas pelos agentes na **app Multipark** (vidro aberto, acidente, atraso…). O dashboard lê-as **em tempo real** da base de dados da Multipark: não se importa nem se copia nada.

**Ver e procurar**
- Menu **Suporte → Ocorrências**.
- Filtra por estado (abertas / resolvidas), prioridade, parque, tipo e datas, ou pesquisa pelo **n.º da reserva** ou pela **matrícula**. Clicar num tipo do quadro "Por tipo" também filtra.
- Cada ocorrência mostra o parque, a matrícula, a reserva, quem a registou, o mapa (quando tem GPS) e se tem anexo. Abre-a para ver as notas todas.
- Aparecem 50 de cada vez: **Carregar mais** traz as seguintes (até 200; depois, refina os filtros).
- **CSV** exporta as que estão na lista e diz quantas leva ("50 de 1240"): para levar mais, carrega mais ou refina os filtros. As datas vêm na hora de Lisboa.

**Resolver**
- As ocorrências resolvem-se na **app Multipark**. Quando são resolvidas lá, aparecem resolvidas aqui, com quem e quando.
- O botão **Resolver** do dashboard está desligado até a Multipark disponibilizar a forma de o fazer a partir daqui.
- **Ver na Multipark** abre a reserva na app.

**Quando a leitura falha**
- **"Ocorrências indisponíveis"**: a base de dados da Multipark não respondeu. Carrega em **Tentar de novo**.
- Se só as contagens falharem, aparece um aviso a laranja e a lista continua certa. Uma falha nunca aparece como "Sem ocorrências" nem como 0.
- O mesmo vale para o painel de Suporte, o resumo da passagem de turno e o assistente: todos leem as ocorrências da app Multipark e dizem "sem dados" quando a leitura falha.

**Ocorrências antigas do dashboard**
- As ocorrências registadas no dashboard antes da ligação à app Multipark ficam guardadas, mas já não entram nos números nem nos lembretes.
- As ligações antigas (num email ou num perdido convertido) abrem-nas só para leitura.

Só quem vê a cidade tem acesso a esta página (condutores e extras não a veem no menu) e cada um vê as ocorrências dos parques das suas cidades.
