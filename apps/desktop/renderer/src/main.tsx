import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Page = "Overview" | "Projects" | "Activity" | "Connection" | "Diagnostics";
type WorkspaceKind = "machine_root" | "project";
type StatusTone = "ok" | "warn" | "bad" | "neutral";
type TunnelAction = "idle" | "starting" | "stopping" | "saving" | "validating";

interface TunnelRuntimeStatus {
  alias: string;
  installed: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  runtimeState: string;
  tunnelId?: string;
  uiUrl?: string;
  executable?: string;
  error?: string;
  checkedAt: string;
}

interface TunnelConfigView {
  tunnelId: string;
  hasApiKey: boolean;
  secureStorageAvailable: boolean;
  validation: {
    state: "unconfigured" | "checking" | "valid" | "invalid";
    message: string;
    checkedAt?: string;
  };
}

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
  tunnel: TunnelRuntimeStatus;
  checkedAt: string;
}

const initialTunnel: TunnelRuntimeStatus = {
  alias: "codex-beg",
  installed: false,
  processRunning: false,
  healthy: false,
  ready: false,
  runtimeState: "checking",
  checkedAt: new Date().toISOString(),
};

const initialStatus: Status = {
  running: false,
  health: null,
  tunnel: initialTunnel,
  checkedAt: new Date().toISOString(),
};

const initialConfig: TunnelConfigView = {
  tunnelId: "",
  hasApiKey: false,
  secureStorageAvailable: true,
  validation: { state: "unconfigured", message: "Add your Tunnel ID and Runtime API key." },
};

function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>("Overview");
  const [status, setStatus] = useState<Status>(initialStatus);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>({ workspaces: [], currentWorkspaceId: null });
  const [config, setConfig] = useState<TunnelConfigView>(initialConfig);
  const [logs, setLogs] = useState<string[]>([]);
  const [doctor, setDoctor] = useState<Record<string, unknown> | null>(null);
  const [tunnelAction, setTunnelAction] = useState<TunnelAction>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const pages = useMemo<Page[]>(() => ["Overview", "Projects", "Activity", "Connection", "Diagnostics"], []);
  const bridgeAvailable = Boolean(window.codexBeg);

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!window.codexBeg) return;
    try { setStatus(await window.codexBeg.status()); } catch { /* next poll retries */ }
  }, []);

  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    if (!window.codexBeg) return;
    const value = await window.codexBeg.workspaceList();
    if (!isError(value)) setWorkspaceState(value as WorkspaceState);
  }, []);

  const refreshConfig = useCallback(async (): Promise<void> => {
    if (!window.codexBeg) return;
    try { setConfig(await window.codexBeg.tunnelConfig()); } catch { /* secure bridge reports on next event */ }
  }, []);

  useEffect(() => {
    if (!window.codexBeg) return;
    const api = window.codexBeg;
    void refreshStatus();
    void refreshWorkspaces();
    void refreshConfig();
    const removeLog = api.onLog((line) => setLogs((items) => [...items.slice(-299), line]));
    const removeTunnel = api.onTunnelStatus((value) => setStatus((current) => ({ ...current, tunnel: value, checkedAt: new Date().toISOString() })));
    const removeConfig = api.onTunnelConfig((value) => setConfig(value));
    const statusTimer = window.setInterval(() => void refreshStatus(), 1_000);
    const workspaceTimer = window.setInterval(() => void refreshWorkspaces(), 1_500);
    return () => {
      removeLog();
      removeTunnel();
      removeConfig();
      window.clearInterval(statusTimer);
      window.clearInterval(workspaceTimer);
    };
  }, [refreshConfig, refreshStatus, refreshWorkspaces]);

  const activeProject = workspaceState.workspaces.find((workspace) => workspace.id === workspaceState.currentWorkspaceId && workspace.kind === "project");

  const addWorkspace = useCallback(async (kind: WorkspaceKind): Promise<void> => {
    if (!window.codexBeg) return;
    const result = await window.codexBeg.workspaceAdd(kind);
    if (result === null) return;
    if (isError(result)) {
      setNotice(result.error);
      return;
    }
    setLogs((items) => [...items.slice(-299), `${kind === "machine_root" ? "Machine root" : "Project"} added.`]);
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  const startTunnel = useCallback(async (): Promise<void> => {
    if (!window.codexBeg || tunnelAction !== "idle") return;
    setTunnelAction("starting");
    setNotice(null);
    try {
      const result = await window.codexBeg.tunnelStart();
      setStatus((current) => ({ ...current, tunnel: result.status, checkedAt: new Date().toISOString() }));
      setConfig(result.config);
      if (result.error) setNotice(result.error);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setTunnelAction("idle");
    }
  }, [tunnelAction]);

  const stopTunnel = useCallback(async (): Promise<void> => {
    if (!window.codexBeg || tunnelAction !== "idle") return;
    setTunnelAction("stopping");
    setNotice(null);
    try {
      const result = await window.codexBeg.tunnelStop();
      setStatus((current) => ({ ...current, tunnel: result.status, checkedAt: new Date().toISOString() }));
      if (result.error) setNotice(result.error);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setTunnelAction("idle");
    }
  }, [tunnelAction]);

  const saveAndValidate = useCallback(async (tunnelId: string, apiKey: string): Promise<void> => {
    if (!window.codexBeg || tunnelAction !== "idle") return;
    setTunnelAction("saving");
    setNotice(null);
    try {
      const saved = await window.codexBeg.tunnelSaveConfig({ tunnelId, apiKey });
      setConfig(saved);
      setTunnelAction("validating");
      const validated = await window.codexBeg.tunnelValidateConfig();
      setConfig(validated);
      if (validated.validation.state === "invalid") setNotice(validated.validation.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setTunnelAction("idle");
    }
  }, [tunnelAction]);

  const validateConfig = useCallback(async (): Promise<void> => {
    if (!window.codexBeg || tunnelAction !== "idle") return;
    setTunnelAction("validating");
    setNotice(null);
    try {
      const value = await window.codexBeg.tunnelValidateConfig();
      setConfig(value);
      if (value.validation.state === "invalid") setNotice(value.validation.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setTunnelAction("idle");
    }
  }, [tunnelAction]);

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setPage("Overview")} aria-label="Codex BEG overview">
        <LogoMark />
        <div><strong>Codex BEG</strong><small>Local workspace agent</small></div>
      </button>
      <nav>{pages.map((item) => <button className={page === item ? "nav active" : "nav"} key={item} onClick={() => setPage(item)}>{item}</button>)}</nav>
      <div className="sidebar-footer"><span className="mini-dot ok" />Protected mode<small>Writes are reversible · destructive actions ask first</small></div>
    </aside>

    <main className="content">
      <header className="topbar">
        <div><h1>{page}</h1>{page === "Overview" && <p>Everything you need at a glance.</p>}</div>
        <StatusStrip status={status} />
      </header>

      {notice && <div className="notice" role="status"><span>{notice}</span><button onClick={() => setNotice(null)}>Dismiss</button></div>}
      {!bridgeAvailable && <Panel title="Open Codex BEG"><p className="muted">This screen needs the desktop app secure bridge.</p></Panel>}
      {bridgeAvailable && page === "Overview" && <Overview status={status} config={config} action={tunnelAction} activeProject={activeProject} logs={logs} onStart={startTunnel} onStop={stopTunnel} onAddProject={() => addWorkspace("project")} onOpenProjects={() => setPage("Projects")} onOpenConnection={() => setPage("Connection")} />}
      {bridgeAvailable && page === "Projects" && <Projects state={workspaceState} onRefresh={refreshWorkspaces} onAddProject={() => addWorkspace("project")} onAddMachineRoot={() => addWorkspace("machine_root")} />}
      {bridgeAvailable && page === "Activity" && <Activity logs={logs} />}
      {bridgeAvailable && page === "Connection" && <ConnectionPanel status={status} config={config} action={tunnelAction} onSave={saveAndValidate} onValidate={validateConfig} onStart={startTunnel} onStop={stopTunnel} />}
      {bridgeAvailable && page === "Diagnostics" && <Diagnostics doctor={doctor} setDoctor={setDoctor} setLogs={setLogs} />}
    </main>
  </div>;
}

function LogoMark(): React.JSX.Element {
  return <svg className="logo-mark" viewBox="0 0 40 40" aria-hidden="true">
    <defs><linearGradient id="begGradient" x1="4" y1="6" x2="36" y2="34" gradientUnits="userSpaceOnUse"><stop stopColor="#2563eb"/><stop offset="1" stopColor="#14b8a6"/></linearGradient></defs>
    <rect x="3" y="3" width="34" height="34" rx="11" fill="url(#begGradient)"/>
    <path d="M9.5 20 15.2 14.3 20.9 20l-5.7 5.7L9.5 20Z" fill="none" stroke="white" strokeWidth="2.4" strokeLinejoin="round"/>
    <path d="m19.1 20 5.7-5.7 5.7 5.7-5.7 5.7-5.7-5.7Z" fill="none" stroke="white" strokeWidth="2.4" strokeLinejoin="round"/>
  </svg>;
}

function Overview({ status, config, action, activeProject, logs, onStart, onStop, onAddProject, onOpenProjects, onOpenConnection }: {
  status: Status;
  config: TunnelConfigView;
  action: TunnelAction;
  activeProject: Workspace | undefined;
  logs: string[];
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onAddProject: () => Promise<void>;
  onOpenProjects: () => void;
  onOpenConnection: () => void;
}): React.JSX.Element {
  const tunnel = status.tunnel;
  return <section className="overview-grid">
    <article className="hero-card">
      <div className="hero-copy">
        <span className="eyebrow">SECURE CONNECTION</span>
        <h2>{tunnel.ready ? "Connected and ready" : tunnel.processRunning ? "Tunnel is starting" : "Tunnel is stopped"}</h2>
        <p>{tunnel.ready ? "ChatGPT can reach your local workspace through the secure tunnel." : config.validation.state === "valid" ? "Configuration is verified. Start the tunnel when you need remote access." : "Configure and verify your tunnel before starting."}</p>
      </div>
      <div className="hero-actions">
        <StatusBadge tone={tunnelTone(tunnel)} label={tunnelLabel(tunnel)} />
        {tunnel.processRunning
          ? <button className="danger-soft" disabled={action !== "idle"} onClick={() => void onStop()}>{action === "stopping" ? "Stopping…" : "Stop tunnel"}</button>
          : <button className="primary" disabled={action !== "idle" || config.validation.state !== "valid" || !mcpReady(status)} onClick={() => void onStart()}>{action === "starting" ? "Starting…" : "Start tunnel"}</button>}
        <button className="text-button" onClick={onOpenConnection}>Connection settings</button>
      </div>
    </article>

    <article className="card">
      <div className="card-head"><span className="eyebrow">ACTIVE PROJECT</span><button className="text-button" onClick={onOpenProjects}>Manage</button></div>
      {activeProject ? <><h2>{activeProject.displayName}</h2><p className="path-text">{activeProject.canonicalRoot}</p><div className="meta-row"><span>{activeProject.projectType || "project"}</span><span className="status-dot-label"><i className="mini-dot ok"/>Selected</span></div></> : <><h2>No project selected</h2><p>Choose a project to make it the default workspace.</p><button className="secondary" onClick={() => void onAddProject()}>Add project</button></>}
    </article>

    <article className="card">
      <div className="card-head"><span className="eyebrow">SYSTEM</span><span className="live-label"><i className="mini-dot ok"/>Live</span></div>
      <div className="system-list">
        <SystemRow label="Agent" value={status.running ? "Running" : "Offline"} tone={status.running ? "ok" : "bad"}/>
        <SystemRow label="Local MCP" value={mcpReady(status) ? "Ready" : "Unavailable"} tone={mcpReady(status) ? "ok" : "bad"}/>
        <SystemRow label="Tunnel" value={tunnelLabel(tunnel)} tone={tunnelTone(tunnel)}/>
      </div>
    </article>

    <article className="card wide-card">
      <div className="card-head"><span className="eyebrow">RECENT ACTIVITY</span><span className="muted-small">updates instantly</span></div>
      <div className="activity-preview">{logs.length ? logs.slice(-5).reverse().map((line, index) => <div key={`${line}-${index}`}>{line}</div>) : <span className="muted">No activity yet.</span>}</div>
    </article>
  </section>;
}

function ConnectionPanel({ status, config, action, onSave, onValidate, onStart, onStop }: {
  status: Status;
  config: TunnelConfigView;
  action: TunnelAction;
  onSave: (tunnelId: string, apiKey: string) => Promise<void>;
  onValidate: () => Promise<void>;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
}): React.JSX.Element {
  const [tunnelId, setTunnelId] = useState(config.tunnelId);
  const [apiKey, setApiKey] = useState("");
  useEffect(() => { setTunnelId(config.tunnelId); }, [config.tunnelId]);
  const validationTone: StatusTone = config.validation.state === "valid" ? "ok" : config.validation.state === "invalid" ? "bad" : config.validation.state === "checking" ? "warn" : "neutral";
  const busy = action !== "idle";

  return <section className="connection-layout">
    <Panel title="Tunnel configuration">
      <p className="muted">Save once on this Mac. The API key is encrypted by the operating system and is never shown again.</p>
      <div className="form-grid">
        <label><span>Tunnel ID</span><input autoComplete="off" spellCheck={false} value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} placeholder="tunnel_0123456789abcdef0123456789abcdef" /></label>
        <label><span>Runtime API key</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.hasApiKey ? "Saved securely — leave blank to keep it" : "Paste Runtime API key"} /></label>
      </div>
      <div className="validation-box">
        <StatusBadge tone={validationTone} label={validationLabel(config.validation.state)} />
        <span>{config.validation.message}</span>
      </div>
      {!config.secureStorageAvailable && <p className="inline-error">Secure credential storage is unavailable. The API key will not be saved.</p>}
      <div className="button-row">
        <button className="primary" disabled={busy || !tunnelId.trim()} onClick={() => { void onSave(tunnelId, apiKey); setApiKey(""); }}>{action === "saving" || action === "validating" ? "Checking…" : "Save & verify"}</button>
        <button className="secondary" disabled={busy || !config.hasApiKey} onClick={() => void onValidate()}>Verify again</button>
      </div>
    </Panel>

    <Panel title="Tunnel control">
      <div className="runtime-hero"><StatusBadge tone={tunnelTone(status.tunnel)} label={tunnelLabel(status.tunnel)} /><strong>{status.tunnel.ready ? "Ready for ChatGPT" : status.tunnel.processRunning ? "Runtime is running" : "Runtime is stopped"}</strong></div>
      <dl className="detail-list">
        <div><dt>Process</dt><dd>{status.tunnel.processRunning ? "running" : "stopped"}</dd></div>
        <div><dt>Health</dt><dd>{status.tunnel.healthy ? "healthy" : "not healthy"}</dd></div>
        <div><dt>Ready</dt><dd>{status.tunnel.ready ? "yes" : "no"}</dd></div>
        <div><dt>Tunnel ID</dt><dd>{status.tunnel.tunnelId ?? (config.tunnelId || "—")}</dd></div>
        <div><dt>Last check</dt><dd>{formatCheckedAt(status.tunnel.checkedAt)}</dd></div>
      </dl>
      {status.tunnel.error && !status.tunnel.ready && <p className="inline-warning">{status.tunnel.error}</p>}
      <div className="button-row">
        {status.tunnel.processRunning
          ? <button className="danger-soft" disabled={busy} onClick={() => void onStop()}>{action === "stopping" ? "Stopping…" : "Stop tunnel"}</button>
          : <button className="primary" disabled={busy || config.validation.state !== "valid" || !mcpReady(status)} onClick={() => void onStart()}>{action === "starting" ? "Starting…" : "Start tunnel"}</button>}
      </div>
    </Panel>
  </section>;
}

function Projects({ state, onRefresh, onAddProject, onAddMachineRoot }: { state: WorkspaceState; onRefresh: () => Promise<void>; onAddProject: () => Promise<void>; onAddMachineRoot: () => Promise<void> }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const selectWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    const value = await window.codexBeg.workspaceSelect(workspaceId);
    if (isError(value)) setError(value.error); else { setError(null); await onRefresh(); }
  }, [onRefresh]);
  const removeWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    const value = await window.codexBeg.workspaceRemove(workspaceId);
    if (isError(value)) setError(value.error); else { setError(null); await onRefresh(); }
  }, [onRefresh]);
  const registerChild = useCallback(async (parentWorkspaceId: string): Promise<void> => {
    const value = await window.codexBeg.workspaceRegisterDirectory(parentWorkspaceId);
    if (value === null) return;
    if (isError(value)) setError(value.error); else { setError(null); await onRefresh(); }
  }, [onRefresh]);

  const roots = state.workspaces.filter((workspace) => workspace.kind === "machine_root");
  const projects = state.workspaces.filter((workspace) => workspace.kind === "project");
  const children = (parentId: string): Workspace[] => projects.filter((workspace) => workspace.parentWorkspaceId === parentId);
  const orphanedProjects = projects.filter((workspace) => !workspace.parentWorkspaceId || !roots.some((root) => root.id === workspace.parentWorkspaceId));

  return <Panel title="Projects">
    <div className="panel-toolbar"><p className="muted">Add only the folders you want Codex BEG to access.</p><div className="button-row compact"><button className="primary" onClick={() => void onAddProject()}>Add project</button><button className="secondary" onClick={() => void onAddMachineRoot()}>Add folder group</button></div></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="project-list">{roots.map((root) => <WorkspaceGroup key={root.id} root={root} children={children(root.id)} currentWorkspaceId={state.currentWorkspaceId} onSelect={selectWorkspace} onRemove={removeWorkspace} onRegisterChild={registerChild} />)}{orphanedProjects.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} current={state.currentWorkspaceId === workspace.id} onSelect={selectWorkspace} onRemove={removeWorkspace} />)}{state.workspaces.length === 0 && <EmptyState title="No projects yet" body="Add a project to get started." />}</div>
  </Panel>;
}

function WorkspaceGroup({ root, children, currentWorkspaceId, onSelect, onRemove, onRegisterChild }: { root: Workspace; children: Workspace[]; currentWorkspaceId: string | null; onSelect: (workspaceId: string) => Promise<void>; onRemove: (workspaceId: string) => Promise<void>; onRegisterChild: (workspaceId: string) => Promise<void> }): React.JSX.Element {
  return <div className="workspace-group"><WorkspaceRow workspace={root} current={false} onSelect={onSelect} onRemove={onRemove} /><div className="workspace-children"><button className="text-button add-child" onClick={() => void onRegisterChild(root.id)}>+ Add project inside {root.displayName}</button>{children.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} current={currentWorkspaceId === workspace.id} child onSelect={onSelect} onRemove={onRemove} />)}</div></div>;
}

function WorkspaceRow({ workspace, current, child = false, onSelect, onRemove }: { workspace: Workspace; current: boolean; child?: boolean; onSelect: (workspaceId: string) => Promise<void>; onRemove: (workspaceId: string) => Promise<void> }): React.JSX.Element {
  return <div className={`project-row${child ? " child-row" : ""}${current ? " current" : ""}`}><div className="project-main"><div className="project-title"><strong>{workspace.displayName}</strong>{current && <span className="active-chip">Active</span>}</div><small>{workspace.canonicalRoot}</small></div><div className="row-actions">{workspace.kind === "project" && !current && <button className="secondary small" onClick={() => void onSelect(workspace.id)}>Select</button>}<button className="ghost small" onClick={() => void onRemove(workspace.id)}>Remove</button></div></div>;
}

type ApprovalView = { approvalId: string; action: string; classification: string; exactOperation: string; risk: string; expiresAt: string; status: string };
type OperationView = { operationId: string; kind: string; status: string; workspaceId: string; updatedAt: string; error?: string };
type RecoveryView = { operationId: string; workspaceId: string; createdAt: string; status: string; changes: Array<{ path: string; existed: boolean }> };

function Activity({ logs }: { logs: string[] }): React.JSX.Element {
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
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1_000); return () => window.clearInterval(timer); }, [refresh]);
  const restore = async (operationId: string): Promise<void> => { const value = await window.codexBeg.restore(operationId); setNotice(isError(value) ? value.error : `Restore completed for ${operationId}.`); await refresh(); };
  const pending = approvals.filter((item) => item.status === "pending");
  const recentOperations = [...operations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 20);
  const recentRecovery = [...recovery].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 12);

  return <section className="activity-grid">
    <Panel title="Approvals"><div className="section-live"><i className="mini-dot ok"/>Live</div>{pending.length === 0 && <p className="muted">Nothing waiting for approval.</p>}{pending.map((item) => <div className="approval" key={item.approvalId}><strong>{item.action}</strong><code>{item.exactOperation}</code><small>{item.classification} · {item.risk}</small><div className="button-row compact"><button className="primary" onClick={() => void window.codexBeg.approve(item.approvalId).then(refresh)}>Approve once</button><button className="secondary" onClick={() => void window.codexBeg.reject(item.approvalId).then(refresh)}>Reject</button></div></div>)}</Panel>
    <Panel title="Operations"><div className="simple-list">{recentOperations.map((item) => <div className="simple-row" key={item.operationId}><div><strong>{item.kind}</strong><small>{item.error ?? item.operationId}</small></div><StatusBadge tone={operationTone(item.status)} label={item.status}/></div>)}{recentOperations.length === 0 && <p className="muted">No operations yet.</p>}</div></Panel>
    <Panel title="Recovery">{notice && <p className="inline-warning">{notice}</p>}<div className="simple-list">{recentRecovery.map((item) => <div className="simple-row" key={item.operationId}><div><strong>{item.changes.map((change) => change.path).join(", ")}</strong><small>{item.operationId}</small></div><div className="row-actions"><span>{item.status}</span>{["applied", "restore_conflict"].includes(item.status) && <button className="secondary small" onClick={() => void restore(item.operationId)}>Restore</button>}</div></div>)}{recentRecovery.length === 0 && <p className="muted">No recovery points.</p>}</div></Panel>
    <Panel title="Live log"><pre className="logs">{logs.length ? logs.join("\n") : "Waiting for activity…"}</pre></Panel>
  </section>;
}

function Diagnostics({ doctor, setDoctor, setLogs }: { doctor: Record<string, unknown> | null; setDoctor: (value: Record<string, unknown>) => void; setLogs: React.Dispatch<React.SetStateAction<string[]>> }): React.JSX.Element {
  return <Panel title="Diagnostics"><p className="muted">Use these checks when something is not connecting as expected.</p><div className="button-row"><button className="primary" onClick={async () => setDoctor(await window.codexBeg.doctor())}>Run checks</button><button className="secondary" onClick={async () => { const result = await window.codexBeg.restartAgentHost(); setLogs((items) => [...items.slice(-299), `Agent Host restart: ${JSON.stringify(result)}`]); setDoctor(await window.codexBeg.doctor()); }}>Restart local agent</button></div>{doctor && <pre className="json">{JSON.stringify(doctor, null, 2)}</pre>}</Panel>;
}

function StatusStrip({ status }: { status: Status }): React.JSX.Element {
  return <div className="status-strip" aria-label="Live status"><StatusSignal label="Agent" value={status.running ? "Running" : "Offline"} tone={status.running ? "ok" : "bad"}/><StatusSignal label="MCP" value={mcpReady(status) ? "Ready" : "Offline"} tone={mcpReady(status) ? "ok" : "bad"}/><StatusSignal label="Tunnel" value={tunnelLabel(status.tunnel)} tone={tunnelTone(status.tunnel)}/></div>;
}

function StatusSignal({ label, value, tone }: { label: string; value: string; tone: StatusTone }): React.JSX.Element { return <div className={`status-signal ${tone}`}><i className="signal-dot"/><span><small>{label}</small><strong>{value}</strong></span></div>; }
function StatusBadge({ label, tone }: { label: string; tone: StatusTone }): React.JSX.Element { return <span className={`status-badge ${tone}`}><i className="mini-dot"/>{label}</span>; }
function SystemRow({ label, value, tone }: { label: string; value: string; tone: StatusTone }): React.JSX.Element { return <div className="system-row"><span>{label}</span><StatusBadge label={value} tone={tone}/></div>; }
function EmptyState({ title, body }: { title: string; body: string }): React.JSX.Element { return <div className="empty-state"><strong>{title}</strong><span>{body}</span></div>; }
function Panel({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element { return <section className="panel"><h2>{title}</h2>{children}</section>; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isError(value: unknown): value is { error: string } { return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"; }
function mcpReady(status: Status): boolean { return status.running && isRecord(status.health) && status.health.ok === true; }
function tunnelTone(tunnel: TunnelRuntimeStatus): StatusTone { if (tunnel.ready) return "ok"; if (tunnel.processRunning || tunnel.healthy) return "warn"; if (tunnel.error && tunnel.runtimeState !== "stopped" && tunnel.runtimeState !== "not_installed") return "bad"; return "neutral"; }
function tunnelLabel(tunnel: TunnelRuntimeStatus): string { if (!tunnel.installed) return "Not installed"; if (tunnel.ready) return "Ready"; if (tunnel.healthy) return "Healthy"; if (tunnel.processRunning) return "Running"; if (tunnel.runtimeState === "checking") return "Checking"; return "Stopped"; }
function validationLabel(state: TunnelConfigView["validation"]["state"]): string { return state === "valid" ? "Verified" : state === "invalid" ? "Invalid" : state === "checking" ? "Checking" : "Not verified"; }
function operationTone(status: string): StatusTone { return status === "succeeded" || status === "completed" ? "ok" : status === "failed" ? "bad" : status === "running" || status === "approval_required" ? "warn" : "neutral"; }
function formatCheckedAt(value: string): string { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleTimeString(); }

createRoot(document.getElementById("root")!).render(<App />);
