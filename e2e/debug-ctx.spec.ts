import { test, expect } from "playwright/test";
import { _electron as electronLauncher } from "playwright";
import { startSshFixture, GOOD_PASSWORD, USERNAME } from "../tests/ssh-fixture";
import { promises as fs } from "node:fs";
import path from "node:path";

let fixture, app, page;
const userData = path.join(process.cwd(), "local-test", "dbg-userdata");

test("debug: ctx menu open/close lifecycle", async () => {
  test.setTimeout(120000);
  await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  const root = path.join(process.cwd(), "local-test", "dbg-e2e-root");
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(root, "e2e-renamed"), { recursive: true });
  fixture = await startSshFixture({ simulatedFsRoot: root });

  app = await electronLauncher.launch({ args: ["."], env: { ...process.env, VPSM_USER_DATA: userData, VPSM_TEST: "1" } });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByRole("button", { name: /Add Server/i }).first().click();
  await page.fill("#srv-name", "Dbg");
  await page.fill("#srv-host", "127.0.0.1");
  await page.fill("#srv-port", String(fixture.port));
  await page.fill("#srv-user", USERNAME);
  await page.fill("#srv-pass", GOOD_PASSWORD);
  await page.getByRole("button", { name: /Save & Connect/i }).click();
  await page.getByRole("button", { name: /Accept & Connect/i }).click({ timeout: 20000 }).catch(() => {});
  await expect(page.locator(".fm-toolbar")).toBeVisible({ timeout: 20000 });

  // watch ctx-menu mount/unmount
  await page.evaluate(() => {
    (window as unknown as { __log: string[] }).__log = [];
    const target = document.body;
    const obs = new MutationObserver(() => {
      const n = document.querySelectorAll(".ctx-menu").length;
      (window as unknown as { __log: string[] }).__log.push(`menus=${n}@${Date.now() % 100000}`);
    });
    obs.observe(target, { childList: true, subtree: true });
  });
  await page.locator(".fm-filelist").click({ button: "right", position: { x: 60, y: 300 } });
  await page.waitForTimeout(300);
  const afterRight = await page.locator(".ctx-menu").count();
  console.log("menus right after right-click:", afterRight);
  // Playwright's click also fires a click afterwards? check quickly
  await page.waitForTimeout(600);
  const log = await page.evaluate(() => (window as unknown as { __log: string[] }).__log);
  console.log("mutation log:", JSON.stringify(log));
  // try keyboard-free: dispatch contextmenu event directly
  await page.evaluate(() => {
    const el = document.querySelector(".fm-filelist") as HTMLElement;
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: el.getBoundingClientRect().left + 60, clientY: el.getBoundingClientRect().top + 300, button: 2 });
    el.dispatchEvent(ev);
  });
  await page.waitForTimeout(300);
  console.log("menus after synthetic event:", await page.locator(".ctx-menu").count());
  await app.close();
  await fixture.close();
});
