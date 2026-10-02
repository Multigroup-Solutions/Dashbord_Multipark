---
modulo: extras_dia
titulo: Extras-Dia
rotas: /extras-dia
palavras: arquivo da escala, tirar da escala, aviso desatualizado, previsão incompleta, proposta automática, suspender, compras online por pagar, pressão, hora apertada, horas apertadas, tempo de entrega, tempo de recolha, horas de ponta, carga, extras dia, extras, escala, escalar, turno, turnos, previsão, pico, condutores necessários, team leader, TL, avisar, aviso de trabalho, preencher com disponíveis, cobertura, slots, lavagens, chegadas, saídas, mandar para casa, custo escalado
---
# Extras-Dia

Planeamento do dia seguinte: chegadas, saídas, lavagens e quantos condutores são precisos por hora, e a escala dos extras.

**Ver a previsão**
1. Menu **Operações → Extras Dia**.
2. Em cima à direita escolhe a **Data base** (a previsão é para o dia seguinte) e a cidade (📍). Só vês as cidades a que tens acesso.
3. Vês a hora de pico, as chegadas/saídas por hora, as lavagens (hoje, amanhã, depois de amanhã) e os "Slots ainda por cobrir".
4. As reservas são lidas **ao vivo da BD da Multipark**: os parques nossos da cidade, sem as canceladas e sem os **Parques que a operação não faz** das Definições (por exemplo, um parque do Porto que a operação não faz não entra na previsão nem nos blocos).
   - As compras online ainda por pagar **contam**, porque vão ser recolhidas na mesma.
   - Se a BD da Multipark não responder, a página usa a cópia local das reservas e mostra um aviso amarelo; os números podem estar desatualizados.
   - Se a leitura vier **cortada no limite**, aparece "Previsão incompleta". Com a previsão incompleta (cortada ou só da cópia), a proposta automática e os avisos de falta de gente ficam parados.
5. Na tabela **Por hora**, a etiqueta **hora apertada** marca as horas que, nos últimos 60 dias, estiveram no top 20 % desse dia da semana em carros por hora ou em tempo de entrega (p75). Passa o rato por cima para ver o motivo.

**Separador "Pressão"** (quando é que aperta)
1. Em cima, escolhe o separador **Pressão** (o separador **Dia** é a previsão de sempre).
2. Escolhe o grupo de parques: a cidade toda (todas as marcas), uma marca + cidade (ex.: Airpark Lisboa) ou o Marketplace.
3. **Onde aperta**: frases curtas com os blocos mais apertados, por exemplo "sextas 17–20h em Lisboa: 42 saídas/h, entrega p75 28 min".
4. **Dia da semana × hora**: mapa de calor. Alterna entre **Carros/hora** (chegadas + saídas concluídas, média por dia) e **Entrega p75** (minutos entre o pedido do cliente e o carro entregue; 75 % das entregas demoram menos do que isto). Contorno laranja = hora apertada. Passa o rato por uma célula para ver volume, carros em simultâneo, mediana/p75/p90 da entrega e o tempo de recolha.
5. **Carga × tempo de entrega**: tabela que compara o tempo de entrega consoante os carros tratados nessa hora, separando horas de ponta (07–10h e 17–20h, aproximação do trânsito) do resto do dia.
6. Os dados são dos últimos 60 dias e são recalculados todos os dias a partir das 04:45 (tarefa automática **Extras-Dia: pressão**), sem os **Parques que a operação não faz** (uma mudança nessa lista só conta a partir do cálculo seguinte). Isto é a base do futuro cálculo automático de extras — por agora é só informação.

**Escalar a equipa** (Team Leader, Supervisor e acima)
1. Na secção **Equipa Manhã / Noite**, carrega em **Adicionar** e escolhe a pessoa e as horas de início e de fim.
   - O turno tem no mínimo 3 h e no máximo 12 h.
   - O início é a partir das 03h; da 0h às 3h é a noite do dia anterior (24h–27h).
   - A mesma pessoa não pode ficar a horas sobrepostas no mesmo dia, nem noutra cidade.
2. Ou usa **Preencher com disponíveis**: escala quem marcou disponibilidade, pelos turnos que a previsão sugere. Lê a disponibilidade da mesma forma que a proposta automática.
3. Define o **Team Leader** do turno (tem de vir do RH).
4. Carrega em **Avisar este turno** para enviar o aviso de trabalho a quem desse turno está confirmado e ainda não foi avisado.
   - Ao lado de cada pessoa aparece o estado: avisado, ✓ confirmou, ✗ não pode.
   - **Aviso desatualizado** quer dizer que as horas mudaram depois do aviso; avisa outra vez.
   - Para um dia que já passou, não se avisa nem se confirma.
5. Se não houver trabalho, usa "Mandado p/ casa" na linha da pessoa.
6. **Tirar da escala** pergunta antes. Se a pessoa já tinha sido avisada, recebe um aviso de que saiu. A linha não se apaga: fica no arquivo da escala, com quem a tirou e quando.

**Proposta automática**
- **Refazer a proposta** só substitui as linhas que a proposta tinha criado e que ainda estão por confirmar. Quem foi posto à mão, quem foi editado e quem já está confirmado ficam. As linhas substituídas vão para o arquivo.
- Editar uma linha não apaga as notas e fica registado quem alterou.
- **Suspender envio automático** só trava a confirmação e os avisos do cron; a proposta automática desse dia continua a correr.
- **Pedir disponibilidade a quem não respondeu**: o número do botão é o número de extras da cidade sem resposta, e é a eles que o pedido vai.

**Quem vê o quê**
- Quem só vê a escala (por exemplo, um condutor) vê as escalas e os turnos, **sem euros** e sem os botões de ação.
- Custos e taxas dos extras: quem planeia a escala.
- Custo do Team Leader: vem do salário, por isso só o vê quem vê salários ou os totais financeiros.
- O custo da escala é uma **estimativa**: o extra recebe pelas horas de ponto.

**Notas**
- "Formação em falta" = a pessoa ainda não concluiu a formação obrigatória.
- O **Custo escalado (estimativa)** e as horas pagas atualizam-se à medida que escalas.
- Se uma leitura falhar, aparece **"Não foi possível carregar…"** com **Tentar de novo**, nunca "nenhum condutor escalado".
- No telemóvel, o nível, as horas pagas e o custo de cada pessoa aparecem por baixo do nome.
