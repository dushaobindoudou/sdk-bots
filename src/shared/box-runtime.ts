export type SandBoxRuntime = "remote" | "local-docker";

export const DEFAULT_SAND_BOX_RUNTIME: SandBoxRuntime = "remote";

export function isSandBoxRuntime(value: unknown): value is SandBoxRuntime {
  return value === "remote" || value === "local-docker";
}
