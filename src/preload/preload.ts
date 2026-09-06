/**
 * Preload: exposes a minimal, typed, whitelisted API to the sandboxed renderer.
 * No Node primitives, no IPC shell, no remote module — only the VPSM surface.
 */

import { contextBridge, ipcRenderer } from "electron";

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api = {
  /* profiles */
  listProfiles: () => invoke("profiles:list"),
  saveProfile: (input: unknown) => invoke("profiles:save", input),
  deleteProfile: (id: string) => invoke("profiles:delete", id),
  duplicateProfile: (id: string) => invoke("profiles:duplicate", id),

  /* connection */
  connect: (id: string, opts?: { acceptHostKey?: boolean }) => invoke("conn:connect", id, opts),
  disconnect: (id: string) => invoke("conn:disconnect", id),
  getState: (id: string) => invoke("conn:state", id),
  getHostKey: (id: string) => invoke("hostkey:get", id),

  /* fs */
  listDir: (id: string, dir: string) => invoke("fs:list", id, dir),
  homeDir: (id: string) => invoke("fs:home", id),
  stat: (id: string, p: string) => invoke("fs:stat", id, p),
  runOperation: (id: string, op: unknown) => invoke("fs:operation", id, op),
  sizeOf: (id: string, paths: string[]) => invoke("fs:sizeOf", id, paths),
  search: (id: string, baseDir: string, query: string, opts: { maxDepth: number; maxResults: number }) =>
    invoke("fs:search", id, baseDir, query, opts),
  readFile: (id: string, p: string) => invoke("fs:readFile", id, p),

  /* transfers */
  startUpload: (id: string, localPath: string, remoteDir: string, overwrite: boolean) =>
    invoke("transfers:upload", id, localPath, remoteDir, overwrite),
  startDownload: (id: string, remotePath: string, localPath: string) =>
    invoke("transfers:download", id, remotePath, localPath),
  listTransfers: (profileId: string) => invoke("transfers:list", profileId),
  cancelTransfer: (transferId: string) => invoke("transfers:cancel", transferId),
  resumeTransfer: (transferId: string) => invoke("transfers:resume", transferId),
  pickLocalFile: (mode: "open" | "save", defaultName?: string) => invoke("dialog:pickFile", mode, defaultName),

  /* metrics */
  getMetrics: (id: string) => invoke("metrics:get", id),

  /* services / processes */
  listServices: (id: string) => invoke("services:list", id),
  serviceAction: (id: string, unit: string, action: "start" | "stop" | "restart") =>
    invoke("services:action", id, unit, action),
  listProcesses: (id: string) => invoke("processes:list", id),
  killProcess: (id: string, pid: number, signal?: string) => invoke("processes:kill", id, pid, signal),

  /* logs */
  startLogStream: (id: string, opts: { mode: "journal" | "file"; unit?: string; filePath?: string }) =>
    invoke("logs:start", id, opts),
  stopLogStream: (streamId: string) => invoke("logs:stop", streamId),

  /* terminal */
  openTerminal: (id: string, size: { cols: number; rows: number }) => invoke("terminal:open", id, size),
  terminalInput: (termId: string, data: string) => invoke("terminal:input", termId, data),
  resizeTerminal: (termId: string, size: { cols: number; rows: number }) => invoke("terminal:resize", termId, size),
  closeTerminal: (termId: string) => invoke("terminal:close", termId),

  /* sudo */
  verifySudo: (id: string, password: string) => invoke("sudo:verify", id, password),
  forgetSudo: (id: string) => invoke("sudo:forget", id),
  systemPower: (id: string, action: "reboot" | "poweroff") => invoke("system:power", id, action),

  /* trash / activity */
  listTrash: (profileId: string) => invoke("trash:list", profileId),
  emptyTrash: (profileId: string) => invoke("trash:empty", profileId),
  listActivity: (profileId: string) => invoke("activity:list", profileId),
  clearActivity: () => invoke("activity:clear"),

  /* app */
  appInfo: () => invoke("app:info"),

  /* push events (main → renderer) */
  onEvent: (handler: (ev: unknown) => void) => {
    const listener = (_e: unknown, ev: unknown) => handler(ev);
    ipcRenderer.on("vpsm:event", listener);
    return () => ipcRenderer.removeListener("vpsm:event", listener);
  }
} as const;

export type VpsmPreloadApi = typeof api;

contextBridge.exposeInMainWorld("vpsm", api);
