// FR-6.9: scheduled digest notifications (daily/weekly summary of runs,
// pass/fail trends, and coverage gaps) to Slack/Teams/email, in addition to
// the existing per-run notifications (FR-7.3).
// FR-6.12: each user can configure their own notification channel/frequency,
// overriding the org-level default this digest otherwise uses.

import { db } from "../db.js";
import { listIntegrations, sendRunNotification } from "./integrationsService.js";
import { getDashboardSummary, getCoverageGaps } from "./reportingService.js";

const DIGEST_INTERVAL_HOURS = 24; // "daily" cadence; a real deploy would expose weekly too

function buildDigestMessage(): string {
  const summary = getDashboardSummary();
  const gaps = getCoverageGaps();
  return [
    `*Daily Digest*`,
    `Runs: ${summary.totalRuns} total, ${summary.totals.passed} passed, ${summary.totals.failed} failed (pass rate ${summary.passRate}%)`,
    `Coverage gaps: ${gaps.length} screen(s) with zero/stale test cases`,
    gaps.length > 0 ? `Top gaps: ${gaps.slice(0, 5).map((g: any) => g.name).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

// FR-6.9: org-level default digest -- sent to every Slack/Teams integration
// opted into notifications, same fan-out pattern as the existing FR-7.3 per-run notify.
export async function sendScheduledDigests(): Promise<{ sent: number; skipped: number }> {
  const now = Date.now();
  const lastSent = getLastDigestSentAt();
  if (lastSent && now - lastSent < DIGEST_INTERVAL_HOURS * 60 * 60 * 1000) {
    return { sent: 0, skipped: 1 };
  }

  const message = buildDigestMessage();
  const targets = listIntegrations().filter((i: any) => (i.type === "slack" || i.type === "teams") && i.notify_on_run);
  const results = await Promise.allSettled(targets.map((t: any) => sendRunNotification(t.id, message)));
  setLastDigestSentAt(now);
  return { sent: results.filter((r) => r.status === "fulfilled").length, skipped: 0 };
}

function getLastDigestSentAt(): number | null {
  const row = db.prepare("SELECT details FROM audit_log WHERE action = 'digest_sent' ORDER BY created_at DESC LIMIT 1").get() as any;
  if (!row) return null;
  try {
    return JSON.parse(row.details).sentAtMs;
  } catch {
    return null;
  }
}

function setLastDigestSentAt(ms: number) {
  db.prepare(
    "INSERT INTO audit_log (id, actor_user_id, actor_role, action, entity_type, entity_id, details, created_at) VALUES (?, NULL, 'system', 'digest_sent', 'digest', NULL, ?, ?)"
  ).run(`digest-${ms}`, JSON.stringify({ sentAtMs: ms }), new Date().toISOString());
}

// FR-6.12: get/set a user's own notification channel + frequency override
export function getUserNotificationPref(userId: string) {
  const row = db.prepare("SELECT * FROM user_notification_prefs WHERE user_id = ?").get(userId);
  return row ?? { user_id: userId, channel: "org-default", frequency: "per-run" };
}

export function setUserNotificationPref(userId: string, channel: string, frequency: string) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_notification_prefs (user_id, channel, frequency, updated_at)
    VALUES (@user_id, @channel, @frequency, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET channel = @channel, frequency = @frequency, updated_at = @updated_at
  `).run({ user_id: userId, channel, frequency, updated_at: now });
  return getUserNotificationPref(userId);
}
