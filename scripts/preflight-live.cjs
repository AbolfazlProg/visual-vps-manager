/* Read-only preflight against the real VPS (no mutations). */
const { Client } = require("ssh2");
const { readFileSync } = require("node:fs");

const cfg = JSON.parse(readFileSync("local-test/live-vps.json", "utf8"));
const client = new Client();
const t0 = Date.now();
client.on("ready", () => {
  console.log(`connected in ${Date.now() - t0}ms`);
  client.exec("uname -a && cat /etc/os-release | head -2 && uptime && df -h / | tail -1 && echo SHELL=$SHELL", (err, stream) => {
    if (err) { console.error("exec err", err); process.exit(1); }
    let out = "", errOut = "";
    stream.on("data", (d) => (out += d));
    stream.stderr.on("data", (d) => (errOut += d));
    stream.on("close", (code) => {
      console.log(out);
      if (errOut) console.log("[stderr]", errOut);
      console.log("[exit]", code);
      client.end();
      const fingerprintNote = "host key accepted implicitly by preflight only — app itself uses TOFU pinning";
      console.log(fingerprintNote);
      process.exit(0);
    });
  });
});
client.on("error", (e) => { console.error("CONNECT ERROR:", e.message); process.exit(1); });
client.connect({
  host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password,
  readyTimeout: 25000, tryKeyboard: true, keepaliveInterval: 15000
});
client.on("keyboard-interactive", (_n, _i, _l, _p, finish) => finish([cfg.password]));
