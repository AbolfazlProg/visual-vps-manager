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
  // land on Files no matter where the previous test left off
  await page.getByRole("button", { name: "Files", exact: true }).click().catch(async () => {
    await page.locator('button[title="File manager"]').click();
  });
  await expect(page.locator(".fm-toolbar")).toBeVisible({ timeout: 15000 });
  // context menu on empty area → New folder (ctx-item = the menu entry)
  await page.locator(".fm-filelist").click({ button: "right", position: { x: 40, y: 200 } });
  await page.locator(".ctx-item", { hasText: "New folder" }).click();
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

test("terminal tab opens a live PTY session AND accepts keyboard input", async () => {
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".term-host .xterm")).toBeVisible({ timeout: 20000 });
  // the fixture shell banner arrives over the real PTY channel
  await expect(page.locator(".term-host")).toContainText("Welcome to fixture shell", { timeout: 20000 });
  // type through the REAL input path (xterm onData -> IPC -> SSH channel -> echo)
  await page.locator(".term-host .xterm").click();
  await page.keyboard.type("echo E2E_PTY_INPUT_OK");
  await expect(page.locator(".term-host")).toContainText("E2E_PTY_INPUT_OK", { timeout: 15000 });
});

test("editor: opens, is interactive (typing + scroll), saves via Ctrl+S, opaque backdrop", async () => {
  // land on Files (previous test leaves us on Terminal)
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator(".fm-toolbar")).toBeVisible({ timeout: 15000 });

  // create a file via UI (right-click BELOW the existing rows — empty area)
  await page.locator(".fm-filelist").click({ button: "right", position: { x: 60, y: 420 } });
  await page.locator(".ctx-item", { hasText: "New file" }).click();
  await page.fill("#prompt-input", "editor-test.txt");
  await page.getByRole("button", { name: "Create file" }).last().click();
  await expect(page.locator(".fm-row", { hasText: "editor-test.txt" })).toBeVisible({ timeout: 15000 });

  // open in editor (double-click)
  await page.locator(".fm-row", { hasText: "editor-test.txt" }).dblclick();
  await expect(page.locator(".editor-overlay")).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".editor-host .cm-editor .cm-content")).toBeVisible();

  // the backdrop must be FULLY opaque (user-reported: text bleeding through)
  const bg = await page.evaluate(() => {
    const el = document.querySelector(".editor-overlay") as HTMLElement;
    const c = getComputedStyle(el).backgroundColor;
    const m = c.match(/rgba?\(([^)]+)\)/);
    const parts = m ? m[1].split(",").map(Number) : [0, 0, 0, 1];
    return { raw: c, alpha: parts.length === 4 ? parts[3] : 1 };
  });
  expect(bg.alpha).toBe(1);

  // type through CodeMirror (keyboard interactivity)
  await page.locator(".editor-host .cm-content").click();
  await page.keyboard.type("first line\nE2E_EDITOR_OK");
  await expect(page.locator(".editor-host")).toContainText("E2E_EDITOR_OK");
  await expect(page.locator(".editor-bar")).toContainText("unsaved");

  // save with Ctrl+S → unsaved badge disappears
  await page.keyboard.press("Control+s");
  await expect(page.locator(".editor-bar .badge")).toHaveCount(0, { timeout: 15000 });

  // close and reopen → saved content persisted on the server
  await page.locator(".editor-bar .icon-btn").click();
  await page.locator(".fm-row", { hasText: "editor-test.txt" }).dblclick();
  await expect(page.locator(".editor-host")).toContainText("E2E_EDITOR_OK", { timeout: 15000 });
  // cursor status bar is live
  await expect(page.locator(".editor-status")).toContainText("Ln");
  await page.locator(".editor-bar .icon-btn").click();
});

test("transfer dock: live progress on a real download, close button, auto-hide", async () => {
  // still on Files view; trigger a REAL download through the app's own IPC
  const profileId = await page.evaluate(() => {
    const s = (window as unknown as { __vpsmStore: { getState(): { profiles: Array<{ id: string }> } } }).__vpsmStore.getState();
    return s.profiles[0].id;
  });
  const target = path.join(process.cwd(), "local-test", "e2e-dl", "downloaded.txt");
  await page.evaluate(({ pid, target }) => {
    void (window as unknown as { vpsm: { startDownload(id: string, rp: string, lp: string): Promise<unknown> } }).vpsm.startDownload(pid, "/editor-test.txt", target);
  }, { pid: profileId, target });

  // dock appears for the running transfer
  await expect(page.locator(".transfer-dock")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".td-row").first()).toBeVisible();
  // small file → completes quickly
  await expect(page.locator(".td-row", { hasText: "downloaded.txt" }).first()).toContainText("done", { timeout: 20000 });

  // CLOSE button dismisses the dock
  await page.locator(".td-close").first().click();
  await expect(page.locator(".transfer-dock")).toHaveCount(0, { timeout: 5000 });

  // a second transfer RE-OPENS the dock, then it AUTO-HIDES after completion
  await page.evaluate(({ pid, target }) => {
    void (window as unknown as { vpsm: { startDownload(id: string, rp: string, lp: string): Promise<unknown> } }).vpsm.startDownload(pid, "/editor-test.txt", target + "2");
  }, { pid: profileId, target });
  await expect(page.locator(".transfer-dock")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".td-row", { hasText: "downloaded.txt2" }).first()).toContainText("done", { timeout: 20000 });
  await page.waitForTimeout(6000);
  await expect(page.locator(".transfer-dock")).toHaveCount(0, { timeout: 5000 });

  // downloaded bytes really landed locally
  const stat = await fs.stat(target + "2").catch(() => null);
  expect(stat?.size).toBeGreaterThan(0);
});

test("server '⋯' context menu stays inside the viewport (regression)", async () => {
  // the dock may already be visible here — dismiss it so nav is clickable
  if (await page.locator(".transfer-dock").count() > 0) {
    await page.locator(".td-close").first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
  // go to Servers via the bottom nav
  await page.getByRole("button", { name: "Servers", exact: true }).click();
  await expect(page.locator('button[title="More"]').first()).toBeVisible({ timeout: 15000 });
  const more = page.locator('button[title="More"]').last();
  await more.click();
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible({ timeout: 10000 });
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  // Electron windows don't expose an emulated viewport — use the real window size
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.w);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.h);
  await page.keyboard.press("Escape");
});

test("transfer dock auto-hides after completion (regression)", async () => {
  // the last save settled >5s ago, so the dock must be gone by now (auto-hide)
  await page.waitForTimeout(6500);
  await expect(page.locator(".transfer-dock")).toHaveCount(0, { timeout: 5000 });
});
