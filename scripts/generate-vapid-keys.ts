/**
 * Gera um par de chaves VAPID para as notificações push das chamadas do
 * WhatsApp (server/webPush.ts). Correr UMA vez e colar o resultado nas envs do
 * Vercel/Railway; NÃO faz parte do deploy.
 *
 *   pnpm exec tsx scripts/generate-vapid-keys.ts
 *
 * A chave privada só aparece aqui, no terminal: não a guardes no repositório.
 * Trocar as chaves invalida as subscrições existentes (cada pessoa volta a
 * carregar em "Ativar notificações de chamadas").
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("VAPID_SUBJECT=mailto:<email de contacto>");
