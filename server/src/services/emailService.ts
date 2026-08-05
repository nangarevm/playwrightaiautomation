// Sends the generated Allure report (as a zip attachment) to a user-supplied email
// address. Mirrors how Jira/Azure/Slack integrations are configured in this codebase --
// real transport, no mock -- so a missing SMTP_* env var fails loudly (503) instead of
// pretending to send. See server/.env.example for the variables this reads.

import nodemailer from "nodemailer";
import fs from "fs";

export function isEmailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

export async function sendAllureReportEmail(
  to: string,
  zipPath: string,
  summary?: { total?: number; passed?: number; failed?: number }
): Promise<{ ok: true; messageId: string }> {
  if (!isEmailConfigured()) {
    throw new Error("Email is not configured -- set SMTP_HOST, SMTP_USER, and SMTP_PASS on the server (see server/.env.example).");
  }
  if (!fs.existsSync(zipPath)) {
    throw new Error("Allure report zip not found -- generate the report before sending it.");
  }

  const transport = getTransport();
  const summaryLine = summary
    ? `Runs: ${summary.total ?? "?"} total, ${summary.passed ?? "?"} passed, ${summary.failed ?? "?"} failed.`
    : "";

  const info = await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Allure test report",
    text: `The latest Allure test report is attached.\n${summaryLine}`,
    attachments: [{ filename: "allure-report.zip", path: zipPath }],
  });

  return { ok: true, messageId: info.messageId };
}
