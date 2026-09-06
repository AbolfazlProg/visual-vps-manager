const { Client } = require("ssh2");
const { readFileSync } = require("node:fs");
const cfg = JSON.parse(readFileSync("local-test/live-vps.json", "utf8"));
const c = new Client();
c.on("ready", () => {
  c.exec("command -v zip; command -v tar; echo EXIT=$?", (err, stream) => {
    if (err) { console.error(err); process.exit(1); }
    let out = "";
    stream.on("data", (d) => (out += d));
    stream.on("close", () => { console.log(out); c.end(); process.exit(0); });
  });
});
c.on("error", (e) => { console.error("ERR", e.message); process.exit(1); });
c.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: 25000, tryKeyboard: true });
c.on("keyboard-interactive", (_n, _i, _l, _p, f) => f([cfg.password]));
