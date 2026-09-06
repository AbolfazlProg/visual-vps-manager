/**
 * Parsers for /proc and command output. Pure functions → trivially unit-testable.
 * The main-process metrics service only feeds raw strings here.
 */

import type { DiskSample, MemSample, ProcessInfo, ServiceInfo, ServiceState } from "./protocol";

export function parseUptimeSeconds(uptimeStr: string): number {
  const v = parseFloat(uptimeStr.trim().split(/\s+/)[0] ?? "");
  return Number.isFinite(v) ? Math.floor(v) : 0;
}

/** /proc/stat cpu lines → per-core busy ratios between two samples. */
export function cpuBusyPercent(prev: number[], next: number[]): number {
  // each line: user nice system idle iowait irq softirq steal ...
  const take = (r: number[]) => {
    const idle = (r[3] ?? 0) + (r[4] ?? 0);
    const total = r.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const p = take(prev);
  const n = take(next);
  const dTotal = n.total - p.total;
  const dIdle = n.idle - p.idle;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
}

export function parseProcStatCpus(text: string): number[][] {
  const rows: number[][] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length >= 4) rows.push(parts);
  }
  return rows;
}

/** /proc/meminfo (kB values) → MemSample. */
export function parseMemInfo(text: string): MemSample {
  const get = (key: string): number => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1], 10) * 1024 : 0;
  };
  const total = get("MemTotal");
  const available = get("MemAvailable");
  const cached = get("Cached") + get("SReclaimable");
  const used = Math.max(0, total - available);
  const swapTotal = get("SwapTotal");
  const swapFree = get("SwapFree");
  return {
    totalBytes: total,
    availableBytes: available,
    cachedBytes: cached,
    usedBytes: used,
    percent: total > 0 ? Math.min(100, (used / total) * 100) : 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree)
  };
}

/** `df -PB1 --output=source,fstype,size,used,avail,pcent,target` output. */
export function parseDf(text: string): DiskSample[] {
  const disks: DiskSample[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem, fstype, sizeS, usedS, availS, pcentS, ...rest] = parts;
    if (fstype === "tmpfs" || fstype === "devtmpfs" || fstype === "squashfs" || fstype === "overlay") continue;
    if (!filesystem.startsWith("/dev/") && !filesystem.startsWith("nvme") && !filesystem.startsWith("sd") && !filesystem.startsWith("vd") && !filesystem.startsWith("xvd")) continue;
    const total = parseInt(sizeS, 10);
    const used = parseInt(usedS, 10);
    const avail = parseInt(availS, 10);
    const mount = rest.join(" ") || "/";
    if (!Number.isFinite(total) || total === 0) continue;
    disks.push({
      filesystem,
      mount,
      totalBytes: total,
      usedBytes: used,
      freeBytes: avail,
      percent: Math.min(100, (used / (used + avail)) * 100)
    });
    void pcentS;
  }
  return disks;
}

/** `cat /proc/net/dev` → totals. */
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  const lines = text.split("\n");
  for (const line of lines.slice(2)) {
    const [ifc, data] = line.split(":");
    if (!data) continue;
    const name = ifc.trim();
    if (name === "lo" || name.startsWith("veth") || name.startsWith("docker")) continue;
    const cols = data.trim().split(/\s+/).map(Number);
    if (cols.length < 9) continue;
    rx += cols[0] || 0;
    tx += cols[8] || 0;
  }
  return { rx, tx };
}

/** `ps -eo pid,user:20,pcpu,pmem,rss,stat,comm --sort=-pcpu` */
export function parsePs(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  const lines = text.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 7) continue;
    const pid = parseInt(parts[0], 10);
    if (!Number.isFinite(pid)) continue;
    out.push({
      pid,
      user: parts[1],
      cpuPercent: parseFloat(parts[2]) || 0,
      memPercent: parseFloat(parts[3]) || 0,
      rssBytes: (parseInt(parts[4], 10) || 0) * 1024,
      state: parts[5],
      command: parts.slice(6).join(" ")
    });
  }
  return out;
}

/** `systemctl list-units --type=service --all --no-legend --no-pager` + show -p props. */
export function parseSystemctlUnits(text: string): ServiceInfo[] {
  const out: ServiceInfo[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 4) continue;
    const unit = parts[0];
    if (!unit.endsWith(".service")) continue;
    const load = parts[1];
    const active = parts[2];
    const running = parts[3];
    const desc = t.slice(t.indexOf(running) + running.length).trim() || unit;
    let state: ServiceState = "unknown";
    if (active === "active" && running === "running") state = "running";
    else if (active === "active") state = "running";
    else if (active === "failed") state = "failed";
    else if (load === "loaded" && active === "inactive") state = "stopped";
    out.push({ unit, description: desc, state, enabled: true });
  }
  return out;
}

/** Parse `stat -c '%a %U %G %s %Y %F'` style single-line outputs. */
export function parseStatLine(line: string): { perms: string; owner: string; group: string; size: number; mtimeSec: number; type: string } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) return null;
  return {
    perms: parts[0],
    owner: parts[1],
    group: parts[2],
    size: parseInt(parts[3], 10) || 0,
    mtimeSec: parseInt(parts[4], 10) || 0,
    type: parts[5]
  };
}

/** Extract numeric mount info from /proc/mounts for read-only detection (helper). */
export function isMountReadOnly(mountsText: string, mount: string): boolean {
  for (const line of mountsText.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length >= 4 && parts[1] === mount) {
      return parts[3].split(",").includes("ro");
    }
  }
  return false;
}
