---
modulo: reclamacoes
titulo: Reclamações
rotas: /reclamacoes
palavras: reclamação, reclamações, cliente, 90 dias, ver todas, cliente respondeu, aviso ao responsável, queixa, dano, sujidade, atraso, cobrança, sla, prazo, email ao cliente, condutores envolvidos, quem mexeu no carro, em serviço, reserva, converter em perdido, em análise, aguarda cliente, arquivar, arquivadas, tirar do arquivo, eliminar, fotos, pontos, csv, anexar email, sincronizar emails, aviso de receção, sugestões da ia
---
# Reclamações

Casos de clientes insatisfeitos (danos, sujidade, atraso, cobrança, staff…).

**Criar**
1. Menu **Suporte → Reclamações** → **Nova Reclamação**.
2. Indica pelo menos um dado do cliente: nº de reserva, matrícula, email, telefone ou nome. Ao gravar, a reserva liga-se sozinha (e completa os dados em falta). No caso, **Ligar reserva automaticamente** volta a tentar.
3. Escolhe o tipo, a prioridade e o prazo (SLA) e escreve uma descrição breve. **Criar Reclamação**.
- Quem só vê a sua cidade e não escolhe o projeto: a reclamação fica na cidade dessa pessoa.
- Os emails para **reclamacoes@** criam reclamações sozinhos (já não há botão "Sincronizar emails": entram sem ninguém carregar). O cliente recebe um aviso de receção com o nº do processo **[REC-n]**, se esse aviso estiver ligado nas Definições.

**Tratar**
- O quadro mostra os estados: Novo → Em Análise → Aguarda Cliente → Resolvido/Fechado. Arrasta ou muda o estado no caso. As convertidas ficam em Fechado e não se movem.
- O quadro abre nas reclamações dos **últimos 90 dias** e em **todas as que ainda estão abertas** (Novo, Em Análise, Aguarda Cliente), sejam de quando forem. **Ver todas** tira o limite; **Só os últimos 90 dias** volta. Ao pesquisar procura em todas; as **Arquivadas** vêm sempre todas.
- Os contadores contam o que está no quadro (tipo, pesquisa e limite de 90 dias incluídos). **Em atraso** = prazo passado em Novo ou Em Análise.
- No caso: separadores **Detalhes**, **Mensagens**, **Fotos**, **Viatura** (quem mexeu no carro), **Em serviço**, **Histórico** e **Comunicações**.
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
- Lista, caso, reserva, histórico, condutores, sugestões da IA e histórico do cliente mostram **"Não foi possível carregar…"** com **Tentar de novo**. Uma falha nunca aparece como "Sem tickets", "0" ou "não corresponde a nenhuma reserva".

**Quem pode**
- Ver, criar e tratar: conforme o acesso a Reclamações, sempre na tua cidade.
- **CSV** (leva contactos do cliente): só quem pode exportar.
- Condutores e extras **não veem** reclamações — nem as em que estão envolvidos (notas internas e contactos do cliente). Só a partir de team leader. O mesmo nas Críticas, Ocorrências e Perdidos.
- O **responsável** só pode ser team leader ou acima (ao criar e em **Atribuição & prazo**). Um responsável antigo abaixo disso aparece marcado "(abaixo de team leader — troca)".
