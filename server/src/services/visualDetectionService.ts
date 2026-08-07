// Enhanced visual bug detection service
// Detects visual issues: layout shifts, color changes, text rendering, image failures, etc.

import { db } from "../db.js";
import { recordBugFinding } from "./bugDetectionService.js";

export interface VisualDifference {
  type: "layout_shift" | "color_change" | "text_rendering" | "image_missing" | "spacing_issue" | "alignment_issue" | "contrast_change";
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  affectedElements?: string[];
  position?: { x: number; y: number; width: number; height: number };
  pixelDifference?: number;
  percentageDiff?: number;
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
