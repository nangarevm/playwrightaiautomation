import { chromium } from "playwright";

const shots = process.env.SHOT_DIR || ".";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

await page.locator("nav").getByText("Run", { exact: true }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Fast", exact: true }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "3. Execute" }).click();
await page.waitForTimeout(500);

// Click "Run all (N)" to queue a batch
const runAllBtn = page.locator("main button", { hasText: /^Run (all|selected)/ });
await runAllBtn.click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${shots}/stop-01-after-run-all.png` });

const bodyText1 = await page.locator("main").innerText();
console.log("HAS_STOP_BUTTON:", bodyText1.includes("Stop execution"));

// Click Stop execution
const stopBtn = page.getByRole("button", { name: /Stop execution/ });
if (await stopBtn.count() > 0) {
  await stopBtn.click();
  await page.waitForTimeout(1500);
}
await page.screenshot({ path: `${shots}/stop-02-after-stop.png` });

const bodyText2 = await page.locator("main").innerText();
console.log("HAS_STOPPED_STATUS:", bodyText2.includes("stopped"));
console.log("STILL_HAS_STOP_BUTTON:", bodyText2.includes("Stop execution"));

console.log("CONSOLE_ERRORS:", JSON.stringify(errors.slice(0, 20)));
await browser.close();
