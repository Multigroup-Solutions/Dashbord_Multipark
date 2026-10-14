/**
 * Corpus de CONTROLO (independente) da triagem dos emails — 14 out 2026.
 *
 * Escrito pelo auditor ANTES de ler o corpus principal
 * (server/fixtures/mailTriageCorpus.ts), para que a meta do Jorge (mais de
 * 90 % das reclamações e dos perdidos vão para lá) não seja medida só com
 * exemplos de quem escreveu as regras. São emails novos e difíceis, em PT-PT,
 * EN, ES e FR: reclamações indiretas e passivo-agressivas, respostas curtas
 * ("continuo à espera"), queixas dentro de pedidos de fatura ou de alteração,
 * ameaças de Livro de Reclamações ou de advogado, danos descritos sem a
 * palavra "reclamação", perdidos (carregador, peluche, doudou), e o que soa a
 * reclamação sem o ser (alteração urgente, elogio, crítica do Google
 * reencaminhada, colegas, a palavra "reclamar" num pedido de comprovativo).
 *
 * Tudo fictício (nomes, emails, matrículas, reservas). Usado pelo "Testar a
 * triagem" (Definições → Comunicação, super admin) e por
 * scripts/eval-mail-triage.ts (--holdout). Nunca entra em casos nem na
 * Comunicação.
 */
import type { TriageCorpusItem } from "./mailTriageCorpus";

const H = (o: Partial<TriageCorpusItem> & Pick<TriageCorpusItem, "id" | "expected" | "subject" | "body">): TriageCorpusItem => ({
  lang: "pt", box: "info", fromName: "Cliente", fromEmail: "cliente.teste@gmail.com", newThread: true, ...o,
});

/** Linhas de um email citado ("> …"). */
const q = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");

export const TRIAGE_HOLDOUT: readonly TriageCorpusItem[] = [
  // ─── Reclamações (indiretas, curtas, dentro de outros pedidos, ameaças) ───
  H({ id: "h-rec-01", expected: "reclamacoes", fromName: "Teresa Vasconcelos", fromEmail: "teresa.vasc@gmail.com", subject: "Obrigada pela experiência",
    body: "Obrigada pela \"excelente\" experiência de ontem. Esperar 50 minutos no terminal, às duas da manhã, com duas crianças a dormir em cima das malas, é mesmo o que se espera de um serviço premium. Fica a nota.",
    note: "sarcasmo, sem pedir nada explicitamente" }),
  H({ id: "h-rec-02", expected: "reclamacoes", newThread: false, fromName: "Hugo Pinheiro", fromEmail: "hugo.pinheiro@sapo.pt", subject: "Re: Risco na porta",
    body: `Continuo à espera.

Em seg., 6/10/2026 às 10:12, Multipark <info@multipark.pt> escreveu:
${q(`Caro Hugo, lamentamos o sucedido. O seu caso foi encaminhado para a equipa responsável e será contactado brevemente.

Em sex., 3/10/2026 às 19:40, Hugo Pinheiro escreveu:
> Levantei hoje o carro e tem um risco enorme na porta do condutor que não tinha quando o deixei. Tenho fotos da entrega.`)}`,
    note: "resposta de duas palavras; a queixa está no citado" }),
  H({ id: "h-rec-03", expected: "reclamacoes", fromName: "Catarina Melo", fromEmail: "catarina.melo@outlook.pt", subject: "Fatura reserva MP-48213",
    body: "Boa tarde,\n\nPreciso da fatura da reserva MP-48213 com o NIF 234567890.\n\nAproveito para dizer que me cobraram 72 € quando no site o preço era 54 €. Agradeço que corrijam a diferença.\n\nCumprimentos,\nCatarina",
    note: "queixa de cobrança dentro de um pedido de fatura" }),
  H({ id: "h-rec-04", expected: "reclamacoes", fromName: "Rui Antunes", fromEmail: "rui.antunes77@gmail.com", subject: "Alterar recolha",
    body: "Bom dia, quero passar a recolha para dia 20 às 18h. E desta vez espero que o motorista não me deixe 40 minutos à espera como da última vez, foi inadmissível.",
    note: "queixa dentro de um pedido de alteração" }),
  H({ id: "h-rec-05", expected: "reclamacoes", fromName: "Fernando Lopes", fromEmail: "f.lopes@netcabo.pt", subject: "Vidro",
    body: "Se até amanhã não tiver uma resposta sobre o vidro traseiro partido, escrevo no Livro de Reclamações e faço queixa à ASAE. Já liguei três vezes.",
    note: "ameaça de Livro de Reclamações" }),
  H({ id: "h-rec-06", expected: "reclamacoes", fromName: "Isabel Correia", fromEmail: "isabel.correia@gmail.com", subject: "Assunto entregue ao advogado",
    body: "Exmos. Senhores,\n\nVenho informar que, não tendo obtido qualquer resposta aos três emails anteriores sobre os danos na jante dianteira direita do veículo 45-XZ-12, o assunto foi entregue ao meu advogado, que vos contactará.\n\nIsabel Correia",
    note: "ameaça de advogado, tom formal" }),
  H({ id: "h-rec-07", lang: "en", expected: "reclamacoes", fromName: "Mark Davies", fromEmail: "mark.davies@btinternet.com", subject: "Car pick-up yesterday",
    body: "Hi,\n\nWhen I picked up my car yesterday I noticed a deep scratch along the rear bumper that wasn't there before. I have photos from when I dropped it off. How do we proceed?\n\nMark",
    note: "dano sem a palavra complaint" }),
  H({ id: "h-rec-08", lang: "en", expected: "reclamacoes", fromName: "Laura Kim", fromEmail: "laurakim@icloud.com", subject: "Mileage",
    body: "Interesting that my car came back with 87 km more on the odometer than when I dropped it off at your car park. Care to explain?",
    note: "passivo-agressivo, curto" }),
  H({ id: "h-rec-09", lang: "es", expected: "reclamacoes", fromName: "Javier Ortega", fromEmail: "jortega@gmail.com", subject: "Mi coche",
    body: "Buenas. Al recoger el coche estaba lleno de arena por dentro y el asiento del conductor movido del todo hacia atrás. No es lo que pagué. Espero una explicación.",
    note: "dano/sujidade em espanhol" }),
  H({ id: "h-rec-10", lang: "fr", expected: "reclamacoes", fromName: "Sophie Laurent", fromEmail: "sophie.laurent@orange.fr", subject: "Retour du 12 octobre",
    body: "Bonjour,\n\nÀ notre retour, personne n'était au point de rendez-vous. Nous avons attendu plus d'une heure puis avons dû prendre un taxi jusqu'au parking. Je souhaite être remboursée du taxi (45 €, reçu joint).\n\nSophie Laurent",
    attachments: ["recu_taxi.jpg"], note: "atraso + pedido de reembolso, francês" }),
  H({ id: "h-rec-11", expected: "reclamacoes", newThread: false, fromName: "Paulo Rebelo", fromEmail: "paulo.rebelo@gmail.com", subject: "Re: Cobrança duplicada",
    body: `Ainda nada?

On Tue, 7 Oct 2026 at 09:03, Paulo Rebelo <paulo.rebelo@gmail.com> wrote:
${q("Bom dia, a reserva MP-50117 foi cobrada duas vezes no meu cartão (2 x 61,50 €). Peço a devolução de uma delas.")}`,
    note: "insistência numa queixa sem resposta" }),
  H({ id: "h-rec-12", expected: "reclamacoes", fromName: "Backoffice Multipark", fromEmail: "backoffice@multipark.pt", subject: "Fwd: Carro sujo",
    body: `Para tratarem, por favor.

---------- Forwarded message ---------
De: Ricardo Antunes <ricardo.antunes@sapo.pt>
Date: dom., 12/10/2026 às 21:14
Subject: Carro sujo
To: <reservas@multipark.pt>

Deixei o carro limpo e recebi-o com lama nos tapetes e o banco do pendura molhado. Paguei a lavagem exterior e não foi feita. Não estou nada satisfeito.`,
    note: "reencaminhamento do backoffice com a queixa do cliente lá dentro" }),
  H({ id: "h-rec-13", lang: "en", expected: "reclamacoes", fromName: "Frontoffice Lisboa", fromEmail: "frontoffice.lisboa@multipark.pt", subject: "FW: Driver attitude",
    body: `FYI

-----Original Message-----
From: Daniel Weber <d.weber@web.de>
Sent: Monday, October 13, 2026 8:02 AM
To: info@multipark.pt
Subject: Driver attitude

The driver who returned our car was rude to my wife, threw the keys on the bonnet and walked off without a word. I expect better for what we paid.`,
    note: "colega reencaminha com uma palavra; queixa em inglês" }),
  H({ id: "h-rec-14", expected: "reclamacoes", fromName: "Manuela Sousa", fromEmail: "manuela.sousa@gmail.com", subject: "Para vosso conhecimento",
    body: "Bom dia. Só para vos dar conhecimento de que, na entrega, o condutor ia ao telemóvel enquanto conduzia o meu carro à saída do parque. Gostaria que tomassem nota e me dissessem que medidas vão tomar. Obrigada.",
    note: "queixa calma e educada" }),
  H({ id: "h-rec-15", expected: "reclamacoes", fromName: "Nuno Barros", fromEmail: "nuno.barros@hotmail.com", subject: "Cancelamento reserva de março",
    body: "Quero cancelar a reserva de março. Depois do que aconteceu em janeiro — carro entregue com a bateria descarregada e ninguém assumiu nada — não volto a confiar em vocês.",
    note: "cancelamento com queixa de um serviço anterior" }),
  H({ id: "h-rec-16", lang: "en", expected: "reclamacoes", fromName: "Olivia Brown", fromEmail: "olivia.brown@gmail.com", subject: "Charged twice - second email",
    body: "I was charged twice for the same booking. This is the second email I'm sending about it. Refund the duplicate charge immediately, please.",
    note: "cobrança duplicada, reembolso exigido" }),
  H({ id: "h-rec-17", expected: "reclamacoes", fromName: "Alberto Faria", fromEmail: "alberto.faria@iol.pt", subject: "Fatura com valores errados",
    body: "Exmos. Senhores, a fatura que me enviaram inclui uma \"lavagem completa\" de 25 € que eu nunca pedi. Não aceito pagar por um serviço que não encomendei. Aguardo a nota de crédito.",
    note: "queixa de cobrança dentro de um assunto de fatura" }),
  H({ id: "h-rec-18", lang: "es", expected: "reclamacoes", newThread: false, fromName: "Carmen Ruiz", fromEmail: "carmen.ruiz@yahoo.es", subject: "RE: Retrovisor",
    body: `Sigo esperando una respuesta sobre el retrovisor roto. Ya han pasado dos semanas.

El jue, 2 oct 2026 a las 18:20, Carmen Ruiz <carmen.ruiz@yahoo.es> escribió:
${q("Al recoger el coche en Faro el retrovisor derecho estaba roto. Quiero saber cómo lo van a solucionar.")}`,
    note: "resposta curta em espanhol" }),
  H({ id: "h-rec-19", expected: "reclamacoes", fromName: "Sérgio Mota", fromEmail: "sergio.mota@gmail.com", subject: "Combustível",
    body: "Boa tarde. Deixei o carro com meio depósito e entregaram-mo com a luz da reserva acesa. Gostava de perceber por onde andou o meu carro.",
    note: "insinuação de uso indevido, sem palavra reclamação" }),
  H({ id: "h-rec-20", lang: "fr", expected: "reclamacoes", fromName: "Pierre Martin", fromEmail: "p.martin@free.fr", subject: "Ma voiture",
    body: "J'ai retrouvé ma voiture avec le rétroviseur gauche rayé et des traces de doigts partout sur le tableau de bord. Vous comprendrez que je ne suis pas satisfait.",
    note: "dano em francês, sem pedido explícito" }),
  H({ id: "h-rec-21", expected: "reclamacoes", fromName: "Graça Nogueira", fromEmail: "graca.nogueira@gmail.com", subject: "Livro de reclamações",
    body: "Fiz hoje uma reclamação no Livro de Reclamações eletrónico e envio também por aqui para ficar registado: a recolha estava marcada para as 6h e o carro só chegou às 6h55, perdi o check-in.",
    note: "cliente diz que já escreveu no Livro (não é o aviso oficial)" }),
  H({ id: "h-rec-22", lang: "en", expected: "reclamacoes", newThread: false, fromName: "Tom Walsh", fromEmail: "tom.walsh@gmail.com", subject: "Re: Your enquiry",
    body: `Thanks for nothing.

On Fri, 10 Oct 2026 at 11:30, Multipark <info@multipark.pt> wrote:
${q(`Dear Tom, after reviewing the check-in photos we cannot confirm the dent happened while the vehicle was in our care, so we are unable to cover the repair.

On Wed, 8 Oct 2026, Tom Walsh wrote:
> There is a dent on the passenger door that was not there before.`)}`,
    note: "resposta seca a uma recusa" }),
  H({ id: "h-rec-23", expected: "reclamacoes", fromName: "Diana Rocha", fromEmail: "diana.rocha@gmail.com", subject: "Lugar coberto",
    body: "Olá, ainda têm lugar coberto para a próxima semana? Da última vez paguei o coberto e o carro ficou no descoberto, veio cheio de pó e caca de pássaro. Desta vez queria garantia de que fica mesmo no coberto.",
    note: "queixa dentro de um pedido de reserva" }),
  H({ id: "h-rec-24", expected: "reclamacoes", fromName: "Vítor Gomes", fromEmail: "vitor.gomes@gmail.com", subject: "(sem assunto)",
    body: "Péssimo serviço. Uma hora à espera no aeroporto. Nunca mais.",
    note: "curtíssimo, sem pedido" }),
  H({ id: "h-rec-25", expected: "reclamacoes", newThread: false, fromName: "Joana Leite", fromEmail: "joana.leite@gmail.com", subject: "Re: Confirmação da reserva MP-51230",
    body: `Recebi esta confirmação mas o valor cobrado no cartão foi 89 €, não 64 € como aqui diz. Expliquem lá isto.

Em sáb., 11/10/2026 às 14:02, Multipark <noreply@multipark.pt> escreveu:
${q("A sua reserva MP-51230 está confirmada. Entrada: 18/10 06:00 · Saída: 25/10 22:00 · Total: 64,00 €")}`,
    note: "resposta a uma confirmação de reserva" }),
  H({ id: "h-rec-26", box: "reclamacoes", expected: "reclamacoes", fromName: "Luís Carvalho", fromEmail: "luis.carvalho@gmail.com", subject: "Reclamação",
    body: "Venho reclamar do atraso de 35 minutos na entrega do carro no dia 9.", note: "entrou pela reclamacoes@ (porta)" }),
  H({ id: "h-rec-27", lang: "es", expected: "reclamacoes", fromName: "Andrés Molina", fromEmail: "andres.molina@gmail.com", subject: "Cambio de fecha",
    body: "Hola, quiero cambiar la fecha de recogida al domingo. Por cierto, la última vez el conductor fue muy maleducado conmigo y con mi mujer; espero que no se repita.",
    note: "queixa dentro de um pedido de alteração, espanhol" }),
  H({ id: "h-rec-28", expected: "reclamacoes", fromName: "Livro de Reclamações", fromEmail: "nao-responder@livroreclamacoes.pt", subject: "Nova reclamação registada",
    body: "Foi registada uma reclamação no Livro de Reclamações Eletrónico relativa ao seu estabelecimento. Aceda à plataforma para consultar e responder no prazo legal.",
    note: "aviso oficial do Livro de Reclamações (regra pelo remetente)" }),

  // ─── Perdidos e achados ────────────────────────────────────────────────────
  H({ id: "h-per-01", expected: "perdidos", fromName: "Marta Pires", fromEmail: "marta.pires@gmail.com", subject: "Carregador",
    body: "Boa noite, ontem quando nos levaram ao terminal na carrinha esqueci-me do carregador do portátil no banco de trás. É possível verificarem? Volto dia 22.",
    note: "esqueceu na carrinha do transfer" }),
  H({ id: "h-per-02", expected: "perdidos", fromName: "Bruno Teixeira", fromEmail: "bruno.teixeira@gmail.com", subject: "Peluche",
    body: "Olá, o meu filho deixou um peluche (um coelho cinzento, já muito gasto) na vossa carrinha quando nos foram buscar ao aeroporto no domingo à noite. Ele não dorme sem ele. Encontraram?",
    note: "objeto de criança" }),
  H({ id: "h-per-03", lang: "en", expected: "perdidos", fromName: "Emma Clarke", fromEmail: "emma.clarke@outlook.com", subject: "AirPods",
    body: "Hi, I think I dropped my AirPods case in the shuttle from the car park to departures this morning. White case with a small yellow sticker. Any chance someone found it?",
    note: "inglês" }),
  H({ id: "h-per-04", lang: "es", expected: "perdidos", fromName: "Lucía Fernández", fromEmail: "lucia.fdez@gmail.com", subject: "Gafas",
    body: "Hola, creo que se me cayeron las gafas de sol en la oficina del parking al pagar, el martes por la tarde. Son unas Ray-Ban negras con funda marrón. ¿Las han visto?",
    note: "espanhol, no balcão" }),
  H({ id: "h-per-05", lang: "fr", expected: "perdidos", fromName: "Claire Dubois", fromEmail: "claire.dubois@laposte.net", subject: "Doudou oublié",
    body: "Bonjour, ma fille a oublié son doudou (un petit lapin rose) dans votre navette samedi matin. Pourriez-vous vérifier s'il a été retrouvé ? Merci infiniment.",
    note: "francês" }),
  H({ id: "h-per-06", expected: "perdidos", fromName: "Helena Moura", fromEmail: "helena.moura@gmail.com", subject: "Obrigada e uma pergunta",
    body: "Quero agradecer ao condutor Rui pela simpatia, foi impecável. Já agora: quando cheguei a casa reparei que não tenho o cartão de cidadão. Pode ter ficado no balcão quando mostrei os documentos. Conseguem ver?",
    note: "perdido dentro de um elogio" }),
  H({ id: "h-per-07", expected: "perdidos", newThread: false, fromName: "Gonçalo Reis", fromEmail: "goncalo.reis@gmail.com", subject: "Re: Casaco",
    body: `Era um casaco azul-escuro da North Face, tamanho M.

Em ter., 7/10/2026 às 16:45, Multipark <perdidos@multipark.pt> escreveu:
${q(`Olá Gonçalo, para procurarmos, pode descrever o casaco?

Em ter., 7/10/2026 às 09:10, Gonçalo Reis escreveu:
> Bom dia, deixei o casaco na vossa carrinha ontem à tarde.`)}`,
    note: "resposta só com a descrição; o perdido está no citado" }),
  H({ id: "h-per-08", lang: "en", expected: "perdidos", fromName: "Backoffice Multipark", fromEmail: "backoffice@multipark.pt", subject: "Fwd: House keys",
    body: `Alguém viu isto?

---------- Forwarded message ---------
From: Sarah Collins <sarah.collins@gmail.com>
Date: Mon, 13 Oct 2026 at 19:22
Subject: House keys
To: <reservas@multipark.pt>

I believe I left my house keys (red keyring) on the counter at your reception when I collected my car this afternoon. Could you check?`,
    note: "reencaminhamento do backoffice de um perdido" }),
  H({ id: "h-per-10", expected: "perdidos", fromName: "Rita Almeida", fromEmail: "rita.almeida@gmail.com", subject: "Guarda-chuva",
    body: "Boa tarde, encontraram por acaso um guarda-chuva preto no parque? Esqueci-me dele junto à máquina de pagamento ontem ao fim do dia.",
    note: "objeto de pouco valor" }),
  H({ id: "h-per-11", lang: "es", expected: "perdidos", newThread: false, fromName: "Pablo Serrano", fromEmail: "pablo.serrano@gmail.com", subject: "RE: Tablet",
    body: `¿Lo han encontrado ya?

El lun, 6 oct 2026 a las 10:02, Pablo Serrano <pablo.serrano@gmail.com> escribió:
${q("Buenos días, olvidé mi tablet (Samsung, funda azul) en el autobús de traslado del parking a la terminal.")}`,
    note: "resposta curta; o perdido está no citado" }),
  H({ id: "h-per-12", expected: "perdidos", fromName: "Fábio Cunha", fromEmail: "fabio.cunha@gmail.com", subject: "Óculos que não são meus",
    body: "Olá, quando cheguei a casa encontrei no meu carro uns óculos graduados que não são meus nem de ninguém da família. Devem ser de outro cliente ou de um condutor. Como faço para os devolver?",
    note: "objeto encontrado (de outra pessoa)" }),
  H({ id: "h-per-13", expected: "perdidos", newThread: false, fromName: "Inês Costa", fromEmail: "ines.costa@gmail.com", subject: "Re: Como correu a sua experiência?",
    body: `Correu tudo bem, obrigada. Só uma coisa: deixei a cadeirinha do bebé na vossa carrinha? Não a encontro em lado nenhum.

Em qui., 9/10/2026 às 12:00, Multipark <info@multipark.pt> escreveu:
${q("Obrigado por ter escolhido a Multipark! Como correu a sua experiência? Responda a este email com a sua opinião.")}`,
    note: "perdido numa resposta a um inquérito" }),
  H({ id: "h-per-14", box: "perdidos", expected: "perdidos", fromName: "Tiago Sá", fromEmail: "tiago.sa@gmail.com", subject: "Chave",
    body: "Bom dia, perdi a chave de casa, deve ter caído no parque. Porta-chaves verde.", note: "entrou pela perdidos@ (porta)" }),

  // ─── Parecem reclamação/perdido e não são ─────────────────────────────────
  H({ id: "h-alt-01", expected: "alteracoes", fromName: "Patrícia Lima", fromEmail: "patricia.lima@gmail.com", subject: "URGENTE!!! Voo antecipado",
    body: "URGENTE!!! O voo foi antecipado, chego HOJE às 23h em vez de amanhã. Preciso que o carro esteja pronto hoje à noite, por favor confirmem o mais rápido possível!!!",
    note: "urgência e maiúsculas, mas é uma alteração" }),
  H({ id: "h-alt-02", lang: "en", expected: "alteracoes", fromName: "James Wilson", fromEmail: "jwilson@gmail.com", subject: "Flight cancelled - extend booking",
    body: "Our flight got cancelled by the airline (not your fault!), so we'll be back two days later than planned. Can we extend the booking? Happy to pay the difference.",
    note: "problema, mas não com o serviço" }),
  H({ id: "h-alt-03", expected: "alteracoes", fromName: "Sandra Neves", fromEmail: "sandra.neves@gmail.com", subject: "Enganei-me!",
    body: "Não acredito! Enganei-me na data da reserva, pus outubro em vez de novembro. Ajudem-me a corrigir por favor, estou mesmo aflita.",
    note: "frustração com o próprio erro" }),
  H({ id: "h-alt-04", lang: "fr", expected: "alteracoes", fromName: "Julien Moreau", fromEmail: "julien.moreau@gmail.com", subject: "Changement d'horaire",
    body: "Bonjour, notre vol retour arrive à 6h au lieu de 9h. Pouvez-vous avancer la livraison de la voiture ? Merci d'avance.",
    note: "francês" }),
  H({ id: "h-can-01", expected: "cancelamentos", fromName: "Rosa Fonseca", fromEmail: "rosa.fonseca@gmail.com", subject: "Cancelar reserva",
    body: "Boa tarde, por motivos de saúde já não vou poder viajar. Quero cancelar a reserva e saber se tenho direito a reembolso.",
    note: "reembolso sem queixa" }),
  H({ id: "h-can-02", lang: "en", expected: "cancelamentos", fromName: "Hannah Scott", fromEmail: "hannah.scott@gmail.com", subject: "Cancellation",
    body: "Unfortunately we have to cancel our trip — my mother is ill. Please confirm the cancellation and the refund. Thank you for understanding.",
    note: "tom triste, sem queixa" }),
  H({ id: "h-cri-01", expected: "criticas", fromName: "Miguel Azevedo", fromEmail: "miguel.azevedo@gmail.com", subject: "Elogio",
    body: "Só queria deixar um elogio à equipa do Porto: carro entregue a horas, limpo, e o senhor Paulo foi impecável. Continuem assim!",
    note: "elogio" }),
  H({ id: "h-cri-02", expected: "criticas", fromName: "Marketing Multipark", fromEmail: "marketing@multipark.pt", subject: "Fwd: Nova avaliação de 2 estrelas",
    body: `Para verem.

---------- Forwarded message ---------
From: Google Business Profile <businessprofile-noreply@google.com>
Date: Tue, 14 Oct 2026 at 08:15
Subject: Nova avaliação para Multipark Lisboa

Ana M. deixou uma avaliação de 2 estrelas: "Demoraram muito a entregar o carro e ninguém atendia o telefone."
Responda à avaliação para mostrar que valoriza a opinião dos clientes.`,
    note: "crítica do Google reencaminhada por um colega (não abre caso: entra pelo Google)" }),
  H({ id: "h-cri-03", lang: "en", expected: "criticas", fromName: "Peter Hughes", fromEmail: "peter.hughes@gmail.com", subject: "Thank you",
    body: "Just wanted to say thanks — smoothest airport parking I've ever used. Will recommend you to friends.",
    note: "elogio em inglês" }),
  H({ id: "h-cri-04", expected: "criticas", fromName: "Carla Matias", fromEmail: "carla.matias@gmail.com", subject: "Sugestão",
    body: "Correu tudo bem. Uma sugestão: seria ótimo terem uma app para acompanhar a chegada do motorista em tempo real.",
    note: "sugestão sem queixa" }),
  H({ id: "h-cri-05", expected: "criticas", fromName: "Google Business Profile", fromEmail: "businessprofile-noreply@google.com", subject: "Nova avaliação para Multipark Porto",
    body: "João P. deixou uma avaliação de 1 estrela: \"Horrível, nunca mais.\" Responda à avaliação.",
    note: "aviso direto do Google de uma avaliação negativa (regra pelo remetente)" }),
  H({ id: "h-fat-01", expected: "faturacao", fromName: "Ricardo Moniz", fromEmail: "ricardo.moniz@empresa-x.pt", subject: "Fatura com NIF",
    body: "Bom dia, preciso da fatura da reserva MP-49900 em nome da empresa (NIF 509876543) para poder reclamar o IVA. Obrigado.",
    note: "\"reclamar\" o IVA — não é queixa" }),
  H({ id: "h-fat-02", lang: "es", expected: "faturacao", fromName: "Elena Vidal", fromEmail: "elena.vidal@gmail.com", subject: "Factura",
    body: "Hola, ¿podrían enviarme la factura a nombre de mi empresa? Les paso los datos fiscales: Vidal Consultores S.L., CIF B12345678.",
    note: "espanhol" }),
  H({ id: "h-fat-03", expected: "faturacao", fromName: "Jorge Batista", fromEmail: "jorge.batista@gmail.com", subject: "Fatura de setembro",
    body: "Olá, ainda não recebi a fatura da reserva de setembro. Podem reenviar para este email? Obrigado.",
    note: "\"ainda não recebi\" sem descontentamento" }),
  H({ id: "h-fat-04", expected: "faturacao", fromName: "Lúcia Ramos", fromEmail: "lucia.ramos@gmail.com", subject: "Comprovativo para o seguro",
    body: "Bom dia, quero reclamar o reembolso ao seguro de viagem e preciso de um comprovativo de que o carro esteve no vosso parque de 2 a 9 de outubro. Podem enviar?",
    note: "\"reclamar\" ao seguro — é um comprovativo" }),
  H({ id: "h-res-01", expected: "reservas", fromName: "Filipa Duarte", fromEmail: "filipa.duarte@gmail.com", subject: "Dúvidas antes de reservar",
    body: "Tenho algum receio de deixar o carro com desconhecidos, já li umas críticas más. Como funciona exatamente a entrega e o seguro? Estou a pensar reservar para agosto.",
    note: "fala de críticas más, mas quer reservar" }),
  H({ id: "h-res-02", lang: "fr", expected: "reservas", fromName: "Nicolas Petit", fromEmail: "nicolas.petit@gmail.com", subject: "Disponibilité",
    body: "Bonjour, avez-vous des places disponibles du 3 au 10 novembre à Lisbonne ? Quel serait le prix pour une voiture citadine ?",
    note: "francês" }),
  H({ id: "h-res-03", expected: "reservas", fromName: "Hélder Pinto", fromEmail: "helder.pinto@gmail.com", subject: "Preço",
    body: "A vossa concorrência está 10 € mais barata para as mesmas datas. Fazem o mesmo preço? Se sim, reservo já.",
    note: "negociação de preço, não é queixa" }),
  H({ id: "h-res-04", lang: "es", expected: "reservas", fromName: "María López", fromEmail: "maria.lopez@gmail.com", subject: "Otra reserva",
    body: "Hola, la última vez todo fue perfecto. Quiero reservar otra vez para Semana Santa, del 28 de marzo al 5 de abril.",
    note: "elogio + reserva" }),
  H({ id: "h-ser-01", expected: "servicos_extra", fromName: "André Coelho", fromEmail: "andre.coelho@gmail.com", subject: "Lavagem",
    body: "Posso pedir lavagem interior e exterior para o carro durante a estadia? Chego dia 15 e volto dia 22.",
    note: "serviço extra" }),
  H({ id: "h-rh-01", expected: "rh", fromName: "João Condutor", fromEmail: "joao.ferreira@multipark.pt", subject: "Troca de turno",
    body: "Boa tarde, consigo trocar o turno de sábado com o Miguel? Ele já concordou. Obrigado.",
    note: "colega (interno)" }),
  H({ id: "h-rh-02", expected: "rh", fromName: "Diogo Martins", fromEmail: "diogo.martins.92@gmail.com", subject: "Candidatura a condutor",
    body: "Boa tarde, tenho carta há 8 anos e disponibilidade aos fins de semana. Envio o meu CV em anexo para a vaga de condutor no Porto.",
    attachments: ["CV_Diogo_Martins.pdf"], note: "candidatura" }),
  H({ id: "h-rh-03", expected: "rh", fromName: "Carlos Extra", fromEmail: "carlos.silva@multipark.pt", subject: "Subsídio",
    body: "Ainda não recebi o subsídio de transporte deste mês. Já é o segundo mês que acontece. Quem trata disto?",
    note: "colaborador descontente — não é reclamação de cliente" }),
  H({ id: "h-oco-01", expected: "ocorrencias", fromName: "Team Leader Porto", fromEmail: "tl.porto@multipark.pt", subject: "Ocorrência P1",
    body: "Ao manobrar o Peugeot 308 cinzento no piso -1, o condutor tocou no pilar e ficou um risco no para-choques traseiro. Fotos em anexo. O cliente ainda não sabe.",
    attachments: ["foto1.jpg", "foto2.jpg"], note: "colega relata um dano (interno)" }),
  H({ id: "h-oco-02", expected: "ocorrencias", fromName: "Multipark", fromEmail: "info@multipark.pt", subject: "Nova ocorrência registada",
    body: "Foi registada uma nova ocorrência.\n\nTipo de ocorrência: Dano\nMatrícula: 12-AB-34\nObservações: risco na porta traseira esquerda\nLink reserva: https://app.multipark.pt/consulta/AbC123xyz9",
    note: "aviso automático da app (regra pelo formulário)" }),
  H({ id: "h-int-01", expected: "geral", fromName: "Backoffice Multipark", fromEmail: "backoffice@multipark.pt", subject: "Faturas a partir de segunda",
    body: "Pessoal, a partir de segunda-feira as faturas passam a ser emitidas pelo novo programa. Qualquer dúvida falem comigo.",
    note: "aviso interno" }),
  H({ id: "h-int-02", expected: "alteracoes", fromName: "Backoffice Multipark", fromEmail: "backoffice@multipark.pt", subject: "Fwd: Hora da recolha",
    body: `Podem tratar?

---------- Forwarded message ---------
De: Mário Pacheco <mario.pacheco@gmail.com>
Date: seg., 13/10/2026 às 22:01
Subject: Hora da recolha

Boa noite, gostaria de mudar a hora da recolha de amanhã para as 7h em vez das 8h. Obrigado.`,
    note: "reencaminhamento do backoffice SEM queixa" }),
  H({ id: "h-int-03", expected: "criticas", fromName: "Frontoffice Faro", fromEmail: "frontoffice.faro@multipark.pt", subject: "Fwd: Obrigado!",
    body: `Que bom!

---------- Forwarded message ---------
From: Kate Morris <kate.morris@gmail.com>
Subject: Thank you!

Just a quick note to thank the team in Faro, especially the young man who helped us with the baby seat. Lovely service.`,
    note: "colega reencaminha um elogio" }),
  H({ id: "h-par-01", lang: "en", expected: "parcerias", fromName: "Seville Travel", fromEmail: "partners@sevilletravel.es", subject: "Partnership proposal",
    body: "We're a travel agency in Seville and would like to discuss a commission agreement for our clients flying out of Faro. Who should we talk to?",
    note: "parceria" }),
  H({ id: "h-noise-01", expected: "ruido", fromName: "ParkCompare", fromEmail: "news@parkcompare.example", subject: "Cansado de esperar pelo carro?",
    headers: { listUnsubscribe: "<https://parkcompare.example/unsub>", listId: "<news.parkcompare.example>", precedence: "bulk" },
    body: "Cansado de esperar pelo seu carro no aeroporto? Compare os melhores parques e poupe até 40 %. Reserve já!",
    note: "newsletter com texto de queixa (cabeçalhos)" }),
  H({ id: "h-noise-02", lang: "en", expected: "ruido", fromName: "Tom Walsh", fromEmail: "tom.walsh@gmail.com", subject: "Automatic reply: Your booking",
    headers: { autoSubmitted: "auto-replied" },
    body: "I'm out of the office until Monday 20 October with limited access to email. For urgent matters please call my office.",
    note: "resposta automática de um cliente" }),
  H({ id: "h-noise-03", expected: "ruido", fromName: "Segurança Conta", fromEmail: "seguranca@conta-verificacao.example", subject: "A sua conta será suspensa",
    body: "Detetámos atividade suspeita. A sua conta será suspensa em 24 horas. Clique aqui para verificar os seus dados de pagamento.",
    note: "phishing" }),
  H({ id: "h-noise-04", lang: "en", expected: "ruido", fromName: "Mail Delivery Subsystem", fromEmail: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)",
    body: "Address not found. Your message wasn't delivered to joana.leite@gmial.com because the address couldn't be found.",
    note: "entrega falhada" }),
  H({ id: "h-noise-05", box: "reclamacoes", lang: "en", expected: "ruido", fromName: "SEO Experts", fromEmail: "growth@seo-rank-fast.example", subject: "Rank #1 on Google",
    body: "Hello, we can get your website to page 1 of Google in 30 days. Reply YES for a free audit.",
    note: "spam que chegou à reclamacoes@" }),
];
