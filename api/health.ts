export default function handler(req: any, res: any) {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    env: !!process.env.DATABASE_URL,
    // presença (booleana, sem expor segredos) das vars críticas
    llm: {
      apiUrl: !!(process.env.LLM_API_URL || process.env.OPENAI_API_URL),
      apiKey: !!(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY),
      model: process.env.LLM_MODEL || null,
    },
    smtp: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    imap: !!(process.env.IMAP_USER && process.env.IMAP_PASS),
    whatsapp: {
      token: !!process.env.WHATSAPP_TOKEN,
      phoneNumberId: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: !!process.env.WHATSAPP_VERIFY_TOKEN,
      appSecret: !!process.env.WHATSAPP_APP_SECRET,
    },
    availabilityForm: {
      tokenSecret: !!process.env.AVAILABILITY_FORM_TOKEN_SECRET,
      url: !!process.env.AVAILABILITY_FORM_URL,
    },
    multiparkWebhook: !!process.env.MULTIPARK_WEBHOOK_SECRET,
  });
}
