/**
 * Monitoring: real-time metrics, services, processes, logs.
 * All parsers live in shared/parsers.ts (unit-tested); this module only
 * fetches raw text over SSH exec and forwards events to the renderer.
 */

import type {
  LogLine,
  MetricsSnapshot,
  ProcessInfo,
  ServiceInfo
} from "../shared/protocol";
import {
  cpuBusyPercent,
  parseDf,
  parseMemInfo,
  parseNetDev,
  parseProcStatCpus,
  parsePs,
  parseSystemctlUnits,
  parseUptimeSeconds
} from "../shared/parsers";
import { vpsmError } from "../shared/errors";
import type { SshSession } from "./ssh";

const METRICS_CMD = [
  "cat /proc/stat",
  "echo '---SECT---'",
  "cat /proc/meminfo",
  "echo '---SECT---'",
  "cat /proc/loadavg",
  "echo '---SECT---'",
  "cat /proc/uptime",
  "echo '---SECT---'",
  "df -PB1 --output=source,fstype,size,used,avail,pcent,target 2>/dev/null | head -60",
  "echo '---SECT---'",
  "cat /proc/net/dev",
  "echo '---SECT---'",
  "uname -srmo",
  "echo '---SECT---'",
  "(head -n 6 /etc/os-release 2>/dev/null || true)",
  "echo '---SECT---'",
  "grep -m1 'model name' /proc/cpuinfo || grep -m1 'Model' /proc/cpuinfo || true",
  "echo '---SECT---'",
  "grep -c '^processor' /proc/cpuinfo || nproc || true"
].join("; ");

interface CpuPrev { rows: number[] }
interface NetPrev { rx: number; tx: number; at: number }

export class MetricsService {
  private cpuPrev = new Map<string, CpuPrev>();
  private netPrev = new Map<string, NetPrev>();

  invalidate(profileId: string): void {
    this.cpuPrev.delete(profileId);
    this.netPrev.delete(profileId);
  }

  async sample(session: SshSession, profileId: string): Promise<MetricsSnapshot> {
    const r = await session.exec(METRICS_CMD, { timeoutMs: 12000 });
    const sections = r.stdout.split("---SECT---").map((s) => s.trim());
    const [procStat, meminfo, loadavg, uptime, dfOut, netdev, uname, osRelease, cpuModel, coresStr] = sections;

    const cpuRows = parseProcStatCpus(procStat);
    const load = loadavg.split(/\s+/).map(Number);
    const mem = parseMemInfo(meminfo);
    const disks = parseDf(dfOut);
    const netNow = parseNetDev(netdev);
    const upSec = parseUptimeSeconds(uptime || "0");

    // cpu deltas
    const agg = cpuRows[0] ?? [];
    let cpuPercent = 0;
    const prev = this.cpuPrev.get(profileId);
    if (prev && agg.length) {
      cpuPercent = cpuBusyPercent(prev.rows, agg);
    }
    if (agg.length) this.cpuPrev.set(profileId, { rows: agg });
    const cores = parseInt((coresStr || "").trim(), 10) || Math.max(1, cpuRows.length - 1);

    // per-core (between the last two samples of each core row)
    const perCore: number[] = [];
    void perCore;

    // net deltas
    const nPrev = this.netPrev.get(profileId);
    const now = Date.now();
    let rxBps = 0;
    let txBps = 0;
    if (nPrev && now > nPrev.at) {
      const dt = (now - nPrev.at) / 1000;
      rxBps = Math.max(0, (netNow.rx - nPrev.rx) / dt);
      txBps = Math.max(0, (netNow.tx - nPrev.tx) / dt);
    }
    this.netPrev.set(profileId, { rx: netNow.rx, tx: netNow.tx, at: now });

    // uname: "Linux 5.15.0-91-generic x86_64 GNU/Linux"
    const unameParts = uname.split(/\s+/);
    const kernel = unameParts[1] ?? "";
    const arch = unameParts[2] ?? "";

    let os = "Linux";
    let osVersion = "";
    for (const line of (osRelease || "").split("\n")) {
      const m = line.match(/^(PRETTY_NAME|NAME)=(?:"([^"]*)"|(.*)$)/);
      if (m) { os = m[2] ?? m[3] ?? os; break; }
    }
    for (const line of (osRelease || "").split("\n")) {
      const m = line.match(/^VERSION_ID=(?:"([^"]*)"|(.*)$)/);
      if (m) { osVersion = m[1] ?? m[2] ?? ""; break; }
    }

    const model = (cpuModel || "").replace(/^[^:]*:\s*/, "").trim() || "CPU";

    return {
      at: now,
      cpu: {
        percent: Math.round(cpuPercent * 10) / 10,
        cores,
        load1: load[0] || 0, load5: load[1] || 0, load15: load[2] || 0,
        model
      },
      mem,
      disks,
      net: {
        rxBytes: netNow.rx,
        txBytes: netNow.tx,
        rxBps: Math.round(rxBps),
        txBps: Math.round(txBps),
        totalRxBytes: netNow.rx,
        totalTxBytes: netNow.tx
      },
      system: {
        hostname: "",
        os,
        osVersion,
        kernel: kernel ? `${kernel}` : "",
        arch,
        cpuModel: model,
        uptimeSec: upSec,
        cores
      }
    };
  }
}

const UNIT_NAME_RE = /^[A-Za-z0-9@._\\-]+$/;

export class ServicesManager {
  private systemdAvailable = new Map<string, boolean | null>();

  async list(session: SshSession, profileId: string): Promise<ServiceInfo[]> {
    const probe = await session.exec("systemctl --no-pager --no-legend --plain list-units --type=service --all", { timeoutMs: 15000 });
    if (probe.code !== 0 && /not found|command not found|No such file/i.test(probe.stderr + probe.stdout)) {
      this.systemdAvailable.set(profileId, false);
      return await this.listSysV(session);
    }
    this.systemdAvailable.set(profileId, true);
    const units = parseSystemctlUnits(probe.stdout);

    const files = await session.exec("systemctl --no-pager --no-legend list-unit-files --type=service", { timeoutMs: 15000 });
    const enabledMap = new Map<string, boolean>();
    for (const line of files.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[0].endsWith(".service")) {
        enabledMap.set(parts[0], parts[1] === "enabled" || parts[1] === "enabled-runtime");
      }
    }
    for (const u of units) {
      u.enabled = enabledMap.get(u.unit) ?? u.enabled;
    }
    return units;
  }

  private async listSysV(session: SshSession): Promise<ServiceInfo[]> {
    const r = await session.exec("service --status-all 2>&1", { timeoutMs: 20000 });
    const out: ServiceInfo[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^\s*\[\s*([+-?])\s*\]\s*(\S+)/);
      if (!m) continue;
      out.push({
        unit: m[2],
        description: m[2],
        state: m[1] === "+" ? "running" : m[1] === "-" ? "stopped" : "unknown",
        enabled: false
      });
    }
    return out;
  }

  private async hasSystemd(session: SshSession): Promise<boolean> {
    const which = await session.exec("command -v systemctl", { timeoutMs: 5000 });
    return which.code === 0 && which.stdout.trim().length > 0;
  }

  async action(session: SshSession, unit: string, action: "start" | "stop" | "restart"): Promise<{ ok: boolean; output: string }> {
    if (!UNIT_NAME_RE.test(unit)) {
      throw vpsmError("EINVAL_INPUT", `Invalid service name: ${unit}`);
    }
    const useSystemd = await this.hasSystemd(session);
    const raw = useSystemd ? `systemctl ${action} ${unit}` : `service ${unit} ${action}`;
    const r = await session.execSudo(raw);
    return { ok: r.code === 0, output: (r.stderr || r.stdout || (r.code === 0 ? "OK" : "")).slice(0, 2000) };
  }

  async statusOf(session: SshSession, unit: string): Promise<{ active: boolean; detail: string }> {
    if (!UNIT_NAME_RE.test(unit)) throw vpsmError("EINVAL_INPUT", `Invalid unit: ${unit}`);
    const useSystemd = await this.hasSystemd(session);
    const cmd = useSystemd
      ? `systemctl is-active ${unit} 2>&1; systemctl status ${unit} --no-pager -n 5 2>&1`
      : `service ${unit} status 2>&1`;
    const r = await session.exec(cmd, { timeoutMs: 15000 });
    const active = /^active$/m.test(r.stdout.trim());
    return { active, detail: (r.stdout + "\n" + r.stderr).slice(0, 4000) };
  }
}

export class ProcessManager {
  async list(session: SshSession): Promise<ProcessInfo[]> {
    const r = await session.exec("ps -eo pid,user:20,pcpu,pmem,rss,stat,comm --sort=-pcpu", { timeoutMs: 15000 });
    return parsePs(r.stdout);
  }

  async kill(session: SshSession, pid: number, signal = "TERM"): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 1 || pid > 4194304) {
      throw vpsmError("EINVAL_INPUT", `Invalid PID: ${pid}`);
    }
    if (!/^(TERM|KILL|INT|HUP)$/.test(signal)) {
      throw vpsmError("EINVAL_INPUT", `Invalid signal: ${signal}`);
    }
    const own = await session.exec(`kill -${signal} ${pid} 2>&1 && echo VPSM_OK`, { timeoutMs: 10000 });
    if (own.stdout.includes("VPSM_OK")) return;
    if (/Operation not permitted/i.test(own.stdout + own.stderr)) {
      const r = await session.execSudo(`kill -${signal} ${pid}`);
      if (r.code !== 0) throw vpsmError("EREMOTE", `kill failed: ${r.stderr.slice(0, 300)}`);
      return;
    }
    if (/No such process/i.test(own.stdout + own.stderr)) {
      throw vpsmError("ENOENT", "Process not found (already exited)");
    }
    throw vpsmError("EREMOTE", `kill failed: ${(own.stderr || own.stdout).slice(0, 300)}`);
  }
}

export interface LogStreamHandle {
  id: string;
  stop(): void;
}

export class LogService {
  private streams = new Map<string, { handle: { stop(): void } }>();

  constructor(
    private readonly onData: (id: string, line: LogLine) => void,
    private readonly onClose: (id: string, reason: string) => void
  ) {}

  private static ts(): number {
    return Date.now();
  }

  start(session: SshSession, opts: { mode: "journal" | "file"; unit?: string; filePath?: string; tailLines?: number }): string {
    const id = session.nextId("log");
    const tail = opts.tailLines ?? 200;
    let cmd: string;
    if (opts.mode === "journal") {
      const unit = opts.unit ?? "";
      if (!UNIT_NAME_RE.test(unit)) throw vpsmError("EINVAL_INPUT", `Invalid unit: ${unit}`);
      cmd = `journalctl -u ${unit} -n ${tail} -o short-iso -f --no-pager`;
    } else {
      if (!opts.filePath) throw vpsmError("EINVAL_INPUT", "Missing log file path");
      const p = opts.filePath.replace(/'/g, `'\\''`);
      cmd = `tail -n ${tail} -F -- '${p}'`;
    }

    const handle = session.execStream(cmd, {
      onLine: (line) => this.onData(id, { t: LogService.ts(), source: opts.mode === "journal" ? (opts.unit ?? "journal") : (opts.filePath ?? "file"), line }),
      onClose: (reason) => {
        this.streams.delete(id);
        this.onClose(id, reason);
      }
    });
    this.streams.set(id, { handle });
    return id;
  }

  stop(id: string): void {
    const s = this.streams.get(id);
    if (s) {
      s.handle.stop();
      this.streams.delete(id);
    }
  }

  stopAll(): void {
    for (const s of this.streams.values()) s.handle.stop();
    this.streams.clear();
  }
}
