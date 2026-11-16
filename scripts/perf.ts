import { createElement } from "react";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AstroIntegrationLogger } from "astro";
import { buildDoneHook } from "../src/hook.js";
import { computeGlobalKey } from "../src/cache.js";
import type { IntegrationOptions, Page, RenderFunction } from "../src/types.js";

const N = Number(process.env.PERF_PAGES ?? 80);
const SITE = "http://example.com";

// SAFETY: Mock logger for perf harness, only info/warn/error/level are used.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- AstroIntegrationLogger is a complex interface; mock satisfies the used subset.
const logger = {
  info: (m: string) => {
    console.log(`  ${m}`);
  },
  warn: (m: string) => {
    console.log(`  WARN ${m}`);
  },
  error: (m: string) => {
    console.log(`  ERR ${m}`);
  },
  level: "info",
} as AstroIntegrationLogger;

const options: IntegrationOptions = {
  width: 1200,
  height: 630,
  format: "png",
  quality: 100,
  verbose: false,
  drawDebugBorder: false,
  domBackend: "linkedom",
  cache: true,
};

const render: RenderFunction = async ({ title }) => {
  await Promise.resolve();
  return createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        width: "100%",
        height: "100%",
        backgroundColor: "#0c0f17",
        color: "#fff",
        fontSize: 72,
      },
    },
    title,
  );
};

function pageHtml(title: string, pathname: string): string {
  return `<!doctype html><html><head>
<meta property="og:title" content="${title}">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}${pathname}">
<meta property="og:image" content="${SITE}${pathname}index.png">
</head><body>${title}</body></html>`;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "takumi-perf-"));
  const dist = join(root, "dist");
  const cacheDir = join(root, "cache");
  await mkdir(dist, { recursive: true });

  const pages: Page[] = [];
  for (let i = 0; i < N; i++) {
    const pathname = `/post-${String(i)}/`;
    await mkdir(join(dist, `post-${String(i)}`), { recursive: true });
    await writeFile(join(dist, `post-${String(i)}`, "index.html"), pageHtml(`Post ${String(i)}`, pathname));
    pages.push({ pathname });
  }
  const dir = pathToFileURL(dist + "/");
  const globalKey = computeGlobalKey({
    render,
    options: { ...options, cacheDir },
    versions: { integration: "perf", core: "perf" },
  });

  console.log(`\n=== astro-takumi perf harness (${String(N)} pages) ===`);

  let t = performance.now();
  await buildDoneHook({ logger, pages, dir, options: { ...options, cacheDir }, render, globalKey });
  console.log(`COLD total: ${String(Math.round(performance.now() - t))}ms`);

  t = performance.now();
  await buildDoneHook({ logger, pages, dir, options: { ...options, cacheDir }, render, globalKey });
  console.log(`WARM total: ${String(Math.round(performance.now() - t))}ms`);

  const changed = 3;
  for (let i = 0; i < changed; i++) {
    const pathname = `/post-${String(i)}/`;
    await writeFile(join(dist, `post-${String(i)}`, "index.html"), pageHtml(`Post ${String(i)} EDITED`, pathname));
  }
  t = performance.now();
  await buildDoneHook({ logger, pages, dir, options: { ...options, cacheDir }, render, globalKey });
  console.log(`PARTIAL (${String(changed)} changed) total: ${String(Math.round(performance.now() - t))}ms`);

  await rm(root, { recursive: true, force: true });
}

// SAFETY: catch variable typed as unknown per use-unknown-in-catch-callback-variable.
main().catch((e: Error) => {
  const msg = e.message;
  console.error(msg);
  process.exit(1);
});
