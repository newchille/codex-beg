import { createReadStream } from "node:fs";
import { copyFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JsonStore, ensureDir } from "./persistence.js";
import { CodexBegError } from "./errors.js";
import type { FileChange, RecoveryManifest } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

interface RecoveryIndex { schemaVersion: 1; operations: RecoveryManifest[] }
const RECOVERY_MAX_FILE_BYTES = 64 * 1024 * 1024;
const RECOVERY_MAX_OPERATION_BYTES = 128 * 1024 * 1024;
async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }

export class RecoveryManager {
  private index: RecoveryIndex = { schemaVersion: 1, operations: [] };
  constructor(private readonly directory: string, private readonly indexStore: JsonStore<RecoveryIndex>, private readonly workspaces: WorkspaceManager) {}
  async init(): Promise<void> { this.index = await this.indexStore.load(); await this.prune(); }
  get(operationId: string): RecoveryManifest | undefined { return this.index.operations.find((item) => item.operationId === operationId); }
  list(limit = 100): RecoveryManifest[] { const max = Math.min(Math.max(limit, 1), 500); return structuredClone([...this.index.operations].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, max)); }

  async capture(operationId: string, workspaceId: string, paths: string[]): Promise<RecoveryManifest> {
    this.workspaces.require(workspaceId);
    const plan: Array<{ absolute: string; relativePath: string; existed: boolean; bytes: number }> = [];
    let totalBytes = 0;
    for (const path of paths) {
      const resolved = await this.workspaces.resolvePath(workspaceId, path, true);
      try {
        const info = await stat(resolved.absolute);
        if (!info.isFile()) throw new CodexBegError("NOT_A_FILE", `Recovery target is not a file: ${path}`);
        if (info.size > RECOVERY_MAX_FILE_BYTES) throw new CodexBegError("RECOVERY_FILE_TOO_LARGE", `Recovery target exceeds the ${RECOVERY_MAX_FILE_BYTES}-byte per-file limit: ${path}`);
        totalBytes += info.size;
        if (totalBytes > RECOVERY_MAX_OPERATION_BYTES) throw new CodexBegError("RECOVERY_OPERATION_TOO_LARGE", `Recovery snapshot exceeds the ${RECOVERY_MAX_OPERATION_BYTES}-byte per-operation limit.`);
        plan.push({ absolute: resolved.absolute, relativePath: resolved.relativePath, existed: true, bytes: info.size });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        plan.push({ absolute: resolved.absolute, relativePath: resolved.relativePath, existed: false, bytes: 0 });
      }
    }
    const operationDir = join(this.directory, operationId);
    await ensureDir(operationDir);
    const changes: FileChange[] = [];
    for (const [index, item] of plan.entries()) {
      if (item.existed) {
        const blob = join(operationDir, `${index}.before`);
        await copyFile(item.absolute, blob);
        changes.push({ path: item.relativePath, existed: true, beforeSha256: await sha256File(blob), bytes: item.bytes });
      } else changes.push({ path: item.relativePath, existed: false, bytes: 0 });
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
    const resolvedChanges: Array<{ index: number; change: FileChange; absolute: string }> = [];
    for (const [index, change] of manifest.changes.entries()) {
      const resolved = await this.workspaces.resolvePath(manifest.workspaceId, change.path, true);
      let currentHash: string | undefined;
      try {
        const info = await stat(resolved.absolute);
        if (!info.isFile()) throw new CodexBegError("NOT_A_FILE", `Recovery target is not a file: ${change.path}`);
        currentHash = await sha256File(resolved.absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (change.afterSha256 !== currentHash) { manifest.status = "restore_conflict"; await this.indexStore.save(this.index); throw new CodexBegError("RESTORE_CONFLICT", `File changed after operation: ${change.path}`); }
      resolvedChanges.push({ index, change, absolute: resolved.absolute });
    }
    for (const item of resolvedChanges) {
      if (item.change.existed) await copyFile(join(operationDir, `${item.index}.before`), item.absolute);
      else await rm(item.absolute, { force: true });
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
