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
  private everConnected = new Set<string>();
  private intentional = new Set<string>();
  private reconnectAttempts = new Map<string, number>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

    // tear down any dead previous session so its late close events
    // don't trigger a spurious reconnect
    const old = this.sessions.get(id);
    if (old) {
      this.intentional.add(id);
      try { old.cleanup(); } catch { /* noop */ }
      this.sessions.delete(id);
      this.intentional.delete(id);
    }

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
        if (ev.status === "offline" || ev.status === "error") {
          this.scheduleReconnect(id, ev.error);
        }
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
    this.everConnected.add(id);
    try {
      await session.connect();
      this.reconnectAttempts.delete(id);
    } catch (err) {
      const mapped = err && typeof err === "object" && "code" in err ? (err as SerializedVpsmError) : vpsmError("EINTERNAL", String(err));
      this.sessions.delete(id);
      try { session.cleanup(); } catch { /* noop */ }
      // initial-connect failures with a pinned key that was previously OK also retry
      this.scheduleReconnect(id, mapped);
      throw mapped;
    }
  }

  /**
   * Auto-reconnect with exponential backoff (2s → 16s, max 5 attempts).
   * Skipped for host-key failures (user must verify) and auth failures
   * (credentials won't change by themselves).
   */
  private scheduleReconnect(id: string, error?: SerializedVpsmError): void {
    if (!this.everConnected.has(id)) return;            // never connected by user → don't auto-retry
    if (this.intentional.has(id)) return;               // explicit disconnect
    if (this.reconnectTimers.has(id)) return;           // already scheduled
    if (error?.code === "EHOSTKEY" || error?.code === "EAUTH" || error?.code === "EINVAL_INPUT") return;
    const attempt = (this.reconnectAttempts.get(id) ?? 0) + 1;
    if (attempt > 5) {
      this.reconnectAttempts.delete(id);
      this.events.onStatus(id, "error", "Auto-reconnect gave up", vpsmError("ECONN", "Could not reconnect automatically", { detail: "Reconnect manually from the Servers page." }));
      return;
    }
    this.reconnectAttempts.set(id, attempt);
    const delay = Math.min(16000, 2000 * 2 ** (attempt - 1));
    const profile = this.profiles.get(id);
    this.events.onStatus(id, "connecting", `Reconnecting (attempt ${attempt}/5)…`);
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(id);
      if (this.sessions.get(id)?.isConnected()) return;
      try {
        await this.connect(id);
      } catch {
        // connect() already scheduled the next attempt
      }
    }, delay);
    this.reconnectTimers.set(id, timer);
    void profile;
  }

  /** Explicit user disconnect — cancels any pending auto-reconnect. */
  async disconnect(id: string): Promise<void> {
    const timer = this.reconnectTimers.get(id);
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(id); }
    this.reconnectAttempts.delete(id);
    this.intentional.add(id);
    const s = this.sessions.get(id);
    if (!s) { this.intentional.delete(id); return; }
    const profile = this.profiles.get(id);
    try { s.cleanup(); } catch { /* noop */ }
    this.sessions.delete(id);
    this.intentional.delete(id);
    if (profile) {
      await this.activity.add(id, { at: Date.now(), kind: "session", summary: `Disconnected from ${profile.name}` });
    }
  }

  private pendingHostKeys = new Map<string, HostKeyInfo>();

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
