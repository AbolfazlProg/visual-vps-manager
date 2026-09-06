import { useEffect } from "react";
import { useApp } from "./store";
import { ServersPage } from "./pages/ServersPage";
import { FilesPage } from "./pages/FilesPage";
import { TerminalPage } from "./components/TerminalPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ServicesPage } from "./pages/ServicesPage";
import { ProcessesPage } from "./pages/ProcessesPage";
import { LogsPage } from "./pages/LogsPage";
import { TrashPage } from "./pages/TrashPage";
import { ActivityPage } from "./pages/ActivityPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UtilitiesPage } from "./pages/UtilitiesPage";
import { ToastHost } from "./components/ToastHost";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { ServerIcon, FolderTreeIcon, GaugeIcon, TerminalIcon, SettingsIcon, ActivityIcon } from "./components/icons";
import type { Route } from "./store";

export function App() {
  const { route, init } = useApp();

  useEffect(() => {
    void init();
  }, [init]);

  const profileId = "profileId" in route ? route.profileId : null;

  return (
    <div className="app-shell">
      <HostKeyDialog />
      <div className="app-main">
        {route.view === "servers" && <ServersPage />}
        {route.view === "files" && <FilesPage profileId={profileId!} />}
        {route.view === "terminal" && <TerminalPage profileId={profileId!} />}
        {route.view === "dashboard" && <DashboardPage profileId={profileId!} />}
        {route.view === "services" && <ServicesPage profileId={profileId!} />}
        {route.view === "processes" && <ProcessesPage profileId={profileId!} />}
        {route.view === "logs" && <LogsPage profileId={profileId!} />}
        {route.view === "trash" && <TrashPage profileId={profileId!} />}
        {route.view === "activity" && <ActivityPage profileId={profileId!} />}
        {route.view === "settings" && <SettingsPage />}
        {route.view === "transfers" && <UtilitiesPage profileId={profileId ?? undefined} />}
      </div>
      <BottomNav route={route} />
      <ToastHost />
    </div>
  );
}

function BottomNav({ route }: { route: Route }) {
  const { navigate, back } = useApp();
  const profileId = "profileId" in route ? (route.profileId ?? null) : null;
  if (route.view === "servers" || route.view === "settings") return null;
  void back;

  const items: Array<{ key: string; label: string; icon: React.ReactNode; go: () => void; active: boolean }> = [
    { key: "files", label: "Files", icon: <FolderTreeIcon size={19} />, go: () => navigate({ view: "files", profileId: profileId! }), active: route.view === "files" },
    { key: "dash", label: "Monitor", icon: <GaugeIcon size={19} />, go: () => navigate({ view: "dashboard", profileId: profileId! }), active: route.view === "dashboard" },
    { key: "term", label: "Terminal", icon: <TerminalIcon size={19} />, go: () => navigate({ view: "terminal", profileId: profileId! }), active: route.view === "terminal" },
    { key: "xfer", label: "Transfers", icon: <ActivityIcon size={19} />, go: () => navigate({ view: "transfers", profileId: profileId ?? undefined }), active: route.view === "transfers" },
    { key: "servers", label: "Servers", icon: <ServerIcon size={19} />, go: () => navigate({ view: "servers" }), active: false }
  ];

  return (
    <nav className="bottom-nav" aria-label="Primary">
      {items.map((it) => (
        <button key={it.key} className={it.active ? "active" : ""} onClick={it.go} aria-label={it.label}>
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
      <button onClick={() => navigate({ view: "settings" })} aria-label="Settings">
        <SettingsIcon size={19} />
        <span>Settings</span>
      </button>
    </nav>
  );
}
