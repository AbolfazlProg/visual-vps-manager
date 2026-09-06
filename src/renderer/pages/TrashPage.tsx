import { useEffect, useState } from "react";
import { useApp, trashItemsOf } from "../store";
import { call, VpsmApiError } from "../ipc";
import { RefreshCw, RotateCcw, TrashIcon2 } from "../components/icons";
import { ConfirmDialog } from "../components/Modal";
import { fileSizeStr, dateStr } from "../components/icons";
import type { TrashItem } from "../../shared/protocol";

export function TrashPage({ profileId }: { profileId: string }) {
  const { states, toast } = useApp();
  const connected = states[profileId]?.status === "connected";
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<TrashItem | null>(null);

  useEffect(() => {
    if (connected) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const reload = async () => {
    try {
      setItems(await trashItemsOf(profileId));
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: "Cannot read trash", detail: e.sErr?.message });
      setItems([]);
    }
  };

  if (!connected) return <div className="center-note"><div>Not connected.</div></div>;

  const restore = async (item: TrashItem) => {
    setBusy(item.id);
    try {
      await call(window.vpsm.runOperation(profileId, { kind: "restore", trashIds: [item.id] }));
      toast({ kind: "success", title: `Restored to ${item.originalPath || "original location"}` });
      await reload();
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: "Restore failed", detail: e.sErr?.message });
    } finally {
      setBusy(null);
      setConfirmRestore(null);
    }
  };

  const empty = async () => {
    setBusy("empty");
    try {
      await call(window.vpsm.emptyTrash(profileId));
      toast({ kind: "success", title: "Trash emptied" });
      await reload();
    } catch (err) {
      const e = err as VpsmApiError;
      toast({ kind: "error", title: "Failed to empty trash", detail: e.sErr?.message });
    } finally {
      setBusy(null);
      setConfirmEmpty(false);
    }
  };

  const totalBytes = (items ?? []).reduce((a, i) => a + i.sizeBytes, 0);

  return (
    <div className="page">
      <div className="page-scroll">
        <div className="row" style={{ marginBottom: 12 }}>
          <h1 className="page-title">Trash</h1>
          <span className="faint">{items?.length ?? 0} items · {fileSizeStr(totalBytes)} · stored in ~/.vpsmgr-trash on the server</span>
          <div className="spacer" />
          <button className="btn small" onClick={() => void reload()}><RefreshCw size={14} /> Refresh</button>
          <button className="btn small danger" onClick={() => setConfirmEmpty(true)} disabled={!items || items.length === 0}><TrashIcon2 size={14} /> Empty trash</button>
        </div>

        {!items ? (
          <div className="center-note"><span className="spinner" /> loading…</div>
        ) : items.length === 0 ? (
          <div className="center-note"><TrashIcon2 size={36} /><div>Trash is empty</div><div className="faint">Deleted items (with "Move to trash") appear here and can be restored.</div></div>
        ) : (
          <div className="svc-rows">
            {items.map((it) => (
              <div key={it.id} className="svc-row" style={{ gridTemplateColumns: "minmax(180px,1fr) 150px 90px auto" }}>
                <div className="mono" style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {it.originalPath || <span className="faint">(metadata missing) {it.trashPath}</span>}
                </div>
                <span className="faint">{dateStr(it.deletedAt)}</span>
                <span className="faint">{fileSizeStr(it.sizeBytes)}</span>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn small" onClick={() => setConfirmRestore(it)} disabled={busy === it.id || !it.originalPath}>
                    <RotateCcw size={13} /> Restore
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmRestore && (
        <ConfirmDialog
          title={`Restore "${confirmRestore.originalPath.split("/").pop()}"?`}
          message={<>It will be moved back to <span className="mono">{confirmRestore.originalPath}</span>. If something already exists there, a "(restored N)" suffix is added.</>}
          confirmLabel="Restore"
          busy={busy === confirmRestore.id}
          onConfirm={() => void restore(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
        />
      )}

      {confirmEmpty && (
        <ConfirmDialog
          title="Empty the trash?"
          message="All items in ~/.vpsmgr-trash will be permanently deleted. This cannot be undone."
          danger
          confirmLabel="Empty permanently"
          busy={busy === "empty"}
          onConfirm={() => void empty()}
          onCancel={() => setConfirmEmpty(false)}
        />
      )}
    </div>
  );
}
