import { useState } from "react";
import { useApp } from "../store";
import { StatusPill } from "./ServersPage";
import { ServerEditorDialog } from "../components/ServerEditorDialog";
import { TransferList } from "../components/TransferList";
import { SudoPanel } from "../components/SudoPanel";
import { EditIcon, FolderTreeIcon } from "../components/icons";

export function UtilitiesPage({ profileId }: { profileId?: string }) {
  const { profiles, states, connect, navigate } = useApp();
  const [editorFor, setEditorFor] = useState<{ id?: string } | null>(null);

  if (!profileId) {
    /* ---------- server-centric utility hub ---------- */
    return (
      <div className="page">
        <div className="page-scroll">
          <h1 className="page-title" style={{ marginBottom: 12 }}>Utilities</h1>
          <div className="col" style={{ gap: 10 }}>
            {profiles.map((p) => {
              const st = states[p.id];
              return (
                <div key={p.id} className="server-card" onClick={() => void (st?.status === "connected" ? null : connect(p.id))}>
                  <div className="avatar" style={{ background: p.color }}>{p.name.slice(0, 2).toUpperCase()}</div>
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <strong>{p.name}</strong>
                      <StatusPill status={st?.status ?? "offline"} />
                    </div>
                    <div className="faint mono">{p.username}@{p.host}:{p.port}</div>
                  </div>
                  <button className="btn small" onClick={(e) => { e.stopPropagation(); setEditorFor({ id: p.id }); }}><EditIcon size={13} /> Edit</button>
                  <button className="icon-btn" onClick={(e) => { e.stopPropagation(); navigate({ view: "files", profileId: p.id }); }} title="Files"><FolderTreeIcon size={16} /></button>
                </div>
              );
            })}
          </div>
          {editorFor && <ServerEditorDialog profileId={editorFor.id} onClose={() => setEditorFor(null)} />}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-scroll">
        <h1 className="page-title" style={{ marginBottom: 12 }}>Transfers</h1>
        <TransferList profileId={profileId} />
        <div style={{ height: 18 }} />
        <SudoPanel profileId={profileId} />
      </div>
    </div>
  );
}
