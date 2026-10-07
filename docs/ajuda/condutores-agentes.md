---
modulo: criticas
titulo: Condutores e agentes
rotas: /pessoas/condutores-agentes
palavras: km, quilómetros, km sem movimentos, pontos da equipa, recolhas, escolher condutor, filtro de cidade, filtro de marca, tirar da lista, ligações, condutores, agentes, ranking, entregas, checkout, performance, ações do agente, histórico do agente, pessoa, ficha, desempenho, desempenho por pessoa, cobranças de parceiros, cobranças de pro, avenças, quem registou
---
# Condutores e agentes

Em **Pessoas → Condutores e agentes** (team leader e acima, nas tuas cidades). Antes estavam nas Críticas.

**Condutores**
- Uma linha por pessoa com as **recolhas**, **entregas**, **movimentos** e os **km do GPS** (Zello) no período, lidos ao vivo da Multipark. Só aparece quem mexeu em carros. As várias contas de agente da mesma ficha somam.
- **Cidade e marca**: o filtro do topo da app. A marca filtra pelos parques dela.
- Escolhe o período (De/Até) e, se quiseres, **um condutor** (ou "Todos").
- Clicar no **nome** abre a ficha. Clicar num **número** abre esses movimentos (ex.: as entregas desse condutor), com a matrícula, o parque e a hora.
- Todas as colunas ordenam; em baixo ficam os totais.

**Agentes**
- A mesma lista, com **todas** as ações de cada agente no período: recolhas, entregas, movimentos, mudanças de lugar, reservas em que mexeu e a última ação. Primeiro a lista, depois o detalhe.
- Procura por **nome ou código do agente**, ou escolhe a pessoa.
- Quem não tem ficha aparece com "sem ficha"; os parceiros com "parceiro".
- O botão **Abrir agente** da ficha do RH abre esta aba já com o detalhe dessa pessoa.
- Se o período tiver ações a mais, o detalhe diz quantas mostra e pede um período mais curto.
- **Quem gere o RH**: o ícone de corrente abre as **Ligações** da pessoa (unir/separar conta e agente); num agente sem ficha, o ícone do olho **tira-o da lista** (fica como "não é funcionário", desfaz-se no RH → Agentes; na Multipark não muda nada).
- No máximo 62 dias de cada vez.

**Desempenho** (só o super admin; os outros nem veem a aba)
- Tudo o que cada pessoa fez, por **dia, semana, mês ou ano** (setas para andar para trás e para a frente). Há uma aba por posto: **Back e front office**, **Supervisão**, **Team leaders** e **Condutores e extras**. A aba segue o papel da conta (front office, backoffice, supervisor, team leader); quem não tem um destes papéis fica pelo posto da ficha.
- Junta três fontes:
  - **Multipark**, pela avaliação diária: recolhas, entregas, movimentos, "pôs em recolha/entrega", reservas criadas e alteradas, ocorrências.
  - **Zello**: km, velocidade máxima, dias acima do limite.
  - **Dashboard**: horas (ponto ou escala), chamadas atendidas e feitas, WhatsApp, emails enviados pela dashboard, respostas e fecho de reclamações, críticas Google respondidas, despesas lançadas e aprovadas, contagens e correções de caixa, tarefas, leads, passagens de turno, contas de parceiros, fechos de mês dos parceiros, extras do dia escalados, atualizações do CRM, perdidos e achados, dias como team leader e quantas pessoas tinha.
  - Também da **Multipark**: voos de regresso registados (as alterações à reserva que mexem no voo de regresso) e as cobranças, em duas colunas:
    - **Cobranças de parceiros**: os pagamentos de parceiros que um agente marcou e os créditos de parceiro lançados.
    - **Cobranças de Pro e avenças**: os pagamentos de clientes Pro e de avenças que um agente marcou.
    - A Multipark guarda sempre quem as registou, e é por aí que se sabe de quem são.
- No topo, os números do grupo e a **evolução**: por dia na semana e no mês, por mês no ano. A seguir, o **ranking**, por **pontos** ou por **pontos por hora**. O "por hora" só aparece com 4 h ou mais no período.
  - **Pontos**: a soma ponderada do que a aba mede. Nos condutores e team leaders o trabalho na rua conta pelos pontos da avaliação, e os dias acima do limite descontam.
  - **Nota**: 100 para o melhor.
- Na tabela, o **nome** abre a ficha no RH; o resto da linha abre o **detalhe** (a evolução dela e todos os números). Todos os cabeçalhos ordenam (um clique sobe, outro desce, o terceiro volta ao ranking).
- **Cidade e marca**: o filtro do topo. Com uma cidade escolhida, cada dia conta na cidade onde a pessoa trabalhou (a escala ou a avaliação do dia). Quem tem a ficha noutra cidade entra só com os dias que fez nesta. A marca conta como a cidade dela.
- **Condutores e extras**: quem não fez nada no período não aparece. **km sem movimentos** quer dizer que a pessoa tem km do Zello mas nenhum movimento na Multipark: o utilizador do Zello/PDA e o agente da Multipark não estão na mesma ficha. Carrega no aviso para abrir as **Ligações** e juntar.
- **Team leaders pela escala**: quem tem posto de condutor ou extra mas foi team leader em pelo menos metade dos dias escalados do período aparece nos Team leaders, com a etiqueta "TL pela escala".
- **A equipa**, nas abas Team leaders e Supervisão:
  - **Team leader**: o turno dele na escala (mesmo dia, cidade e turno, sem ele).
  - **Supervisor**: todos os escalados das cidades da conta dele, team leaders incluídos. Dois supervisores da mesma cidade partilham a equipa.
  - Para cada um mostra: dias com equipa, pessoas·dia, movimentos da equipa (recolhas, entregas e movimentos), custo da equipa (como na Atividade do dia), quem mexeu carros sem o Zello ligado, horas paradas (GPS), movimentos por pessoa·dia e € por movimento.
  - No supervisor mostra também as **extras a menos / a mais**: as horas·pessoa abaixo ou acima da previsão do Extras Dia. Só aparece com **Dia** ou **Semana**, porque a previsão é lida ao vivo, dia a dia.
  - **Pontos da equipa**: contam-se por dia e por pessoa da equipa, para uma equipa maior não ganhar só por ser maior. Cada movimento dá +1, cada pessoa que mexeu carros sem Zello −20 e cada hora parada −2, sempre a dividir pelo número de pessoas da equipa. Somam-se aos pontos do TL (que é avaliado também como condutor) e do supervisor.
- **Como se contam os pontos desta aba**: a tabela de baixo mostra quanto vale cada coisa, os pontos da avaliação (recolha +3, movimento +2…) e os da equipa.
- Os telefonemas da central contam quando a consola da Vodafone os regista na dashboard (Integrações → Central Vodafone). As chamadas internas (com colegas do RH ou de extensões) não contam, exceto as do supervisor a ligar aos extras (a chamar o pessoal). As chamadas do WhatsApp contam sempre. Os emails mandados diretamente no Gmail ainda não têm autor.

**Quando a leitura falha**
- Mostra **"Não foi possível carregar…"** com **Tentar de novo**, nunca "sem dados".
