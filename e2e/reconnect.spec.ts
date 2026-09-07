/**
 * E2E: auto-reconnect — the server hard-drops every connection (simulated
 * network cut); the app must recover to "connected" without user action.
 */
import { test, expect } from "playwright/test";
import { _electron as electronLauncher } from "playwright";
import { startSshFixture, GOOD_PASSWORD, USERNAME } from "../tests/ssh-fixture";
import { promises as fs } from "node:fs";
import path from "node:path";

let fixture, app, page;
const userData = path.join(process.cwd(), "local-test", "reconn-userdata");

test("auto-reconnects when the server hard-drops the connection", async () => {
  test.setTimeout(180000);
  await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  const root = path.join(process.cwd(), "local-test", "reconn-root");
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(root, { recursive: true });
  fixture = await startSshFixture({ simulatedFsRoot: root });

  app = await electronLauncher.launch({ args: ["."], env: { ...process.env, VPSM_USER_DATA: userData, VPSM_TEST: "1" } });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByRole("button", { name: /Add Server/i }).first().click();
  await page.fill("#srv-name", "Reconnect Test");
  await page.fill("#srv-host", "127.0.0.1");
  await page.fill("#srv-port", String(fixture.port));
  await page.fill("#srv-user", USERNAME);
  await page.fill("#srv-pass", GOOD_PASSWORD);
  await page.getByRole("button", { name: /Save & Connect/i }).click();
  await page.getByRole("button", { name: /Accept & Connect/i }).click({ timeout: 20000 }).catch(() => {});
  await expect(page.locator(".fm-toolbar")).toBeVisible({ timeout: 20000 });

  // 💥 hard-cut: destroy every socket on the fixture side (network cut)
  fixture.killConnections();

  // the Files view has no status pill — check the Servers page card state.
  // auto-reconnect with backoff → the app must recover to Connected.
  const check = async (): Promise<boolean> => {
    await page.getByRole("button", { name: "Servers", exact: true }).click().catch(() => {});
    const pill = page.locator(".status-pill", { hasText: "Connected" }).first();
    try {
      await pill.waitFor({ state: "visible", timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  };

  let recovered = false;
  for (let i = 0; i < 6 && !recovered; i++) {
    recovered = await check();
    if (!recovered) await page.waitForTimeout(7000);
  }
  expect(recovered).toBe(true);

  await app.close().catch(() => {});
  await fixture.close().catch(() => {});
});
