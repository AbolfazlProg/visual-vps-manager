import { describe, expect, it } from "vitest";
import {
  cpuBusyPercent,
  parseDf,
  parseMemInfo,
  parseNetDev,
  parseProcStatCpus,
  parsePs,
  parseStatLine,
  parseSystemctlUnits,
  parseUptimeSeconds
} from "./parsers";

const PROC_STAT = `cpu  100 0 50 1000 0 0 0 0 0 0
cpu0 60 0 20 500 0 0 0 0 0 0
cpu1 40 0 30 500 0 0 0 0 0 0
intr 12345
ctxt 999`;

describe("parseProcStatCpus / cpuBusyPercent", () => {
  it("extracts aggregate + per-core rows", () => {
    const rows = parseProcStatCpus(PROC_STAT);
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe(100);
    expect(rows[1][0]).toBe(60);
  });

  it("computes busy percentage between samples", () => {
    const a = [0, 0, 0, 1000, 0, 0, 0];
    const b = [0, 0, 500, 1500, 0, 0, 0]; // Δbusy 500 / Δtotal 1000 → 50%
    expect(cpuBusyPercent(a, b)).toBeCloseTo(50, 5);
    const c = [0, 0, 1500, 1500, 0, 0, 0]; // Δbusy 1000 / Δtotal 1000 → 100%
    expect(cpuBusyPercent(b, c)).toBeCloseTo(100, 5);
    expect(cpuBusyPercent(a, a)).toBe(0);
  });
});

describe("parseMemInfo", () => {
  it("computes used/available/percent", () => {
    const text = `MemTotal:       16384000 kB
MemFree:         2000000 kB
MemAvailable:    8192000 kB
Cached:          4000000 kB
SReclaimable:      50000 kB
SwapTotal:       2097148 kB
SwapFree:        1048574 kB`;
    const m = parseMemInfo(text);
    expect(m.totalBytes).toBe(16384000 * 1024);
    expect(m.availableBytes).toBe(8192000 * 1024);
    expect(m.usedBytes).toBe((16384000 - 8192000) * 1024);
    expect(m.cachedBytes).toBe((4000000 + 50000) * 1024);
    expect(m.percent).toBeCloseTo(50, 5);
    expect(m.swapUsedBytes).toBe((2097148 - 1048574) * 1024);
  });
});

describe("parseDf", () => {
  it("filters pseudo filesystems and parses values", () => {
    const text = `Filesystem 1B-blocks Used Available Use% Mounted on
/dev/vda1 ext4 421544923136 210000000000 211544923136 50% /
tmpfs tmpfs 1050000000 0 1050000000 0% /dev/shm
/dev/vdb1 xfs 105000000000 10500000000 94500000000 11% /data`;
    const disks = parseDf(text);
    expect(disks).toHaveLength(2);
    expect(disks[0].mount).toBe("/");
    expect(disks[0].percent).toBeCloseTo(49.8, 0);
    expect(disks[1].mount).toBe("/data");
  });
});

describe("parseNetDev", () => {
  it("sums interfaces excluding loopback/veth", () => {
    const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 10 0 0 0 0 0 0 100 10 0 0 0 0 0 0
  eth0: 1000 10 0 0 0 0 0 0 2000 10 0 0 0 0 0 0
  eth1: 500 5 0 0 0 0 0 0 800 5 0 0 0 0 0 0
 veth0: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0`;
    const n = parseNetDev(text);
    expect(n.rx).toBe(1500);
    expect(n.tx).toBe(2800);
  });
});

describe("parsePs", () => {
  it("parses rows", () => {
    const text = `  PID USER                 %CPU %MEM    RSS S COMMAND
    1 root                  0.0  0.1   8192 S systemd
 1234 www-data              2.5  4.0  32768 S nginx: worker process`;
    const procs = parsePs(text);
    expect(procs).toHaveLength(2);
    expect(procs[1].pid).toBe(1234);
    expect(procs[1].user).toBe("www-data");
    expect(procs[1].command).toBe("nginx: worker process");
    expect(procs[1].rssBytes).toBe(32768 * 1024);
  });
});

describe("parseSystemctlUnits", () => {
  it("parses unit rows with states", () => {
    const text = `nginx.service    loaded active running  A high performance web server
docker.service   loaded failed failed   Docker Application Container Engine
redis.service    loaded inactive dead     In-memory data store
syslog.service   not-found inactive dead  n/a`;
    const units = parseSystemctlUnits(text);
    expect(units).toHaveLength(4);
    expect(units[0].state).toBe("running");
    expect(units[1].state).toBe("failed");
    expect(units[2].state).toBe("stopped");
    expect(units[0].description).toBe("A high performance web server");
  });
});

describe("parseStatLine / uptime", () => {
  it("parses stat -c output", () => {
    const r = parseStatLine("755 root root 4096 1700000000 regular file");
    expect(r?.perms).toBe("755");
    expect(r?.owner).toBe("root");
    expect(r?.size).toBe(4096);
  });
  it("parses uptime", () => {
    expect(parseUptimeSeconds("12345.67 45678.9")).toBe(12345);
  });
});
