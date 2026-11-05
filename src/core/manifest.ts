/**
 * Installed tools and services are not copied. The manifest records that they
 * were used so the restored session can show that fact without a file list.
 */

import type { PathRoots } from "./paths.ts";

export interface ToolUse {
  name: string;
  kind: "binary" | "service";
  evidence: string;
}

export interface SessionManifest {
  version: 1;
  source: PathRoots & { name: string };
  target: PathRoots & { name: string };
  destPath: string;
  toolsUsed: ToolUse[];
  /** External files travel with the project. This count is not a path list. */
  externalFileCount: number;
  note: string;
  createdAt: string;
}

const TOOLS: { name: string; kind: "binary" | "service"; pattern: RegExp }[] = [
  { name: "docker", kind: "service", pattern: /(^|[;&|`(]\s*)docker(\s|$)/i },
  { name: "podman", kind: "service", pattern: /(^|[;&|`(]\s*)podman(\s|$)/i },
  { name: "mysql", kind: "service", pattern: /(^|[;&|`(]\s*)mysql(\s|$)/i },
  { name: "mariadb", kind: "service", pattern: /(^|[;&|`(]\s*)mariadb(\s|$)/i },
  { name: "psql", kind: "service", pattern: /(^|[;&|`(]\s*)psql(\s|$)/i },
  { name: "postgres", kind: "service", pattern: /(^|[;&|`(]\s*)postgres(\s|$)/i },
  { name: "redis-cli", kind: "service", pattern: /(^|[;&|`(]\s*)redis-cli(\s|$)/i },
  { name: "redis-server", kind: "service", pattern: /(^|[;&|`(]\s*)redis-server(\s|$)/i },
  { name: "mongod", kind: "service", pattern: /(^|[;&|`(]\s*)mongod(\s|$)/i },
  { name: "nginx", kind: "service", pattern: /(^|[;&|`(]\s*)nginx(\s|$)/i },
  { name: "node", kind: "binary", pattern: /(^|[;&|`(]\s*)node(\s|$)/i },
  { name: "npm", kind: "binary", pattern: /(^|[;&|`(]\s*)npm(\s|$)/i },
  { name: "npx", kind: "binary", pattern: /(^|[;&|`(]\s*)npx(\s|$)/i },
  { name: "pnpm", kind: "binary", pattern: /(^|[;&|`(]\s*)pnpm(\s|$)/i },
  { name: "yarn", kind: "binary", pattern: /(^|[;&|`(]\s*)yarn(\s|$)/i },
  { name: "bun", kind: "binary", pattern: /(^|[;&|`(]\s*)bun(\s|$)/i },
  { name: "python", kind: "binary", pattern: /(^|[;&|`(]\s*)python3?(\s|$)/i },
  { name: "pip", kind: "binary", pattern: /(^|[;&|`(]\s*)pip3?(\s|$)/i },
  { name: "go", kind: "binary", pattern: /(^|[;&|`(]\s*)go(\s|$)/i },
  { name: "cargo", kind: "binary", pattern: /(^|[;&|`(]\s*)cargo(\s|$)/i },
  { name: "rustc", kind: "binary", pattern: /(^|[;&|`(]\s*)rustc(\s|$)/i },
  { name: "php", kind: "binary", pattern: /(^|[;&|`(]\s*)php(\s|$)/i },
  { name: "composer", kind: "binary", pattern: /(^|[;&|`(]\s*)composer(\s|$)/i },
  { name: "java", kind: "binary", pattern: /(^|[;&|`(]\s*)java(\s|$)/i },
  { name: "sqlite3", kind: "binary", pattern: /(^|[;&|`(]\s*)sqlite3(\s|$)/i },
];

export function recordToolsUsed(commands: readonly string[]): ToolUse[] {
  const found = new Map<string, ToolUse>();
  for (const command of commands) {
    const evidence = command.replace(/\s+/g, " ").trim().slice(0, 180);
    if (!evidence) continue;
    for (const tool of TOOLS) {
      if (found.has(tool.name)) continue;
      if (!tool.pattern.test(command)) continue;
      found.set(tool.name, { name: tool.name, kind: tool.kind, evidence });
    }
  }
  return [...found.values()];
}

export function createManifest(input: Omit<SessionManifest, "version" | "note">): SessionManifest {
  return {
    version: 1,
    ...input,
    note: "Installed tools and services (Node, Docker, databases, binaries on PATH) were used and were not copied.",
  };
}
