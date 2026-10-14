/**
 * Corpus CEGO da triagem dos emails (auditoria, ronda 2 — 14 out 2026).
 *
 * Escrito por quem auditou ANTES de ler o corpus principal
 * (mailTriageCorpus.ts), o de controlo (mailTriageHoldout.ts) ou as
 * avaliações anteriores — para medir a meta do Jorge ("mais de 90 % das
 * reclamações e dos perdidos vão para lá") com emails que ninguém usou para
 * afinar o pedido à IA.
 *
 * 60 emails, todos inventados (nomes, endereços, matrículas e reservas não
 * existem): 27 reclamações (20 escondidas — dentro de outro pedido, curtas,
 * irónicas, só com a foto, numa resposta de uma linha, reencaminhadas ou de um
 * parceiro em nome do cliente), 12 perdidos e 21 que NÃO são caso (urgências
 * normais, dúvidas de preço, elogios com sugestão, avisos automáticos, emails
 * internos, lixo). PT-PT na maioria, mais EN, ES, FR e um em PT-BR.
 *
 * `partner: true` (cg08, cg09, cg24, cg33): a agência / o hotel é um contacto
 * das Parcerias — o pior caso para a meta (em produção o caso só abre com o
 * interruptor AI_MAIL_PARTNER_CASES ligado; a avaliação mede com tudo ligado).
 */
import type { TriageCorpusItem } from "./mailTriageCorpus";

const quoteOf = (who: string, when: string, lines: string[]) => [`Em ${when}, ${who} escreveu:`, ...lines.map((l) => `> ${l}`)].join("\n");

/** Rodapé comprido das nossas respostas (a citação enorme numa cadeia longa). */
const OUR_FOOTER = [
  "Com os melhores cumprimentos,",
  "Equipa de Apoio ao Cliente",
  "Multipark — Parque e Valet no Aeroporto de Lisboa",
  "Tel. +351 210 000 000 · Todos os dias, 6h–24h",
  "",
  "AVISO DE CONFIDENCIALIDADE: Esta mensagem e quaisquer ficheiros anexos são confidenciais e destinam-se exclusivamente ao destinatário.",
  "Se recebeu esta mensagem por engano, por favor informe o remetente e apague-a do seu sistema. Qualquer utilização, divulgação ou cópia não",
  "autorizada é estritamente proibida. As opiniões expressas nesta mensagem são da exclusiva responsabilidade do seu autor.",
  "Antes de imprimir este email, pense no ambiente.",
];

export const TRIAGE_BLIND: readonly TriageCorpusItem[] = [
  // ─── Reclamações (27) ──────────────────────────────────────────────────────
  {
    id: "cg01", lang: "pt", box: "info", fromName: "Helena Barros", fromEmail: "helena.barros.82@gmail.com",
    subject: "Risco no para-choques — reserva 48812",
    body: "Bom dia,\n\nRecolhi ontem o meu carro (reserva 48812) e tem um risco comprido no para-choques traseiro que não tinha quando o deixei. Tenho fotografias de antes. Peço que me digam como vão resolver.\n\nHelena Barros",
    expected: "reclamacoes", note: "direta, com calma",
  },
  {
    id: "cg02", lang: "pt", box: "reservas", fromName: "Tiago Fonseca", fromEmail: "tfonseca@sapo.pt",
    subject: "Reserva dezembro",
    body: "Olá,\n\nQueria reservar de 3 a 10 de dezembro, chegada ao T1 às 6h20. Da última vez esperei 40 minutos pelo transfer e ninguém atendia o telefone — espero sinceramente que desta vez não se repita, porque quase perdi o voo.\n\nObrigado",
    expected: "reclamacoes", note: "escondida num pedido de reserva",
  },
  {
    id: "cg03", lang: "pt", box: "faturacao", fromName: "Carla Mendes", fromEmail: "carla.mendes@outlook.pt",
    subject: "Fatura reserva 49120",
    body: "Boa tarde,\n\nPreciso da fatura da reserva 49120 com o NIF 212345670.\n\nE já agora expliquem-me porque é que me cobraram 89 € no cartão quando a confirmação da reserva dizia 64 €. Não pedi nenhum extra.\n\nCarla",
    expected: "reclamacoes", note: "escondida num pedido de fatura (cobrança a mais)",
  },
  {
    id: "cg04", lang: "pt", box: "info", fromName: "Nuno Pacheco", fromEmail: "nuno.pacheco@gmail.com",
    subject: "Parabéns",
    body: "Muito obrigado pela experiência inesquecível: 55 minutos ao frio à espera do vosso shuttle às 2h da manhã, com dois miúdos a dormir em cima das malas. Serviço de 5 estrelas, sem dúvida. Recomendo a toda a gente… que não tenha pressa.\n\nNuno",
    expected: "reclamacoes", note: "irónica (parece um elogio)",
  },
  {
    id: "cg05", lang: "pt", box: "info", fromName: "Rita Lopes", fromEmail: "ritalopes1990@hotmail.com",
    subject: "Matrícula 23-TX-91",
    body: "Isto não estava assim.",
    attachments: ["foto_porta_condutor.jpg"],
    expected: "reclamacoes", note: "só a foto e uma linha",
  },
  {
    id: "cg06", lang: "pt", box: "reservas", fromName: "Paulo Gaspar", fromEmail: "paulo.gaspar@netcabo.pt",
    subject: "RE: Reserva 50122 - Confirmação de recolha", newThread: false,
    body: [
      "Pois, mas ninguém apareceu à hora marcada.",
      "",
      quoteOf("Multipark <reservas@multipark.pt>", "12/10/2026 09:14", [
        "Caro cliente,",
        "Confirmamos a recolha do seu veículo no dia 12/10 às 07h00 no Terminal 1, piso 0.",
        "Obrigado pela preferência.",
      ]),
    ].join("\n"),
    expected: "reclamacoes", note: "resposta de uma linha",
  },
  {
    id: "cg07", lang: "pt", box: "info", fromName: "Sofia Antunes", fromEmail: "sofia.antunes@gmail.com",
    subject: "Re: O seu recibo Multipark", newThread: false,
    body: [
      quoteOf("Multipark <info@multipark.pt>", "2/10/2026 18:02", [
        "Olá Sofia,",
        "Segue em anexo o recibo da sua reserva 49330.",
        "Obrigado!",
      ]),
      "",
      "Continuo à espera do reembolso dos 20 € que me prometeram ao telefone há duas semanas.",
    ].join("\n"),
    expected: "reclamacoes", note: "resposta de uma linha por baixo da citação (promessa não cumprida)",
  },
  {
    id: "cg08", partner: true, lang: "en", box: "info", fromName: "Sunway Travel — Bookings", fromEmail: "bookings@sunwaytravel.co.uk",
    subject: "Client feedback – ref MP-77120",
    body: "Dear Multipark team,\n\nOur client Mr. Hughes (your ref MP-77120) informs us that his car was returned with 340 km more on the odometer than when he dropped it off. He is very upset and has asked us to take this up with you on his behalf.\n\nCould you please look into it and advise?\n\nKind regards,\nEmma Clarke\nSunway Travel",
    expected: "reclamacoes", note: "parceiro em nome do cliente",
  },
  {
    id: "cg09", partner: true, lang: "pt", box: "info", fromName: "Hotel Tejo Mar — Receção", fromEmail: "rececao@hoteltejomar.pt",
    subject: "Hóspede — transfer de hoje",
    body: "Bom dia,\n\nO nosso hóspede Sr. Valente, que usou o vosso transfer esta manhã, veio queixar-se à receção de que o motorista foi bastante mal-educado com a esposa por causa das malas. Pedimos que averiguem, porque recomendamos o vosso serviço aos nossos clientes.\n\nCumprimentos,\nReceção Hotel Tejo Mar",
    expected: "reclamacoes", note: "hotel parceiro em nome do hóspede",
  },
  {
    id: "cg10", lang: "es", box: "info", fromName: "Javier Ortega", fromEmail: "javi.ortega@yahoo.es",
    subject: "Reserva 49002",
    body: "Buenas,\n\nMe devolvieron el coche sin gasolina. Lo dejé con medio depósito y ahora la luz de reserva estaba encendida. Quiero una explicación.\n\nJavier",
    expected: "reclamacoes",
  },
  {
    id: "cg11", lang: "fr", box: "info", fromName: "Claire Moreau", fromEmail: "claire.moreau@orange.fr",
    subject: "Retour de voyage",
    body: "Bonjour,\n\nÀ notre retour samedi soir, la batterie de la voiture était à plat et personne n'a pu nous aider pendant plus d'une heure. Inacceptable après avoir payé un service de voiturier.\n\nCordialement,\nClaire Moreau",
    expected: "reclamacoes",
  },
  {
    id: "cg12", lang: "pt", box: "info", fromName: "Rafael Souza", fromEmail: "rafael.souza.br@gmail.com",
    subject: "Retrovisor",
    body: "Oi, pessoal. Meu carro voltou com o retrovisor do lado do passageiro quebrado e ninguém me falou nada na entrega. Quero saber como vocês vão resolver isso. Abraço, Rafael",
    expected: "reclamacoes", note: "PT-BR",
  },
  {
    id: "cg13", lang: "pt", box: "info", fromName: "Bruno Teixeira", fromEmail: "bteixeira@gmail.com",
    subject: "",
    body: "Risco novo no capô. 46-ZT-08.",
    expected: "reclamacoes", note: "assunto vazio, uma linha",
  },
  {
    id: "cg14", lang: "pt", box: "alteracoes", fromName: "Marta Simões", fromEmail: "marta.simoes@gmail.com",
    subject: "Alterar entrega reserva 50411",
    body: "Olá,\n\nPreciso de mudar a entrega para sábado às 14h, o voo mudou.\n\nAproveito para dizer que na última vez o vosso colaborador me deixou o carro com o banco todo encostado ao volante e restos do lanche dele no tablier. Achei uma falta de respeito.\n\nMarta",
    expected: "reclamacoes", note: "escondida num pedido de alteração",
  },
  {
    id: "cg15", lang: "pt", box: "cancelamentos", fromName: "Jorge Amaral", fromEmail: "jorge.amaral@iol.pt",
    subject: "Cancelar 51230",
    body: "Quero cancelar a reserva 51230.\n\nDepois do que aconteceu em julho (o carro apareceu com uma mossa na porta e nunca me responderam aos emails) deixei de confiar em vocês.",
    expected: "reclamacoes", note: "escondida num cancelamento (dano sem resposta)",
  },
  {
    id: "cg16", lang: "en", box: "info", fromName: "Mark Davies", fromEmail: "mark.davies@btinternet.com",
    subject: "Great job",
    body: "Great job guys. Came back from two weeks away and my car stinks of cigarettes. I don't smoke.",
    expected: "reclamacoes", note: "irónica e curta",
  },
  {
    id: "cg17", lang: "pt", box: "reservas", fromName: "Inês Correia", fromEmail: "ines.correia@gmail.com",
    subject: "RE: RE: RE: Reserva 50870 — valor final", newThread: false,
    body: [
      "Eu não pedi lavagem nenhuma. Não vou pagar isso.",
      "",
      quoteOf("Multipark <reservas@multipark.pt>", "13/10/2026 11:40", [
        "Olá Inês,",
        "Como indicado, o valor final da sua estadia é de 60,00 €, que inclui a lavagem exterior realizada no dia 11/10.",
        "O valor inicial de 45,00 € não incluía serviços adicionais.",
        ...OUR_FOOTER,
        "",
        "Em 12/10/2026 22:10, Inês Correia escreveu:",
        "Boa noite, o valor que me apresentaram na entrega não é o da reserva. Podem confirmar?",
        "",
        "Em 10/10/2026 08:00, Multipark escreveu:",
        "Olá Inês, confirmamos a sua reserva 50870 de 03/10 a 11/10 no valor de 45,00 €.",
        ...OUR_FOOTER,
      ]),
    ].join("\n"),
    expected: "reclamacoes", note: "cadeia longa: texto novo curto, citação enorme",
  },
  {
    id: "cg18", lang: "pt", box: "info", fromName: "Backoffice Multipark", fromEmail: "backoffice@multipark.pt",
    subject: "Fwd: carro",
    body: "Para tratarem.\n\n---------- Forwarded message ---------\nDe: Rui Matos <rui.matos77@gmail.com>\nDate: seg, 13/10/2026 às 19:22\nSubject: carro\nTo: <backoffice@multipark.pt>\n\nDeixei o carro convosco no dia 5 e quando o fui buscar tinha a jante da frente toda raspada. Quero que vejam as câmaras.\n\nRui Matos",
    expected: "reclamacoes", note: "reencaminhada pela empresa",
  },
  {
    id: "cg19", lang: "pt", box: "info", fromName: "Ana Rebelo", fromEmail: "ana.rebelo@gmail.com",
    subject: "Fwd: Reserva 49777 — porta",
    body: "Reenvio porque ninguém me respondeu há uma semana.\n\n---------- Forwarded message ---------\nDe: Ana Rebelo <ana.rebelo@gmail.com>\nDate: ter, 7/10/2026 às 10:03\nSubject: Reserva 49777 — porta\nTo: <info@multipark.pt>\n\nBom dia, o meu carro foi entregue com a porta de trás sem fechar bem (faz barulho e entra água). Antes de o deixar convosco estava perfeito. Aguardo contacto.\n\nAna",
    expected: "reclamacoes", note: "o cliente reencaminha o próprio email sem resposta: a queixa está no citado",
  },
  {
    id: "cg20", lang: "pt", box: "reclamacoes", fromName: "Fernando Rocha", fromEmail: "fernando.rocha@gmail.com",
    subject: "Reclamação",
    body: "Exmos. Senhores,\n\nVenho apresentar reclamação pelo atraso de 1h10 na entrega do meu veículo no dia 12/10, que me obrigou a pagar um táxi para ir buscar a minha filha. Solicito o reembolso do táxi (32 €, recibo em anexo).\n\nFernando Rocha",
    attachments: ["recibo_taxi.pdf"],
    expected: "reclamacoes", note: "pela reclamacoes@",
  },
  {
    id: "cg21", lang: "pt", box: "reservas", fromName: "Luísa Prates", fromEmail: "luisa.prates@gmail.com",
    subject: "Lugar coberto dia 3?",
    body: "Boa tarde, têm lugar coberto para 3 de novembro? Não quero que volte a acontecer o que aconteceu em agosto: paguei coberto e o carro ficou ao sol, cheio de caca de pássaro. Obrigada.",
    expected: "reclamacoes", note: "escondida numa pergunta de reserva",
  },
  {
    id: "cg22", lang: "en", box: "info", fromName: "Peter Novak", fromEmail: "peter.novak@gmail.com",
    subject: "Booking 50310",
    body: "Where is my car?? Been waiting 45 min at arrivals and nobody answers the phone.",
    expected: "reclamacoes", note: "curta, ao vivo (parece só urgência)",
  },
  {
    id: "cg23", lang: "pt", box: "info", fromName: "Manuel Guerra", fromEmail: "manuel.guerra@gmail.com",
    subject: "Quilómetros",
    body: "Olá, só para vos informar que quando fui buscar o carro o conta-quilómetros tinha mais 60 km do que quando o deixei. Gostava de perceber porquê.\n\nManuel",
    expected: "reclamacoes", note: "calma, sem a palavra reclamação",
  },
  {
    id: "cg24", partner: true, lang: "fr", box: "info", fromName: "Voyages Lumière", fromEmail: "contact@voyageslumiere.fr",
    subject: "Réservation 49870 — Mme Dubois",
    body: "Bonjour,\n\nNotre cliente Mme Dubois (réservation 49870) nous signale avoir attendu 1h15 au terminal à son retour, sans aucune information. Merci de nous faire un retour afin que nous puissions lui répondre.\n\nBien cordialement,\nAgence Voyages Lumière",
    expected: "reclamacoes", note: "agência em nome da cliente",
  },
  {
    id: "cg25", lang: "es", box: "faturacao", fromName: "Lucía Martín", fromEmail: "lucia.martin@gmail.com",
    subject: "Factura reserva 50001",
    body: "Hola,\n\nNecesito la factura de la reserva 50001 a nombre de mi empresa (CIF B12345678). Por cierto, el conductor llegó 30 minutos tarde a la recogida y casi pierdo el vuelo.\n\nGracias",
    expected: "reclamacoes", note: "escondida num pedido de fatura",
  },
  {
    id: "cg26", lang: "pt", box: "info", fromName: "Henrique Leal", fromEmail: "henrique.leal@gmail.com",
    subject: "Re: Como correu a sua experiência?", newThread: false,
    body: [
      "Mal. O carro veio sujo por dentro e com o depósito na reserva.",
      "",
      quoteOf("Multipark <info@multipark.pt>", "13/10/2026 10:00", [
        "Olá Henrique,",
        "Gostaríamos de saber como correu a sua experiência connosco. Basta responder a este email.",
        "Obrigado!",
      ]),
    ].join("\n"),
    expected: "reclamacoes", note: "resposta de uma linha ao inquérito",
  },
  {
    id: "cg27", lang: "pt", box: "info", fromName: "Diogo Neves", fromEmail: "diogo.neves@gmail.com",
    subject: "Reserva 47555",
    body: "Segue foto do estado em que recebi o carro: para-brisas rachado no canto inferior direito.",
    attachments: ["IMG_20261013_201455.jpg"],
    expected: "reclamacoes", note: "só a foto descrita",
  },

  // ─── Perdidos e achados (12) ───────────────────────────────────────────────
  {
    id: "cg28", lang: "pt", box: "info", fromName: "Teresa Vaz", fromEmail: "teresa.vaz@gmail.com",
    subject: "Óculos",
    body: "Bom dia, esqueci-me dos meus óculos graduados (armação castanha) na carrinha do transfer ontem por volta das 18h, terminal 2. Alguém os encontrou?\n\nTeresa",
    expected: "perdidos",
  },
  {
    id: "cg29", lang: "en", box: "info", fromName: "Sarah Mitchell", fromEmail: "sarah.mitchell@gmail.com",
    subject: "Teddy",
    body: "Hi, my daughter left her teddy (a brown rabbit with a blue scarf) on your shuttle bus on Sunday. It means the world to her. Any chance you found it?\n\nThanks, Sarah",
    expected: "perdidos",
  },
  {
    id: "cg30", lang: "es", box: "info", fromName: "Pablo Ruiz", fromEmail: "pablo.ruiz@gmail.com",
    subject: "Llaves",
    body: "¿Han encontrado unas llaves de casa con un llavero rojo? Creo que se me cayeron en el parking al dejar el coche el martes.",
    expected: "perdidos",
  },
  {
    id: "cg31", lang: "fr", box: "info", fromName: "Julien Bernard", fromEmail: "julien.bernard@free.fr",
    subject: "Chargeur",
    body: "Bonjour, j'ai oublié mon chargeur d'ordinateur dans le minibus qui nous a amenés au terminal ce matin. Pouvez-vous vérifier ? Merci.",
    expected: "perdidos",
  },
  {
    id: "cg32", lang: "pt", box: "info", fromName: "Patrícia Faria", fromEmail: "patricia.faria@gmail.com",
    subject: "RE: Pedido de informação", newThread: false,
    body: [
      "Já encontraram? É preta, da Michael Kors.",
      "",
      quoteOf("Multipark <info@multipark.pt>", "11/10/2026 16:30", [
        "Olá Patrícia,",
        "Recebemos o seu pedido e vamos verificar com a equipa do turno da manhã.",
      ]),
    ].join("\n"),
    expected: "perdidos", note: "resposta de uma linha (o objeto está implícito)",
  },
  {
    id: "cg33", partner: true, lang: "pt", box: "info", fromName: "Hotel Avenida Parque — Receção", fromEmail: "front.office@avenidaparquehotel.pt",
    subject: "Carteira de hóspede",
    body: "Boa tarde,\n\nUm hóspede nosso, o Sr. Almeida, deixou a carteira na vossa viatura de transfer esta manhã (saída do hotel às 9h). Podem confirmar se a encontraram? Pode ser deixada na nossa receção.\n\nObrigado",
    expected: "perdidos", note: "hotel em nome do hóspede",
  },
  {
    id: "cg34", lang: "pt", box: "faturacao", fromName: "Vasco Ribeiro", fromEmail: "vasco.ribeiro@gmail.com",
    subject: "Fatura 49111",
    body: "Olá, preciso da fatura da reserva 49111 em nome da empresa (NIF 509876543).\n\nOutra coisa: deixei um guarda-chuva verde no vosso balcão de entrega no dia 9. Se aparecer, guardem-mo, por favor.",
    expected: "perdidos", note: "escondido num pedido de fatura",
  },
  {
    id: "cg35", lang: "pt", box: "info", fromName: "Cristina Moura", fromEmail: "cristina.moura@gmail.com",
    subject: "Objeto no meu carro",
    body: "Olá, ao recolher o meu carro encontrei no banco de trás um porta-moedas que não é meu (cor-de-rosa, com moedas estrangeiras). Deve ser de outro cliente. Como faço para vo-lo devolver?",
    expected: "perdidos", note: "o cliente ENCONTROU um objeto",
  },
  {
    id: "cg36", lang: "en", box: "info", fromName: "Tom Walker", fromEmail: "tomwalker@icloud.com",
    subject: "Lost phone",
    body: "Left my phone in your van this morning, Samsung with a black case. Please call my wife on her number if you find it.",
    expected: "perdidos",
  },
  {
    id: "cg37", lang: "pt", box: "perdidos", fromName: "Mariana Costa", fromEmail: "mariana.costa@gmail.com",
    subject: "Brinco",
    body: "Perdi um brinco de ouro em forma de argola, talvez no vosso parque ou na carrinha. Se o encontrarem, avisem por favor.",
    expected: "perdidos", note: "pela perdidos@",
  },
  {
    id: "cg38", lang: "pt", box: "info", fromName: "Rui Duarte", fromEmail: "rui.duarte@gmail.com",
    subject: "Casaco",
    body: "A minha mãe deixou o casaco no vosso shuttle no sábado. Cinzento, comprido. Obrigado.",
    expected: "perdidos", note: "curto, em nome de outra pessoa",
  },
  {
    id: "cg39", lang: "es", box: "reservas", fromName: "Elena Gómez", fromEmail: "elena.gomez@gmail.com",
    subject: "Re: Reserva 50777", newThread: false,
    body: [
      "Gracias. Otra cosa: creo que me dejé las gafas de sol en vuestra furgoneta.",
      "",
      "El 12/10/2026 a las 10:00, Multipark <reservas@multipark.pt> escribió:",
      "> Hola Elena, su reserva 50777 queda confirmada. ¡Buen viaje!",
    ].join("\n"),
    expected: "perdidos", note: "resposta numa conversa de reserva",
  },

  // ─── Não são caso (21) ─────────────────────────────────────────────────────
  {
    id: "cg40", lang: "pt", box: "info", fromName: "Gonçalo Pires", fromEmail: "goncalo.pires@gmail.com",
    subject: "URGENTE!!! Reserva 51002",
    body: "URGENTE!!! O voo foi antecipado, preciso do carro amanhã às 6h em vez das 10h. Reserva 51002. Respondam por favor, estou muito preocupado!!",
    expected: "alteracoes", note: "urgência normal, não é queixa",
  },
  {
    id: "cg41", lang: "pt", box: "reservas", fromName: "Filipa Santos", fromEmail: "filipa.santos@gmail.com",
    subject: "Preços estranhos",
    body: "Boa tarde, porque é que 8 dias custam mais do que 10 no vosso simulador? Fiz a simulação duas vezes. Não percebo.",
    expected: "reservas", note: "dúvida de preço (antes de reservar)",
  },
  {
    id: "cg42", lang: "pt", box: "info", fromName: "Alexandre Brito", fromEmail: "alex.brito@gmail.com",
    subject: "Elogio",
    body: "Queria só deixar um elogio ao motorista Paulo, super simpático e prestável. Uma sugestão: podiam ter garrafas de água nas carrinhas. Continuem assim!",
    expected: "criticas", note: "elogio com sugestão",
  },
  {
    id: "cg43", lang: "en", box: "info", fromName: "Laura Kent", fromEmail: "laura.kent@gmail.com",
    subject: "Re: How was your experience?", newThread: false,
    body: "Everything was perfect, thanks! Will recommend.\n\nOn Mon, 13 Oct 2026 at 10:00, Multipark <info@multipark.pt> wrote:\n> We'd love to hear how your experience was. Just reply to this email.",
    expected: "criticas",
  },
  {
    id: "cg44", lang: "pt", box: "cancelamentos", fromName: "Pedro Matias", fromEmail: "pedro.matias@gmail.com",
    subject: "Cancelamento 50990",
    body: "Bom dia, quero cancelar a reserva 50990 porque a viagem foi adiada. Como funciona o reembolso?",
    expected: "cancelamentos",
  },
  {
    id: "cg45", lang: "pt", box: "faturacao", fromName: "Joana Rosa", fromEmail: "joana.rosa@empresa-abc.pt",
    subject: "Fatura com NIF",
    body: "Olá, podem enviar a fatura da reserva 50123 com o NIF 509111222? Obrigada.",
    expected: "faturacao",
  },
  {
    id: "cg46", lang: "pt", box: "info", fromName: "Ricardo Lima", fromEmail: "ricardo.lima@gmail.com",
    subject: "Lavagem",
    body: "Durante a estadia podem lavar o carro por dentro e por fora? Quanto custa? Reserva 51111.",
    expected: "servicos_extra",
  },
  {
    id: "cg47", lang: "pt", box: "info", fromName: "Hotel Oriente Prime — Direção", fromEmail: "direcao@orienteprimehotel.pt",
    subject: "Proposta de parceria",
    body: "Exmos. Senhores,\n\nSomos um hotel de 4 estrelas no Parque das Nações e gostaríamos de propor uma parceria: transfer para os nossos hóspedes com tarifa acordada. Teriam disponibilidade para uma reunião?\n\nCumprimentos,\nDireção",
    expected: "parcerias",
  },
  {
    id: "cg48", lang: "pt", box: "info", fromName: "João Carvalho", fromEmail: "joao.carvalho.1994@gmail.com",
    subject: "Candidatura espontânea — motorista",
    body: "Boa tarde, gostaria de me candidatar a motorista. Tenho carta há 10 anos e disponibilidade total. Envio o CV em anexo.",
    attachments: ["CV_Joao_Carvalho.pdf"],
    expected: "rh",
  },
  {
    id: "cg49", lang: "en", box: "reclamacoes", fromName: "Rank Boost Agency", fromEmail: "growth@rankboost-seo.biz",
    subject: "Your website is losing customers",
    body: "Hi there,\n\nI noticed multipark.pt is not on the first page of Google for \"airport parking Lisbon\". Our team can fix that in 30 days, guaranteed. Reply YES for a free audit.\n\nBest,\nKevin",
    expected: "ruido", note: "lixo a cair na reclamacoes@",
  },
  {
    id: "cg50", lang: "pt", box: "info", fromName: "Administrador de Correio", fromEmail: "admin@mail-verificacao-conta.com",
    subject: "A sua caixa de correio atingiu o limite",
    body: "Caro utilizador,\n\nA sua caixa de correio atingiu 99% do limite. Para evitar a suspensão, valide a sua conta nas próximas 24 horas no link abaixo:\nhttp://valida-conta-mail.example/login\n\nEquipa de Suporte",
    expected: "ruido", note: "phishing",
  },
  {
    id: "cg51", lang: "pt", box: "reservas", fromName: "Maria Silva", fromEmail: "maria.silva@empresa-x.pt",
    subject: "Resposta automática: Reserva 50111",
    body: "Estou ausente do escritório até dia 20 de outubro, com acesso limitado ao email. Para assuntos urgentes contacte geral@empresa-x.pt.",
    headers: { autoSubmitted: "auto-replied" },
    expected: "ruido", note: "resposta automática (cabeçalho)",
  },
  {
    id: "cg52", lang: "pt", box: "info", fromName: "ParkVia Deals", fromEmail: "news@parkvia-deals.com",
    subject: "Ofertas de outono: estacionamento a partir de 3 €/dia",
    body: "Aproveite as nossas ofertas de outono em mais de 200 parques em toda a Europa. Reserve já!\n\nPara deixar de receber estes emails clique aqui.",
    headers: { listUnsubscribe: "<mailto:unsubscribe@parkvia-deals.com>", listId: "<news.parkvia-deals.com>" },
    expected: "ruido", note: "newsletter (cabeçalhos de lista)",
  },
  {
    id: "cg53", lang: "pt", box: "info", fromName: "Google Business Profile", fromEmail: "businessprofile-noreply@google.com",
    subject: "Nova avaliação de 2 estrelas para Multipark",
    body: "Recebeu uma nova avaliação.\n\n★★☆☆☆ \"Demoraram imenso a entregar o carro e o motorista nem pediu desculpa.\"\n\nResponder à avaliação",
    expected: "criticas", note: "aviso de avaliação negativa (vai para as Críticas, não é caso)",
  },
  {
    id: "cg54", lang: "pt", box: "info", fromName: "Rui Costa", fromEmail: "rui.costa@multipark.pt",
    subject: "Troca de turno sábado",
    body: "Olá, podes trocar-me o turno de sábado com o Bruno? Tenho uma consulta de manhã. Obrigado, Rui",
    expected: "rh", note: "interno",
  },
  {
    id: "cg55", lang: "pt", box: "info", fromName: "Operações Multipark", fromEmail: "operacoes@multipark.pt",
    subject: "P2 — pneu vazio 33-RT-12",
    body: "No parque P2 o carro 33-RT-12 de um cliente foi encontrado com o pneu traseiro esquerdo vazio na ronda das 23h. Chamámos a assistência, fica registado para memória.",
    expected: "ocorrencias", note: "interno — incidente para registo",
  },
  {
    id: "cg56", lang: "pt", box: "info", fromName: "App Multipark", fromEmail: "app@multipark.app",
    subject: "Nova ocorrência registada",
    body: "Tipo de ocorrência: Dano\nMatrícula: 45-AA-12\nObservações: risco na porta traseira direita detetado na receção\nLink reserva: https://multipark.pt/consulta/QWERTY123456",
    expected: "ocorrencias", note: "formulário da app",
  },
  {
    id: "cg57", lang: "en", box: "reservas", fromName: "Mail Delivery Subsystem", fromEmail: "mailer-daemon@googlemail.com",
    subject: "Delivery Status Notification (Failure)",
    body: "Address not found\n\nYour message wasn't delivered to j.smith@exmaple.com because the address couldn't be found, or is unable to receive mail.",
    expected: "ruido", note: "entrega falhada",
  },
  {
    id: "cg58", lang: "pt", box: "info", fromName: "Sandra Fialho", fromEmail: "sandra.fialho@gmail.com",
    subject: "Onde vos encontro?",
    body: "Acabei de aterrar no T1, onde é o ponto de encontro? Estou sem rede para ligar. Reserva 51200.",
    expected: "reservas", note: "urgência normal (ainda nada correu mal)",
  },
  {
    id: "cg59", lang: "es", box: "info", fromName: "Carlos Navarro", fromEmail: "carlos.navarro@gmail.com",
    subject: "Precio agosto",
    body: "Hola, ¿cuánto cuesta dejar el coche 15 días en agosto? ¿Tienen plazas cubiertas?",
    expected: "reservas",
  },
  {
    id: "cg60", lang: "fr", box: "info", fromName: "Nathalie Petit", fromEmail: "nathalie.petit@gmail.com",
    subject: "Merci",
    body: "Service impeccable, merci ! Petite suggestion : un SMS quand le chauffeur arrive serait bien pratique.",
    expected: "criticas", note: "elogio com sugestão",
  },
];
