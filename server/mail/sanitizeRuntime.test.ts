import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// A função da Vercel carrega o sanitize-html por require(). Se a dependência
// htmlparser2 vier só em ESM (v12+), o arranque rebenta com ERR_REQUIRE_ESM e
// toda a API dá 500. Garante que a versão resolvida tem saída CommonJS.
describe("sanitize-html no runtime da Vercel", () => {
  it("o htmlparser2 usado pelo sanitize-html exporta CommonJS", () => {
    const req = createRequire(import.meta.url);
    const sanitizeDir = dirname(req.resolve("sanitize-html/package.json"));
    const fromSanitize = createRequire(`${sanitizeDir}/index.js`);
    // Caminho que o require() escolhe (condição "require" dos exports).
    const entry = fromSanitize.resolve("htmlparser2");
    const pkgDir = entry.slice(0, entry.lastIndexOf("/htmlparser2/") + "/htmlparser2".length);
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { type?: string };
    // Em pacotes "type: module" só é CommonJS se o require cair num .cjs ou numa pasta commonjs.
    const hasCjs =
      pkg.type !== "module" || entry.endsWith(".cjs") || entry.includes("/commonjs/");
    expect(hasCjs).toBe(true);
  });
});
