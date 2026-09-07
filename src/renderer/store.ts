import { create } from "zustand";
import { call, VpsmApiError } from "./ipc";
import type {
  ActivityEntry, ConnStatus, MetricsSnapshot, ServerProfile, ServerState,
  TrashItem, TransferState, SerializedVpsmError
} from "./types";

export interface Toast {
  id: number;
  kind: "success" | "error" | "info" | "warn";
  title: string;
  detail?: string;
}

export type Route =
  | { view: "servers" }
  | { view: "files"; profileId: string }
  | { view: "terminal"; profileId: string }
  | { view: "dashboard"; profileId: string }
  | { view: "services"; profileId: string }
  | { view: "processes"; profileId: string }
  | { view: "logs"; profileId: string }
  | { view: "trash"; profileId: string }
  | { view: "activity"; profileId: string }
  | { view: "transfers"; profileId?: string }
  | { view: "settings" };

interface AppState {
  /* data */
  profiles: ServerProfile[];
  states: Record<string, ServerState>;
  transfers: TransferState[];
  sudoOk: Record<string, boolean>;
  theme: "dark" | "light";
  route: Route;
  history: Route[];

  /* ui */
  toasts: Toast[];
  busy: Record<string, boolean>;

  /* actions */
  init(): Promise<void>;
  refreshProfiles(): Promise<void>;
  navigate(route: Route): void;
  back(): void;
  setTheme(t: "dark" | "light"): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
  setBusy(key: string, v: boolean): void;
  setSudoOk(profileId: string, ok: boolean): void;

  /* server actions */
  connect(profileId: string, acceptHostKey?: boolean): Promise<boolean>;
  disconnect(profileId: string): Promise<void>;
  saveProfile(input: Record<string, unknown>): Promise<ServerProfile>;
  deleteProfile(id: string): Promise<void>;
  duplicateProfile(id: string): Promise<void>;
}

let toastSeq = 1;
let eventBound = false;

export const useApp = create<AppState>((set, get) => ({
  profiles: [],
  states: {},
  transfers: [],
  sudoOk: {},
  theme: "dark",
  route: { view: "servers" },
  history: [],
  toasts: [],
  busy: {},

  async init() {
    // theme from system setting persisted in localStorage
    const savedTheme = (localStorage.getItem("vpsm.theme") as "dark" | "light" | null) ?? "dark";
    set({ theme: savedTheme });
    document.documentElement.dataset.theme = savedTheme;

    if (!eventBound) {
      eventBound = true;
      window.vpsm.onEvent((ev) => {
        const e = ev as { type: string } & Record<string, unknown>;
        if (e.type === "profile-state") {
          const st = e.state as ServerState;
          set((s) => ({ states: { ...s.states, [st.id]: st } }));
        } else if (e.type === "transfer") {
          const t = e.state as TransferState;
          set((s) => {
            const idx = s.transfers.findIndex((x) => x.id === t.id);
            const transfers = [...s.transfers];
            if (idx >= 0) transfers[idx] = t;
            else transfers.unshift(t);
            return { transfers };
          });
        } else if (e.type === "terminal-output" || e.type === "log-line" || e.type === "terminal-exit" || e.type === "log-closed") {
          window.dispatchEvent(new CustomEvent(`vpsm:${e.type}`, { detail: e }));
        }
      });
    }

    await get().refreshProfiles();

    // restore statuses (main may still hold connections)
    const { profiles } = get();
    for (const p of profiles) {
      try {
        const st = await call(window.vpsm.getState(p.id));
        set((s) => ({ states: { ...s.states, [p.id]: st } }));
      } catch { /* offline */ }
    }
  },

  async refreshProfiles() {
    const profiles = await call(window.vpsm.listProfiles());
    set({ profiles });
  },

  navigate(route: Route) {
    set((s) => ({ route, history: [...s.history.slice(-30), s.route] }));
  },

  back() {
    set((s) => {
      const history = [...s.history];
      const prev = history.pop();
      return prev ? { route: prev, history } : {};
    });
  },

  setTheme(t) {
    localStorage.setItem("vpsm.theme", t);
    document.documentElement.dataset.theme = t;
    set({ theme: t });
  },

  toast(t) {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.kind === "error" ? 9000 : 4500);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  setBusy(key, v) {
    set((s) => ({ busy: { ...s.busy, [key]: v } }));
  },

  setSudoOk(profileId, ok) {
    set((s) => ({ sudoOk: { ...s.sudoOk, [profileId]: ok } }));
  },

  async connect(profileId, acceptHostKey) {
    const { profiles } = get();
    const profile = profiles.find((p) => p.id === profileId);
    set((s) => ({
      states: { ...s.states, [profileId]: { id: profileId, status: "connecting" as ConnStatus } }
    }));
    try {
      await call(window.vpsm.connect(profileId, acceptHostKey ? { acceptHostKey: true } : undefined));
      set((s) => ({ states: { ...s.states, [profileId]: { id: profileId, status: "connected" as ConnStatus } } }));
      get().toast({ kind: "success", title: `Connected to ${profile?.name ?? "server"}` });
      void get().refreshProfiles();
      return true;
    } catch (err) {
      const e = err as VpsmApiError;
      const sErr = e.sErr as SerializedVpsmError | undefined;
      if (sErr?.code === "EHOSTKEY") {
        set((s) => ({
          states: {
            ...s.states,
            [profileId]: { id: profileId, status: "hostkey" as ConnStatus, message: sErr.message, hostKey: parseHostKeyDetail(sErr.detail) }
          }
        }));
        return false;
      }
      set((s) => ({
        states: { ...s.states, [profileId]: { id: profileId, status: "error" as ConnStatus, error: sErr } }
      }));
      get().toast({ kind: "error", title: sErr?.message ?? "Connection failed", detail: sErr?.detail });
      return false;
    }
  },

  async disconnect(profileId) {
    try {
      await call(window.vpsm.disconnect(profileId));
    } finally {
      set((s) => ({ states: { ...s.states, [profileId]: { id: profileId, status: "offline" as ConnStatus } } }));
    }
  },

  async saveProfile(input) {
    const profile = await call(window.vpsm.saveProfile(input));
    await get().refreshProfiles();
    return profile;
  },

  async deleteProfile(id) {
    await call(window.vpsm.deleteProfile(id));
    const states = { ...get().states };
    delete states[id];
    set({ states });
    await get().refreshProfiles();
  },

  async duplicateProfile(id) {
    await call(window.vpsm.duplicateProfile(id));
    await get().refreshProfiles();
  }
}));

function parseHostKeyDetail(detail?: string): { fingerprint: string; keyType: string; verified: boolean } | undefined {
  if (!detail) return undefined;
  try {
    return JSON.parse(detail);
  } catch {
    return undefined;
  }
}

// exposed for E2E debugging / advanced diagnostics (AFTER store creation)
if (typeof window !== "undefined") {
  (window as unknown as { __vpsmStore: unknown }).__vpsmStore = useApp;
}

/* selector helpers */
export const statusOf = (s: AppState, id: string): ConnStatus => s.states[id]?.status ?? "offline";
export const activityEntriesOf = (_id: string): Promise<ActivityEntry[]> => call(window.vpsm.listActivity(_id));
export const trashItemsOf = (_id: string): Promise<TrashItem[]> => call(window.vpsm.listTrash(_id));
export const metricsOf = (id: string): Promise<MetricsSnapshot> => call(window.vpsm.getMetrics(id));
