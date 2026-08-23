declare module "diff" {
  export function applyPatch(source: string, patch: string, options?: unknown): string | false;
}
