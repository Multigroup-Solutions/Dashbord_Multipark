/*
 * Service worker do dashboard: SÓ notificações push — chamadas do WhatsApp a
 * tocar e (plano 56) o código de entrada para o TL/supervisor de serviço
 * (`type: "login_code"`); num PDA, só "Tens um aviso" (`type: "pda"`). Não faz cache nem interceta pedidos (sem handler de
 * fetch), por isso não muda nada no carregamento da app.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }

  // Código de entrada (plano 56): aviso normal (não toca como uma chamada).
  // Não se fecha sozinho — o browser não deixa o service worker esperar os
  // 10 minutos do código; o sino e o cartão "Códigos de entrada" dizem se ainda vale.
  if (data.type === "login_code") {
    event.waitUntil(
      self.registration.showNotification(data.title || "Código de entrada", {
        body: data.body || "Abre a app para veres o código.",
        tag: data.tag || "login-code",
        renotify: true,
        icon: "/icon.png",
        badge: "/icon.png",
        data: { url: data.url || "/operacional?tab=live" },
      }),
    );
    return;
  }

  // Plano 56 (A2): num PDA (aparelho partilhado) o aviso não diz nada de
  // ninguém — "Tens um aviso" — e abre a app. Outros tipos com nome (ex.:
  // "terminal") também são avisos normais, nunca o toque de uma chamada.
  if (data.type === "pda" || (data.type && data.type !== "wa_call")) {
    event.waitUntil(
      self.registration.showNotification(data.title || "Multipark", {
        body: data.body || "Tens um aviso",
        tag: data.tag || "aviso",
        renotify: true,
        icon: "/icon.png",
        badge: "/icon.png",
        data: { url: data.url || "/" },
      }),
    );
    return;
  }

  const title = data.title || "Chamada WhatsApp";
  const tag = data.tag || "wa-call";
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body: data.body || "Abre o dashboard para atender.",
        tag,
        renotify: true,
        requireInteraction: true,
        icon: "/icon.png",
        badge: "/icon.png",
        data: { url: data.url || "/whatsapp" },
      });
      // Uma chamada deixa de tocar ao fim de ~1 min (atendida por outra
      // pessoa, perdida): o aviso fecha-se sozinho em vez de ficar horas no
      // ecrã. (Um 2.º push "fechar" obrigava o Chrome a mostrar outro aviso.)
      await new Promise((resolve) => setTimeout(resolve, 70000));
      const open = await self.registration.getNotifications({ tag });
      open.forEach((n) => n.close());
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/whatsapp", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Um separador do dashboard já aberto: traz para a frente (o toque está
      // lá; recarregar deitava fora uma chamada em curso).
      for (const client of windows) {
        if (new URL(client.url).origin === target.origin && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
