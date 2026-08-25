import { mkdir, readFile, rename, writeFile, open, readdir, stat, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AgentEvent } from "./events.js";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export class JsonStore<T> {
  private static readonly saveQueues = new Map<string, Promise<void>>();
  constructor(private readonly path: string, private readonly initial: T) {}

  async load(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return structuredClone(this.initial);
    }
  }

  async save(value: T): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const previous = JsonStore.saveQueues.get(this.path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await ensureDir(dirname(this.path));
      const temp = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await writeFile(temp, serialized, "utf8");
      const handle = await open(temp, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(temp, this.path);
    });
    JsonStore.saveQueues.set(this.path, current);
    try { await current; }
    finally {
      if (JsonStore.saveQueues.get(this.path) === current) JsonStore.saveQueues.delete(this.path);
    }
  }
}

export class AuditLog {
  private static readonly appendQueues = new Map<string, Promise<void>>();
  constructor(private readonly directory: string, private readonly maxBytes = 5 * 1024 * 1024) {}

  async append(event: AgentEvent): Promise<void> {
    const previous = AuditLog.appendQueues.get(this.directory) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await ensureDir(this.directory);
      const path = join(this.directory, "events.ndjson");
      const handle = await open(path, "a");
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        const info = await stat(path);
        if (info.size > this.maxBytes) await rename(path, join(this.directory, `events-${Date.now()}-${randomUUID()}.ndjson`));
      } catch { /* best-effort audit rotation */ }
    });
    AuditLog.appendQueues.set(this.directory, current);
    try { await current; }
    finally {
      if (AuditLog.appendQueues.get(this.directory) === current) AuditLog.appendQueues.delete(this.directory);
    }
  }
}

export async function listFiles(path: string): Promise<string[]> {
  try { return await readdir(path); } catch { return []; }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: false, force: true });
}
