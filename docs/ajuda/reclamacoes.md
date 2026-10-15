---
modulo: reclamacoes
grupo: Suporte
pagina: reclamacoes
titulo: Reclamações
rotas: /reclamacoes
palavras: reclamação, reclamações, por confirmar, por confirmar ia, é reclamação, não é reclamação, criada pela ia, reclamação escondida, reencaminhamento, livro de reclamações, cliente, 90 dias, ver todas, cliente respondeu, aviso ao responsável, queixa, dano, sujidade, atraso, cobrança, sla, prazo, email ao cliente, condutores envolvidos, quem mexeu no carro, em serviço, reserva, converter em perdido, em análise, aguarda cliente, arquivar, arquivadas, tirar do arquivo, eliminar, fotos, pontos, csv, anexar email, sincronizar emails, aviso de receção, sugestões da ia, emails do cliente, histórico de emails, todas as caixas, parece uma reclamação, criar reclamação, não é reclamação, origem, filtros, responsável, sem cidade, datas, telemóvel
---
# Reclamações

Casos de clientes insatisfeitos (danos, sujidade, atraso, cobrança, staff…).

**Criar**
1. Menu **Suporte → Reclamações** → **Nova Reclamação**.
2. Indica pelo menos um dado do cliente: nº de reserva, matrícula, email, telefone ou nome. Ao gravar, a reserva liga-se sozinha (e completa os dados em falta). No caso, **Ligar reserva automaticamente** volta a tentar.
3. Escolhe o tipo, a prioridade e o prazo (SLA) e escreve uma descrição breve. **Criar Reclamação**.
- Quem só vê a sua cidade e não escolhe o projeto: a reclamação fica na cidade dessa pessoa.
- Os emails para **reclamacoes@** criam reclamações sozinhos (já não há botão "Sincronizar emails": entram sem ninguém carregar). O cliente recebe um aviso de receção com o nº do processo **[REC-n]**, se esse aviso estiver ligado nas Definições.
- Uma reclamação que chega a **outra caixa** (info@, reservas@, cancelamentos…) também vem para aqui — ver "Reclamações que a IA vê noutras caixas".

**Reclamações que a IA vê noutras caixas**
- A IA lê cada email das caixas partilhadas (info@, reservas@, cancelamentos…) **pelo sentido** — não por palavras. Vê a reclamação mesmo **escondida noutro pedido** ("quero mudar a data… e da última vez o carro veio sujo"), num pedido de reembolso zangado, num "nunca mais", numa **resposta** curta ("ainda estou à espera!") ou num **reencaminhamento** do backoffice. Quando vê uma reclamação:
  - **certeza alta** → a reclamação é criada sozinha, ou o email junta-se à reclamação **aberta** do mesmo cliente (mesma conversa, o nº **[REC-n]** no assunto, ou o mesmo email; a mesma matrícula ou a mesma reserva só quando essa reclamação é do mesmo email ou não tem email — nunca no caso de outro cliente, nunca só pelo nome ou pelo assunto). Se o email do mesmo cliente traz **outra reserva ou outra matrícula** ("Reserva: …", "Matrícula: …") do que a reclamação aberta, é **outra reclamação**;
  - **certeza média** → a reclamação é criada na mesma, marcada **"Por confirmar (IA)"** (selo no cartão e aviso roxo no caso). Abre-a e carrega em **É reclamação** (confirma) ou **Não é reclamação** (arquiva com o motivo — nada se apaga; volta com "Tirar do arquivo");
  - **pouca certeza** → nada.
- A conversa vai para a caixa **Reclamações** da Comunicação, **por ler**.
- Nunca para emails internos (salvo o backoffice a reencaminhar a queixa de um cliente), automáticos, envios em massa nem avisos de avaliações.
- **Parceiros** (agência, hotel, comparador — contacto das Parcerias) que escrevem em nome de um cliente: só com o interruptor **"IA: reclamações e perdidos que um parceiro manda em nome de um cliente abrem o caso"** (Definições → Automações; **desligado** por omissão). Ligado, a reclamação nasce sempre **"Por confirmar (IA)"** e o email do parceiro **não fica** como o do cliente (nunca junta reclamações de clientes diferentes da mesma agência) — confirma quem é o cliente. Desligado, o email de um parceiro nunca abre reclamação.
- Quando a IA diz que há uma queixa **em qualquer parte** do email (mesmo de passagem, dentro de outro pedido), a reclamação abre pelo menos **"Por confirmar (IA)"**, mesmo que a certeza seja baixa.
- Um email só em HTML (sem texto simples) é lido pelo texto do HTML — não só pelas primeiras linhas.
- **Nunca responde ao cliente**: sem aviso de receção, sem resposta. O aviso no sino vai à equipa como numa reclamação nova ("Reclamação por confirmar (IA)" quando é o caso).
- Uma conversa nunca dá duas reclamações, mesmo que a sincronização corra outra vez. Se o cliente responder nessa conversa, a resposta entra na mesma reclamação (volta a **Em Análise**). Uma reclamação **"Por confirmar (IA)"** que alguém **arquivou** ("Não é reclamação") **não volta** com a resposta seguinte do cliente: a pessoa já decidiu.
- O **Livro de Reclamações eletrónico** (aviso da plataforma oficial) abre sempre a reclamação.
- Na reclamação fica uma nota **"Criada pela IA"** com a caixa por onde chegou, o motivo e a certeza, e a origem **IA (email noutra caixa)**. Nos cartões aparece o selo **IA**.
- As sugestões antigas **Parecem reclamações** (de antes de 14 out 2026, ou quando não se conseguiu confirmar se o remetente é um parceiro) continuam no topo, com **Criar reclamação** e **Não é reclamação**.
- Se a criação falhar (Gmail ou base de dados em baixo), fica em **Parecem reclamações** como **Falhou ao criar** com **Tentar de novo**; o sistema também volta a tentar sozinho.
- **As que já estão nas caixas**: com o interruptor **"IA: rever os emails que já estão nas caixas"** (desligado por omissão) a IA passa também pelos emails dos últimos 30 dias ainda sem caso.
- Interruptor: Definições → Automações → **"IA: reclamações que chegam a outras caixas vão para as Reclamações"** (ligado). Precisa de **"IA: separar emails e WhatsApp pelas caixas"** ligado (é a mesma leitura da IA). As certezas estão em Definições → Parâmetros → IA (**ai.mailComplaints**: 0,85 para confirmada, 0,5 para "Por confirmar"). Desligado: deixa de criar.
- Para ver se a IA está a apanhar as reclamações: Definições → Comunicação → **Testar a triagem** (super admin). A meta é mais de 90 % em cada um dos três conjuntos de exemplo.

**Filtros**
- **Pesquisar**: nº, título, nome, email, telefone, reserva, matrícula e responsável (sem acentos nem traços: "aa12bb" encontra "AA-12-BB"). **#12** abre só a reclamação nº 12.
- **Estado** (também **Em aberto** e **Em atraso**), **Tipo**, **Cidade** (inclui **Sem cidade** para quem vê todas), **Responsável** (ou **Sem responsável**), **Origem** (email, IA, WhatsApp, crítica Google, ocorrência/perdido, à mão, API, ou **Por confirmar (IA)** — só as que a IA criou e ninguém confirmou) e **Criada de / até** (dia de Lisboa).
- Quando há reclamações **"Por confirmar (IA)"**, aparece por cima do quadro quantas são, com **Ver só essas**.
- Tudo filtra a **mesma** lista: o quadro, os contadores, o CSV e o total batem sempre certo. **Limpar filtros** volta ao início. Os filtros ficam guardados enquanto o separador estiver aberto (sair e voltar às Reclamações não os perde).
- Escolher uma cidade no cabeçalho tira o **Sem cidade**.
- Com datas escolhidas procura em todas (sem o limite dos 90 dias), como a pesquisa.
- No telemóvel os filtros estão no botão **Filtros (n)** e o quadro mostra **um estado de cada vez** (os botões têm as contagens).

**Tratar**
- O quadro mostra os estados: Novo → Em Análise → Aguarda Cliente → Resolvido/Fechado. Arrasta ou muda o estado no caso. As convertidas ficam em Fechado e não se movem.
- O quadro abre nas reclamações dos **últimos 90 dias** e em **todas as que ainda estão abertas** (Novo, Em Análise, Aguarda Cliente), sejam de quando forem. **Ver todas** tira o limite; **Só os últimos 90 dias** volta. Ao pesquisar procura em todas; as **Arquivadas** vêm sempre todas.
- Os contadores contam o que está no quadro (tipo, pesquisa e limite de 90 dias incluídos). **Em atraso** = prazo passado em Novo ou Em Análise.
- No caso: separadores **Detalhes**, **Mensagens**, **Fotos**, **Viatura** (quem mexeu no carro), **Em serviço**, **Histórico** e **Emails do cliente**.
- **Emails do cliente**: TODAS as conversas com o cliente nas caixas partilhadas que vês (info@, reservas@, reclamações@, cancelamentos…), da mais recente para a mais antiga — não só as desta reclamação. Cada uma mostra a caixa, o assunto, a última mensagem e a data; carregar abre a conversa na Comunicação. A desta reclamação está marcada **Esta reclamação**.
  - O cliente encontra-se pelo email da reclamação (e dos emails ligados ao caso), pelo email do cliente da reserva ligada e pelos emails da ficha do cliente no CRM. Em **Procurado por** vês quais.
  - Nunca entram os emails de **parceiros/agências** (uma agência reserva para muitos clientes — as conversas dela são de outros). A ficha do CRM só conta pelo telefone (ou por um email de duas fichas) quando tem o **mesmo nome**; empresas nunca.
  - O teu email pessoal ("O meu email") e as caixas a que não tens acesso nunca aparecem.
  - Mostra 10 de cada vez; **Ver mais** traz mais (até 100).
  - Em baixo, **Só desta reclamação** tem os emails ligados e as reuniões.
- **Mensagens**: o que escreves fica no caso. Ao cliente só chega o que enviares com **Enviar email** (há modelos de resposta).
- **Enviar email** passa o caso a **Aguarda Cliente** (só se estava em Novo ou Em Análise). Quando o cliente responde, volta a **Em Análise**, e um caso fechado reabre.
- Com **"Reclamações: avisar o responsável quando o cliente responde"** ligado nas Definições (vem desligado), o responsável recebe no sino **"O cliente respondeu à reclamação #n"** — no máximo um aviso por reclamação a cada 30 min, só emails do próprio cliente (um reencaminhamento interno não conta). Sem responsável não avisa ninguém.
- **Reabrir** (voltar a um estado aberto) limpa a data de fecho e o aviso de prazo; pode voltar a avisar.
- **Sugestões da IA** (tipo, prioridade, reserva, rascunho de resposta): nada é enviado ao cliente sem uma pessoa.
- **Anexar email da caixa** junta ao caso um email que não se ligou sozinho. Anexar outra vez não duplica.
- Se afinal é um objeto perdido, usa **Converter em Perdido** (admin).
- No cartão "Dados da Reserva", **Abrir ficha da reserva** mostra tudo sobre a reserva, lido em tempo real da Multipark.

**Prazo (SLA)**
- O prazo corre em **Novo** e **Em Análise**; em **Aguarda Cliente** para.
- Fora do prazo, a cidade e o responsável recebem um aviso (uma vez por reclamação).
- O prazo da **Atribuição** conta até ao fim do dia escolhido.

**Condutores (Em serviço)**
- **Sugeridos**: quem mexeu na reserva (ligado à ficha pela conta do agente na Multipark, nunca pelo nome) e quem estava escalado (confirmado) nos dias de entrada e saída, na cidade da reclamação.
- **Associar** liga a pessoa ao caso; os pontos contam na avaliação dela.
- **Tirar** pede confirmação: deixa de contar, mas a associação fica registada.

**Fotos**
- Só fotos (JPG, PNG, WebP, GIF, HEIC). As grandes são reduzidas antes de enviar.
- **Tirar a foto do caso** pede confirmação; a foto fica guardada.

**Arquivar (em vez de eliminar)**
- **Arquivar** (admin) pede o motivo. A reclamação sai das listas, contadores, lembretes e avaliação. Nada é apagado.
- **Arquivadas** mostra-as; no caso, **Tirar do arquivo** devolve-a.
- Se o cliente voltar a escrever, sai do arquivo sozinha.

**Quando a leitura falha**
- Lista, caso, reserva, histórico, condutores, sugestões da IA, histórico do cliente e **emails do cliente** mostram **"Não foi possível carregar…"** com **Tentar de novo**. Uma falha nunca aparece como "Sem tickets", "0", "sem emails" ou "não corresponde a nenhuma reserva".
- Nos emails do cliente, se só uma parte falhar (a reserva na Multipark ou a ficha do CRM), aparece o aviso **"podem faltar conversas"**.

**Quem pode**
- Ver, criar e tratar: conforme o acesso a Reclamações, sempre na tua cidade.
- **CSV** (leva contactos do cliente): só quem pode exportar.
- Condutores e extras **não veem** reclamações — nem as em que estão envolvidos (notas internas e contactos do cliente). Só a partir de team leader. O mesmo nas Críticas, Ocorrências e Perdidos.
- O **responsável** só pode ser team leader ou acima (ao criar e em **Atribuição & prazo**). Um responsável antigo abaixo disso aparece marcado "(abaixo de team leader — troca)".
