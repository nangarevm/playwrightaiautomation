import Crawler from "../Crawler.js";

// Ultrafast Mode: crawl a site → generate tests → run → report, with no intermediate checkpoints.
// Fast Mode keeps the step-by-step pipeline in Run.tsx instead.
export function UltrafastRunner() {
  return <Crawler />;
}
