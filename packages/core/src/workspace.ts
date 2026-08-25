import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { JsonStore } from "./persistence.js";
import { PathViolationError, CodexBegError } from "./errors.js";
import { EventBus } from "./events.js";
import type { CommandConfig, ProjectType, RegistryState, SearchFilesResult, Workspace, WorkspaceKind } from "./types.js";
import { PROJECT_TYPES, WORKSPACE_KINDS } from "./types.js";

const EMPTY_REGISTRY: RegistryState = { schemaVersion: 1, workspaces: [], currentWorkspaceId: null };
const IGNORED = new Set([".git", "node_modules", ".pnpm-store", ".turbo", "dist", "build", "out", ".output", ".next", "target", ".dart_tool", "coverage", "cache", ".cache", "vendor", "obj", ".venv", "venv", "__pycache__"]);

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function detectProject(root: string): Promise<{ type: ProjectType; commands: CommandConfig }> {
  const exists = async (name: string) => { try { await access(join(root, name)); return true; } catch { return false; } };
  const commands: CommandConfig = {};
  if (await exists("package.json")) {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const manager = await exists("pnpm-lock.yaml") ? "pnpm" : await exists("yarn.lock") ? "yarn" : "npm";
    const executable = process.platform === "win32" ? `${manager}.cmd` : manager;
    for (const name of ["test", "lint", "typecheck", "build", "dev"] as const) {
      if (packageJson.scripts?.[name]) commands[name] = { executable, args: ["run", name], script: packageJson.scripts[name] };
    }
    return { type: PROJECT_TYPES.node, commands };
  }
  if (await exists("pubspec.yaml")) {
    commands.test = { executable: process.platform === "win32" ? "flutter.bat" : "flutter", args: ["test"] };
    commands.lint = { executable: process.platform === "win32" ? "flutter.bat" : "flutter", args: ["analyze"] };
    return { type: PROJECT_TYPES.flutter, commands };
  }
  if (await exists("Cargo.toml")) {
    commands.test = { executable: "cargo", args: ["test"] };
    commands.lint = { executable: "cargo", args: ["clippy"] };
    commands.typecheck = { executable: "cargo", args: ["check"] };
    commands.build = { executable: "cargo", args: ["build"] };
    return { type: PROJECT_TYPES.rust, commands };
  }
  if (await exists("go.mod")) {
    commands.test = { executable: "go", args: ["test", "./..."] };
    commands.lint = { executable: "go", args: ["vet", "./..."] };
    commands.build = { executable: "go", args: ["build", "./..."] };
    return { type: PROJECT_TYPES.go, commands };
  }
  if (await exists("pom.xml") || await exists("mvnw") || await exists("mvnw.cmd")) {
    const executable = process.platform === "win32" && await exists("mvnw.cmd") ? "mvnw.cmd" : await exists("mvnw") ? "./mvnw" : "mvn";
    commands.test = { executable, args: ["test"] };
    commands.build = { executable, args: ["package", "-DskipTests"] };
    return { type: PROJECT_TYPES.maven, commands };
  }
  if (await exists("build.gradle") || await exists("build.gradle.kts") || await exists("gradlew") || await exists("gradlew.bat")) {
    const executable = process.platform === "win32" && await exists("gradlew.bat") ? "gradlew.bat" : await exists("gradlew") ? "./gradlew" : "gradle";
    commands.test = { executable, args: ["test"] };
    commands.build = { executable, args: ["build"] };
    return { type: PROJECT_TYPES.gradle, commands };
  }
  const hasDotnetFile = (await readdir(root)).some((name) => name.endsWith(".sln") || name.endsWith(".csproj"));
  if (hasDotnetFile) {
    commands.test = { executable: "dotnet", args: ["test"] };
    commands.build = { executable: "dotnet", args: ["build"] };
    return { type: PROJECT_TYPES.dotnet, commands };
  }
  return { type: PROJECT_TYPES.unknown, commands };
}

export class WorkspaceManager {
  private state: RegistryState = EMPTY_REGISTRY;

  constructor(private readonly store: JsonStore<RegistryState>, private readonly events = new EventBus()) {}

  async init(): Promise<void> {
    this.state = await this.store.load();
    let migrated = false;
    for (const workspace of this.state.workspaces) {
      if (!(workspace as Partial<Workspace>).kind) {
        workspace.kind = WORKSPACE_KINDS.project;
        migrated = true;
      }
    }
    if (migrated) await this.store.save(this.state);
  }
  getState(): RegistryState { return structuredClone(this.state); }

  async add(rootPath: string, displayName?: string, kind: WorkspaceKind = WORKSPACE_KINDS.project, parentWorkspaceId?: string): Promise<Workspace> {
    if (!isAbsolute(rootPath)) throw new PathViolationError("Workspace root must be an absolute path.");
    const root = await realpath(rootPath);
    const info = await stat(root);
    if (!info.isDirectory()) throw new CodexBegError("INVALID_WORKSPACE", "Workspace root must be a directory.");
    const existing = this.state.workspaces.find((item) => normalizeForCompare(item.canonicalRoot) === normalizeForCompare(root));
    if (existing) {
      if (existing.kind !== kind) throw new CodexBegError("WORKSPACE_KIND_CONFLICT", `Workspace already exists as ${existing.kind}; cannot reuse it as ${kind}.`);
      return existing;
    }
    const detected = kind === WORKSPACE_KINDS.project ? await detectProject(root) : { type: PROJECT_TYPES.unknown, commands: {} };
    const now = new Date().toISOString();
    const workspace: Workspace = { id: randomUUID(), displayName: displayName ?? root.split(/[\\/]/).pop() ?? "Workspace", kind, canonicalRoot: root, projectType: detected.type, commands: detected.commands, createdAt: now, updatedAt: now };
    if (parentWorkspaceId) workspace.parentWorkspaceId = parentWorkspaceId;
    this.state.workspaces.push(workspace);
    if (!this.state.currentWorkspaceId) this.state.currentWorkspaceId = workspace.id;
    await this.store.save(this.state);
    this.events.emit("workspace.changed", { action: "added", workspaceId: workspace.id });
    return workspace;
  }

  async register(parentWorkspaceId: string, path: string, displayName?: string): Promise<Workspace> {
    const parent = this.require(parentWorkspaceId);
    if (parent.kind !== WORKSPACE_KINDS.machineRoot) throw new CodexBegError("INVALID_WORKSPACE", "Child projects may only be registered below a machine root.");
    const resolved = await this.resolvePath(parentWorkspaceId, path);
    const info = await stat(resolved.absolute);
    if (!info.isDirectory()) throw new CodexBegError("INVALID_WORKSPACE", "Registered project path must be a directory.");
    const canonicalPath = await realpath(resolved.absolute);
    if (normalizeForCompare(parent.canonicalRoot) === normalizeForCompare(canonicalPath)) throw new CodexBegError("INVALID_WORKSPACE", "Child project path must be below the parent workspace root.");
    const existing = this.state.workspaces.find((item) => normalizeForCompare(item.canonicalRoot) === normalizeForCompare(canonicalPath));
    if (existing) {
      if (existing.kind !== WORKSPACE_KINDS.project) throw new CodexBegError("WORKSPACE_KIND_CONFLICT", "A machine-root workspace cannot be registered as a child project.");
      existing.parentWorkspaceId = parentWorkspaceId;
      existing.updatedAt = new Date().toISOString();
      await this.store.save(this.state);
      this.events.emit("workspace.changed", { action: "registered", workspaceId: existing.id, parentWorkspaceId });
      return existing;
    }
    return this.add(canonicalPath, displayName, WORKSPACE_KINDS.project, parentWorkspaceId);
  }

  async select(id: string): Promise<Workspace> {
    const workspace = this.require(id);
    this.state.currentWorkspaceId = workspace.id;
    await this.store.save(this.state);
    this.events.emit("workspace.changed", { action: "selected", workspaceId: workspace.id });
    return workspace;
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    this.state.workspaces = this.state.workspaces.filter((item) => item.id !== id);
    const unlinkedAt = new Date().toISOString();
    for (const workspace of this.state.workspaces) {
      if (workspace.parentWorkspaceId !== id) continue;
      delete workspace.parentWorkspaceId;
      workspace.updatedAt = unlinkedAt;
    }
    if (this.state.currentWorkspaceId === id) this.state.currentWorkspaceId = this.state.workspaces[0]?.id ?? null;
    await this.store.save(this.state);
    this.events.emit("workspace.changed", { action: "removed", workspaceId: id });
  }

  require(id: string): Workspace {
    const workspace = this.state.workspaces.find((item) => item.id === id);
    if (!workspace) throw new CodexBegError("WORKSPACE_NOT_FOUND", `Unknown workspace: ${id}`);
    return workspace;
  }

  requireProject(id: string): Workspace {
    const workspace = this.require(id);
    if (workspace.kind !== WORKSPACE_KINDS.project) throw new CodexBegError("PROJECT_WORKSPACE_REQUIRED", "This operation requires a project workspace.");
    return workspace;
  }

  current(): Workspace | null { return this.state.currentWorkspaceId ? this.require(this.state.currentWorkspaceId) : null; }

  async resolvePath(workspaceId: string, input: string, allowMissing = false): Promise<{ workspace: Workspace; absolute: string; relativePath: string }> {
    const workspace = this.require(workspaceId);
    if (!input || input.includes("\0") || isAbsolute(input)) throw new PathViolationError("Only relative paths are allowed.");
    const normalizedInput = input.replaceAll("\\", "/");
    if (normalizedInput.split("/").some((part) => part === "..")) throw new PathViolationError("Parent traversal is not allowed.");
    if (/^[A-Za-z]:(?:[\\/]|$)/.test(normalizedInput) || normalizedInput.startsWith("//") || normalizedInput.startsWith("/?/") || normalizedInput.startsWith("/.")) throw new PathViolationError("Windows device, drive, and UNC paths are not allowed.");
    const components = normalizedInput.split("/");
    if (components.some((part) => part.includes(":"))) throw new PathViolationError("Alternate data stream paths are not allowed.");
    if (components.some((part) => /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part) || (part !== "." && /[ .]$/.test(part)))) throw new PathViolationError("Windows reserved device names and ambiguous trailing-dot paths are not allowed.");
    const candidate = resolve(workspace.canonicalRoot, input);
    let checked = candidate;
    try { checked = await realpath(candidate); } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let parent = dirname(candidate);
      while (parent !== dirname(parent)) {
        try { checked = resolve(await realpath(parent), relative(parent, candidate)); break; } catch { parent = dirname(parent); }
      }
    }
    if (!isInside(normalizeForCompare(workspace.canonicalRoot), normalizeForCompare(checked))) throw new PathViolationError("Resolved path escapes the registered workspace.");
    return { workspace, absolute: candidate, relativePath: relative(workspace.canonicalRoot, candidate) || "." };
  }

  async tree(workspaceId: string, maxDepth = 6, maxEntries = 2000): Promise<Array<{ path: string; kind: "file" | "directory"; size?: number }>> {
    const workspace = this.require(workspaceId);
    const result: Array<{ path: string; kind: "file" | "directory"; size?: number }> = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > maxDepth || result.length >= maxEntries) return;
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        if (IGNORED.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        const relativePath = relative(workspace.canonicalRoot, absolute);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { result.push({ path: relativePath, kind: "directory" }); await visit(absolute, depth + 1); }
        else { const info = await stat(absolute); result.push({ path: relativePath, kind: "file", size: info.size }); }
        if (result.length >= maxEntries) return;
      }
    };
    await visit(workspace.canonicalRoot, 0);
    return result;
  }

  async snapshot(workspaceId: string): Promise<{ workspace: Workspace; tree: Awaited<ReturnType<WorkspaceManager["tree"]>>; git?: unknown }> {
    const workspace = this.require(workspaceId);
    return { workspace, tree: await this.tree(workspaceId) };
  }

  async search(workspaceId: string, query: string, rootPath?: string, maxResults = 200): Promise<Array<{ path: string; line: number; text: string }>> {
    const start = rootPath ? (await this.resolvePath(workspaceId, rootPath)).absolute : this.require(workspaceId).canonicalRoot;
    const result: Array<{ path: string; line: number; text: string }> = [];
    const rootStat = await stat(start);
    if (rootStat.isFile()) {
      try {
        const content = await readFile(start);
        if (!content.includes(0)) {
          content.toString("utf8").split(/\r?\n/).forEach((line, index) => {
            if (result.length < maxResults && line.toLowerCase().includes(query.toLowerCase())) result.push({ path: relative(this.require(workspaceId).canonicalRoot, start), line: index + 1, text: line.slice(0, 500) });
          });
        }
      } catch { /* unreadable/binary files are skipped */ }
      return result;
    }
    const visit = async (directory: string): Promise<void> => {
      if (result.length >= maxResults) return;
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else {
          try {
          const info = await stat(absolute);
          if (info.size > 256 * 1024) continue;
          const content = await readFile(absolute);
            if (content.includes(0)) continue;
            const lines = content.toString("utf8").split(/\r?\n/);
            lines.forEach((line, index) => { if (result.length < maxResults && line.toLowerCase().includes(query.toLowerCase())) result.push({ path: relative(this.require(workspaceId).canonicalRoot, absolute), line: index + 1, text: line.slice(0, 500) }); });
          } catch { /* unreadable/binary files are skipped */ }
        }
      }
    };
    await visit(start);
    return result;
  }

  async searchTextPage(workspaceId: string, query: string, rootPath?: string, offset = 0, maxResults = 100): Promise<{ items: Array<{ path: string; line: number; text: string }>; truncated: boolean; nextOffset: number | null }> {
    const workspace = this.require(workspaceId);
    const start = rootPath ? (await this.resolvePath(workspaceId, rootPath)).absolute : workspace.canonicalRoot;
    const normalizedQuery = query.toLocaleLowerCase();
    const items: Array<{ path: string; line: number; text: string }> = [];
    let skipped = 0;
    let truncated = false;
    const consider = (path: string, line: number, text: string): void => {
      if (truncated) return;
      if (skipped < offset) { skipped += 1; return; }
      if (items.length >= maxResults) { truncated = true; return; }
      items.push({ path, line, text: text.slice(0, 500) });
    };
    const inspect = async (absolute: string): Promise<void> => {
      if (truncated) return;
      try {
        const info = await stat(absolute);
        if (!info.isFile() || info.size > 256 * 1024) return;
        const content = await readFile(absolute);
        if (content.includes(0)) return;
        const relativePath = relative(workspace.canonicalRoot, absolute);
        const lines = content.toString("utf8").split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (line.toLocaleLowerCase().includes(normalizedQuery)) consider(relativePath, index + 1, line);
          if (truncated) return;
        }
      } catch { /* unreadable/binary files are skipped */ }
    };
    const rootStat = await stat(start);
    if (rootStat.isFile()) {
      await inspect(start);
      return { items, truncated, nextOffset: truncated ? offset + items.length : null };
    }
    const visit = async (directory: string): Promise<void> => {
      if (truncated) return;
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) await inspect(absolute);
        if (truncated) return;
      }
    };
    await visit(start);
    return { items, truncated, nextOffset: truncated ? offset + items.length : null };
  }

  async searchFiles(workspaceId: string, query: string, rootPath?: string, offset = 0, maxResults = 200): Promise<SearchFilesResult> {
    const workspace = this.require(workspaceId);
    const start = rootPath ? (await this.resolvePath(workspaceId, rootPath)).absolute : workspace.canonicalRoot;
    const normalizedQuery = query.toLocaleLowerCase();
    const items: SearchFilesResult["items"] = [];
    let matchedCount = 0;
    let truncated = false;
    const consider = (item: SearchFilesResult["items"][number]): void => {
      if (truncated) return;
      if (matchedCount < offset) { matchedCount += 1; return; }
      if (items.length >= maxResults) { truncated = true; return; }
      items.push(item);
      matchedCount += 1;
    };
    const matches = (path: string) => path.toLocaleLowerCase().includes(normalizedQuery);
    const rootStat = await stat(start);
    if (rootStat.isFile()) {
      const relativePath = relative(workspace.canonicalRoot, start);
      if (matches(relativePath)) consider({ path: relativePath, kind: "file", size: rootStat.size });
      return { items, truncated, nextOffset: truncated ? offset + items.length : null };
    }
    const visit = async (directory: string): Promise<void> => {
      if (truncated) return;
      const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = join(directory, entry.name);
        const relativePath = relative(workspace.canonicalRoot, absolute);
        if (entry.isDirectory()) {
          if (matches(relativePath)) consider({ path: relativePath, kind: "directory" });
          await visit(absolute);
        } else if (entry.isFile() && matches(relativePath)) {
          const info = await stat(absolute);
          consider({ path: relativePath, kind: "file", size: info.size });
        }
        if (truncated) return;
      }
    };
    await visit(start);
    return { items, truncated, nextOffset: truncated ? offset + items.length : null };
  }

  async sha256(absolute: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    return hash.digest("hex");
  }
}
