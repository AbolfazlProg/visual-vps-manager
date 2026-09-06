/**
 * Local persistence layer.
 *
 * SECURITY:
 * - Secrets live ONLY in `Vault`, encrypted with Electron `safeStorage`
 *   (Windows: DPAPI bound to the user account; macOS: Keychain;
 *   Linux: libsecret / kwallet). Plaintext secrets never touch disk.
 * - If the OS secure store is unavailable we refuse to persist secrets by
 *   default (`allowInsecureFallback=false`) — the UI must ask explicitly.
 * - Host keys are pinned per host:port; changes surface as EHOSTKEY.
 * - Activity log strips secret material defensively.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { CredentialMaterial, HostKeyInfo, ServerProfile, ActivityEntry } from "../shared/protocol";

/** Abstraction over Electron safeStorage so stores are unit-testable. */
export interface SecretEncoder {
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
  isAvailable(): boolean;
}

export class PlaintextEncoder implements SecretEncoder {
  // test-only fallback, explicitly marked
  encrypt(plain: string): Buffer { return Buffer.from(`INSECURE:${plain}`, "utf8"); }
  decrypt(blob: Buffer): string {
    const s = blob.toString("utf8");
    if (!s.startsWith("INSECURE:")) throw new Error("corrupt vault entry");
    return s.slice("INSECURE:".length);
  }
  isAvailable(): boolean { return false; }
}

interface VaultFile {
  version: 1;
  insecureFallback: boolean;
  entries: Record<string, { blob: string; createdAt: number }>;
}

export class Vault {
  private data: VaultFile = { version: 1, insecureFallback: false, entries: {} };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private file: string, private encoder: SecretEncoder) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.data = JSON.parse(raw) as VaultFile;
    } catch {
      this.data = { version: 1, insecureFallback: false, entries: {} };
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data), "utf8");
    await fs.rename(tmp, this.file);
  }

  private enqueueWrite(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.save());
    return this.writeChain;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Vault not loaded");
  }

  async set(profileId: string, material: CredentialMaterial): Promise<void> {
    this.assertLoaded();
    if (!this.encoder.isAvailable() && !this.data.insecureFallback) {
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
    }
    const blob = this.encoder.encrypt(JSON.stringify(material)).toString("base64");
    this.data.entries[profileId] = { blob, createdAt: Date.now() };
    await this.enqueueWrite();
  }

  /** Explicit user consent to store secrets without OS protection (rare setups). */
  enableInsecureFallback(): void {
    this.data.insecureFallback = true;
    this.enqueueWrite().catch(() => {});
  }

  secureStorageAvailable(): boolean {
    return this.encoder.isAvailable();
  }

  get(profileId: string): CredentialMaterial | null {
    this.assertLoaded();
    const e = this.data.entries[profileId];
    if (!e) return null;
    try {
      return JSON.parse(this.encoder.decrypt(Buffer.from(e.blob, "base64"))) as CredentialMaterial;
    } catch {
      return null;
    }
  }

  has(profileId: string): boolean {
    this.assertLoaded();
    return this.data.entries[profileId] !== undefined;
  }

  async delete(profileId: string): Promise<void> {
    this.assertLoaded();
    delete this.data.entries[profileId];
    await this.enqueueWrite();
  }
}

/** Non-secret profile persistence. */
export class ProfileStore {
  private profiles: ServerProfile[] = [];
  private loaded = false;

  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.profiles = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.profiles = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.profiles, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  assertLoaded(): void {
    if (!this.loaded) throw new Error("ProfileStore not loaded");
  }

  list(): ServerProfile[] {
    this.assertLoaded();
    return [...this.profiles];
  }

  get(id: string): ServerProfile | undefined {
    this.assertLoaded();
    return this.profiles.find((p) => p.id === id);
  }

  async upsert(profile: ServerProfile): Promise<void> {
    this.assertLoaded();
    const idx = this.profiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) this.profiles[idx] = profile;
    else this.profiles.push(profile);
    await this.save();
  }

  async delete(id: string): Promise<void> {
    this.assertLoaded();
    this.profiles = this.profiles.filter((p) => p.id !== id);
    await this.save();
  }
}

/** Pinned SSH host keys (TOFU). Key format: host:port. */
export class HostKeyStore {
  private map = new Map<string, HostKeyInfo & { acceptedAt: number }>();
  private loaded = false;

  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const arr = JSON.parse(raw) as Array<HostKeyInfo & { acceptedAt: number; id: string }>;
      this.map = new Map(arr.map((e) => [e.id, e]));
    } catch {
      this.map = new Map();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const arr = [...this.map.entries()].map(([id, v]) => ({ id, ...v }));
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(arr, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  private static key(host: string, port: number): string {
    return `${host.toLowerCase()}:${port}`;
  }

  assertLoaded(): void {
    if (!this.loaded) throw new Error("HostKeyStore not loaded");
  }

  get(host: string, port: number): (HostKeyInfo & { acceptedAt: number }) | undefined {
    this.assertLoaded();
    return this.map.get(HostKeyStore.key(host, port));
  }

  async accept(host: string, port: number, info: HostKeyInfo): Promise<void> {
    this.assertLoaded();
    this.map.set(HostKeyStore.key(host, port), { ...info, acceptedAt: Date.now() });
    await this.save();
  }

  async remove(host: string, port: number): Promise<void> {
    this.assertLoaded();
    this.map.delete(HostKeyStore.key(host, port));
    await this.save();
  }
}

/** Append-only capped activity log (JSONL). */
export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private loaded = false;
  private static readonly CAP = 500;

  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.entries = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ActivityEntry);
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, this.entries.map((e) => JSON.stringify(e)).join("\n"), "utf8");
  }

  assertLoaded(): void {
    if (!this.loaded) throw new Error("ActivityLog not loaded");
  }

  list(profileId?: string): ActivityEntry[] {
    return [...this.entries].filter((e) => !profileId || (e as ActivityEntry & { profileId?: string }).profileId === profileId).reverse();
  }

  async add(profileId: string, entry: ActivityEntry): Promise<void> {
    this.assertLoaded();
    this.entries.push({ ...entry, ...( { profileId } as object) } as ActivityEntry);
    if (this.entries.length > ActivityLog.CAP) {
      this.entries = this.entries.slice(-ActivityLog.CAP);
    }
    await this.save();
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.save();
  }
}

export function removeSecrets(text: string): string {
  // defensive scrubbing for anything logged or shown
  return text
    .replace(/(-P\s+)'[^']*'/g, "$1'***'")
    .replace(/(password[=:]\s*)\S+/gi, "$1***")
    .replace(/(BEGIN (OPENSSH )?PRIVATE KEY)[\s\S]*?(END (OPENSSH )?PRIVATE KEY)/g, "$1 *** $3");
}

export const STORAGE_FILES = {
  profiles: "profiles.json",
  vault: "vault.bin",
  hostKeys: "hostkeys.json",
  activity: "activity.jsonl",
  settings: "settings.json"
} as const;
