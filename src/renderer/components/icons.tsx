import React from "react";
import {
  Folder, FolderOpen, File, FileText, FileCode2, FileJson, FileImage, FileVideo,
  FileAudio, FileArchive, FileTerminal, FileSymlink, Terminal, Settings, Server,
  Gauge, FolderTree, AlertTriangle, ShieldCheck, KeyRound, Activity,
  Trash2, Plus, Copy, Pencil, MoreVertical, RefreshCw, ChevronRight, ChevronUp, ChevronDown, ArrowUp,
  Home, ArrowLeft, ArrowRight, Search, Upload, Download, Scissors, ClipboardPaste,
  Info, Check, Eye, EyeOff, Play, Square, RotateCw, RotateCcw, HardDrive, Cpu,
  MemoryStick, Wifi, Clock, Lock, Save, ListTree, Power, X as XIcon
} from "lucide-react";

export {
  Folder, FolderOpen, File, FileText, FileCode2, FileJson, FileImage, FileVideo,
  FileAudio, FileArchive, FileTerminal, FileSymlink, Terminal, Settings, Server,
  Gauge, FolderTree, AlertTriangle, ShieldCheck, KeyRound, Activity,
  Trash2 as TrashIcon2, Plus as PlusIcon, Copy as CopyIcon, Pencil as EditIcon,
  MoreVertical as MoreIcon, RefreshCw, ChevronRight, ChevronUp, ChevronDown, ArrowUp, Home, ArrowLeft,
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

const EXT_ICONS: Record<string, { cls: FtxClass }> = {
  // web & programming
  js: { cls: "js" }, mjs: { cls: "js" }, cjs: { cls: "js" }, jsx: { cls: "js" },
  ts: { cls: "ts" }, tsx: { cls: "ts" }, mts: { cls: "ts" }, cts: { cls: "ts" },
  py: { cls: "python" }, pyw: { cls: "python" }, pyi: { cls: "python" }, pyx: { cls: "python" },
  php: { cls: "php" }, php3: { cls: "php" }, php4: { cls: "php" }, phtml: { cls: "php" },
  html: { cls: "html" }, htm: { cls: "html" }, xhtml: { cls: "html" }, vue: { cls: "html" }, svelte: { cls: "html" },
  css: { cls: "css" }, scss: { cls: "css" }, sass: { cls: "css" }, less: { cls: "css" }, styl: { cls: "css" },
  json: { cls: "json" }, jsonc: { cls: "json" }, json5: { cls: "json" }, webmanifest: { cls: "json" },
  yml: { cls: "yaml" }, yaml: { cls: "yaml" }, toml: { cls: "yaml" }, plist: { cls: "yaml" },
  xml: { cls: "xml" }, xsl: { cls: "xml" }, xslt: { cls: "xml" }, dtd: { cls: "xml" }, rss: { cls: "xml" }, atom: { cls: "xml" }, wsdl: { cls: "xml" },
  rb: { cls: "js" }, erb: { cls: "html" }, gemspec: { cls: "js" },
  go: { cls: "ts" }, rs: { cls: "ts" }, swift: { cls: "ts" }, kt: { cls: "ts" }, kts: { cls: "ts" },
  java: { cls: "ts" }, jar: { cls: "exe" }, class: { cls: "exe" }, scala: { cls: "ts" }, gradle: { cls: "ts" },
  c: { cls: "ts" }, h: { cls: "ts" }, cpp: { cls: "ts" }, cc: { cls: "ts" }, cxx: { cls: "ts" }, hpp: { cls: "ts" }, hh: { cls: "ts" },
  cs: { cls: "ts" }, csproj: { cls: "ts" }, sln: { cls: "ts" }, fs: { cls: "ts" }, vb: { cls: "ts" },
  m: { cls: "ts" }, mm: { cls: "ts" }, dart: { cls: "ts" }, lua: { cls: "ts" }, pl: { cls: "python" }, pm: { cls: "python" },
  r: { cls: "python" }, jl: { cls: "python" }, ex: { cls: "ts" }, exs: { cls: "ts" }, erl: { cls: "ts" }, hrl: { cls: "ts" },
  hs: { cls: "ts" }, ml: { cls: "ts" }, mli: { cls: "ts" }, zig: { cls: "ts" }, nim: { cls: "ts" }, v: { cls: "ts" },
  asm: { cls: "ts" }, s: { cls: "ts" }, sol: { cls: "ts" }, astro: { cls: "html" }, prisma: { cls: "yaml" },
  graphql: { cls: "yaml" }, gql: { cls: "yaml" }, proto: { cls: "yaml" },
  // shell & config
  sh: { cls: "bash" }, bash: { cls: "bash" }, zsh: { cls: "bash" }, fish: { cls: "bash" }, ksh: { cls: "bash" }, command: { cls: "bash" },
  bat: { cls: "bash" }, cmd: { cls: "bash" }, ps1: { cls: "bash" }, psm1: { cls: "bash" },
  conf: { cls: "config" }, cfg: { cls: "config" }, ini: { cls: "config" }, env: { cls: "config" },
  properties: { cls: "config" }, editorconfig: { cls: "config" }, gitconfig: { cls: "config" }, reg: { cls: "config" },
  service: { cls: "config" }, socket: { cls: "config" }, timer: { cls: "config" }, desktop: { cls: "config" },
  list: { cls: "config" }, sources: { cls: "config" },
  // documents & data
  txt: { cls: "doc" }, text: { cls: "doc" }, doc: { cls: "doc" }, docx: { cls: "doc" }, odt: { cls: "doc" }, rtf: { cls: "doc" },
  pages: { cls: "doc" }, wpd: { cls: "doc" }, abw: { cls: "doc" },
  xls: { cls: "csv" }, xlsx: { cls: "csv" }, ods: { cls: "csv" }, numbers: { cls: "csv" },
  ppt: { cls: "doc" }, pptx: { cls: "doc" }, odp: { cls: "doc" }, key: { cls: "doc" }, keynote: { cls: "doc" },
  md: { cls: "markdown" }, markdown: { cls: "markdown" }, mdown: { cls: "markdown" }, rst: { cls: "markdown" }, adoc: { cls: "markdown" }, org: { cls: "markdown" }, tex: { cls: "markdown" },
  csv: { cls: "csv" }, tsv: { cls: "csv" }, psv: { cls: "csv" }, parquet: { cls: "csv" },
  pdf: { cls: "pdf" }, ps: { cls: "pdf" }, eps: { cls: "pdf" }, ai: { cls: "pdf" }, djvu: { cls: "pdf" },
  sql: { cls: "sql" }, sqlite: { cls: "sql" }, db: { cls: "sql" }, db3: { cls: "sql" }, dump: { cls: "sql" },
  // images
  png: { cls: "image" }, jpg: { cls: "image" }, jpeg: { cls: "image" }, gif: { cls: "image" }, webp: { cls: "image" },
  bmp: { cls: "image" }, ico: { cls: "image" }, avif: { cls: "image" }, tiff: { cls: "image" }, tif: { cls: "image" },
  svgz: { cls: "image" }, heic: { cls: "image" }, heif: { cls: "image" }, raw: { cls: "image" }, cr2: { cls: "image" }, nef: { cls: "image" },
  psd: { cls: "image" }, xcf: { cls: "image" }, sketch: { cls: "image" }, fig: { cls: "image" }, exr: { cls: "image" },
  // video
  mp4: { cls: "video" }, mkv: { cls: "video" }, avi: { cls: "video" }, mov: { cls: "video" }, webm: { cls: "video" },
  wmv: { cls: "video" }, flv: { cls: "video" }, m4v: { cls: "video" }, mpg: { cls: "video" }, mpeg: { cls: "video" },
  "3gp": { cls: "video" }, ogv: { cls: "video" }, mpg2: { cls: "video" }, vob: { cls: "video" }, m2ts: { cls: "video" }, wrf: { cls: "video" }, "264": { cls: "video" }, h264: { cls: "video" }, hevc: { cls: "video" }, f4v: { cls: "video" }, roq: { cls: "video" }, mxf: { cls: "video" }, roq2: { cls: "video" }, mng: { cls: "video" }, "ts-video": { cls: "video" },
  // audio
  mp3: { cls: "audio" }, wav: { cls: "audio" }, ogg: { cls: "audio" }, flac: { cls: "audio" }, m4a: { cls: "audio" },
  aac: { cls: "audio" }, wma: { cls: "audio" }, opus: { cls: "audio" }, aiff: { cls: "audio" }, mid: { cls: "audio" }, midi: { cls: "audio" },
  // archives & disk
  zip: { cls: "archive" }, tar: { cls: "archive" }, gz: { cls: "archive" }, bz2: { cls: "archive" }, xz: { cls: "archive" },
  "7z": { cls: "archive" }, rar: { cls: "archive" }, tgz: { cls: "archive" }, tbz2: { cls: "archive" }, txz: { cls: "archive" },
  zst: { cls: "archive" }, lz4: { cls: "archive" }, lzma: { cls: "archive" }, br: { cls: "archive" }, deb: { cls: "archive" },
  rpm: { cls: "archive" }, apk: { cls: "archive" }, pkg: { cls: "archive" }, snap: { cls: "archive" }, cab: { cls: "archive" },
  iso: { cls: "iso" }, img: { cls: "iso" }, dmg: { cls: "iso" }, vhd: { cls: "iso" }, vmdk: { cls: "iso" }, qcow2: { cls: "iso" }, squashfs: { cls: "iso" },
  // executables & libs
  exe: { cls: "exe" }, msi: { cls: "exe" }, bin: { cls: "exe" }, out: { cls: "exe" }, appimage: { cls: "exe" },
  run: { cls: "exe" }, com: { cls: "exe" }, elf: { cls: "exe" }, so: { cls: "exe" }, dylib: { cls: "exe" }, dll: { cls: "exe" }, o: { cls: "exe" }, a: { cls: "exe" },
  // fonts
  ttf: { cls: "font" }, otf: { cls: "font" }, woff: { cls: "font" }, woff2: { cls: "font" }, eot: { cls: "font" }, fon: { cls: "font" },
  // logs
  log: { cls: "log" }, logs: { cls: "log" }, journal: { cls: "log" }, xzlog: { cls: "log" }
};

const NAME_ICONS: Array<[RegExp, FtxClass]> = [
  [/^\.?gitignore$|^\.git$|^\.gitmodules$|^\.gitattributes$/i, "git"],
  [/^dockerfile($|\.)|^\.dockerignore$/i, "docker"],
  [/^docker-compose/i, "docker"],
  [/^makefile$|^cmakelists\.txt$|^\.mk$$/i, "config"],
  [/^\.env/i, "config"],
  [/^\.htaccess$|^\.htpasswd$/i, "config"],
  [/^nginx\.conf$|^httpd\.conf$|^\.cnf$/i, "config"],
  [/^license$|^licence$|^copying$|^notice$/i, "doc"],
  [/^readme$|^changelog$|^authors$|^contributors$/i, "doc"],
  [/^\.ssh|^id_rsa|^id_ed25519|^id_ecdsa|^authorized_keys|^known_hosts|\.pem$|\.key$|\.pub$|\.crt$|\.cer$|\.pfx$|\.p12$/i, "lock"],
  [/^\.npmrc$|^\.yarnrc|^package-lock\.json$|^yarn\.lock$|^pnpm-lock\.yaml$|^composer\.lock$/i, "lock"],
  [/^vagrantfile$|^procfile$/i, "config"],
  [/^\.bashrc$|^\.zshrc$|^\.profile$|^\.bash_profile$/i, "bash"]
];

export function classifyFileType(name: string, isDir: boolean): { cls: FtxClass; icon: React.ReactNode } {
  const lower = name.toLowerCase();
  if (isDir) return { cls: "folder", icon: <Folder size={19} /> };
  for (const [re, cls] of NAME_ICONS) {
    if (re.test(lower)) {
      return { cls, icon: iconFor(cls) };
    }
  }
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const hit = EXT_ICONS[ext];
  if (hit) return { cls: hit.cls, icon: iconFor(hit.cls) };
  return { cls: "config", icon: <File size={19} /> };
}

function iconFor(cls: FtxClass): React.ReactNode {
  switch (cls) {
    case "js": return <FileCode2 size={19} />;
    case "ts": return <FileCode2 size={19} />;
    case "python": return <FileCode2 size={19} />;
    case "php": return <FileCode2 size={19} />;
    case "html": return <FileCode2 size={19} />;
    case "css": return <FileCode2 size={19} />;
    case "json": return <FileJson size={19} />;
    case "yaml": case "xml": return <FileText size={19} />;
    case "image": return <FileImage size={19} />;
    case "video": return <FileVideo size={19} />;
    case "audio": return <FileAudio size={19} />;
    case "archive": return <FileArchive size={19} />;
    case "iso": return <FileArchive size={19} />;
    case "exe": return <FileTerminal size={19} />;
    case "bash": return <FileTerminal size={19} />;
    case "log": return <FileText size={19} />;
    case "config": return <FileText size={19} />;
    case "doc": return <FileText size={19} />;
    case "markdown": return <FileText size={19} />;
    case "sql": return <FileText size={19} />;
    case "csv": return <FileText size={19} />;
    case "font": return <FileText size={19} />;
    case "pdf": return <FileText size={19} />;
    case "docker": return <FileText size={19} />;
    case "git": return <FileText size={19} />;
    case "lock": return <File size={19} />;
    default: return <File size={19} />;
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
