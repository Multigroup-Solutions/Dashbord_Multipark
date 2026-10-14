/**
 * Corpus ROTULADO para avaliar a triagem dos emails (14 out 2026 — meta do
 * Jorge: mais de 90 % das reclamações e dos perdidos vão para lá).
 *
 * Emails realistas (fictícios: nomes, emails, matrículas e reservas
 * inventados), a maioria em PT-PT, mais inglês, espanhol e francês. Cada um
 * diz por que caixa entrou, se abre a conversa ou é uma resposta, os
 * cabeçalhos de envio em massa quando os tem, e a categoria CERTA (o que a
 * triagem deve decidir). Inclui os difíceis: reclamações disfarçadas (pedido
 * de reembolso zangado, "nunca mais", dentro de um pedido de alteração, um
 * reencaminhamento do backoffice, uma resposta curta), a palavra
 * "reclamação" num email que não é, perdidos misturados com elogios, avisos
 * automáticos e lixo.
 *
 * Usado pelo "Testar a triagem" (Definições → Comunicação, super admin) e por
 * scripts/eval-mail-triage.ts. Nunca entra em casos nem na Comunicação.
 */
import type { MailTriageCategory } from "../../shared/mailTriage";

export interface TriageCorpusItem {
  id: string;
  lang: "pt" | "en" | "es" | "fr";
  /** Caixa por onde entrou (info, reservas, rh, reclamacoes, perdidos…). */
  box: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  /** false = resposta numa conversa que já existe (omissão: abre a conversa). */
  newThread?: boolean;
  attachments?: string[];
  /** Cabeçalhos de envio automático/em massa. */
  headers?: { listUnsubscribe?: string; listId?: string; autoSubmitted?: string; precedence?: string };
  /**
   * Ronda 2: o remetente é um contacto das Parcerias (agência, hotel…) — em
   * produção isso decide se o caso abre (interruptor AI_MAIL_PARTNER_CASES).
   */
  partner?: boolean;
  expected: MailTriageCategory;
  /** Porque é difícil (para quem lê os erros). */
  note?: string;
}

const C = (o: Partial<TriageCorpusItem> & Pick<TriageCorpusItem, "id" | "expected" | "subject" | "body">): TriageCorpusItem => ({
  lang: "pt", box: "info", fromName: "Cliente", fromEmail: "cliente@gmail.com", newThread: true, ...o,
});

const NEWS = { listUnsubscribe: "<https://news.example.com/unsub?u=123>", listId: "<news.example.com>", precedence: "bulk" };

export const TRIAGE_CORPUS: readonly TriageCorpusItem[] = [
  // ─── Reclamações diretas ──────────────────────────────────────────────────
  C({ id: "rec-01", expected: "reclamacoes", fromName: "Rui Matos", fromEmail: "rui.matos@gmail.com", subject: "Risco na porta do meu carro",
    body: "Boa tarde,\n\nFui buscar o meu carro ontem ao aeroporto (reserva 48213) e tinha um risco enorme na porta do condutor que não estava lá quando o entreguei. Tenho fotografias de antes. Quero saber como vão resolver isto.\n\nRui Matos" }),
  C({ id: "rec-02", expected: "reclamacoes", box: "reservas", fromName: "Teresa Lopes", fromEmail: "teresa.lopes@hotmail.com", subject: "Atraso inaceitável na entrega",
    body: "Aterrei às 23h10 e o carro só me foi entregue à 00h05. Liguei três vezes e ninguém atendia. Estava com duas crianças pequenas no terminal. Isto não pode acontecer." }),
  C({ id: "rec-03", expected: "reclamacoes", fromName: "Paulo Fernandes", fromEmail: "pfernandes@sapo.pt", subject: "Cobrança errada",
    body: "Reservei 5 dias por 45€ e no cartão foram debitados 89€. Não pedi nenhum serviço extra. Exijo a devolução da diferença." }),
  C({ id: "rec-04", expected: "reclamacoes", fromName: "Marta Silva", fromEmail: "marta.silva88@gmail.com", subject: "Carro devolvido sujo e com lixo",
    body: "Olá. Deixei o carro limpo e quando o recebi tinha uma garrafa de água e papéis no banco de trás que não são meus, e o tapete cheio de terra. Não é o serviço que paguei." }),
  C({ id: "rec-05", expected: "reclamacoes", fromName: "João Correia", fromEmail: "joao.correia@outlook.pt", subject: "Péssimo atendimento do motorista",
    body: "O vosso condutor foi extremamente mal-educado comigo na entrega, falou-me aos gritos porque eu me atrasei 5 minutos por causa da bagagem. Gostava que alguém falasse com ele." }),
  C({ id: "rec-06", expected: "reclamacoes", fromName: "Ana Rebelo", fromEmail: "ana.rebelo@gmail.com", subject: "Quilómetros a mais",
    body: "O meu carro tinha 45.210 km quando o deixei e 45.287 quando o recebi. 77 km para um parque ao lado do aeroporto? Quero uma explicação." }),
  C({ id: "rec-07", expected: "reclamacoes", fromName: "Luís Nogueira", fromEmail: "luis.nogueira@gmail.com", subject: "Para-choques amolgado",
    body: "Bom dia, ao chegar a casa reparei que o para-choques traseiro está amolgado. Isto aconteceu enquanto o carro estava convosco. Aguardo contacto urgente." }),
  C({ id: "rec-08", expected: "reclamacoes", fromName: "Sofia Pinto", fromEmail: "sofia.pinto@iol.pt", subject: "Ninguém responde",
    body: "Já enviei dois emails e deixei mensagem no WhatsApp sobre o dano no meu carro e até hoje ninguém me respondeu. Vou avançar com o livro de reclamações se não tiver resposta até sexta." }),
  C({ id: "rec-09", expected: "reclamacoes", fromName: "Carlos Duarte", fromEmail: "cduarte@gmail.com", subject: "Combustível",
    body: "Deixei o carro com meio depósito e veio com a luz da reserva acesa. Alguém andou com o meu carro. Como é possível?" }),
  C({ id: "rec-10", expected: "reclamacoes", fromName: "Inês Rocha", fromEmail: "ines.rocha@gmail.com", subject: "Espera no aeroporto",
    body: "Fiquei 50 minutos à espera no ponto de encontro do Terminal 1, à chuva. Disseram-me que o motorista estava a caminho e nada. Muito desagradável." }),
  // ─── Reclamações disfarçadas ──────────────────────────────────────────────
  C({ id: "rec-11", expected: "reclamacoes", box: "cancelamentos", fromName: "Pedro Gaspar", fromEmail: "pedro.gaspar@gmail.com", subject: "Reembolso!!!",
    body: "Cancelei com 4 dias de antecedência como diz nas vossas condições e cobraram-me a reserva inteira. Quero o meu dinheiro de volta já, isto é uma vergonha.", note: "pedido de reembolso zangado" }),
  C({ id: "rec-12", expected: "reclamacoes", fromName: "Helena Costa", fromEmail: "helena.costa@sapo.pt", subject: "Última vez",
    body: "Foi a última vez que deixei o carro convosco. Nunca mais.", note: "\"nunca mais\" sem dizer o problema" }),
  C({ id: "rec-13", expected: "reclamacoes", box: "alteracoes", fromName: "Miguel Antunes", fromEmail: "miguel.antunes@gmail.com", subject: "Alterar data de regresso",
    body: "Olá, preciso de alterar a data de regresso da reserva 50122 para dia 22 às 14h. Aproveito para dizer que da última vez o carro veio com o banco do condutor todo manchado e ninguém me deu uma explicação, espero que desta vez não aconteça.",
    note: "reclamação dentro de um pedido de alteração" }),
  C({ id: "rec-14", expected: "reclamacoes", box: "info", fromName: "Backoffice Multipark", fromEmail: "backoffice@multipark.pt", subject: "Fwd: Problema com o meu carro",
    body: "Para tratar, por favor.\n\n---------- Forwarded message ---------\nDe: Ricardo Teles <ricardo.teles@gmail.com>\nDate: segunda, 13/10/2026 18:02\nSubject: Problema com o meu carro\nTo: <reservas@multipark.pt>\n\nBoa tarde, o espelho retrovisor direito do meu carro está partido desde que o fui buscar ao vosso parque no domingo. Reserva 49870. Preciso que me digam o que vão fazer.",
    note: "reencaminhamento do backoffice" }),
  C({ id: "rec-15", expected: "reclamacoes", newThread: false, fromName: "Rui Matos", fromEmail: "rui.matos@gmail.com", subject: "RE: Risco na porta do meu carro",
    body: "Já passou uma semana. Continuo à espera!!\n\nEm 07/10/2026, Multipark escreveu:\n> Caro Rui, estamos a analisar a situação do risco na porta e voltaremos a contactar.",
    note: "resposta curta a uma reclamação" }),
  C({ id: "rec-16", expected: "reclamacoes", fromName: "Diana Moreira", fromEmail: "diana.moreira@gmail.com", subject: "Sugestão",
    body: "Bom dia. Queria só deixar uma nota: na recolha o motorista não verificou o carro comigo e depois disseram-me que já tinha um risco. Acho que deviam fazer a vistoria à frente do cliente para evitar estas situações. Fiquei bastante incomodada com a insinuação.",
    note: "queixa escrita com calma, em forma de sugestão" }),
  C({ id: "rec-17", expected: "reclamacoes", box: "faturacao", fromName: "Nuno Barros", fromEmail: "nuno.barros@gmail.com", subject: "Fatura com valor errado",
    body: "A fatura que me enviaram tem 72€ mas a reserva confirmada dizia 54€. Cobraram-me a mais e já pedi a correção há uma semana sem resposta. Estou muito descontente.",
    note: "queixa de cobrança que chega à faturação" }),
  C({ id: "rec-18", expected: "reclamacoes", box: "reservas", newThread: false, fromName: "Patrícia Reis", fromEmail: "patricia.reis@gmail.com", subject: "Re: Confirmação da sua reserva",
    body: "A reserva estava confirmada mas quando cheguei ao parque disseram-me que não tinham lugar e tive de ir para outro parque mais longe. Assim não dá.\n\nOn Fri, Multipark <reservas@multipark.pt> wrote:\n> A sua reserva 51003 está confirmada.",
    note: "queixa numa resposta à confirmação" }),
  C({ id: "rec-19", expected: "reclamacoes", fromName: "Fernando Lima", fromEmail: "fernando.lima@clix.pt", subject: "Multa de estacionamento",
    body: "Recebi uma multa da EMEL com data de 3 de outubro, dia em que o meu carro estava à vossa guarda. A matrícula é minha e o local é em Lisboa centro. Alguém usou o carro. Quero que assumam a multa." }),
  C({ id: "rec-20", expected: "reclamacoes", fromName: "Joana Vieira", fromEmail: "joana.vieira@gmail.com", subject: "Chaves",
    body: "Entregaram-me as chaves de outro carro e fiquei 30 minutos à espera até trocarem. Depois de um voo de 8 horas. Não volto a recomendar." }),
  C({ id: "rec-21", expected: "reclamacoes", box: "reservas", fromName: "Tiago Martins", fromEmail: "tiago.m@gmail.com", subject: "Reserva 52011",
    body: "Bom dia, a reserva 52011 está em nome da minha mulher. Ainda não percebi porque é que me cobraram a taxa de serviço de aeroporto se eu próprio fui deixar o carro ao parque. Ninguém me explica e isto parece-me abusivo.",
    note: "começa como pergunta sobre a reserva" }),
  C({ id: "rec-22", expected: "reclamacoes", fromName: "Livro de Reclamações", fromEmail: "naoresponder@livroreclamacoes.pt", subject: "Livro de Reclamações Eletrónico - Nova reclamação ROR123456789",
    body: "Exmos. Senhores,\nInformamos que foi registada uma reclamação no Livro de Reclamações Eletrónico relativa ao vosso estabelecimento.\nN.º da reclamação: ROR123456789\nConsulte a reclamação na plataforma.",
    note: "aviso oficial do Livro de Reclamações (regra pelo remetente)" }),
  // ─── Reclamações noutras línguas ──────────────────────────────────────────
  C({ id: "rec-23", lang: "en", expected: "reclamacoes", fromName: "James Carter", fromEmail: "james.carter@gmail.com", subject: "Dent on my car",
    body: "Hi,\nWhen I collected my car yesterday at Lisbon airport there was a new dent on the rear passenger door. It was not there when I dropped it off. Booking ref 47719. Please advise how you will handle this.\nRegards, James" }),
  C({ id: "rec-24", lang: "en", expected: "reclamacoes", fromName: "Emma Wilson", fromEmail: "emma.w@yahoo.co.uk", subject: "Very disappointed",
    body: "We waited over an hour for our car at the arrivals and nobody answered the phone. We missed our connection to the hotel. Very disappointed with your service." }),
  C({ id: "rec-25", lang: "es", expected: "reclamacoes", fromName: "Lucía Gómez", fromEmail: "lucia.gomez@gmail.com", subject: "Coche con arañazo",
    body: "Hola, al recoger mi coche en el aeropuerto de Oporto he visto un arañazo nuevo en el capó. Lo dejé sin ningún daño. Quiero una solución." }),
  C({ id: "rec-26", lang: "fr", expected: "reclamacoes", fromName: "Julien Martin", fromEmail: "julien.martin@orange.fr", subject: "Attente inadmissible",
    body: "Bonjour, j'ai attendu 45 minutes à l'aéroport de Faro avant que quelqu'un m'apporte ma voiture. Personne ne répondait au téléphone. C'est inadmissible." }),
  C({ id: "rec-27", lang: "en", expected: "reclamacoes", box: "cancelamentos", fromName: "Mark Davies", fromEmail: "mark.davies@outlook.com", subject: "Refund still not received",
    body: "I cancelled my booking three weeks ago and was promised a refund within 5 days. Still nothing and nobody replies to my emails. This is unacceptable.", note: "reembolso zangado em inglês" }),
  C({ id: "rec-28", lang: "es", expected: "reclamacoes", box: "reservas", fromName: "Javier Ruiz", fromEmail: "javier.ruiz@hotmail.es", subject: "Cobro duplicado",
    body: "Me han cobrado dos veces la misma reserva en la tarjeta. Llevo días intentando hablar con alguien. Necesito que me devuelvan el dinero." }),
  C({ id: "rec-29", lang: "fr", expected: "reclamacoes", fromName: "Claire Dubois", fromEmail: "claire.dubois@free.fr", subject: "Voiture sale",
    body: "Ma voiture m'a été rendue avec des traces de boue sur les sièges et une odeur de cigarette. Je ne fume pas. Je suis très mécontente." }),
  C({ id: "rec-30", expected: "reclamacoes", box: "rh", fromName: "Rosa Almeida", fromEmail: "rosa.almeida@gmail.com", subject: "Queixa sobre um funcionário",
    body: "Não sei se é para este email mas quero queixar-me do condutor que me entregou o carro no sábado à noite em Faro, cheirava a álcool e conduziu o meu carro de forma perigosa à minha frente.",
    note: "queixa enviada para o RH" }),
  // ─── Chegam diretamente à reclamacoes@ ────────────────────────────────────
  C({ id: "rec-31", expected: "reclamacoes", box: "reclamacoes", fromName: "Bruno Sá", fromEmail: "bruno.sa@gmail.com", subject: "Reclamação reserva 50544",
    body: "Venho apresentar reclamação: o carro foi entregue com a bateria descarregada e tive de esperar pela assistência em viagem." }),
  C({ id: "rec-32", expected: "reclamacoes", box: "reclamacoes", fromName: "Cátia Freitas", fromEmail: "catia.freitas@gmail.com", subject: "Sem assunto",
    body: "Bom dia, alguém me pode ligar? É sobre o meu carro, foi entregue com um pneu em baixo.", note: "chega à reclamacoes@ com pouco texto" }),
  C({ id: "rec-33", lang: "en", expected: "reclamacoes", box: "reclamacoes", fromName: "Oliver Brown", fromEmail: "oliver.brown@gmail.com", subject: "Complaint",
    body: "My windscreen was cracked when I got the car back. Please contact me." }),
  C({ id: "noise-01", expected: "ruido", box: "reclamacoes", fromName: "Pneus Express", fromEmail: "promo@pneusexpress-promo.com", subject: "Promoção de outono: pneus a metade do preço!",
    body: "Aproveite a nossa promoção de outono! Pneus de todas as marcas com 50% de desconto. Oferta válida até 31 de outubro. Clique aqui para encomendar já.",
    note: "publicidade que chegou à reclamacoes@ (sem cabeçalhos de lista)" }),

  // ─── Perdidos e achados ───────────────────────────────────────────────────
  C({ id: "lost-01", expected: "perdidos", fromName: "Raquel Mendes", fromEmail: "raquel.mendes@gmail.com", subject: "Óculos de sol",
    body: "Boa tarde, acho que deixei os meus óculos de sol no carro de transporte para o terminal ontem às 6h da manhã. São Ray-Ban pretos com estojo castanho. Encontraram?" }),
  C({ id: "lost-02", expected: "perdidos", fromName: "Hugo Faria", fromEmail: "hugo.faria@gmail.com", subject: "Carregador",
    body: "Deixei o carregador do telemóvel ligado no isqueiro do meu carro e quando o fui buscar já não estava. Podem verificar se ficou no parque?" }),
  C({ id: "lost-03", expected: "perdidos", fromName: "Vera Cardoso", fromEmail: "vera.cardoso@sapo.pt", subject: "Cadeira de bebé",
    body: "Bom dia, tirámos a cadeirinha do bebé para meter as malas na carrinha e esquecemo-nos dela no vosso parque de Faro. Reserva 50991. Como a posso recuperar?" }),
  C({ id: "lost-04", expected: "perdidos", fromName: "André Lourenço", fromEmail: "andre.lourenco@gmail.com", subject: "Chaves de casa",
    body: "O meu porta-chaves com as chaves de casa estava junto à chave do carro quando a entreguei ao vosso motorista. Agora só me devolveram a chave do carro. Onde estão as outras?" }),
  C({ id: "lost-05", expected: "perdidos", fromName: "Cristina Moura", fromEmail: "cristina.moura@gmail.com", subject: "Carteira",
    body: "Penso que a minha carteira caiu dentro do vosso shuttle quando me levaram ao aeroporto domingo de manhã. Tem os meus documentos. Por favor verifiquem." }),
  C({ id: "lost-06", expected: "perdidos", box: "reservas", fromName: "Gonçalo Pires", fromEmail: "goncalo.pires@gmail.com", subject: "Casaco",
    body: "Olá, deixei um casaco azul escuro no banco de trás do carro, reserva 49002. Já levantei o carro e não estava lá. Encontraram-no?" }),
  C({ id: "lost-07", expected: "perdidos", fromName: "Mariana Teixeira", fromEmail: "mariana.teixeira@gmail.com", subject: "Muito obrigada!",
    body: "Excelente serviço, foram super rápidos na entrega! Só uma coisa: acho que deixei o meu iPad na bolsa da porta do lado do passageiro. Conseguem ver se ficou aí?",
    note: "perdido dentro de um elogio" }),
  C({ id: "lost-08", expected: "perdidos", newThread: false, fromName: "Raquel Mendes", fromEmail: "raquel.mendes@gmail.com", subject: "Re: Óculos de sol",
    body: "Já os encontraram? Volto a Lisboa amanhã e podia passar aí.\n\nEm 12/10/2026, Multipark escreveu:\n> Estamos a verificar com a equipa do turno da manhã.",
    note: "resposta curta sobre um perdido" }),
  C({ id: "lost-09", lang: "en", expected: "perdidos", fromName: "Sarah Johnson", fromEmail: "sarah.johnson@gmail.com", subject: "Left my sunglasses",
    body: "Hello, I think I left my sunglasses in the shuttle van this morning around 7am. They are brown Prada. Could you check, please?" }),
  C({ id: "lost-10", lang: "en", expected: "perdidos", fromName: "Tom Harris", fromEmail: "tom.harris@hotmail.co.uk", subject: "Lost AirPods",
    body: "Hi, my AirPods case might have fallen between the seats of my car while your driver was parking it. Booking 48765. Can someone have a look?" }),
  C({ id: "lost-11", lang: "es", expected: "perdidos", fromName: "Pablo Sánchez", fromEmail: "pablo.sanchez@gmail.com", subject: "Cartera olvidada",
    body: "Hola, me dejé la cartera en el coche que nos llevó al aeropuerto ayer por la tarde. Tiene mi DNI. ¿La han encontrado?" }),
  C({ id: "lost-12", lang: "fr", expected: "perdidos", fromName: "Sophie Laurent", fromEmail: "sophie.laurent@orange.fr", subject: "Chargeur oublié",
    body: "Bonjour, j'ai oublié mon chargeur d'ordinateur dans la navette entre le parking et le terminal. Pouvez-vous vérifier ?" }),
  C({ id: "lost-13", expected: "perdidos", fromName: "Rita Simões", fromEmail: "rita.simoes@gmail.com", subject: "Peluche",
    body: "A minha filha está inconsolável, ficou o peluche dela (um coelho cinzento) no vosso carro de transfer. Por favor digam-me se o encontraram." }),
  C({ id: "lost-14", expected: "perdidos", box: "alteracoes", fromName: "Filipe Rocha", fromEmail: "filipe.rocha@gmail.com", subject: "Alteração e uma pergunta",
    body: "Bom dia, queria saber se encontraram uns auriculares brancos no meu carro (reserva 51220). Obrigado.", note: "chega pelas alterações" }),
  C({ id: "lost-15", expected: "perdidos", box: "perdidos", fromName: "Daniel Coelho", fromEmail: "daniel.coelho@gmail.com", subject: "Objeto perdido",
    body: "Deixei uma mochila preta no parque de Lisboa no dia 10. Tem um portátil." }),
  C({ id: "lost-16", lang: "en", expected: "perdidos", box: "perdidos", fromName: "Anna Schmidt", fromEmail: "anna.schmidt@web.de", subject: "Lost item",
    body: "Hi, I lost my reading glasses in your car. Black frame. Thanks." }),

  // ─── Críticas (avisos de avaliação e elogios) ─────────────────────────────
  C({ id: "crit-01", expected: "criticas", fromName: "Google Business Profile", fromEmail: "businessprofile-noreply@google.com", subject: "Nova crítica para Airpark - Estacionamento Aeroporto",
    body: "Cantinho deixou uma crítica sobre Airpark - Estacionamento Aeroporto\nrecebeu uma nova crítica de 5 estrela(s)\nServiço excelente, recomendo!\nResponder à crítica" }),
  C({ id: "crit-02", expected: "criticas", box: "reservas", fromName: "Google Business Profile", fromEmail: "businessprofile-noreply@google.com", subject: "Nova crítica de 1 estrela",
    body: "Marco deixou uma crítica sobre Skypark Porto\nrecebeu uma nova crítica de 1 estrela(s)\nPéssimo, o carro veio riscado e ninguém assume.\nResponder à crítica",
    note: "crítica negativa do Google — não é reclamação por email (as críticas ficam quietas)" }),
  C({ id: "crit-03", lang: "en", expected: "criticas", fromName: "Trustpilot", fromEmail: "noreply@trustpilot.com", subject: "You've got a new review on Trustpilot",
    body: "A customer left a new 4-star review for Multipark.\n\"Easy and fast\"\nReply to the review on Trustpilot." }),
  C({ id: "crit-04", expected: "criticas", fromName: "Manuela Gomes", fromEmail: "manuela.gomes@gmail.com", subject: "Parabéns",
    body: "Queria só dar os parabéns à equipa de Faro, especialmente ao senhor Carlos que nos entregou o carro. Muito simpático e pontual. Voltaremos certamente!" }),
  C({ id: "crit-05", lang: "en", expected: "criticas", fromName: "David Miller", fromEmail: "david.miller@gmail.com", subject: "Great service",
    body: "Just wanted to say thank you. Everything went smoothly, the driver was on time and very friendly. Will use you again." }),
  C({ id: "crit-06", expected: "criticas", fromName: "Jorge Pacheco", fromEmail: "jorge.pacheco@gmail.com", subject: "Opinião",
    body: "Usei o vosso serviço pela primeira vez. Correu tudo bem. Acho que o site podia ser mais simples, mas de resto gostei.", note: "opinião sem nada para resolver" }),
  C({ id: "crit-07", lang: "es", expected: "criticas", fromName: "Carmen López", fromEmail: "carmen.lopez@gmail.com", subject: "Gracias",
    body: "Muchas gracias por el servicio, todo perfecto. Lo recomendaré a mis amigos." }),
  C({ id: "crit-08", lang: "fr", expected: "criticas", fromName: "Tripadvisor", fromEmail: "noreply@tripadvisor.com", subject: "Nouvel avis publié",
    body: "Un voyageur a publié un nouvel avis sur votre établissement.\nNote : 5/5\nLire l'avis" }),

  // ─── Ocorrências ──────────────────────────────────────────────────────────
  C({ id: "occ-01", expected: "ocorrencias", fromName: "Sky Park", fromEmail: "info@multipark.pt", subject: "Ocorrência numa reserva",
    body: "Tipo de ocorrência: Carro ou chaves mal arrumado F/lugar\nLocalização: https://www.google.com/maps/search/?api=1&query=38.7897941,-9.1173531\nMatrícula: BG95ZL\nObservações: Apenas marquei o carro\nLink reserva: https://www.admin.multigroup.pt/consulta/MvG5TZRxYURGKipy2WjU",
    note: "aviso automático da app (regra pelo formulário)" }),
  C({ id: "occ-02", expected: "ocorrencias", box: "reservas", fromName: "Multipark", fromEmail: "info@multipark.pt", subject: "Ocorrência numa reserva",
    body: "**Tipo de ocorrência:** Vidro aberto\n**Matrícula:** 12-AB-34\n**Observações:** Vidro do condutor estava aberto, fechei.\n**Link reserva:** https://www.admin.multigroup.pt/consulta/Qw81ZxPpLm22AbCdEfGh" }),
  C({ id: "occ-03", expected: "ocorrencias", box: "ocorrencias", fromName: "Airpark", fromEmail: "info@multipark.pt", subject: "Nova ocorrência",
    body: "Tipo de ocorrência: Dano no veículo\nMatrícula: AA-11-BB\nObservações: Risco na porta traseira esquerda à chegada ao parque" }),
  C({ id: "occ-04", expected: "ocorrencias", fromName: "Hélder TL Lisboa", fromEmail: "helder.santos@multipark.pt", subject: "Carro com bateria em baixo",
    body: "Bom dia, o carro 45-RT-98 que está no parque P2 não pegou de manhã, tivemos de usar o booster. Fica registado para o caso de o cliente perguntar.",
    note: "colaborador a relatar (não é reclamação de cliente)" }),
  C({ id: "occ-05", expected: "ocorrencias", box: "reservas", fromName: "Supervisor Porto", fromEmail: "supervisor.porto@skypark.pt", subject: "Toque no parque",
    body: "Ontem à noite um extra encostou o carro AQ-56-PL num pilar ao estacionar, pequeno risco no para-choques. Já tirei fotos. Falta registar na app." }),
  C({ id: "occ-06", expected: "ocorrencias", fromName: "Marco Operações", fromEmail: "marco.ops@multipark.pt", subject: "Chave trocada",
    body: "Atenção: a chave do 22-XX-11 estava no cacifo do 22-XY-11. Já troquei. Registo para a equipa da manhã." }),

  // ─── RH ───────────────────────────────────────────────────────────────────
  C({ id: "rh-01", expected: "rh", fromName: "Bruno Teixeira", fromEmail: "bruno.teixeira@gmail.com", subject: "Candidatura a motorista", attachments: ["CV_Bruno_Teixeira.pdf"],
    body: "Bom dia, venho por este meio candidatar-me a uma vaga de motorista. Tenho carta há 8 anos e disponibilidade total. Envio o CV em anexo." }),
  C({ id: "rh-02", expected: "rh", fromName: "Sara Neves", fromEmail: "sara.neves@gmail.com", subject: "Vagas",
    body: "Olá, estão a recrutar para o Porto? Gostava de trabalhar aos fins de semana." }),
  C({ id: "rh-03", expected: "rh", box: "reservas", fromName: "Tiago Moreira", fromEmail: "tiago.moreira93@gmail.com", subject: "Trabalho extra",
    body: "Boa tarde, um amigo meu trabalha convosco como extra e disse-me para enviar email. Tenho 26 anos e carta de condução. Como faço para me candidatar?" }),
  C({ id: "rh-04", expected: "rh", fromName: "Ricardo Extra", fromEmail: "ricardo.extra@gmail.com", subject: "Disponibilidade semana 43",
    body: "Olá, esta semana posso trabalhar quarta e sexta de manhã. Sábado não consigo." }),
  C({ id: "rh-05", lang: "en", expected: "rh", fromName: "Ivan Petrov", fromEmail: "ivan.petrov@gmail.com", subject: "Job application", attachments: ["Resume.pdf"],
    body: "Hello, I am interested in working as a driver in Lisbon. I have a Portuguese driving licence and a residence permit. Please find my resume attached." }),
  C({ id: "rh-06", expected: "rh", fromName: "Liliana Santos", fromEmail: "liliana.santos@gmail.com", subject: "Recibo de vencimento",
    body: "Boa tarde, ainda não recebi o recibo de vencimento de setembro. Podem enviar-me? Obrigada.", note: "colaboradora (não é faturação de cliente)" }),
  C({ id: "rh-07", lang: "es", expected: "rh", fromName: "Diego Fernández", fromEmail: "diego.fernandez@gmail.com", subject: "Oferta de empleo",
    body: "Hola, vivo en Faro y busco trabajo como conductor. ¿Tienen vacantes?" }),
  C({ id: "rh-08", expected: "rh", fromName: "Paula Ramos", fromEmail: "paula.ramos@gmail.com", subject: "Horário",
    body: "Bom dia, não vou conseguir fazer o turno de amanhã à noite por motivos de saúde. Peço desculpa. Envio o atestado depois." }),

  // ─── Reservas ─────────────────────────────────────────────────────────────
  C({ id: "res-01", expected: "reservas", fromName: "Beatriz Carvalho", fromEmail: "beatriz.carvalho@gmail.com", subject: "Preço",
    body: "Bom dia, quanto custa deixar o carro de 3 a 10 de novembro no aeroporto de Lisboa?" }),
  C({ id: "res-02", expected: "reservas", fromName: "Henrique Dias", fromEmail: "henrique.dias@gmail.com", subject: "Como funciona",
    body: "Olá, nunca usei este tipo de serviço. Eu deixo o carro no aeroporto e vocês levam-no? E quando volto onde é que o vou buscar?" }),
  C({ id: "res-03", expected: "reservas", box: "reservas", fromName: "Lara Monteiro", fromEmail: "lara.monteiro@gmail.com", subject: "Disponibilidade Natal",
    body: "Têm lugar para um carro de 20 de dezembro a 4 de janeiro no Porto? É uma carrinha de 7 lugares." }),
  C({ id: "res-04", lang: "en", expected: "reservas", fromName: "Peter Clark", fromEmail: "peter.clark@gmail.com", subject: "Booking for next week",
    body: "Hi, I'd like to book valet parking at Faro airport from the 21st to the 28th. Do I need to pay online in advance?" }),
  C({ id: "res-05", lang: "es", expected: "reservas", fromName: "María Torres", fromEmail: "maria.torres@gmail.com", subject: "Reserva",
    body: "Buenos días, quería saber el precio para 7 días en Lisboa en noviembre y si incluye el seguro." }),
  C({ id: "res-06", expected: "reservas", fromName: "Rafael Sousa", fromEmail: "rafael.sousa@gmail.com", subject: "Carro elétrico",
    body: "Aceitam carros elétricos? Tenho um Tesla e queria reservar para a próxima semana." }),
  C({ id: "res-07", expected: "reservas", box: "reservas", fromName: "Isabel Fonseca", fromEmail: "isabel.fonseca@gmail.com", subject: "Grupo",
    body: "Somos 3 famílias a viajar juntas, cada uma com o seu carro. Fazem preço para 3 carros na mesma reserva?" }),
  C({ id: "res-08", lang: "fr", expected: "reservas", fromName: "Antoine Bernard", fromEmail: "antoine.bernard@gmail.com", subject: "Tarif",
    body: "Bonjour, quel est le tarif pour 10 jours à l'aéroport de Porto en décembre ?" }),
  C({ id: "res-09", expected: "reservas", fromName: "Manuel Costa", fromEmail: "manuel.costa@gmail.com", subject: "Livro de reclamações?",
    body: "Bom dia, antes de reservar queria saber se têm seguro para danos no carro e se em caso de problema há livro de reclamações. Obrigado.",
    note: "fala de reclamações mas é uma pergunta antes de reservar" }),

  // ─── Alterações ───────────────────────────────────────────────────────────
  C({ id: "alt-01", expected: "alteracoes", fromName: "Ricardo Lemos", fromEmail: "ricardo.lemos@gmail.com", subject: "Alteração de data",
    body: "Bom dia, a minha reserva 51544 é de 5 a 12 de novembro mas o regresso passou para dia 14. Podem alterar?" }),
  C({ id: "alt-02", expected: "alteracoes", box: "reservas", fromName: "Catarina Mota", fromEmail: "catarina.mota@gmail.com", subject: "Voo alterado",
    body: "O meu voo de regresso foi alterado pela companhia e agora chego às 6h em vez das 22h. O que tenho de fazer?" }),
  C({ id: "alt-03", expected: "alteracoes", fromName: "Diogo Ribeiro", fromEmail: "diogo.ribeiro@gmail.com", subject: "Matrícula",
    body: "Na reserva 50877 vou levar outro carro, a matrícula é 33-ZZ-44 em vez da que indiquei." }),
  C({ id: "alt-04", lang: "en", expected: "alteracoes", fromName: "Laura Evans", fromEmail: "laura.evans@gmail.com", subject: "Change my booking",
    body: "Hi, could you please change my return time from 10am to 6pm on the 19th? Booking 49930. Thanks!" }),
  C({ id: "alt-05", expected: "alteracoes", fromName: "Nelson Pereira", fromEmail: "nelson.pereira@gmail.com", subject: "Voo cancelado",
    body: "O meu voo foi cancelado e só volto dois dias depois. Posso prolongar a reserva sem pagar multa?", note: "fala de cancelado mas quer prolongar" }),
  C({ id: "alt-06", lang: "es", expected: "alteracoes", fromName: "Sergio Martín", fromEmail: "sergio.martin@gmail.com", subject: "Cambio de fecha",
    body: "Hola, necesito cambiar la fecha de entrega del coche al día 3 en lugar del 2. ¿Es posible?" }),
  C({ id: "alt-07", expected: "alteracoes", box: "alteracoes", newThread: false, fromName: "Ricardo Lemos", fromEmail: "ricardo.lemos@gmail.com", subject: "Re: Alteração de data",
    body: "Perfeito, obrigado. Então fica dia 14 às 16h.\n\nEm 13/10/2026, Multipark escreveu:\n> A alteração é possível, indique a hora de chegada.", note: "resposta numa alteração" }),
  C({ id: "alt-08", expected: "alteracoes", fromName: "Sílvia Matos", fromEmail: "silvia.matos@gmail.com", subject: "Mudar o terminal",
    body: "Agora volto pelo Terminal 2 e não pelo 1. Podem entregar-me o carro lá?" }),

  // ─── Cancelamentos ────────────────────────────────────────────────────────
  C({ id: "can-01", expected: "cancelamentos", fromName: "Andreia Brito", fromEmail: "andreia.brito@gmail.com", subject: "Cancelar reserva",
    body: "Bom dia, quero cancelar a reserva 52044 porque a viagem foi adiada. Obrigada." }),
  C({ id: "can-02", expected: "cancelamentos", box: "reservas", fromName: "Vítor Gomes", fromEmail: "vitor.gomes@gmail.com", subject: "Reembolso",
    body: "Cancelei a reserva 51790 na segunda-feira. Quando posso contar com o reembolso? Obrigado.", note: "reembolso sem queixa" }),
  C({ id: "can-03", lang: "en", expected: "cancelamentos", fromName: "Rachel Green", fromEmail: "rachel.green@gmail.com", subject: "Cancellation",
    body: "Hello, unfortunately we have to cancel our trip. Please cancel booking 50012 and let me know about the refund." }),
  C({ id: "can-04", lang: "fr", expected: "cancelamentos", fromName: "Pierre Moreau", fromEmail: "pierre.moreau@gmail.com", subject: "Annulation",
    body: "Bonjour, je souhaite annuler ma réservation pour le 15 novembre. Merci." }),
  C({ id: "can-05", expected: "cancelamentos", fromName: "Tânia Lopes", fromEmail: "tania.lopes@gmail.com", subject: "Não vou precisar",
    body: "Olá, já não vou precisar do estacionamento do próximo fim de semana. Podem anular?" }),
  C({ id: "can-06", lang: "es", expected: "cancelamentos", fromName: "Elena Navarro", fromEmail: "elena.navarro@gmail.com", subject: "Cancelar",
    body: "Hola, por favor cancelen mi reserva 49111, el viaje se ha suspendido." }),
  C({ id: "can-07", expected: "cancelamentos", fromName: "Rodrigo Alves", fromEmail: "rodrigo.alves@gmail.com", subject: "Duas reservas iguais",
    body: "Fiz a reserva duas vezes por engano (51870 e 51871). Podem cancelar a segunda?" }),

  // ─── Serviços extra ───────────────────────────────────────────────────────
  C({ id: "ext-01", expected: "servicos_extra", fromName: "Célia Pinto", fromEmail: "celia.pinto@gmail.com", subject: "Lavagem",
    body: "Bom dia, é possível lavarem o carro por dentro e por fora enquanto estou de férias? Quanto custa?" }),
  C({ id: "ext-02", expected: "servicos_extra", fromName: "Gustavo Reis", fromEmail: "gustavo.reis@gmail.com", subject: "Carregamento",
    body: "O meu carro é elétrico. Conseguem carregá-lo antes de eu chegar no dia 20?" }),
  C({ id: "ext-03", lang: "en", expected: "servicos_extra", fromName: "Chris Taylor", fromEmail: "chris.taylor@gmail.com", subject: "Car wash",
    body: "Hi, can I add a full valet to my existing booking 50330?" }),
  C({ id: "ext-04", expected: "servicos_extra", box: "reservas", fromName: "Mónica Viana", fromEmail: "monica.viana@gmail.com", subject: "Inspeção",
    body: "O meu carro tem de ir à inspeção esta semana e vou estar fora. Fazem esse serviço enquanto está convosco?" }),
  C({ id: "ext-05", expected: "servicos_extra", fromName: "Artur Nunes", fromEmail: "artur.nunes@gmail.com", subject: "Pneus",
    body: "Aproveitando que deixo o carro 15 dias, podem verificar a pressão dos pneus e o óleo?" }),

  // ─── Parcerias ────────────────────────────────────────────────────────────
  C({ id: "par-01", expected: "parcerias", fromName: "Hotel Mar Azul", fromEmail: "direcao@hotelmarazul.pt", subject: "Proposta de parceria",
    body: "Boa tarde, somos um hotel a 5 km do aeroporto de Faro e gostaríamos de oferecer aos nossos hóspedes o vosso serviço com condições especiais. Podemos marcar uma reunião?" }),
  C({ id: "par-02", expected: "parcerias", fromName: "Viagens Sol", fromEmail: "comercial@viagenssol.pt", subject: "Agência de viagens",
    body: "Somos uma agência de viagens em Braga e queremos revender os vossos lugares de estacionamento aos nossos clientes. Que comissões praticam?" }),
  C({ id: "par-03", lang: "en", expected: "parcerias", fromName: "ParkCompare", fromEmail: "partners@parkcompare.example", subject: "Partnership opportunity",
    body: "Hello, we run a parking comparison website with 2M visitors a year and would like to list your car parks. Could we set up a call to discuss an affiliate agreement?" }),
  C({ id: "par-04", expected: "parcerias", fromName: "Rent a Car Faro", fromEmail: "geral@rentacarfaro.pt", subject: "Colaboração",
    body: "Bom dia, somos uma rent-a-car em Faro e precisamos de lugares de estacionamento para a nossa frota no inverno. Têm condições para empresas?" }),
  C({ id: "par-05", expected: "parcerias", fromName: "Empresa TransLuso", fromEmail: "frota@transluso.pt", subject: "Conta empresa",
    body: "Temos 12 colaboradores que viajam todas as semanas. Gostaríamos de abrir uma conta empresa com faturação mensal." }),

  // ─── Faturação ────────────────────────────────────────────────────────────
  C({ id: "fat-01", expected: "faturacao", fromName: "Pedro Fonseca", fromEmail: "pedro.fonseca@gmail.com", subject: "Fatura com NIF",
    body: "Bom dia, podem enviar-me a fatura da reserva 50212 com o NIF 123456789? Obrigado." }),
  C({ id: "fat-02", expected: "faturacao", fromName: "Contabilidade Silva & Filhos", fromEmail: "contabilidade@silvaefilhos.pt", subject: "Recibo",
    body: "Precisamos do recibo do pagamento feito a 2 de outubro para a nossa contabilidade." }),
  C({ id: "fat-03", expected: "faturacao", fromName: "Joana Brás", fromEmail: "joana.bras@gmail.com", subject: "Corrigir NIF",
    body: "A fatura saiu com o NIF errado, o correto é 987654321. Podem emitir nova?" }),
  C({ id: "fat-04", lang: "en", expected: "faturacao", fromName: "Michael Scott", fromEmail: "michael.scott@gmail.com", subject: "Invoice",
    body: "Hi, could you send me an invoice for my booking 49770 with my company name and VAT number? Thanks." }),
  C({ id: "fat-05", expected: "faturacao", fromName: "Lurdes Matias", fromEmail: "lurdes.matias@gmail.com", subject: "Fatura para o seguro",
    body: "Preciso da fatura da reserva de setembro para apresentar uma reclamação à minha seguradora por causa de um voo atrasado. Podem enviar?",
    note: "tem a palavra reclamação mas é um pedido de fatura" }),
  C({ id: "fat-06", expected: "faturacao", box: "reservas", fromName: "Hugo Carvalho", fromEmail: "hugo.carvalho@gmail.com", subject: "Comprovativo de pagamento",
    body: "Segue em anexo o comprovativo da transferência da reserva 51333.", attachments: ["comprovativo.pdf"] }),
  C({ id: "fat-07", lang: "es", expected: "faturacao", fromName: "Raúl Castro", fromEmail: "raul.castro@gmail.com", subject: "Factura",
    body: "Buenos días, necesito la factura de mi reserva a nombre de mi empresa, CIF B12345678." }),

  // ─── Lixo (publicidade, spam, automáticos) ────────────────────────────────
  C({ id: "noise-02", expected: "ruido", fromName: "Booking Partners News", fromEmail: "news@partner-news.example", subject: "Novidades de outubro", headers: NEWS,
    body: "Descubra as novidades deste mês e as melhores práticas para o seu negócio. Para deixar de receber clique aqui." }),
  C({ id: "noise-03", lang: "en", expected: "ruido", fromName: "SEO Experts", fromEmail: "growth.team.seo@gmail.com", subject: "Rank #1 on Google",
    body: "Dear website owner, we noticed your website is not ranking on the first page of Google. Our team can get you to #1 in 30 days. Reply for a free audit." }),
  C({ id: "noise-04", lang: "en", expected: "ruido", fromName: "Mail Admin", fromEmail: "admin@secure-mailbox-verify.example", subject: "Your mailbox is almost full",
    body: "Your mailbox has reached 98% of its quota. Click here to verify your account and avoid losing incoming messages." }),
  C({ id: "noise-05", expected: "ruido", fromName: "Ana Rebelo", fromEmail: "ana.rebelo.emp@empresa-x.pt", subject: "Resposta automática: Pedido de orçamento", headers: { autoSubmitted: "auto-replied" },
    body: "Estou ausente até dia 20 de outubro, com acesso limitado ao email. Para assuntos urgentes contacte geral@empresa-x.pt." }),
  C({ id: "noise-06", lang: "en", expected: "ruido", fromName: "Mail Delivery Subsystem", fromEmail: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)",
    body: "Address not found. Your message wasn't delivered to cliente.inexistente@gmail.com because the address couldn't be found." }),
  C({ id: "noise-07", expected: "ruido", fromName: "Fornecedor Limpezas", fromEmail: "marketing@limpezaspro.example", subject: "Campanha de outono", headers: NEWS,
    body: "Serviços de limpeza para empresas com 20% de desconto este mês. Peça já o seu orçamento. Não quer receber mais? Anular subscrição." }),
  C({ id: "noise-08", lang: "en", expected: "ruido", fromName: "Crypto Wins", fromEmail: "luck.winner2026@gmail.com", subject: "You won 2 BTC",
    body: "Congratulations! You have been selected to receive 2 BTC. Send your wallet details and a small processing fee to claim your prize." }),
  C({ id: "noise-09", expected: "ruido", fromName: "LinkedIn", fromEmail: "messages-noreply@linkedin.com", subject: "Tem 5 novas notificações", headers: { listUnsubscribe: "<https://linkedin.com/unsub>" },
    body: "Veja quem visitou o seu perfil esta semana." }),
  C({ id: "noise-10", lang: "es", expected: "ruido", fromName: "Ofertas Viaje", fromEmail: "ofertas@viajes-baratos.example", subject: "¡Vuelos desde 9€!",
    body: "Las mejores ofertas de vuelos para este invierno. Reserva ya antes de que se agoten." }),

  // ─── Geral (de pessoas, sem tema claro) ───────────────────────────────────
  C({ id: "ger-01", expected: "geral", fromName: "Alberto Matos", fromEmail: "alberto.matos@gmail.com", subject: "Contacto",
    body: "Bom dia, podem ligar-me para o 912345678 por favor? Obrigado." }),
  C({ id: "ger-02", expected: "geral", fromName: "Nádia Couto", fromEmail: "nadia.couto@gmail.com", subject: "teste",
    body: "teste" }),
  C({ id: "ger-03", expected: "geral", fromName: "Escola Básica n.º 3", fromEmail: "secretaria@eb3.example.pt", subject: "Visita de estudo",
    body: "Boa tarde, somos uma escola e gostaríamos de saber se aceitam visitas de estudo de alunos do 9.º ano às vossas instalações." }),
  C({ id: "ger-04", expected: "geral", fromName: "Jornal da Região", fromEmail: "redacao@jornaldaregiao.example", subject: "Pedido de entrevista",
    body: "Estamos a preparar uma reportagem sobre o estacionamento nos aeroportos portugueses. Seria possível falar com um responsável?" }),
];

/** Categorias presentes no corpus e quantos emails há de cada. PURA. */
export function corpusCounts(items: readonly TriageCorpusItem[] = TRIAGE_CORPUS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i.expected] = (out[i.expected] ?? 0) + 1;
  return out;
}
