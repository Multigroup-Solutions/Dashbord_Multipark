---
modulo: extras_dia
titulo: Extras-Dia
rotas: /extras-dia
palavras: pressão, hora apertada, horas apertadas, tempo de entrega, tempo de recolha, horas de ponta, carga, extras dia, extras, escala, escalar, turno, turnos, previsão, pico, condutores necessários, team leader, TL, avisar, aviso de trabalho, preencher com disponíveis, cobertura, slots, lavagens, chegadas, saídas, mandar para casa, custo escalado
---
# Extras-Dia

Planeamento do dia seguinte: chegadas, saídas, lavagens e quantos condutores são precisos por hora, e a escala dos extras.

**Ver a previsão**
1. Menu **Operações → Extras Dia**.
2. Em cima à direita escolhe a **Data base** (a previsão é para o dia seguinte) e a cidade (📍). Só vês as cidades a que tens acesso.
3. Vês a hora de pico, as chegadas/saídas por hora, as lavagens (hoje, amanhã, depois de amanhã) e os "Slots ainda por cobrir".
4. As reservas são lidas **ao vivo da BD da Multipark** (parques nossos da cidade, sem canceladas e sem os **Parques que a operação não faz** das Definições — ex.: um parque do Porto que a operação não faz não entra na previsão nem nos blocos). Se a BD da Multipark não responder, a página usa a cópia local das reservas e mostra um aviso amarelo — nesse caso os números podem estar desatualizados.
5. Na tabela **Por hora**, a etiqueta **hora apertada** marca as horas que, nos últimos 60 dias, estiveram no top 20 % desse dia da semana em carros por hora ou em tempo de entrega (p75). Passa o rato por cima para ver o motivo.

**Separador "Pressão"** (quando é que aperta)
1. Em cima, escolhe o separador **Pressão** (o separador **Dia** é a previsão de sempre).
2. Escolhe o grupo de parques: a cidade toda (todas as marcas), uma marca + cidade (ex.: Airpark Lisboa) ou o Marketplace.
3. **Onde aperta**: frases curtas com os blocos mais apertados, por exemplo "sextas 17–20h em Lisboa: 42 saídas/h, entrega p75 28 min".
4. **Dia da semana × hora**: mapa de calor. Alterna entre **Carros/hora** (chegadas + saídas concluídas, média por dia) e **Entrega p75** (minutos entre o pedido do cliente e o carro entregue; 75 % das entregas demoram menos do que isto). Contorno laranja = hora apertada. Passa o rato por uma célula para ver volume, carros em simultâneo, mediana/p75/p90 da entrega e o tempo de recolha.
5. **Carga × tempo de entrega**: tabela que compara o tempo de entrega consoante os carros tratados nessa hora, separando horas de ponta (07–10h e 17–20h, aproximação do trânsito) do resto do dia.
6. Os dados são dos últimos 60 dias e são recalculados todos os dias a partir das 04:45 (tarefa automática **Extras-Dia: pressão**), sem os **Parques que a operação não faz** (uma mudança nessa lista só conta a partir do cálculo seguinte). Isto é a base do futuro cálculo automático de extras — por agora é só informação.

**Escalar a equipa** (Team Leader, Supervisor e acima)
1. Na secção **Equipa Manhã / Noite**, carrega em **Adicionar** e escolhe a pessoa, a hora de início e de fim (mínimo 3 h, máximo 12 h).
2. Ou usa **Preencher com disponíveis**: escala quem marcou disponibilidade, pelos turnos que a previsão sugere.
3. Define o **Team Leader** do turno (tem de vir do RH).
4. Carrega em **Avisar por WhatsApp** para enviar o aviso de trabalho a quem ainda não foi avisado. O estado aparece ao lado de cada pessoa: avisado, ✓ confirmou, ✗ não pode.
5. Se não houver trabalho, usa "Mandado p/ casa" na linha da pessoa.

**Notas**
- "Formação em falta" = a pessoa ainda não concluiu a formação obrigatória.
- O **Custo escalado** e as horas pagas atualizam-se à medida que escalas.
- Um condutor só vê (não edita) esta página.
