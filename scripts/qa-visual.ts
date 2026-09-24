/**
 * QA visual (Playwright) — screenshots + verificações automáticas por página.
 *
 * Uso (a app tem de estar a correr, ex.: `PORT=3101 pnpm dev`):
 *
 *   QA_BASE_URL=http://localhost:3101 \
 *   QA_JWT_SECRET=<o JWT_SECRET local> QA_OPEN_ID=<openId de um user> QA_APP_ID=<VITE_APP_ID> \
 *   QA_PAGES="/,/dashboard,/operacoes" QA_OUT=/tmp/qa \
 *   npx tsx scripts/qa-visual.ts
 *
 * Em vez de QA_JWT_SECRET/QA_OPEN_ID/QA_APP_ID pode passar-se QA_COOKIE (valor
 * já assinado do cookie de sessão). Outras variáveis:
 *   QA_VIEWPORTS  "desktop,mobile" (1440×900 e 390×844)
 *   QA_DARK       "1" → também corre com a classe .dark no <html>
 *   QA_TAG        sufixo nos nomes dos ficheiros (ex.: "before" / "after")
 *   QA_MAX_HEIGHT altura máxima do screenshot em px (omissão 4000)
 *   QA_WAIT_MS    espera extra depois do networkidle (omissão 1200)
 *   PLAYWRIGHT_BROWSERS_PATH  (ex.: /opt/pw-browsers)
 *   HTTPS_PROXY   se definido, as Google Fonts são obtidas via curl (que o usa)
 *
 * Verificações (por página × viewport), escritas em <QA_OUT>/report-<tag>.json
 * e resumidas na consola:
 *   - clipped:   texto cortado (scrollWidth > clientWidth + 1) sem reticências
 *   - hscroll:   o documento tem scroll horizontal
 *   - contrast:  texto com contraste < 4.5:1 (< 3:1 para texto grande)
 *   - tiny:      font-size < 11px
 *   - covered:   elementos visíveis tapados por barras fixas (depois de ir ao fim)
 *
 * Não altera dados — só navega (GET) e tira screenshots.
 */
import { createRequire } from "node:module";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SignJWT } from "jose";

const require = createRequire(import.meta.url);

function loadPlaywright(): any {
  try {
    return require("playwright");
  } catch {
    const globalRoot = execSync("npm root -g").toString().trim();
    return require(path.join(globalRoot, "playwright"));
  }
}

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3101";
const OUT = process.env.QA_OUT ?? path.resolve("qa-out");
const TAG = process.env.QA_TAG ?? "run";
const WAIT_MS = Number(process.env.QA_WAIT_MS ?? 1200);
const PAGES = (process.env.QA_PAGES ?? "/").split(",").map(s => s.trim()).filter(Boolean);
const VIEWPORTS = (process.env.QA_VIEWPORTS ?? "desktop,mobile").split(",").map(s => s.trim());
const DARK = process.env.QA_DARK === "1";
const MAX_H = Number(process.env.QA_MAX_HEIGHT ?? 4000);

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const SIZES: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

async function sessionCookie(): Promise<string> {
  if (process.env.QA_COOKIE) return process.env.QA_COOKIE;
  const secret = process.env.QA_JWT_SECRET;
  const openId = process.env.QA_OPEN_ID;
  if (!secret || !openId) throw new Error("Defina QA_COOKIE ou QA_JWT_SECRET + QA_OPEN_ID");
  return new SignJWT({
    openId,
    appId: process.env.QA_APP_ID ?? "qa-app",
    name: process.env.QA_NAME ?? "QA",
    sv: Number(process.env.QA_SV ?? 0),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + 24 * 3600)
    .sign(new TextEncoder().encode(secret));
}

/** Corre dentro da página: devolve a lista de problemas encontrados. */
function inPageChecks() {
  type Issue = { kind: string; sel: string; text: string; detail: string };
  const issues: Issue[] = [];
  const W = window.innerWidth;

  const describe = (el: Element) => {
    const parts: string[] = [];
    let e: Element | null = el;
    for (let i = 0; e && i < 3; i++) {
      let s = e.tagName.toLowerCase();
      const cls = (e.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      if (cls) s += "." + cls;
      parts.unshift(s);
      e = e.parentElement;
    }
    return parts.join(" > ");
  };
  const ownText = (el: Element) =>
    Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent ?? "")
      .join("")
      .trim();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    // ignora conteúdo sr-only
    if (r.width <= 1 && r.height <= 1) return false;
    return true;
  };
  const parse = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) {
      // oklch/lab/color(): deixa o browser converter via canvas
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const ctx = cv.getContext("2d")!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    }
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (top: number[], bottom: number[]) => {
    const a = top[3];
    return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  const bgOf = (el: Element): number[] | null => {
    const stack: number[][] = [];
    let e: Element | null = el;
    let opacity = 1;
    while (e) {
      const cs = getComputedStyle(e);
      opacity *= Number(cs.opacity);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // gradiente/imagem: desconhecido
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) {
        stack.push(c);
        if (c[3] >= 1) break;
      }
      e = e.parentElement;
    }
    let base = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) base = blend(stack[i], base);
    return base;
  };

  const all = Array.from(document.querySelectorAll("body *"));
  for (const el of all) {
    if (el.closest("[aria-hidden='true'], svg, script, style, noscript")) continue;
    if (!visible(el)) continue;
    const text = ownText(el);
    const cs = getComputedStyle(el);

    // clipped/overflowing text
    if (text && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const ox = cs.overflowX;
      const ellipsis = cs.textOverflow === "ellipsis";
      if (ox !== "auto" && ox !== "scroll" && !ellipsis && cs.display !== "inline") {
        issues.push({ kind: "clipped", sel: describe(el), text: text.slice(0, 60), detail: `${el.scrollWidth}>${el.clientWidth} overflow=${ox}` });
      } else if (ellipsis && !el.getAttribute("title") && !el.closest("[title]")) {
        issues.push({ kind: "truncated-no-title", sel: describe(el), text: text.slice(0, 60), detail: `${el.scrollWidth}>${el.clientWidth}` });
      }
    }
    // element sticks out of the viewport horizontally
    const r = el.getBoundingClientRect();
    if (text && (r.right > W + 1) && !el.closest("[data-radix-scroll-area-viewport], .overflow-x-auto, .overflow-auto, [data-slot='table-container']")) {
      issues.push({ kind: "offscreen", sel: describe(el), text: text.slice(0, 60), detail: `right=${Math.round(r.right)} vw=${W}` });
    }
    if (!text) continue;
    const fs = parseFloat(cs.fontSize);
    if (fs < 11) issues.push({ kind: "tiny", sel: describe(el), text: text.slice(0, 60), detail: `${fs}px` });

    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (fg && bg) {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      const eff = blend([fg[0], fg[1], fg[2], fg[3] * o], bg);
      const L1 = lum(eff), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const bold = Number(cs.fontWeight) >= 700;
      const large = fs >= 24 || (bold && fs >= 18.66);
      const min = large ? 3 : 4.5;
      if (ratio < min && !(el as HTMLElement).closest("[disabled], [aria-disabled='true'], [data-disabled]") && !(el.closest("input, textarea") )) {
        issues.push({ kind: "contrast", sel: describe(el), text: text.slice(0, 60), detail: `${ratio.toFixed(2)} (${cs.color} on rgb(${bg.slice(0, 3).map(Math.round).join(",")}))` });
      }
    }
  }

  const hscroll = document.documentElement.scrollWidth > window.innerWidth + 1;
  if (hscroll) issues.push({ kind: "hscroll", sel: "html", text: "", detail: `${document.documentElement.scrollWidth}>${window.innerWidth}` });
  return issues;
}

/** Depois de fazer scroll até ao fim: elementos visíveis tapados por barras fixas. */
function coveredChecks() {
  const issues: { kind: string; sel: string; text: string; detail: string }[] = [];
  const fixed = Array.from(document.querySelectorAll("body *")).filter(el => {
    const p = getComputedStyle(el).position;
    const r = el.getBoundingClientRect();
    return p === "fixed" && r.width > 40 && r.height > 20 && r.height < window.innerHeight / 2;
  });
  if (!fixed.length) return issues;
  const cands = Array.from(document.querySelectorAll("main button, main a, main input, main td, main p, main h2, main h3, main span"));
  for (const el of cands) {
    if (fixed.some(f => f.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // já cortado por um contentor com scroll próprio (ex.: coluna do kanban) — não conta
    let clippedByParent = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const oy = getComputedStyle(a).overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "hidden") {
        const ar = a.getBoundingClientRect();
        if (cy > ar.bottom || cy < ar.top) { clippedByParent = true; break; }
      }
    }
    if (clippedByParent) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (hit && fixed.some(f => f.contains(hit)) && !el.contains(hit)) {
      issues.push({ kind: "covered", sel: el.tagName.toLowerCase(), text: (el.textContent ?? "").trim().slice(0, 60), detail: `under fixed at y=${Math.round(cy)}` });
    }
  }
  return issues;
}

async function main() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(OUT, { recursive: true });
  const cookie = await sessionCookie();
  const url = new URL(BASE);
  // Atrás de um proxy HTTPS (ex.: sandbox) o Chromium não chega às Google
  // Fonts: servimo-las via curl (que respeita HTTPS_PROXY).
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const fontCache = new Map<string, Buffer>();
  const browser = await chromium.launch();
  const report: Record<string, any> = {};

  for (const vp of VIEWPORTS) {
    const size = SIZES[vp] ?? SIZES.desktop;
    const ctx = await browser.newContext({
      viewport: size,
      deviceScaleFactor: 1,
      isMobile: vp === "mobile",
      hasTouch: vp === "mobile",
      locale: "pt-PT",
      timezoneId: "Europe/Lisbon",
    });
    if (proxy) {
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, async (route: any) => {
        const u = route.request().url();
        try {
          let body = fontCache.get(u);
          if (!body) {
            body = execFileSync("curl", ["-sS", "-A", CHROME_UA, u]);
            fontCache.set(u, body);
          }
          await route.fulfill({ body, contentType: u.includes("googleapis") ? "text/css" : "font/woff2", headers: { "access-control-allow-origin": "*" } });
        } catch {
          await route.abort();
        }
      });
    }
    await ctx.addCookies([{ name: "app_session_id", value: cookie, domain: url.hostname, path: "/", httpOnly: true }]);
    // o tsx/esbuild injeta __name(...) nas funções serializadas para page.evaluate
    await ctx.addInitScript("window.__name = (f) => f;");
    if (DARK) await ctx.addInitScript(() => {
      const apply = () => document.documentElement.classList.add("dark");
      apply();
      new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    });
    const page = await ctx.newPage();
    for (const p of PAGES) {
      const key = `${vp}${DARK ? "-dark" : ""} ${p}`;
      const file = `${p.replace(/^\//, "").replace(/[/?=&]+/g, "_") || "root"}-${vp}${DARK ? "-dark" : ""}-${TAG}.png`;
      try {
        await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 45_000 });
      } catch {
        /* networkidle pode não chegar (polling) — segue */
      }
      await page.waitForTimeout(WAIT_MS);
      const issues = await page.evaluate(inPageChecks);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(250);
      const covered = await page.evaluate(coveredChecks);
      await page.evaluate(() => window.scrollTo(0, 0));
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.screenshot({
        path: path.join(OUT, file),
        fullPage: true,
        clip: { x: 0, y: 0, width: size.width, height: Math.min(h, MAX_H) },
      });
      const all = [...issues, ...covered];
      report[key] = { file, issues: all };
      const counts = all.reduce<Record<string, number>>((a, i) => ((a[i.kind] = (a[i.kind] ?? 0) + 1), a), {});
      console.log(`${key.padEnd(38)} ${JSON.stringify(counts)}`);
    }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, `report-${TAG}${DARK ? "-dark" : ""}.json`), JSON.stringify(report, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
