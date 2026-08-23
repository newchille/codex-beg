import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Page = "Home" | "Projects" | "Live Logs" | "Settings" | "Doctor";

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>("Home");
  const [status, setStatus] = useState<{ running: boolean; health: unknown; events: unknown }>({ running: false, health: null, events: [] });
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
  const addProject = async () => {
    if (!window.codexBeg) return;
    const path = await window.codexBeg.chooseDirectory();
    if (path) { const result = await window.codexBeg.workspaceAdd(path); setLogs((items) => [...items, `Workspace registered: ${JSON.stringify(result)}`]); }
  };

  return <div className="app-shell">
    <aside><div className="brand"><span className="brand-mark">◈</span><div><strong>CODEX BEG</strong><small>Local engineering control</small></div></div><nav>{pages.map((item) => <button className={page === item ? "nav active" : "nav"} key={item} onClick={() => setPage(item)}>{item}</button>)}</nav><div className="side-note">Permission mode<br /><strong>Full access</strong><br /><span>Destructive actions: Ask first</span></div></aside>
    <main><header><div><h1>{page}</h1><p>Sol-compatible local MCP workspace agent</p></div><div className="status-pill"><i className={status.running ? "dot online" : "dot"}></i>{status.running ? "Agent running" : "Agent offline"}</div></header>
      {!bridgeAvailable && <section className="panel"><h2>Open Codex BEG desktop app</h2><p>This renderer was opened without its secure Electron preload bridge. Launch the packaged app or use the desktop development command.</p></section>}
      {bridgeAvailable && page === "Home" && <Home status={status} onAdd={addProject} />}
      {bridgeAvailable && page === "Projects" && <Projects onAdd={addProject} />}
      {bridgeAvailable && page === "Live Logs" && <LiveLogs logs={logs} />}
      {bridgeAvailable && page === "Settings" && <Panel title="Settings"><label>MCP endpoint<input readOnly value="http://127.0.0.1:43123/mcp" /></label><label>Tunnel integration<input readOnly value="External tunnel-client (not managed)" /></label><p className="muted">Codex BEG does not make model API requests or store tunnel runtime keys.</p></Panel>}
      {bridgeAvailable && page === "Doctor" && <Panel title="Diagnostics"><button className="primary" onClick={async () => setDoctor(await window.codexBeg.doctor())}>Run checks</button>{doctor && <pre className="json">{JSON.stringify(doctor, null, 2)}</pre>}</Panel>}
    </main>
  </div>;
}

async function WindowStatus(set: (value: { running: boolean; health: unknown; events: unknown }) => void): Promise<void> { set(await window.codexBeg.status()); }
function Home({ status, onAdd }: { status: { running: boolean; health: unknown; events: unknown }; onAdd: () => Promise<void> }): React.JSX.Element { return <section className="grid"><article className="card wide"><span className="eyebrow">CURRENT WORKFLOW</span><h2>Planner: ChatGPT <span>→</span> Transport: Secure MCP Tunnel <span>→</span> Executor: Codex BEG Agent Host <span>→</span> Worker: local project commands</h2><div className="facts"><div><b>Agent</b><span>{status.running ? "Connected" : "Starting"}</span></div><div><b>MCP</b><span>127.0.0.1:43123/mcp</span></div><div><b>Codex CLI</b><span>Disabled</span></div></div></article><article className="card"><span className="eyebrow">ACTIVE PROJECT</span><h2>No project selected</h2><p>Add a local directory to create an isolated workspace.</p><button className="primary" onClick={() => void onAdd()}>+ Add project</button></article><article className="card"><span className="eyebrow">SAFETY</span><h2>Central policy enabled</h2><ul><li>Relative workspace paths</li><li>Atomic reversible writes</li><li>No raw shell or delete tool</li><li>Approval required for destructive operations</li></ul></article></section>; }
function Projects({ onAdd }: { onAdd: () => Promise<void> }): React.JSX.Element { const [state, setState] = useState<{ workspaces?: Array<{ id: string; displayName: string; canonicalRoot: string }>; currentWorkspaceId?: string | null }>({}); const refresh = () => void window.codexBeg.workspaceList().then((value) => setState(value as typeof state)); useEffect(refresh, []); return <Panel title="Projects"><p>Register local directories as isolated workspaces. Project files are never deleted when a registration is removed.</p><button className="primary" onClick={() => void onAdd().then(refresh)}>Choose project directory</button><div className="project-list">{state.workspaces?.map((workspace) => <div className="project-row" key={workspace.id}><div><strong>{workspace.displayName}</strong><small>{workspace.canonicalRoot}</small></div><span>{state.currentWorkspaceId === workspace.id ? "Active" : <button onClick={() => void window.codexBeg.workspaceSelect(workspace.id).then(refresh)}>Select</button>} <button onClick={() => void window.codexBeg.workspaceRemove(workspace.id).then(refresh)}>Remove</button></span></div>)}</div></Panel>; }
function LiveLogs({ logs }: { logs: string[] }): React.JSX.Element { const [approvals, setApprovals] = useState<Array<{ approvalId: string; action: string; exactOperation: string; risk: string; expiresAt: string; status: string }>>([]); const refresh = () => void window.codexBeg.approvals().then((value) => setApprovals(Array.isArray(value) ? value as typeof approvals : [])); useEffect(() => { refresh(); const timer = window.setInterval(refresh, 2000); return () => window.clearInterval(timer); }, []); return <Panel title="Live activity"><h3>Approval queue</h3>{approvals.filter((item) => item.status === "pending").map((item) => <div className="approval" key={item.approvalId}><strong>{item.action}</strong><code>{item.exactOperation}</code><small>{item.risk} · expires {item.expiresAt}</small><button className="primary" onClick={() => void window.codexBeg.approve(item.approvalId).then(refresh)}>Approve once</button><button onClick={() => void window.codexBeg.reject(item.approvalId).then(refresh)}>Reject</button></div>)}<pre className="logs">{logs.length ? logs.join("\n") : "Waiting for agent events…"}</pre></Panel>; }
function Panel({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element { return <section className="panel"><h2>{title}</h2>{children}</section>; }

createRoot(document.getElementById("root")!).render(<App />);
