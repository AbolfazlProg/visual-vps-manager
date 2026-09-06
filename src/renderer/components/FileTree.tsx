import { useCallback, useEffect, useState } from "react";
import { call, VpsmApiError } from "../ipc";
import { ChevronRight, Folder, FolderOpenIcon } from "./icons";

interface TreeNode {
  path: string;
  name: string;
  loaded: boolean;
  children: TreeNode[];
  expanded: boolean;
  error?: string;
}

/** Lazy-loading remote directory tree — children load only on expand. */
export function FileTree({ profileId, currentPath, onOpen }: {
  profileId: string;
  currentPath: string;
  onOpen(path: string): void;
}) {
  const [root, setRoot] = useState<TreeNode | null>(null);

  const loadChildren = useCallback(async (node: TreeNode): Promise<TreeNode> => {
    if (node.loaded) return node;
    try {
      const res = await call(window.vpsm.listDir(profileId, node.path));
      node.children = res.entries
        .filter((e) => e.kind === "directory")
        .map((e) => ({ path: e.path, name: e.name, loaded: false, children: [], expanded: false }));
      node.loaded = true;
      node.error = undefined;
    } catch (err) {
      const e = err as VpsmApiError;
      node.error = e.sErr?.message ?? "failed";
      node.loaded = true;
    }
    return node;
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r: TreeNode = { path: "/", name: "/", loaded: false, children: [], expanded: true };
      await loadChildren(r);
      if (!cancelled) setRoot({ ...r });
    })();
    return () => { cancelled = true; };
  }, [loadChildren]);

  // highlight + auto-expand towards currentPath
  useEffect(() => {
    if (!root) return;
    void (async () => {
      const parts = currentPath.split("/").filter(Boolean);
      let node = root;
      const newRoot = { ...root, expanded: true };
      let cursor = newRoot;
      let acc = "";
      for (const part of parts) {
        acc += `/${part}`;
        if (!cursor.loaded) {
          const loaded = await loadChildren(cursor);
          Object.assign(cursor, loaded);
        }
        const child = cursor.children.find((c) => c.path === acc);
        if (!child) break;
        child.expanded = true;
        cursor.children = cursor.children.map((c) => (c.path === acc ? child : c));
        cursor = child;
      }
      void node;
      setRoot({ ...newRoot });
    })();
  }, [currentPath, root, loadChildren]);

  if (!root) return <div className="faint" style={{ padding: 10 }}>Loading tree…</div>;

  return (
    <div>
      <TreeRow node={root} depth={0} profileId={profileId} currentPath={currentPath} onOpen={onOpen} loadChildren={loadChildren} onChange={(n) => setRoot({ ...n })} />
    </div>
  );
}

function TreeRow({ node, depth, profileId, currentPath, onOpen, loadChildren, onChange }: {
  node: TreeNode;
  depth: number;
  profileId: string;
  currentPath: string;
  onOpen(path: string): void;
  loadChildren(n: TreeNode): Promise<TreeNode>;
  onChange(n: TreeNode): void;
}) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const n = { ...node, expanded: !node.expanded };
    if (n.expanded && !n.loaded) {
      const loaded = await loadChildren(n);
      Object.assign(n, loaded);
    }
    onChange(n);
    setBusy(false);
  };

  const isActive = currentPath === node.path;

  return (
    <div>
      <div
        className={`tree-item${isActive ? " active" : ""}`}
        style={{ paddingLeft: 6 }}
        onClick={() => onOpen(node.path)}
        role="treeitem"
        aria-expanded={node.expanded}
        aria-selected={isActive}
      >
        <button
          className="twist icon-btn"
          style={{ width: 18, height: 18 }}
          onClick={(e) => { e.stopPropagation(); void toggle(); }}
          aria-label={node.expanded ? "Collapse" : "Expand"}
        >
          {busy ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <ChevronRight size={13} style={{ transform: node.expanded ? "rotate(90deg)" : "none", transition: "transform 0.12s" }} />}
        </button>
        {node.expanded ? <FolderOpenIcon size={15} /> : <Folder size={15} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
      </div>
      {node.error && <div className="faint" style={{ paddingLeft: 34, color: "var(--red)" }}>{node.error}</div>}
      {node.expanded && node.loaded && (
        <div className="tree-children">
          {node.children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} profileId={profileId} currentPath={currentPath} onOpen={onOpen} loadChildren={loadChildren} onChange={(n) => {
              // replace child in parent
              const newNode = { ...node, children: node.children.map((x) => (x.path === n.path ? n : x)) };
              onChange(newNode);
            }} />
          ))}
          {node.children.length === 0 && <div className="faint" style={{ paddingLeft: 34, padding: "2px 0 4px 34px" }}>empty</div>}
        </div>
      )}
    </div>
  );
}
