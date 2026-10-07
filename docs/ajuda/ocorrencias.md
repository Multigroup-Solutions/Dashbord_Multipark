---
modulo: ocorrencias
titulo: Ocorrências
rotas: /ocorrencias
palavras: ocorrência, ocorrências, fechada sozinha, fecha sozinha, 3 dias, três dias, média, fechadas sozinhas, parques tratados, parques que a operação não faz, incidente, vidro aberto, carro aberto, acidente, foi um acidente, confirmar acidente, quem conduzia, desfazer acidente, menos 6000, atraso, prioridade, multipark, app multipark, resolver, resolvida, parque, matrícula, reserva, ocorrência antiga, csv, indisponível, tentar de novo
---
# Ocorrências

As ocorrências registadas pelos agentes na **app Multipark** (vidro aberto, acidente, atraso…). O dashboard lê-as **em tempo real** da base de dados da Multipark: não se importa nem se copia nada.

**Ver e procurar**
- Menu **Suporte → Ocorrências**.
- Filtra por estado (abertas / resolvidas / fechadas sozinhas), prioridade, parque, tipo e datas, ou pesquisa pelo **n.º da reserva** ou pela **matrícula**. Clicar num tipo do quadro "Por tipo" também filtra.
- Cada ocorrência mostra o parque, a matrícula, a reserva, quem a registou, o mapa (quando tem GPS) e se tem anexo. Abre-a para ver as notas todas.
- **Parques tratados:** por baixo do título aparece quantos parques as Ocorrências tratam e quantos ficam de fora. Carrega para ver a lista por cidade.
  - Ficam de fora os **Parques que a operação não faz** (Definições). As ocorrências desses parques não aparecem na lista, nas contagens nem no painel de Suporte.
  - As **Reclamações** e as **Críticas** continuam a vir de todos os parques.
- As datas são **dias de calendário** (00h–24h de Lisboa).
- Aparecem 50 de cada vez: **Carregar mais** traz as seguintes (até 200; depois, refina os filtros).
- **CSV** exporta as que estão na lista e diz quantas leva ("50 de 1240"): para levar mais, carrega mais ou refina os filtros. As datas vêm na hora de Lisboa.

**Fecham sozinhas ao fim de 3 dias**
- Uma ocorrência de prioridade **média**, por resolver, que **não tenha a ver com dinheiro, danos nem reclamações**, fica **Fechada (3 dias)** no dashboard, 3 dias depois de ter sido criada. Assim a lista de abertas não fica cheia de coisas antigas sem importância (vidro aberto, carro aberto, atraso…).
- Nunca fecham sozinhas as de prioridade **alta** ou **baixa**, nem as que falam de dinheiro (valor, pagamento, reembolso, fatura, €…), de danos ou acidentes (dano, risco, amolgado, partido, acidente, furto…) ou de reclamações (reclamação, queixa, livro amarelo). Na dúvida, fica aberta.
- É uma marca **só do dashboard**: na app Multipark continua por resolver (a BD da Multipark é só de leitura). Se a resolverem na app, passa a **Resolvida** como sempre.
- Deixa de contar nas **Abertas** (aqui, no painel de Suporte e no assistente). Por baixo do número das abertas aparece "+ N fechadas sozinhas": carrega para as ver, ou escolhe **Fechadas sozinhas (3 dias)** no filtro de estado.
- Nada se apaga nem se escreve: a regra é calculada sempre que a lista é lida.

**Resolver**
- As ocorrências resolvem-se na **app Multipark**. Quando são resolvidas lá, aparecem resolvidas aqui, com quem e quando.
- O botão **Resolver** do dashboard está desligado até a Multipark disponibilizar a forma de o fazer a partir daqui.
- **Ver na Multipark** abre a reserva na app.

**Foi um acidente? (−6000 na avaliação)**
- Ao abrir uma ocorrência, o team leader (ou acima) vê **Foi um acidente?**. Aparece a amarelo quando o tipo ou as notas parecem um acidente.
- A lista sugere quem conduzia: as pessoas das últimas ações nessa reserva nos 3 dias antes da ocorrência, com a última em primeiro. Quem não tem ficha aparece, mas não se escolhe (liga-o à ficha no RH).
- Escolhe a pessoa, junta uma nota se quiseres e carrega em **Confirmar acidente** e depois em **Sim**. A pessoa fica com **−6000 pontos** na avaliação do dia da ocorrência (dia operacional, 03h–03h).
- Só conta depois de confirmado. O team leader só confirma acidentes da sua equipa e ninguém confirma um acidente seu.
- Só contam as ocorrências **a partir de 3 de outubro de 2026**. Numa ocorrência anterior aparece só a explicação e não há botão.
- Na lista, a ocorrência fica com **Acidente confirmado**.
- **Desfazer** pede o motivo e tira os pontos. Nada se apaga: a confirmação fica no histórico da ocorrência, com quem a desfez e porquê.
- Se ninguém mexeu na reserva antes da ocorrência, quem gere a avaliação faz um ajuste em **Avaliação** (Acidentes / danos).

**Quando a leitura falha**
- **"Ocorrências indisponíveis"**: a base de dados da Multipark não respondeu. Carrega em **Tentar de novo**.
- Se só as contagens falharem, aparece um aviso a laranja e a lista continua certa. Uma falha nunca aparece como "Sem ocorrências" nem como 0.
- O mesmo vale para o painel de Suporte, o resumo da passagem de turno e o assistente: todos leem as ocorrências da app Multipark e dizem "sem dados" quando a leitura falha.

**Ocorrências antigas do dashboard**
- As ocorrências registadas no dashboard antes da ligação à app Multipark ficam guardadas, mas já não entram nos números nem nos lembretes.
- As ligações antigas (num email ou num perdido convertido) abrem-nas só para leitura.

Só a partir de team leader se tem acesso a esta página: condutores e extras não a veem — nem as ocorrências em que estão envolvidos, nem na ficha da reserva. Cada um vê as ocorrências dos parques das suas cidades.
