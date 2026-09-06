/**
 * E2E: launch the REAL Electron app against the REAL in-process SSH fixture
 * and drive the primary user flows through the actual UI:
 *
 *   Add Server → Save & Connect → accept host key → Files open
 *   → create folder → verify → rename → delete → trash restore
 */

import { test, expect, chromium, type ElectronApplication, type Page } from "playwright/test";
import { _electron as electronLauncher } from "playwright";
import { startSshFixture, GOOD_PASSWORD, USERNAME } from "../tests/ssh-fixture";
import type { FixtureServer } from "../tests/ssh-fixture";
import { promises as fs } from "node:fs";
import path from "node:path";

let fixture: FixtureServer;
let app: ElectronApplication;
let page: Page;
const userData = path.join(process.cwd(), "local-test", "e2e-userdata");

test.beforeAll(async () => {
  await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(process.cwd(), "local-test", "e2e-root"), { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(process.cwd(), "local-test", "e2e-root"), { recursive: true });
  fixture = await startSshFixture({ simulatedFsRoot: path.join(process.cwd(), "local-test", "e2e-root") });

  app = await electronLauncher.launch({
    args: ["."],
    env: {
      ...process.env,
      VPSM_USER_DATA: userData,
      VPSM_TEST: "1",
      ELECTRON_ENABLE_LOGGING: "0"
    }
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await fixture?.close().catch(() => {});
});

test("add server, connect through host-key dialog, land in file manager", async () => {
  await expect(page.locator("h1")).toContainText("My Servers");
  await page.getByRole("button", { name: /Add Server/i }).first().click();

  await page.fill("#srv-name", "E2E Fixture");
  await page.fill("#srv-host", "127.0.0.1");
  await page.fill("#srv-port", String(fixture.port));
  await page.fill("#srv-user", USERNAME);
  await page.fill("#srv-pass", GOOD_PASSWORD);

  await page.getByRole("button", { name: /Save & Connect/i }).click();

  // first handshake is refused (TOFU) → host-key dialog appears
  await expect(page.getByText("Verify server identity")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: /Accept & Connect/i }).click();

  // connected → auto-navigation to Files
  await expect(page.locator(".fm-toolbar")).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".crumb.current").first()).toHaveText("/");
});

test("create folder, rename it, delete to trash and restore", async () => {
  // context menu on empty area → New folder
  await page.locator(".fm-filelist").click({ button: "right", position: { x: 40, y: 200 } });
  await page.getByRole("button", { name: "New folder" }).click();
  await page.fill("#prompt-input", "e2e-folder");
  await page.getByRole("button", { name: "Create folder" }).last().click();
  await expect(page.locator(".fm-row", { hasText: "e2e-folder" })).toBeVisible({ timeout: 15000 });

  // rename
  await page.locator(".fm-row", { hasText: "e2e-folder" }).click({ button: "right" });
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.fill("#prompt-input", "e2e-renamed");
  await page.getByRole("button", { name: "Rename", exact: true }).last().click();
  await expect(page.locator(".fm-row", { hasText: "e2e-renamed" })).toBeVisible({ timeout: 15000 });

  // delete to trash
  await page.locator(".fm-row", { hasText: "e2e-renamed" }).click({ button: "right" });
  await page.getByRole("button", { name: /Delete \(trash\)/i }).click();
  await page.getByRole("button", { name: /Move to trash/i }).click();
  await expect(page.locator(".fm-row", { hasText: "e2e-renamed" })).toHaveCount(0, { timeout: 15000 });

  // undo from the toast-side button
  await page.getByRole("button", { name: /Undo: Delete/i }).click();
  await expect(page.locator(".fm-row", { hasText: "e2e-renamed" })).toBeVisible({ timeout: 15000 });
});

test("terminal tab opens a live PTY session", async () => {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".term-host .xterm")).toBeVisible({ timeout: 20000 });
  // the fixture shell banner arrives over the real PTY channel
  await expect(page.locator(".term-host")).toContainText("Welcome to fixture shell", { timeout: 20000 });
});
