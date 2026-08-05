#!/usr/bin/env node
// CLI entry point: `npm run crawl -- --url https://example.com --user testuser --pass ****`
// Standalone JSON-file mode (no server/DB required) -- writes the Output
// Schema JSON described in the project brief to ./crawl-output/<host>-<timestamp>.json.
// The in-app flow (server/src/routes/crawler.ts) is the persisted, diff-aware,
// curate-before-generate path; this CLI is the "just give me the JSON" path.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runCrawl } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "..", "crawl-output");

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = value;
    }
  }
  return args;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (command !== "run") {
    console.error('Usage: crawl-tool run --url <url> [--user <username>] [--pass <password>] [--max-pages <n>] [--capture-api] [--concurrency <n>]');
    process.exit(1);
  }

  const args = parseArgs(rest);
  if (!args.url) {
    console.error("Error: --url is required.");
    process.exit(1);
  }

  console.log(`Crawling ${args.url} ...`);
  const result = await runCrawl(
    {
      url: args.url,
      username: args.user,
      password: args.pass,
      maxPages: args["max-pages"] ? Number(args["max-pages"]) : 10,
      captureApi: Boolean(args["capture-api"]),
      concurrency: args.concurrency ? Number(args.concurrency) : 2,
      onProgress: (p) => process.stdout.write(`\r  pages=${p.pagesDiscovered} forms=${p.formsDiscovered} scenarios=${p.scenariosDiscovered} current=${p.currentPage}          `),
    },
    () => null // CLI mode: always treated as a first-time crawl (no stored baseline)
  );
  console.log("");

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const host = new URL(/^https?:\/\//i.test(args.url) ? args.url : `https://${args.url}`).hostname;
  const outPath = path.join(OUTPUT_DIR, `${host}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`Done. ${result.pages.length} page(s) crawled. Output written to ${outPath}`);
}

main().catch((err) => {
  console.error("Crawl failed:", err.message);
  process.exit(1);
});
