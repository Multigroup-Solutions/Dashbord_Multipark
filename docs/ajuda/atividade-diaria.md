---
modulo: atividade_diaria
titulo: Actividade Diária (quem fez o quê, GPS e PDAs)
rotas: /operacional
palavras: trajeto, mapa das velocidades, geojson, recolher dados, forçar re-divisão, escolher pessoa, actividade diária, atividade diária, atividade do dia, quem fez o quê, recolhas, entregas, movimentações, no horário, fora do horário, escalados, km, quilómetros, gps, zello, velocidade, excessos, histórico de velocidade, ao vivo, mapa, pda, pdas, check-in do pda, retirar pda, agente por ligar, parceiro, pda sem login, ponto
---
# Actividade Diária

Menu **Operações → Actividade Diária**: quem fez o quê nas reservas, os km e as velocidades do GPS (Zello) e os PDAs. As transcrições de rádio estão em **Operações → Rádio**.

**Que abas vês**
- Só aparecem as abas a que a tua conta tem acesso. **Atividade do Dia** e **Ao Vivo** pedem a Actividade Diária; **Histórico Diário**, o Histórico diário (GPS); **PDAs**, os PDAs.
- **Condutores e extras** veem só **O meu histórico de velocidade**: os km e as velocidades deles, dia a dia, nos últimos 30 ou 90 dias.

**Atividade do Dia**
- Escolhe **Hoje**, **Ontem**, **Últimos 7d**, **Últimos 30d**, **Este mês** ou um **Intervalo**. O intervalo pode ter até **93 dias**; acima disso aparece o aviso e não se pede nada.
- Os cartões mostram recolhas, entregas, movimentações, cancelamentos, ações no horário e fora dele, km do GPS, pessoas ativas e, para quem vê os totais financeiros, o custo dos extras.
- A tabela **Quem fez o quê** tem uma linha por pessoa. O tipo vem escrito ao lado do nome:
  - sem nada: colaborador com ficha ligada;
  - **🤝 (parceiro)**: agência ou parceiro que marca pelo portal;
  - **⚠ (agente por ligar)**: agente da Multipark sem ficha ligada (liga-o em **RH → Agentes**);
  - **📡 (PDA sem login)**: km de um PDA sem ninguém com login.
- As ações contam no dia do **turno**: a noite que passa a meia-noite fica no dia em que começou.
- Clica no **nome** para abrir a **ficha** da pessoa no RH. Clica no resto da linha (ou carrega em Enter) para abrir **o dia dessa pessoa**: ações, GPS com o trajeto, PDAs e ponto.
- **Todas as pessoas** (por cima da tabela) escolhe uma pessoa só; **Todas** volta à lista toda.

**Histórico Diário**
- O GPS de um dia por pessoa: km, horas em movimento e paradas, velocidades, excessos, bateria e trajeto. **Export CSV** descarrega a tabela.
- Abre no último dia que o Zello já entrega completo (há 2 dias). **Ontem** ainda não vem do Zello, por isso aparecia vazio.
- Clica no **nome** para abrir a ficha. Clica no resto da linha para ver o **histórico de velocidade** dessa pessoa: a velocidade máxima e a média em movimento, dia a dia.
- **Trajeto** abre o dia no **mapa**, pintado pela velocidade:
  - azul claro é devagar e azul escuro é depressa;
  - a **vermelho** está o que passou o limite dos excessos;
  - estão marcados o início, o fim e o ponto da velocidade máxima;
  - por baixo aparece um gráfico com a velocidade ao longo do dia e a linha do limite;
  - um dia com muitos pontos é reduzido para o mapa, mas os excessos ficam sempre.
- A recolha corre de madrugada. Quem gere o Histórico diário tem dois botões:
  - **Recolher Dados** vai buscar agora ao Zello o GPS do dia escolhido (km, velocidades, trajeto) de todos os utilizadores. O Zello só dá um dia completo 2 dias depois; o de hoje fica provisório.
  - **Forçar re-divisão** volta a repartir o GPS já recolhido pelas pessoas que tinham cada PDA (pelos check-ins de PDA). Usa-se depois de corrigir um check-in. Não volta ao Zello nem muda as velocidades.

**Ao Vivo**
- Mapa com a posição de cada condutor. Atualiza sozinho a cada 30 segundos.
- Em cima fica uma linha só: quantos estão no mapa, a hora da última leitura e os alertas contados (acima do limite de velocidade, bateria fraca, sem reportar há mais de 1 h). Carrega num alerta para ver os nomes.
- **Atualizar** lê tudo de novo (posições, ligações Zello ↔ pessoas e PDAs) e volta a mostrar toda a gente no mapa.
- **Utilizadores Zello ↔ Pessoas**: os PDAs ligam-se pelo check-in do dia; o seletor fixo é só para telemóveis pessoais.

**PDAs**
- Os PDAs da cidade, quem está com cada um e desde quando, e os alertas **A trabalhar sem PDA ou Zello ligado**.
- **Novo PDA**, **editar** e **QR** para quem edita PDAs. O olho abre o **histórico** do PDA (os últimos 100 check-ins).
- **Retirar** (o caixote, só administração) passa o PDA a **Inativo**. Nunca se apaga: o histórico de quem o teve e o GPS partido por pessoa ficam.

**Quando a leitura falha**
- Aparece um aviso vermelho **"Não foi possível carregar…"** com **Tentar de novo**. Os cartões mostram **—** em vez de 0. Uma falha nunca aparece como "sem atividade", "sem dados" ou "nada em aberto".
- Sem permissão aparece **"Sem acesso"**.

Cada pessoa só vê as pessoas, os PDAs e o GPS das suas cidades.
