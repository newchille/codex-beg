import type { CommandName, CommandSpec, ProjectType, Workspace } from "./types.js";
import { CodexBegError } from "./errors.js";

export function getProjectCommand(workspace: Workspace, name: CommandName): CommandSpec {
  const command = workspace.commands[name];
  if (!command) throw new CodexBegError("COMMAND_UNAVAILABLE", `No ${name} command is configured for this workspace.`);
  return { ...command, args: [...command.args] };
}

export function describeProject(type: ProjectType): string { return type === "unknown" ? "Unknown project" : `${type} project`; }
