import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JsonStore, ensureDir } from "./persistence.js";
import { CodexBegError } from "./errors.js";
import type { FileChange, RecoveryManifest } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

interface RecoveryIndex { schemaVersion: 1; operations: RecoveryManifest[] }

export class RecoveryManager {
  private index: RecoveryIndex = { schemaVersion: 1, operations: [] };
  constructor(private readonly directory: string, private readonly indexStore: JsonStore<RecoveryIndex>, private readonly workspaces: WorkspaceManager) {}
  async init(): Promise<void> { this.index = await this.indexStore.load(); await this.prune(); }
  get(operationId: string): RecoveryManifest | undefined { return this.index.operations.find((item) => item.operationId === operationId); }

  async capture(operationId: string, workspaceId: string, paths: string[]): Promise<RecoveryManifest> {
    const workspace = this.workspaces.require(workspaceId);
    const operationDir = join(this.directory, operationId);
    await ensureDir(operationDir);
    const changes: FileChange[] = [];
    for (const path of paths) {
      const resolved = await this.workspaces.resolvePath(workspaceId, path, true);
      try {
        const info = await stat(resolved.absolute);
        if (!info.isFile()) throw new CodexBegError("NOT_A_FILE", `Recovery target is not a file: ${path}`);
        const before = await readFile(resolved.absolute);
        const blob = join(operationDir, `${changes.length}.before`);
        await writeFile(blob, before);
        changes.push({ path: resolved.relativePath, existed: true, beforeSha256: createHash("sha256").update(before).digest("hex"), bytes: before.byteLength });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        changes.push({ path: resolved.relativePath, existed: false, bytes: 0 });
      }
    }
    const manifest: RecoveryManifest = { operationId, workspaceId, createdAt: new Date().toISOString(), status: "captured", changes };
    this.index.operations.push(manifest);
    await this.indexStore.save(this.index);
    await this.prune();
    return manifest;
  }

  async markApplied(operationId: string, after: Map<string, string>): Promise<RecoveryManifest> {
    const manifest = this.getOrThrow(operationId);
    for (const change of manifest.changes) {
      const hash = after.get(change.path);
      if (hash) change.afterSha256 = hash;
    }
    manifest.status = "applied";
    await this.indexStore.save(this.index);
    return manifest;
  }

  async rollback(operationId: string): Promise<RecoveryManifest> {
    const manifest = this.getOrThrow(operationId);
    const operationDir = join(this.directory, operationId);
    for (const [index, change] of manifest.changes.entries()) {
      const resolved = await this.workspaces.resolvePath(manifest.workspaceId, change.path, true);
      if (change.existed) await copyFile(join(operationDir, `${index}.before`), resolved.absolute);
      else await rm(resolved.absolute, { force: true });
    }
    manifest.status = "restored";
    await this.indexStore.save(this.index);
    return manifest;
  }

  async restore(operationId: string): Promise<RecoveryManifest> {
    const manifest = this.getOrThrow(operationId);
    const operationDir = join(this.directory, operationId);
    for (const [index, change] of manifest.changes.entries()) {
      const resolved = await this.workspaces.resolvePath(manifest.workspaceId, change.path, true);
      let current: Buffer | null = null;
      try { current = await readFile(resolved.absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const currentHash = current ? createHash("sha256").update(current).digest("hex") : undefined;
      if (change.afterSha256 !== currentHash) { manifest.status = "restore_conflict"; await this.indexStore.save(this.index); throw new CodexBegError("RESTORE_CONFLICT", `File changed after operation: ${change.path}`); }
      if (change.existed) await copyFile(join(operationDir, `${index}.before`), resolved.absolute);
      else await rm(resolved.absolute, { force: true });
    }
    manifest.status = "restored";
    await this.indexStore.save(this.index);
    return manifest;
  }

  private getOrThrow(id: string): RecoveryManifest { const value = this.get(id); if (!value) throw new CodexBegError("RECOVERY_NOT_FOUND", `Unknown recovery operation: ${id}`); return value; }

  private async prune(maxAgeMs = 7 * 24 * 60 * 60 * 1000, maxBytes = 500 * 1024 * 1024): Promise<void> {
    const now = Date.now();
    const candidates: Array<{ manifest: RecoveryManifest; directory: string; bytes: number }> = [];
    let total = 0;
    for (const manifest of this.index.operations) {
      const directory = join(this.directory, manifest.operationId);
      let bytes = 0;
      try { for (const name of await readdir(directory)) bytes += (await stat(join(directory, name))).size; } catch { continue; }
      total += bytes;
      if (!(["captured", "restore_conflict"].includes(manifest.status))) candidates.push({ manifest, directory, bytes });
    }
    for (const candidate of candidates.sort((a, b) => Date.parse(a.manifest.createdAt) - Date.parse(b.manifest.createdAt))) {
      if (total <= maxBytes && now - Date.parse(candidate.manifest.createdAt) <= maxAgeMs) continue;
      await rm(candidate.directory, { recursive: true, force: true });
      this.index.operations = this.index.operations.filter((item) => item.operationId !== candidate.manifest.operationId);
      total -= candidate.bytes;
    }
    await this.indexStore.save(this.index);
  }
}
