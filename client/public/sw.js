/*
 * Service worker do dashboard: SÓ notificações push (chamadas do WhatsApp a
 * tocar). Não faz cache nem interceta pedidos (sem handler de fetch), por isso
 * não muda nada no carregamento da app.
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
