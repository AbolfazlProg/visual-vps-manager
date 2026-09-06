/**
 * Session registry: one SshSession per profile id + connection orchestration
 * (vault lookup, host-key pinning, state fan-out, auto-cleanup).
 */

import type { ConnStatus, HostKeyInfo, ServerProfile, CredentialMaterial, ServerState } from "../shared/protocol";
import { vpsmError, type SerializedVpsmError } from "../shared/errors";
import { SshSession } from "./ssh";
import type { ActivityLog, HostKeyStore, ProfileStore, Vault } from "./storage";

export interface SessionEvents {
  onStatus(profileId: string, status: ConnStatus, message?: string, error?: SerializedVpsmError): void;
}

export class SessionRegistry {
  private sessions = new Map<string, SshSession>();

  constructor(
    private readonly profiles: ProfileStore,
    private readonly vault: Vault,
    private readonly hostKeys: HostKeyStore,
    private readonly activity: ActivityLog,
    private readonly events: SessionEvents
  ) {}

  listProfiles(): ServerProfile[] {
    return this.profiles.list();
  }

  private requireProfile(id: string): ServerProfile {
    const p = this.profiles.get(id);
    if (!p) throw vpsmError("EINVAL_INPUT", "Unknown server profile");
    return p;
  }

  getState(id: string): ServerState {
    const s = this.sessions.get(id);
    if (!s) return { id, status: "offline" };
    return { id, status: s.getStatus() };
  }

  has(id: string): boolean {
    return this.sessions.get(id)?.isConnected() ?? false;
  }

  /** Connected session or throw — used by every remote operation. */
  requireConnected(id: string): SshSession {
    const s = this.sessions.get(id);
    if (!s || !s.isConnected()) throw vpsmError("ECONN", "Not connected", { detail: "Open the connection first." });
    return s;
  }

  async connect(id: string, opts: { acceptHostKey?: boolean } = {}): Promise<void> {
    const profile = this.requireProfile(id);
    if (this.sessions.get(id)?.isConnected()) return;

    if (opts.acceptHostKey) {
      // caller saw the fingerprint dialog; pin BEFORE the next handshake
      const pending = this.pendingHostKeys.get(id);
      if (pending) {
        await this.hostKeys.accept(profile.host, profile.port, pending);
        this.pendingHostKeys.delete(id);
        await this.activity.add(id, {
          at: Date.now(),
          kind: "security",
          summary: `Host key accepted for ${profile.host}:${profile.port}`,
          detail: pending.fingerprint
        });
      }
    }

    const material: CredentialMaterial = this.vault.has(id)
      ? this.vault.get(id) ?? {}
      : {};

    const session = new SshSession(profile, material, (ev) => {
      if (ev.type === "status") {
        if (ev.status === "connected") {
          void this.profiles.upsert({ ...profile, lastConnectedAt: Date.now() }).catch(() => {});
          void this.activity.add(id, {
            at: Date.now(),
            kind: "session",
            summary: `Connected to ${profile.name} (${profile.host})`
          });
        }
        this.events.onStatus(id, ev.status, ev.message, ev.error);
      } else if (ev.type === "hostkey") {
        this.pendingHostKeys.set(id, ev.info);
      }
    }, {
      getHostKey: (host, port) => this.hostKeys.get(host, port),
      onVerifiedHostKey: async (info) => {
        if (info.fingerprint) {
          await this.hostKeys.accept(profile.host, profile.port, info);
        }
      }
    });

    this.sessions.set(id, session);
    try {
      await session.connect();
    } catch (err) {
      const mapped = err && typeof err === "object" && "code" in err ? (err as SerializedVpsmError) : vpsmError("EINTERNAL", String(err));
      this.sessions.delete(id);
      try { session.cleanup(); } catch { /* noop */ }
      throw mapped;
    }
  }

  private pendingHostKeys = new Map<string, HostKeyInfo>();

  async disconnect(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    const profile = this.profiles.get(id);
    try { s.cleanup(); } catch { /* noop */ }
    this.sessions.delete(id);
    if (profile) {
      await this.activity.add(id, { at: Date.now(), kind: "session", summary: `Disconnected from ${profile.name}` });
    }
  }

  async deleteProfile(id: string): Promise<void> {
    const profile = this.profiles.get(id);
    await this.disconnect(id);
    await this.profiles.delete(id);
    await this.vault.delete(id);
    if (profile) {
      await this.hostKeys.remove(profile.host, profile.port).catch(() => {});
    }
  }

  forgetSudo(id: string): void {
    this.sessions.get(id)?.forgetSudo();
  }
}
