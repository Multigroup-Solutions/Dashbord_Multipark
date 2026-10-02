---
modulo: rh
titulo: RH e ponto
rotas: /rh, /rh/dashboard, /perfil
palavras: iban, nib, mudar o iban, pedido de iban, aprovar iban, comprovativo de iban, pedido de alteração, nif escondido, mostrar nif, pedir a cidade, extra sem cidade, márcia, não enviar, desligar mensagens, desligar emails, telefonar ao colaborador, escrever email ao colaborador, rh, recursos humanos, ponto, picar o ponto, check-in, check-out, dar entrada, dar saída, gps, foto, horas, horário, documentos, ficha, colaborador, novo colaborador, recibos, recibo de vencimento, folha de ordenados, extras, agentes, ligações, ligacoes, juntar contas, conta duplicada, conta perdida, dois emails, anexar agente, retirar agente, agente extra, conta extra, ficha sem cidade, cidade, centro de custo, agentes de teste, por ligar
---
# RH e ponto

**Picar o ponto**
1. No topo da aplicação carrega em **Dar entrada (check-in)** quando começas e **Dar saída (check-out)** quando acabas.
2. A aplicação pede uma **foto** e a **localização exata (GPS)**. Autoriza a localização no telemóvel; sem GPS não dá para picar.
3. Se deres entrada fora do raio do local de trabalho, fica registado com um aviso.
4. As tuas horas do mês aparecem na tua ficha (separador **Ponto**).

**A tua ficha**
- Em **Perfil → A minha ficha** (ou **Pessoas → Recursos Humanos**) abres a tua ficha: dados, **Documentos**, **Ponto** e **Horário**. O Perfil em si tem os atalhos, a foto, as notificações e as contas Google (ver a ajuda "Perfil").
- O **NIF** e o **IBAN** aparecem escondidos (PT50 •••• 1234); carrega em **mostrar** para os ver por extenso.
- **Mudar o IBAN**: se não és do RH, a mudança fica como **pedido** à espera de aprovação — o IBAN atual mantém-se até o RH aprovar. O IBAN é validado (número de controlo) e o pedido fica registado (mascarado). Carrega também o **Comprovativo NIB** nos Documentos. Sem centro de custos atribuído, consegues na mesma abrir a tua ficha, pôr a foto e carregar documentos.
- Carrega documentos (CC, carta de condução, comprovativo de morada, NIB…) no separador **Documentos**. Documentos em falta podem bloquear o acesso.

**Gestão** (Team Leader e acima, na sua cidade)
- **Pessoas → Recursos Humanos** lista os colaboradores (separadores Colaboradores, Extras, Agentes). Os emails de **recrutamento** (recursos-humanos@) passaram para os **Leads de Extras**.
- O separador **Agentes** ("Agentes por ligar") lê os agentes **ao vivo** da BD da Multipark: os ativos e os que tiveram ações nos últimos 180 dias e ainda não estão ligados a uma ficha, a um parceiro nem marcados como "não é funcionário". A ligação automática de hora a hora (por email e por nome) usa a mesma leitura. Se a BD da Multipark não responder, aparece um aviso e a lista vem da cópia antiga (sem os agentes novos).
- Num **PDA registado**, ao entrar na app o aparelho fica ligado a ti (e ao Zello do PDA) até saíres ou outra pessoa entrar. Se essa ligação falhar, aparece um aviso — fala com a chefia.
- **PDAs só pelo QR**: cada PDA regista-se uma vez lendo, no próprio aparelho, o QR colado nele (Operacional → PDAs → botão QR). Já não há check-in manual nem registo pela lista. A seguir ao registo aparece **Instalar a app neste PDA**: o dashboard fica instalado e abre sempre direto, no mesmo browser.
- Cada PDA tem uma **etiqueta** (nome ou número) e uma **cidade** fixa (Operacional → PDAs → editar).
- Com o interruptor **"Zello: nome de quem tem o PDA no mapa"** ligado (Definições → Automações), o nome da conta Zello do PDA passa a "PDA 12 · Rui Santos" quando alguém entra, e volta a "PDA 12" quando sai.
- **A trabalhar sem PDA ou Zello ligado** (Operacional → PDAs, em cima): de 5 em 5 minutos aparecem aqui as pessoas do operacional com o ponto aberto sem PDA (passados 10 min), com o Zello do PDA desligado, ou com movimentos na Multipark sem ponto aberto ou com o Zello desligado. O back office e o front office ficam de fora. Cada alerta fecha sozinho quando o problema desaparece.
  - Com o interruptor **"Alertas: a trabalhar sem PDA ou Zello ligado"** ligado, avisa no sino o team leader escalado nesse turno e cidade, os team leaders com ponto aberto na cidade e o supervisor.
  - Quem recebe carrega em **Visto** (com uma nota, se quiser). Sem ligação nem Visto em 10 min (Definições → Operação), e com o interruptor do WhatsApp ligado, vai um WhatsApp (modelo aprovado pela Meta) aos administradores da cidade e à cópia (Definições → Operação → "WhatsApp dos administradores").
- Na ficha, **Ligar**, **WhatsApp** e **Email** para o colaborador (o telefone e o email da empresa e os pessoais). O WhatsApp fica ligado à ficha e na caixa RH; o email abre na caixa **RH**.
- **Não enviar WhatsApp / Não enviar email** (na ficha, por baixo dos contactos): desliga para essa pessoa tudo o que é **automático ou em massa** nesse canal: pedidos e lembretes de disponibilidade, avisos de escala, turno cancelado, difusões, lembretes de formação e o pedido da cidade. Responder uma a uma (no WhatsApp ou num email) continua a funcionar. **Só o RH** (front office, back office, administrador) liga ou desliga — o próprio já não; fica no registo.
- **Pedidos de IBAN** (RH): aparecem no topo de **Recursos Humanos** e na ficha, com o IBAN novo por extenso para conferires com o comprovativo → **Aprovar** (passa a ser o IBAN da ficha) ou **Recusar** (com motivo). Quem pediu não aprova o próprio pedido. O RH muda o IBAN de uma ficha diretamente (validado e registado). Aviso no sino: interruptor **"Aviso dos pedidos de IBAN"** (Definições → Automações, desligado por omissão).
- **Foto da ficha**: só JPEG, PNG ou WebP (a app reduz a foto antes de enviar); a troca fica registada — é a foto que se compara com a selfie do ponto.
- **Novo Colaborador** cria uma ficha; cada ficha precisa de centro de custos (cidade).
- Correções de ponto: na ficha, separador Ponto, revê e corrige as horas.
  - **Aprovar** com horas corrigidas paga essas horas — **0 horas quer dizer que não se paga** o turno (entra na folha com 0 h). Deixar vazio mantém as horas registadas.
  - **Rejeitar** tira o turno da folha.
- Ordenados, recibos e folha para o contabilista só para admin.
- **Folha para o contabilista** gera o PDF da folha do mês, abre-o num separador novo e avisa o RH com o link. O envio ao contabilista faz-se à mão (descarrega o PDF e envia-o).

## Ligações (fichas, contas de login e agentes da Multipark)

Em **RH → Ligações** (quem gere o RH) vês o que falta ligar entre as fichas, as contas de login e os agentes da Multipark. A ligação automática corre de hora a hora; aqui ficam os casos para decidir à mão. Para ligar ou procurar, só contam letras e números: acentos, maiúsculas, apóstrofos e traços não contam ("João d'Almeida-Sá" = "JOAO DALMEIDA SA").

**Uma pessoa: contas e agentes**
1. Escolhe a ficha. Vês as **contas de login** (principal e extra) e os **agentes da Multipark** (principal e extra). Uma pessoa pode ter vários agentes (emails antigos e novos).
2. **Anexar agente**: escreve o nome ou o email do agente e carrega em **Anexar**. Se o agente estava noutra ficha, passa para esta. Se a pessoa já tinha agente, este entra como agente extra.
3. **Retirar**: tira o agente da ficha. Se era o principal e havia extras, o primeiro extra passa a principal.

**Comparar a lista de agentes da Multipark (xlsx ou CSV)**
1. Na Multipark exporta os agentes (xlsx) e carrega o ficheiro no cartão **Comparar a lista de agentes da Multipark**. É lida a folha **Agentes** (nome, email, telefone, cargo, estado e ID de utilizador). O CSV antigo (nome_agente;email;cidade) também serve.
2. Com o xlsx, cada agente é identificado pelo **ID de utilizador** (sem adivinhas). A equipa (condutores, supervisores, chefes de turno…) é comparada com as fichas pelo **email**, depois pelo **telefone** e por fim pelo **nome**: **Ligado**, **Ligar (mesmo email)**, **Ligar (mesmo telefone)**, **Ligar? (mesmo nome)**, **Sem ficha** ou **Não está na Multipark**.
3. Os agentes com cargo **Parceiro** (e as agências) vão para as **parcerias**, não para fichas: aparecem como **Parceiro por ligar**, com a parceria sugerida pelo domínio do email ou pelo nome, ou escolhes a parceria na lista.
4. Contas de sistema ("api") e de teste ficam em **Sistema / teste**. Os inativos e os de convite expirado aparecem marcados **inativo** (há a opção **Esconder inativos**).
5. Nada é ligado sozinho: carrega em **Ligar** em cada linha, ou em **Ligar os seguros** (os do mesmo email ou telefone e os parceiros encontrados pelo email). Os do mesmo nome vês um a um. Os "Sem ficha" anexam-se à mão no cartão **Uma pessoa**.

**Juntar contas** (só administradores)
- Caso típico: a ficha foi criada com um email (por exemplo do Outlook) e a pessoa entrou na app com outra conta Google, que ficou "perdida".
- Na ficha, escolhe a **conta perdida (sem ficha)** e carrega em **Juntar**, ou numa conta extra carrega em **Ficar só com esta**.
- Fica a conta que entra na app. Tudo o que era da pessoa passa para ela: a ficha, as permissões e cidades extra, as notificações, o Google, o email, o WhatsApp e os casos atribuídos. O papel fica o mais alto dos dois.
- A outra conta fica **desativada** ("conta duplicada"), nunca apagada, e o email dela passa para a ficha como email pessoal. O registo de quem fez o quê fica como estava.

**Juntar fichas da mesma pessoa** (só administradores)
- Caso típico: a ficha do RH e outra criada sozinha a partir de um login ou de um agente (ex.: "ribeirohelio662", "Agent DRIVER").
- No cartão **Uma pessoa**, escolhe a ficha que fica e, em **Ficha duplicada da mesma pessoa**, a outra. Carrega em **Juntar nesta ficha**: vês antes o que passa (ponto, PDAs, escalas, documentos…).
- Tudo o que era da outra passa para esta, com o utilizador e o agente da Multipark (principal se esta não tiver, senão extra). A outra fica **desativada** ("ficha duplicada"), nunca apagada.

**Agentes que não são pessoas**
- "system", "api" e "API User" são ações automáticas da Multipark: nunca se ligam a fichas e deixam de aparecer nos conflitos. Agentes de teste, agências e textos de formulário ("NOME DO RESPONSÁVEL…") também não. A ligação de hora a hora (e **Reconciliar agora**) tira-os das fichas onde tivessem ficado presos, e fica registado.
- Login com o email da casa (@multipark.pt…) e ficha com o email pessoal é o normal: já não aparece como conflito.
- **Agentes por ligar** mostra só quem mexeu em carros nos últimos 60 dias; os parados ficam num botão à parte ("Mostrar também os parados"). Há dois separadores: **Equipa** (liga à ficha da pessoa) e **Parceiros e agências** (liga à parceria, para sabermos quando mexem em carros ou fazem reservas — não precisam de utilizador aqui). Cada agente traz uma **sugestão** (mesmo email ou nome parecido) que aceitas com um clique, ou todas as do email de uma vez. Podes escolher vários e marcá-los como "não é funcionário".
- O email dos agentes vem dos convites da Multipark e, quando não há convite, do registo de atividade (quem fez cada ação). A ligação automática de hora a hora também já ignora a cidade colada no nome ("Bruno Meireles - PORTO") e números no fim, e aceita "primeiro nome + um apelido".

**Agentes de teste**
- Agentes cujo nome ou email diz "teste", "test", "demo" e parecidos não aparecem nos "por ligar". Continuam na Multipark.

**Fichas sem cidade**
- De hora a hora, uma ficha ativa sem cidade recebe a cidade onde o agente da Multipark da pessoa mais trabalhou nos últimos 180 dias. Se não houver agente, usa-se a cidade da candidatura ou da morada.
- Se nada der, a ficha fica em aberto e é criada uma **tarefa** com **prazo de uma semana**, com email, para a Márcia Nunes (Definições → "Responsável pelas fichas sem cidade"). Sem cidade a pessoa não consegue entrar na app **nem é chamada para a escala**.
- **Extras sem cidade** (com **"Pedir a cidade aos extras sem cidade"** ligado em Definições → Automações; desligado por omissão): antes da tarefa, o dashboard pede-lhe a cidade **uma vez**, por email (sai da recursos-humanos@, e a resposta cai na caixa RH) e por WhatsApp se a conversa com ele estiver aberta (respondeu nas últimas 24 h). Respeita o "Não enviar" da ficha. A tarefa e o email à Márcia dizem se o pedido saiu e por onde.
