/* Debug: launch the app, click through add-server, dump console + state. */
import { _electron as electronLauncher } from "playwright";
import { startSshFixture, GOOD_PASSWORD, USERNAME } from "../tests/ssh-fixture";
import { promises as fs } from "node:fs";
import path from "node:path";

(async () => {
  const userData = path.join(process.cwd(), "local-test", "dbg-userdata");
  await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  const root = path.join(process.cwd(), "local-test", "dbg-e2e-root");
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(root, { recursive: true });
  const fixture = await startSshFixture({ simulatedFsRoot: root });
  console.log("fixture port:", fixture.port);

  const app = await electronLauncher.launch({
    args: ["."],
    env: { ...process.env, VPSM_USER_DATA: userData, VPSM_TEST: "1" }
  });
  const page = await app.firstWindow();
  page.on("console", (m) => console.log("[renderer]", m.type(), m.text().slice(0, 300)));
  app.process().stderr?.on("data", (d) => console.log("[main-err]", d.toString().slice(0, 400)));
  app.process().stdout?.on("data", (d) => console.log("[main-out]", d.toString().slice(0, 200)));
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: /Add Server/i }).first().click();
  await page.fill("#srv-name", "Dbg");
  await page.fill("#srv-host", "127.0.0.1");
  await page.fill("#srv-port", String(fixture.port));
  await page.fill("#srv-user", USERNAME);
  await page.fill("#srv-pass", GOOD_PASSWORD);
  await page.getByRole("button", { name: /Save & Connect/i }).click();
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pill = await page.locator(".status-pill").first().textContent().catch(() => "none");
    const dlg = await page.locator(".modal-head h2").allTextContents().catch(() => []);
    console.log(`t=${i * 2}s pill=${pill} dialogs=${JSON.stringify(dlg)}`);
  }
  await app.close().catch(() => {});
  await fixture.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
