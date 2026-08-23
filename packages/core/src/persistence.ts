import { appendFile, mkdir, readFile, rename, writeFile, open, readdir, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentEvent } from "./events.js";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export class JsonStore<T> {
  constructor(private readonly path: string, private readonly initial: T) {}

  async load(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.initial;
    }
  }

  async save(value: T): Promise<void> {
    await ensureDir(dirname(this.path));
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const handle = await open(temp, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.path);
  }
}

export class AuditLog {
  constructor(private readonly directory: string, private readonly maxBytes = 5 * 1024 * 1024) {}

  async append(event: AgentEvent): Promise<void> {
    await ensureDir(this.directory);
    const path = join(this.directory, "events.ndjson");
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
    try {
      const info = await stat(path);
      if (info.size > this.maxBytes) await rename(path, join(this.directory, `events-${Date.now()}.ndjson`));
    } catch { /* best-effort audit rotation */ }
  }
}

export async function listFiles(path: string): Promise<string[]> {
  try { return await readdir(path); } catch { return []; }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: false, force: true });
}
