import { access, constants, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CodexBegError } from "./errors.js";

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);

export interface ExecutableResolutionOptions {
  cwd?: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export interface ResolvedExecutable {
  executable: string;
  argsPrefix: string[];
}

function packageManagerName(executable: string): string | undefined {
  const base = executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().replace(/\.(cmd|exe)$/i, "");
  return base && PACKAGE_MANAGERS.has(base) ? base : undefined;
}

export function executableNames(name: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return [name];
  return [`${name}.cmd`, `${name}.exe`, name];
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function canonicalExecutable(path: string, platform: NodeJS.Platform): Promise<string | undefined> {
  if (!(await isExecutable(path, platform))) return undefined;
  try { return await realpath(path); } catch { return path; }
}

async function nvmBinDirectories(nvmDir: string): Promise<string[]> {
  const versionsDir = join(nvmDir, "versions", "node");
  try {
    const entries = await readdir(versionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((left, right) => (left === "current" ? -1 : right === "current" ? 1 : right.localeCompare(left)))
      .map((name) => join(versionsDir, name, "bin"));
  } catch {
    return [];
  }
}

async function preferredNvmBinDirectory(nvmDir: string, projectRoot: string): Promise<string | undefined> {
  const metadataFiles = [".nvmrc", ".node-version"];
  let requestedVersion: string | undefined;
  for (const metadataFile of metadataFiles) {
    try {
      const value = (await readFile(join(projectRoot, metadataFile), "utf8")).split(/\r?\n/, 1)[0]?.trim();
      if (value) {
        requestedVersion = value;
        break;
      }
    } catch {
      // A missing version file is normal; continue to the next supported convention.
    }
  }
  if (!requestedVersion) return undefined;

  const versionsDir = join(nvmDir, "versions", "node");
  try {
    const entries = (await readdir(versionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    const normalizedRequested = requestedVersion.replace(/^v/i, "");
    const match = entries.find((entry) => {
      const normalizedEntry = entry.name.replace(/^v/i, "");
      return entry.name === requestedVersion || normalizedEntry === normalizedRequested || (requestedVersion === "node" && entry.name === "current");
    });
    return match ? join(versionsDir, match.name, "bin") : undefined;
  } catch {
    return undefined;
  }
}

async function executableDirectories(options: { env: NodeJS.ProcessEnv; homeDir: string; platform: NodeJS.Platform; projectRoot?: string }): Promise<string[]> {
  const { env, homeDir, platform, projectRoot } = options;
  const delimiter = platform === "win32" ? ";" : ":";
  const directories: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = resolve(value);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    directories.push(normalized);
  };

  for (const entry of (env.PATH ?? "").split(delimiter)) add(entry);

  if (platform === "win32") {
    add(env.NVM_SYMLINK);
    add(env.NVM_HOME);
    add(env.VOLTA_HOME ? join(env.VOLTA_HOME, "bin") : undefined);
    add(env.PNPM_HOME);
    add(env.APPDATA ? join(env.APPDATA, "npm") : undefined);
    add(env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "pnpm") : undefined);
    add(join(homeDir, "AppData", "Roaming", "npm"));
    add(join(homeDir, ".volta", "bin"));
    add(join(homeDir, ".local", "share", "pnpm"));
    add("C:\\Program Files\\nodejs");
  } else {
    add(env.NVM_BIN);
    const nvmDir = env.NVM_DIR ?? join(homeDir, ".nvm");
    if (projectRoot) add(await preferredNvmBinDirectory(nvmDir, projectRoot));
    add(env.PNPM_HOME);
    add(env.VOLTA_HOME ? join(env.VOLTA_HOME, "bin") : undefined);
    add(env.COREPACK_HOME ? join(env.COREPACK_HOME, "bin") : undefined);
    add(dirname(process.execPath));
    add(join(homeDir, ".volta", "bin"));
    add(join(homeDir, ".local", "bin"));
    add(join(homeDir, ".local", "share", "pnpm"));
    add(join(homeDir, ".npm-global", "bin"));
    for (const directory of await nvmBinDirectories(nvmDir)) add(directory);
    add("/opt/homebrew/bin");
    add("/usr/local/bin");
    add("/usr/bin");
    add("/bin");
  }
  return directories;
}

async function findInDirectories(names: string[], directories: string[], platform: NodeJS.Platform): Promise<string | undefined> {
  for (const directory of directories) {
    for (const name of names) {
      const found = await canonicalExecutable(join(directory, name), platform);
      if (found) return found;
    }
  }
  return undefined;
}

export async function resolveExecutable(executable: string, options: ExecutableResolutionOptions = {}): Promise<ResolvedExecutable> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const manager = packageManagerName(executable);

  if (isAbsolute(executable) || /[\\/]/.test(executable)) {
    const direct = await canonicalExecutable(isAbsolute(executable) ? executable : resolve(cwd, executable), platform);
    if (direct) return { executable: direct, argsPrefix: [] };
    if (!manager) throw new CodexBegError("COMMAND_NOT_FOUND", `Executable not found: ${executable}`, { executable });
  }

  const directories = await executableDirectories({ env, homeDir, platform, projectRoot: options.projectRoot ?? cwd });
  const names = executableNames(manager ?? executable, platform);
  const found = await findInDirectories(names, directories, platform);
  if (found) return { executable: found, argsPrefix: [] };

  if (manager) {
    const corepack = await findInDirectories(executableNames("corepack", platform), directories, platform);
    if (corepack) return { executable: corepack, argsPrefix: [manager] };
  }

  throw new CodexBegError("COMMAND_NOT_FOUND", `Executable not found: ${executable}`, { executable, searchedDirectories: directories });
}
