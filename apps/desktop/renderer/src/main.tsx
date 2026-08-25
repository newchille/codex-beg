import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Page = "Home" | "Projects" | "Live Logs" | "Settings" | "Doctor";
type WorkspaceKind = "machine_root" | "project";

interface Workspace {
  id: string;
  displayName: string;
  kind: WorkspaceKind;
  parentWorkspaceId?: string;
  canonicalRoot: string;
  projectType: string;
}

interface WorkspaceState {
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
}

interface Status {
  running: boolean;
  health: unknown;
  events: unknown;
}

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>("Home");
  const [status, setStatus] = useState<Status>({ running: false, health: null, events: [] });
  const [logs, setLogs] = useState<string[]>([]);
  const [doctor, setDoctor] = useState<Record<string, unknown> | null>(null);
  const pages = useMemo<Page[]>(() => ["Home", "Projects", "Live Logs", "Settings", "Doctor"], []);
  const bridgeAvailable = Boolean(window.codexBeg);

  useEffect(() => {
    if (!window.codexBeg) return;
    const api = window.codexBeg;
    void WindowStatus(setStatus);
    const remove = api.onLog((line) => setLogs((items) => [...items.slice(-199), line]));
    const timer = window.setInterval(() => void WindowStatus(setStatus), 2000);
    return () => { remove(); window.clearInterval(timer); };
  }, []);

  const addWorkspace = async (kind: WorkspaceKind): Promise<void> => {
    if (!window.codexBeg) return;
    const result = await window.codexBeg.workspaceAdd(kind);
    setLogs((items) => [...items, `${kind === "machine_root" ? "Machine root" : "Project"} registered: ${JSON.stringify(result)}`]);
  };
  const addProject = async (): Promise<void> => addWorkspace("project");
  const addMachineRoot = async (): Promise<void> => addWorkspace("machine_root");

  return <div className="app-shell">
    <aside><div className="brand"><span className="brand-mark">◈</span><div><strong>CODEX BEG</strong><small>Local engineering control</small></div></div><nav>{pages.map((item) => <button className={page === item ? "nav active" : "nav"} key={item} onClick={() => setPage(item)}>{item}</button>)}</nav><div className="side-note">Permission mode<br /><strong>Full access</strong><br /><span>Destructive actions: Ask first</span></div></aside>
    <main><header><div><h1>{page}</h1><p>Sol-compatible local MCP workspace agent</p></div><div className="status-pill"><i className={status.running ? "dot online" : "dot"}></i>{status.running ? "Agent running" : "Agent offline"}</div></header>
      {!bridgeAvailable && <section className="panel"><h2>Open Codex BEG desktop app</h2><p>This renderer was opened without its secure Electron preload bridge. Launch the packaged app or use the desktop development command.</p></section>}
      {bridgeAvailable && page === "Home" && <Home status={status} onAdd={addProject} />}
      {bridgeAvailable && page === "Projects" && <Projects onAddProject={addProject} onAddMachineRoot={addMachineRoot} />}
      {bridgeAvailable && page === "Live Logs" && <LiveLogs logs={logs} />}
      {bridgeAvailable && page === "Settings" && <Panel title="Settings"><label>MCP endpoint<input readOnly value="http://127.0.0.1:43123/mcp" /></label><label>Tunnel integration<input readOnly value="External tunnel-client (not managed)" /></label><p className="muted">Codex BEG does not make model API requests or store tunnel runtime keys.</p></Panel>}
      {bridgeAvailable && page === "Doctor" && <Panel title="Diagnostics"><div className="project-actions"><button className="primary" onClick={async () => setDoctor(await window.codexBeg.doctor())}>Run checks</button><button onClick={async () => { const result = await window.codexBeg.restartAgentHost(); setLogs((items) => [...items, `Agent Host restart: ${JSON.stringify(result)}`]); setDoctor(await window.codexBeg.doctor()); }}>Restart Agent Host</button></div>{doctor && <pre className="json">{JSON.stringify(doctor, null, 2)}</pre>}</Panel>}
    </main>
  </div>;
}

async function WindowStatus(set: (value: Status) => void): Promise<void> { set(await window.codexBeg.status()); }

function Home({ status, onAdd }: { status: Status; onAdd: () => Promise<void> }): React.JSX.Element { return <section className="grid"><article className="card wide"><span className="eyebrow">CURRENT WORKFLOW</span><h2>Planner: ChatGPT <span>→</span> Transport: Secure MCP Tunnel <span>→</span> Executor: Codex BEG Agent Host <span>→</span> Worker: local project commands</h2><div className="facts"><div><b>Agent</b><span>{status.running ? "Connected" : "Starting"}</span></div><div><b>MCP</b><span>127.0.0.1:43123/mcp</span></div><div><b>Codex CLI</b><span>Disabled</span></div></div></article><article className="card"><span className="eyebrow">ACTIVE PROJECT</span><h2>No project selected</h2><p>Add a local directory to create an isolated workspace.</p><button className="primary" onClick={() => void onAdd()}>+ Add project</button></article><article className="card"><span className="eyebrow">SAFETY</span><h2>Central policy enabled</h2><ul><li>Relative workspace paths</li><li>Atomic reversible writes</li><li>No raw shell or delete tool</li><li>Approval required for destructive operations</li></ul></article></section>; }

function Projects({ onAddProject, onAddMachineRoot }: { onAddProject: () => Promise<void>; onAddMachineRoot: () => Promise<void> }): React.JSX.Element {
  const [state, setState] = useState<WorkspaceState>({ workspaces: [], currentWorkspaceId: null });
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    const value = await window.codexBeg.workspaceList();
    if (isError(value)) { setError(value.error); return; }
    setState(value as WorkspaceState);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const selectWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    const value = await window.codexBeg.workspaceSelect(workspaceId);
    if (isError(value)) setError(value.error);
    else await refresh();
  }, [refresh]);
  const removeWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    const value = await window.codexBeg.workspaceRemove(workspaceId);
    if (isError(value)) setError(value.error);
    else await refresh();
  }, [refresh]);
  const registerChild = useCallback(async (parentWorkspaceId: string): Promise<void> => {
    const value = await window.codexBeg.workspaceRegisterDirectory(parentWorkspaceId);
    if (isError(value)) setError(value.error);
    else { setError(null); await refresh(); }
  }, [refresh]);

  const roots = state.workspaces.filter((workspace) => workspace.kind === "machine_root");
  const projects = state.workspaces.filter((workspace) => workspace.kind === "project");
  const children = (parentId: string): Workspace[] => projects.filter((workspace) => workspace.parentWorkspaceId === parentId);
  const orphanedProjects = projects.filter((workspace) => !workspace.parentWorkspaceId || !roots.some((root) => root.id === workspace.parentWorkspaceId));

  return <Panel title="Projects"><p>Register projects and machine roots intentionally. Removing a registration never deletes project files.</p><div className="project-actions"><button className="primary" onClick={() => void onAddProject()}>+ Add project</button><button onClick={() => void onAddMachineRoot()}>+ Add machine root</button></div>{error && <p className="error" role="alert">{error}</p>}<div className="project-list hierarchy-list">{roots.map((root) => <WorkspaceGroup key={root.id} root={root} children={children(root.id)} currentWorkspaceId={state.currentWorkspaceId} onSelect={selectWorkspace} onRemove={removeWorkspace} onRegisterChild={registerChild} />)}{orphanedProjects.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} current={state.currentWorkspaceId === workspace.id} onSelect={selectWorkspace} onRemove={removeWorkspace} />)}{state.workspaces.length === 0 && <p className="muted">No workspaces registered yet.</p>}</div></Panel>;
}

function WorkspaceGroup({ root, children, currentWorkspaceId, onSelect, onRemove, onRegisterChild }: { root: Workspace; children: Workspace[]; currentWorkspaceId: string | null; onSelect: (workspaceId: string) => Promise<void>; onRemove: (workspaceId: string) => Promise<void>; onRegisterChild: (workspaceId: string) => Promise<void> }): React.JSX.Element {
  const register = (): Promise<void> => onRegisterChild(root.id);
  return <div className="workspace-group"><WorkspaceRow workspace={root} current={currentWorkspaceId === root.id} onSelect={onSelect} onRemove={onRemove} /><div className="workspace-children"><button className="secondary" onClick={() => void register()}>+ Register child project</button>{children.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} current={currentWorkspaceId === workspace.id} onSelect={onSelect} onRemove={onRemove} child />)}{children.length === 0 && <small className="muted">No child projects registered.</small>}</div></div>;
}

function WorkspaceRow({ workspace, current, child = false, onSelect, onRemove }: { workspace: Workspace; current: boolean; child?: boolean; onSelect: (workspaceId: string) => Promise<void>; onRemove: (workspaceId: string) => Promise<void> }): React.JSX.Element {
  const select = (): Promise<void> => onSelect(workspace.id);
  const remove = (): Promise<void> => onRemove(workspace.id);
  return <div className={child ? "project-row child-row" : "project-row"}><div><strong>{workspace.displayName}</strong><span className="workspace-kind">{workspace.kind === "machine_root" ? "machine root" : workspace.projectType || "project"}</span><small>{workspace.canonicalRoot}</small></div><span className="project-actions-inline">{workspace.kind === "project" && (current ? <span className="active-label">Active</span> : <button onClick={() => void select()}>Select</button>)}<button onClick={() => void remove()}>Remove registration</button></span></div>;
}

function isError(value: unknown): value is { error: string } { return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"; }

type ApprovalView = { approvalId: string; action: string; classification: string; exactOperation: string; risk: string; expiresAt: string; status: string };
type OperationView = { operationId: string; kind: string; status: string; workspaceId: string; updatedAt: string; error?: string };
type RecoveryView = { operationId: string; workspaceId: string; createdAt: string; status: string; changes: Array<{ path: string; existed: boolean }> };

function LiveLogs({ logs }: { logs: string[] }): React.JSX.Element {
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [operations, setOperations] = useState<OperationView[]>([]);
  const [recovery, setRecovery] = useState<RecoveryView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    const [approvalValue, operationValue, recoveryValue] = await Promise.all([window.codexBeg.approvals(), window.codexBeg.operations(), window.codexBeg.recovery()]);
    setApprovals(Array.isArray(approvalValue) ? approvalValue as ApprovalView[] : []);
    setOperations(Array.isArray(operationValue) ? operationValue as OperationView[] : []);
    setRecovery(Array.isArray(recoveryValue) ? recoveryValue as RecoveryView[] : []);
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 2000); return () => window.clearInterval(timer); }, [refresh]);
  const restore = async (operationId: string): Promise<void> => {
    const value = await window.codexBeg.restore(operationId);
    setNotice(isError(value) ? `Restore: ${value.error}. If approval is required, review the approval queue.` : `Restore completed for ${operationId}.`);
    await refresh();
  };
  const pending = approvals.filter((item) => item.status === "pending");
  const recentApprovalDecisions = approvals.filter((item) => item.status !== "pending").slice(-10).reverse();
  const recentOperations = [...operations].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, 20);
  const recentRecovery = [...recovery].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 20);

  return <Panel title="Live activity">
    <h3>Approval queue</h3>
    {pending.length === 0 && <p className="muted">No pending approvals.</p>}
    {pending.map((item) => <div className="approval" key={item.approvalId}><strong>{item.action}</strong><code>{item.exactOperation}</code><small>{item.classification} · {item.risk} · expires {item.expiresAt}</small><button className="primary" onClick={() => void window.codexBeg.approve(item.approvalId).then(refresh)}>Approve once</button><button onClick={() => void window.codexBeg.reject(item.approvalId).then(refresh)}>Reject</button></div>)}
    <h3>Recent approval decisions</h3>
    <div className="project-list">{recentApprovalDecisions.map((item) => <div className="project-row" key={item.approvalId}><div><strong>{item.action}</strong><small>{item.classification} · {item.exactOperation}</small></div><span>{item.status}{item.status === "approved" ? " · single-use" : ""}</span></div>)}{recentApprovalDecisions.length === 0 && <p className="muted">No approval decisions recorded.</p>}</div>
    <h3>Recent operations</h3>
    <div className="project-list">{recentOperations.map((item) => <div className="project-row" key={item.operationId}><div><strong>{item.kind}</strong><small>{item.operationId} · {item.workspaceId}</small>{item.error && <small className="error">{item.error}</small>}</div><span>{item.status}</span></div>)}{recentOperations.length === 0 && <p className="muted">No operations recorded.</p>}</div>
    <h3>Recovery</h3>
    {notice && <p className="muted">{notice}</p>}
    <div className="project-list">{recentRecovery.map((item) => <div className="project-row" key={item.operationId}><div><strong>{item.operationId}</strong><small>{item.changes.map((change) => `${change.path}${change.existed ? "" : " (created)"}`).join(", ")}</small></div><span className="project-actions-inline"><span>{item.status}</span>{["applied", "restore_conflict"].includes(item.status) && <button onClick={() => void restore(item.operationId)}>Restore</button>}</span></div>)}{recentRecovery.length === 0 && <p className="muted">No recovery manifests recorded.</p>}</div>
    <h3>Agent log</h3>
    <pre className="logs">{logs.length ? logs.join("\n") : "Waiting for agent events…"}</pre>
  </Panel>;
}
function Panel({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element { return <section className="panel"><h2>{title}</h2>{children}</section>; }

createRoot(document.getElementById("root")!).render(<App />);
