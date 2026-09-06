// Playbook §48 -- Final Report. Every engine built this session answers its
// own narrow question (where's the risk, how healthy is this screen, what
// regressed, what's the coverage gap...) -- nothing until now assembles
// them into the single consolidated document a QA lead or stakeholder
// actually wants at the end of a testing cycle: one comprehensive rollup
// pulling together bug-dashboard totals, coverage, quality, the hottest
// heatmap cells, the highest-risk screens to test next, and any regressions,
// all in one call. Pure aggregation over every other service already built
// -- no new browser automation, no new detection logic, just assembly.
//
// FALSE-POSITIVE RISK: none beyond what each constituent service already
// documents -- this is a read-only rollup and inherits each part's own
// caveats (bugConfidenceService's heuristic scores, testPriorityService's
// naming-convention-based critical-area guess, etc.) rather than adding any
// new ones of its own.

import { getBugDashboard } from "./bugReportingService.js";
import { computeCoverageModel } from "./coverageModelService.js";
import { computeAppWideQualityScore, computeQualityScoresByScreen } from "./qualityScoreService.js";
import { computeBugHeatmap } from "./bugHeatmapService.js";
import { computeTestPriorities } from "./testPriorityService.js";
import { summarizeRegressions, listRegressions } from "./regressionIntelligenceService.js";

export const FINAL_REPORT_CONFIG = {
  // How many rows of each "top N" list to include in the report, so a large
  // app's report stays a readable summary rather than a full data dump --
  // every underlying service's own full list remains available via its own
  // endpoint for anyone who needs the complete picture.
  topScreensCount: 10,
  topHeatmapCellsCount: 10,
};

export interface FinalReport {
  generatedAt: string;
  bugDashboard: ReturnType<typeof getBugDashboard>;
  coverageModel: ReturnType<typeof computeCoverageModel>;
  qualityScore: {
    appWide: ReturnType<typeof computeAppWideQualityScore>;
    worstScreens: ReturnType<typeof computeQualityScoresByScreen>;
  };
  topHeatmapCells: ReturnType<typeof computeBugHeatmap>;
  topPriorityScreens: ReturnType<typeof computeTestPriorities>;
  regressions: {
    summary: ReturnType<typeof summarizeRegressions>;
    recent: ReturnType<typeof listRegressions>;
  };
}

/**
 * Assembles the single consolidated end-of-cycle report: bug dashboard
 * totals, coverage model, app-wide + worst-screen quality scores, the
 * hottest heatmap cells, the highest test-priority screens, and a
 * regression-intelligence summary. Every list is capped to a readable "top
 * N" via FINAL_REPORT_CONFIG -- each constituent service's own endpoint
 * remains the source for the complete, uncapped data.
 */
export function generateFinalReport(): FinalReport {
  return {
    generatedAt: new Date().toISOString(),
    bugDashboard: getBugDashboard(),
    coverageModel: computeCoverageModel(),
    qualityScore: {
      appWide: computeAppWideQualityScore(),
      worstScreens: computeQualityScoresByScreen().slice(0, FINAL_REPORT_CONFIG.topScreensCount),
    },
    topHeatmapCells: computeBugHeatmap().slice(0, FINAL_REPORT_CONFIG.topHeatmapCellsCount),
    topPriorityScreens: computeTestPriorities().slice(0, FINAL_REPORT_CONFIG.topScreensCount),
    regressions: {
      summary: summarizeRegressions(),
      recent: listRegressions().slice(0, FINAL_REPORT_CONFIG.topScreensCount),
    },
  };
}
