import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

// Os testes correm em UTC, como a produção (Vercel). A BD devolve as datas
// (ex.: time_records.recordedAt, mode 'string') como "AAAA-MM-DD HH:MM:SS" em
// UTC e o código lê-as com new Date(); num computador em hora de Lisboa as
// horas do ponto davam +1 h (pdasEntrar: 9 h em vez de 8 h).
process.env.TZ = "UTC";

export default defineConfig({
  root: templateRoot,
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts"],
  },
});
