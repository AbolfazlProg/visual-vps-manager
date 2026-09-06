import React from "react";
import {
  Folder, FolderOpen, File, FileText, FileCode2, FileJson, FileImage, FileVideo,
  FileAudio, FileArchive, FileTerminal, FileSymlink, Terminal, Settings, Server,
  Gauge, FolderTree, AlertTriangle, ShieldCheck, KeyRound, Activity,
  Trash2, Plus, Copy, Pencil, MoreVertical, RefreshCw, ChevronRight, ArrowUp,
  Home, ArrowLeft, ArrowRight, Search, Upload, Download, Scissors, ClipboardPaste,
  Info, Check, Eye, EyeOff, Play, Square, RotateCw, RotateCcw, HardDrive, Cpu,
  MemoryStick, Wifi, Clock, Lock, Save, ListTree, Power, X as XIcon
} from "lucide-react";

export {
  Folder, FolderOpen, File, FileText, FileCode2, FileJson, FileImage, FileVideo,
  FileAudio, FileArchive, FileTerminal, FileSymlink, Terminal, Settings, Server,
  Gauge, FolderTree, AlertTriangle, ShieldCheck, KeyRound, Activity,
  Trash2 as TrashIcon2, Plus as PlusIcon, Copy as CopyIcon, Pencil as EditIcon,
  MoreVertical as MoreIcon, RefreshCw, ChevronRight, ArrowUp, Home, ArrowLeft,
  ArrowRight, Search, Upload, Download, Scissors, ClipboardPaste, Info, Check,
  Eye, EyeOff, Play, Square, RotateCw, RotateCcw, HardDrive, Cpu, MemoryStick,
  Wifi, Clock, Lock, Save, ListTree, Power, XIcon as X
};

export const ServerIcon = Server;
export const FolderTreeIcon = FolderTree;
export const TerminalIcon = Terminal;
export const GaugeIcon = Gauge;
export const SettingsIcon = Settings;

export function fileSizeStr(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function dateStr(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type FtxClass =
  | "folder" | "folder-open" | "js" | "ts" | "python" | "php" | "html" | "css" | "json"
  | "yaml" | "xml" | "image" | "video" | "audio" | "archive" | "exe" | "log" | "config"
  | "doc" | "markdown" | "sql" | "bash" | "docker" | "git" | "lock" | "iso" | "font" | "pdf" | "csv";

export function classifyFileType(name: string, isDir: boolean): { cls: FtxClass; icon: React.ReactNode } {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (isDir) return { cls: "folder", icon: <Folder size={19} /> };
  switch (ext) {
    case "js": case "mjs": case "cjs": case "jsx": return { cls: "js", icon: <FileCode2 size={19} /> };
    case "ts": case "tsx": case "mts": case "cts": return { cls: "ts", icon: <FileCode2 size={19} /> };
    case "py": case "pyw": return { cls: "python", icon: <FileCode2 size={19} /> };
    case "php": return { cls: "php", icon: <FileCode2 size={19} /> };
    case "html": case "htm": return { cls: "html", icon: <FileCode2 size={19} /> };
    case "css": case "scss": case "sass": case "less": return { cls: "css", icon: <FileCode2 size={19} /> };
    case "json": return { cls: "json", icon: <FileJson size={19} /> };
    case "yml": case "yaml": return { cls: "yaml", icon: <FileText size={19} /> };
    case "xml": case "svg": return { cls: "xml", icon: <FileCode2 size={19} /> };
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "bmp": case "ico": case "avif":
      return { cls: "image", icon: <FileImage size={19} /> };
    case "mp4": case "mkv": case "avi": case "mov": case "webm": return { cls: "video", icon: <FileVideo size={19} /> };
    case "mp3": case "wav": case "ogg": case "flac": return { cls: "audio", icon: <FileAudio size={19} /> };
    case "zip": case "tar": case "gz": case "bz2": case "xz": case "7z": case "rar": case "tgz": case "zst":
      return { cls: "archive", icon: <FileArchive size={19} /> };
    case "sh": case "bash": case "zsh": case "fish": case "command": return { cls: "bash", icon: <FileTerminal size={19} /> };
    case "log": return { cls: "log", icon: <FileText size={19} /> };
    case "conf": case "cfg": case "ini": case "toml": case "env": case "properties": return { cls: "config", icon: <FileText size={19} /> };
    case "doc": case "docx": case "odt": case "rtf": case "txt": return { cls: "doc", icon: <FileText size={19} /> };
    case "md": case "markdown": return { cls: "markdown", icon: <FileText size={19} /> };
    case "sql": return { cls: "sql", icon: <FileText size={19} /> };
    case "exe": case "bin": case "out": case "appimage": case "run": return { cls: "exe", icon: <File size={19} /> };
    case "iso": case "img": return { cls: "iso", icon: <FileArchive size={19} /> };
    case "ttf": case "otf": case "woff": case "woff2": return { cls: "font", icon: <FileText size={19} /> };
    case "pdf": return { cls: "pdf", icon: <FileText size={19} /> };
    case "csv": case "tsv": return { cls: "csv", icon: <FileText size={19} /> };
    case "lock": return { cls: "lock", icon: <File size={19} /> };
    default:
      if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return { cls: "docker", icon: <FileText size={19} /> };
      if (lower.startsWith(".git")) return { cls: "git", icon: <FileText size={19} /> };
      if (lower === "makefile" || lower === "cmakelists.txt") return { cls: "config", icon: <FileText size={19} /> };
      if (lower.endsWith(".pub") || lower === "authorized_keys" || lower === "id_rsa" || lower === "id_ed25519")
        return { cls: "lock", icon: <File size={19} /> };
      return { cls: "config", icon: <File size={19} /> };
  }
}

export function FileTypeIcon({ name, kind }: { name: string; kind: "file" | "directory" | "symlink" }) {
  if (kind === "symlink") {
    return <span className="ftx" style={{ color: "#c084fc" }}><FileSymlink size={19} /></span>;
  }
  const { cls, icon } = classifyFileType(name, kind === "directory");
  return <span className={`ftx ${cls}`}>{icon}</span>;
}

export function AlertIcon({ size = 18 }: { size?: number }) {
  return <AlertTriangle size={size} />;
}

export function ShieldIcon({ size = 18 }: { size?: number }) {
  return <ShieldCheck size={size} />;
}

export function KeyIcon({ size = 18 }: { size?: number }) {
  return <KeyRound size={size} />;
}

export function ActivityIcon({ size = 18 }: { size?: number }) {
  return <Activity size={size} />;
}

export function FolderOpenIcon({ size = 19 }: { size?: number }) {
  return <FolderOpen size={size} />;
}
