// Enhanced visual bug detection service (FEATURE 5)
// Detects visual issues: layout shifts, color changes, text rendering, image failures, etc.
// Supports: Layout shifts, color/contrast changes, spacing, alignment, z-index issues

import { db } from "../db.js";
import { recordBugFinding } from "./bugDetectionService.js";

export interface VisualDifference {
  type: "layout_shift" | "color_change" | "text_rendering" | "image_missing" | "spacing_issue" | "alignment_issue" | "contrast_change" | "z_index_issue" | "overflow_issue";
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  affectedElements?: string[];
  position?: { x: number; y: number; width: number; height: number };
  pixelDifference?: number;
  percentageDiff?: number;
  colorInfo?: { baseline: string; current: string };
  spacingInfo?: { baseline: number; current: number };
}

/**
 * Analyzes pixel differences between two screenshots
 * Returns a list of detected visual issues
 */
export function analyzeVisualDifferences(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
  screenId: string,
  screenName: string
): VisualDifference[] {
  const issues: VisualDifference[] = [];

  try {
    // Compare buffer sizes
    if (baselineBuffer.length === 0 || currentBuffer.length === 0) {
      return issues; // No valid images to compare
    }

    // Calculate pixel difference percentage
    const minLength = Math.min(baselineBuffer.length, currentBuffer.length);
    let differentPixels = 0;

    for (let i = 0; i < minLength; i += 4) {
      // Compare RGBA values
      const r1 = baselineBuffer[i];
      const g1 = baselineBuffer[i + 1];
      const b1 = baselineBuffer[i + 2];
      const a1 = baselineBuffer[i + 3];

      const r2 = currentBuffer[i];
      const g2 = currentBuffer[i + 1];
      const b2 = currentBuffer[i + 2];
      const a2 = currentBuffer[i + 3];

      // Calculate color difference
      const colorDiff = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) + Math.abs(a1 - a2);

      if (colorDiff > 30) {
        // Threshold for detecting pixel change
        differentPixels++;
      }
    }

    const percentageDiff = (differentPixels / (minLength / 4)) * 100;

    // Detect severity based on percentage
    if (percentageDiff > 50) {
      issues.push({
        type: "layout_shift",
        severity: "critical",
        description: `Major layout shift detected: ${Math.round(percentageDiff)}% of pixels differ from baseline`,
        pixelDifference: differentPixels,
        percentageDiff,
      });
    } else if (percentageDiff > 30) {
      issues.push({
        type: "layout_shift",
        severity: "high",
        description: `Significant visual change detected: ${Math.round(percentageDiff)}% of pixels differ`,
        pixelDifference: differentPixels,
        percentageDiff,
      });
    } else if (percentageDiff > 10) {
      issues.push({
        type: "color_change",
        severity: "medium",
        description: `Visual changes detected: ${Math.round(percentageDiff)}% of pixels differ`,
        pixelDifference: differentPixels,
        percentageDiff,
      });
    } else if (percentageDiff > 0.5) {
      issues.push({
        type: "spacing_issue",
        severity: "low",
        description: `Minor visual differences: ${Math.round(percentageDiff * 100) / 100}% of pixels differ`,
        pixelDifference: differentPixels,
        percentageDiff,
      });
    }

    // Size check: if file sizes differ significantly, detect image loading issue
    const sizeDiff = Math.abs(baselineBuffer.length - currentBuffer.length) / baselineBuffer.length;
    if (sizeDiff > 0.3) {
      issues.push({
        type: "image_missing",
        severity: "high",
        description: `Image size differs significantly (${Math.round(sizeDiff * 100)}% different)`,
      });
    }
  } catch (err: any) {
    console.warn(`Visual analysis failed: ${err.message}`);
  }

  return issues;
}

/**
 * Records visual bugs found during execution
 */
export function recordVisualBugs(screenId: string, screenName: string, differences: VisualDifference[]): void {
  for (const diff of differences) {
    recordBugFinding({
      source: "ui_exploratory",
      screenId,
      title: `Visual Issue: ${diff.type}`,
      severity: diff.severity === "critical" ? "critical" : diff.severity === "high" ? "high" : "medium",
      detail: diff.description,
    });
  }
}

/**
 * Detects image loading failures by looking for common patterns
 */
export function detectImageLoadingIssues(htmlContent: string): VisualDifference[] {
  const issues: VisualDifference[] = [];

  // Check for broken image indicators
  const brokenImagePatterns = [
    /alt="[^"]*"[^>]*src=""/, // Empty src with alt
    /data:image[/]gif;base64,R0lGODlhAQAB/, // Common 1x1 broken image
    /<img[^>]*>/g, // All img tags
  ];

  // Look for images that might not have loaded
  const imgMatches = htmlContent.match(/<img[^>]*>/g) || [];
  const brokenImages = imgMatches.filter((img) => {
    // Check for placeholder or error src
    return (
      img.includes("placeholder") ||
      img.includes("broken") ||
      img.includes("error") ||
      img.includes("404") ||
      (img.includes('src=""') && img.includes("alt="))
    );
  });

  if (brokenImages.length > 0) {
    issues.push({
      type: "image_missing",
      severity: "high",
      description: `${brokenImages.length} broken or missing image(s) detected on page`,
      affectedElements: brokenImages.slice(0, 3),
    });
  }

  return issues;
}

/**
 * Checks for text rendering issues (invisible text, wrong size, etc)
 */
export function detectTextRenderingIssues(
  baselineText: string,
  currentText: string
): VisualDifference[] {
  const issues: VisualDifference[] = [];

  // If text content differs significantly
  const baselineWords = baselineText.split(/\s+/).length;
  const currentWords = currentText.split(/\s+/).length;

  if (baselineWords > 10 && currentWords === 0) {
    issues.push({
      type: "text_rendering",
      severity: "critical",
      description: "All text content disappeared - possible rendering issue",
    });
  } else if (Math.abs(baselineWords - currentWords) > baselineWords * 0.5) {
    issues.push({
      type: "text_rendering",
      severity: "high",
      description: `Significant text content change: ${baselineWords} words → ${currentWords} words`,
    });
  }

  return issues;
}

/**
 * Detects spacing and alignment issues
 */
export function detectSpacingIssues(elementCount: number, prevElementCount: number): VisualDifference[] {
  const issues: VisualDifference[] = [];

  if (elementCount > prevElementCount * 1.5) {
    issues.push({
      type: "spacing_issue",
      severity: "medium",
      description: "Excessive spacing or element duplication detected",
    });
  } else if (elementCount < prevElementCount * 0.5) {
    issues.push({
      type: "alignment_issue",
      severity: "medium",
      description: "Missing or collapsed layout elements detected",
    });
  }

  return issues;
}

/**
 * FEATURE 5 ENHANCEMENT: Detects color/contrast changes between screenshots
 */
export function detectColorChanges(
  baselineBuffer: Buffer,
  currentBuffer: Buffer
): VisualDifference[] {
  const issues: VisualDifference[] = [];
  
  try {
    if (baselineBuffer.length === 0 || currentBuffer.length === 0) return issues;

    // Sample pixels to detect color changes
    let colorDifferences = 0;
    let maxColorDiff = 0;
    const sampleRate = 100; // Check every 100th pixel for performance

    for (let i = 0; i < baselineBuffer.length; i += 4 * sampleRate) {
      const r1 = baselineBuffer[i] || 0;
      const g1 = baselineBuffer[i + 1] || 0;
      const b1 = baselineBuffer[i + 2] || 0;

      const r2 = currentBuffer[i] || 0;
      const g2 = currentBuffer[i + 1] || 0;
      const b2 = currentBuffer[i + 2] || 0;

      // Calculate color distance (RGB difference)
      const distance = Math.sqrt(
        Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2)
      );

      if (distance > 50) {
        colorDifferences++;
        maxColorDiff = Math.max(maxColorDiff, distance);
      }
    }

    const colorChangePercent = (colorDifferences / (baselineBuffer.length / (4 * sampleRate))) * 100;

    if (colorChangePercent > 20) {
      issues.push({
        type: "color_change",
        severity: colorChangePercent > 50 ? "high" : "medium",
        description: `Color/styling changes detected: ${Math.round(colorChangePercent)}% of sampled pixels differ in color`,
        percentageDiff: colorChangePercent,
        colorInfo: { baseline: "various", current: "changed" },
      });
    }
  } catch (err: any) {
    console.warn(`Color detection failed: ${err.message}`);
  }

  return issues;
}

/**
 * FEATURE 5 ENHANCEMENT: Detects contrast/accessibility issues
 */
export function detectContrastIssues(htmlContent: string): VisualDifference[] {
  const issues: VisualDifference[] = [];

  try {
    // Check for low contrast patterns
    const lowContrastStyles = [
      /color:\s*#[a-fA-F0-9]{6}.*background[^;]*#[a-fA-F0-9]{6}/gi,
      /opacity:\s*0\.[0-4]/gi, // Very transparent elements
    ];

    let lowContrastMatches = 0;
    for (const pattern of lowContrastStyles) {
      const matches = htmlContent.match(pattern) || [];
      lowContrastMatches += matches.length;
    }

    if (lowContrastMatches > 0) {
      issues.push({
        type: "contrast_change",
        severity: "medium",
        description: `Potential low contrast issues detected: ${lowContrastMatches} elements may have poor readability`,
        affectedElements: [`${lowContrastMatches} elements`],
      });
    }
  } catch (err: any) {
    console.warn(`Contrast detection failed: ${err.message}`);
  }

  return issues;
}

/**
 * FEATURE 5 ENHANCEMENT: Detects z-index/layering issues
 */
export function detectLayeringIssues(htmlContent: string): VisualDifference[] {
  const issues: VisualDifference[] = [];

  try {
    // Check for z-index problems (negative values, very high values)
    const zIndexMatches = htmlContent.match(/z-index:\s*(-?\d+)/gi) || [];
    const zIndexValues: number[] = [];

    for (const match of zIndexMatches) {
      const value = parseInt(match.match(/-?\d+/)?.[0] || "0");
      zIndexValues.push(value);
    }

    if (zIndexValues.length > 0) {
      const negativeZIndex = zIndexValues.filter((z) => z < 0).length;
      const veryHighZIndex = zIndexValues.filter((z) => z > 10000).length;

      if (negativeZIndex > 3 || veryHighZIndex > 2) {
        issues.push({
          type: "z_index_issue",
          severity: "medium",
          description: `Potential z-index layering issues: ${negativeZIndex} negative, ${veryHighZIndex} very high values found`,
          affectedElements: zIndexValues.map((z) => `z-index: ${z}`).slice(0, 3),
        });
      }
    }
  } catch (err: any) {
    console.warn(`Layering detection failed: ${err.message}`);
  }

  return issues;
}

/**
 * FEATURE 5 ENHANCEMENT: Detects overflow/clipping issues
 */
export function detectOverflowIssues(htmlContent: string): VisualDifference[] {
  const issues: VisualDifference[] = [];

  try {
    // Check for hidden overflow that might hide content
    const overflowHiddenMatches = htmlContent.match(/overflow:\s*(hidden|scroll|clip)/gi) || [];
    const maxWidthMatches = htmlContent.match(/max-width:\s*\d+px/gi) || [];
    const maxHeightMatches = htmlContent.match(/max-height:\s*\d+px/gi) || [];

    if (overflowHiddenMatches.length > 5) {
      issues.push({
        type: "overflow_issue",
        severity: "low",
        description: `Multiple overflow:hidden declarations found (${overflowHiddenMatches.length}). May be hiding content.`,
        affectedElements: [`${overflowHiddenMatches.length} elements with overflow:hidden`],
      });
    }

    if ((maxWidthMatches.length > 0 || maxHeightMatches.length > 0) && overflowHiddenMatches.length > 0) {
      issues.push({
        type: "overflow_issue",
        severity: "low",
        description: `Content may be clipped with ${maxWidthMatches.length} max-width and ${maxHeightMatches.length} max-height constraints`,
      });
    }
  } catch (err: any) {
    console.warn(`Overflow detection failed: ${err.message}`);
  }

  return issues;
}

/**
 * FEATURE 5 ENHANCEMENT: Comprehensive visual analysis combining all checks
 */
export function analyzeComprehensiveVisualIssues(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
  htmlContent: string,
  screenName: string
): VisualDifference[] {
  const allIssues: VisualDifference[] = [];

  // Run all detection methods
  allIssues.push(...analyzeVisualDifferences(baselineBuffer, currentBuffer, "screen", screenName));
  allIssues.push(...detectColorChanges(baselineBuffer, currentBuffer));
  allIssues.push(...detectContrastIssues(htmlContent));
  allIssues.push(...detectLayeringIssues(htmlContent));
  allIssues.push(...detectOverflowIssues(htmlContent));
  allIssues.push(...detectImageLoadingIssues(htmlContent));
  allIssues.push(...detectTextRenderingIssues(htmlContent, htmlContent));

  // Remove duplicates and sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const uniqueIssues = Array.from(
    new Map(allIssues.map((issue) => [issue.type + issue.description, issue])).values()
  ).sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return uniqueIssues;
}
