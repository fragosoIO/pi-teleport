/**
 * Rewrite paths when a session moves between Linux, macOS, and Windows.
 * Internal relatives always use `/`. Target paths use the destination OS.
 */

export type OsName = "linux" | "darwin" | "win32";

export interface PathRoots {
  os: OsName;
  /** Absolute home directory on that OS. */
  home: string;
  /** Absolute project root on that OS. */
  project: string;
}

export interface ExactReplacement {
  from: string;
  to: string;
}

const DRIVE = /^[A-Za-z]:/;

export function isAbsolutePath(path: string, os: OsName): boolean {
  if (os === "win32") return DRIVE.test(path) || path.startsWith("\\\\") || path.startsWith("//");
  return path.startsWith("/");
}

export function expandHome(path: string, home: string, os: OsName): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return joinOs(os, home, path.slice(2).replace(/\\/g, "/"));
  return path;
}

/** Forward-slash form without a trailing slash (root `/` and `C:` stay intact). */
export function toForward(path: string): string {
  let value = path.replace(/\\/g, "/");
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function samePath(a: string, b: string, os: OsName): boolean {
  if (os === "linux") return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

function startsWithPath(full: string, prefix: string, os: OsName): boolean {
  if (os === "linux") return full.startsWith(prefix);
  return full.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Path of `full` relative to `root`, using `/`, or null when `full` is outside `root`.
 * Empty string means `full` is the root itself.
 */
export function relativeInside(root: string, full: string, os: OsName): string | null {
  const r = toForward(root);
  const f = toForward(full);
  if (samePath(r, f, os)) return "";
  const prefix = `${r}/`;
  if (!startsWithPath(f, prefix, os)) return null;
  return f.slice(prefix.length);
}

export function joinOs(os: OsName, base: string, relPosix: string): string {
  const rel = relPosix.split("/").filter((part) => part.length > 0);
  if (rel.length === 0) return stripTrailingSep(base, os);
  if (os === "win32") {
    const root = stripTrailingSep(base, os);
    return [root, ...rel].join("\\");
  }
  const root = base === "/" ? "" : stripTrailingSep(base, os);
  return `${root}/${rel.join("/")}`;
}

function stripTrailingSep(path: string, os: OsName): string {
  if (os === "win32") {
    const trimmed = path.replace(/[\\/]+$/, "");
    return DRIVE.test(trimmed) && trimmed.length === 2 ? `${trimmed}\\` : trimmed;
  }
  if (path === "/") return "/";
  return path.replace(/\/+$/, "") || "/";
}

/**
 * Map an absolute path that sits outside both home and the project onto the other OS.
 * Windows drive letters become `/c/...` on POSIX. POSIX paths outside home land on `C:\`.
 */
export function convertAbsolute(path: string, from: OsName, to: OsName): string {
  const fwd = path.replace(/\\/g, "/");
  const unc = fwd.startsWith("//");
  if (unc) {
    const rest = fwd.replace(/^\/+/, "");
    return to === "win32" ? `\\\\${rest.replace(/\//g, "\\")}` : `//${rest}`;
  }
  if (from === "win32" && to !== "win32") {
    const match = fwd.match(/^([A-Za-z]):\/?(.*)$/);
    if (!match) return fwd;
    const rest = match[2].replace(/^\/+/, "");
    return `/${match[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
  }
  if (from !== "win32" && to === "win32") {
    const rest = fwd.replace(/^\/+/, "").replace(/\//g, "\\");
    return rest.length === 0 ? "C:\\" : `C:\\${rest}`;
  }
  if (to === "win32") return fwd.replace(/\//g, "\\");
  return fwd;
}

/** Rewrite one path from the source machine onto the destination machine. */
export function rewritePath(path: string, from: PathRoots, to: PathRoots): string {
  const expanded = expandHome(path, from.home, from.os);
  const projectRel = relativeInside(from.project, expanded, from.os);
  if (projectRel !== null) return joinOs(to.os, to.project, projectRel);
  const homeRel = relativeInside(from.home, expanded, from.os);
  if (homeRel !== null) return joinOs(to.os, to.home, homeRel);
  return convertAbsolute(expanded, from.os, to.os);
}

function pathVariants(path: string): string[] {
  const forward = path.replace(/\\/g, "/");
  const back = forward.replace(/\//g, "\\");
  return [...new Set([path, forward, back])];
}

function pathKey(path: string, os: OsName): string {
  const forward = toForward(path);
  return os === "linux" ? forward : forward.toLowerCase();
}

function isBoundary(char: string | undefined): boolean {
  if (char === undefined) return true;
  return !/[A-Za-z0-9._~+\-:@]/.test(char) && char !== "/" && char !== "\\";
}

function startsWithVariant(text: string, variant: string, os: OsName): boolean {
  if (text.length < variant.length) return false;
  const slice = text.slice(0, variant.length);
  return os === "linux" ? slice === variant : slice.toLowerCase() === variant.toLowerCase();
}

/**
 * Rewrite paths embedded in session text.
 * A whole path token is rewritten so separators match the target OS.
 * Exact mappings (spare copies) win over the home-folder location of the same file.
 * `/home/ada` does not match `/home/ada2`.
 */
export function rewriteText(
  input: string,
  from: PathRoots,
  to: PathRoots,
  exact: readonly ExactReplacement[] = [],
): string {
  const exactMap = new Map<string, string>();
  for (const item of exact) {
    exactMap.set(pathKey(item.from, from.os), item.to);
  }
  const prefixes = [...pathVariants(from.project), ...pathVariants(from.home)].sort((a, b) => b.length - a.length);
  const exactVariants = exact.flatMap((item) => pathVariants(item.from).map((variant) => ({ variant, to: item.to })));
  exactVariants.sort((a, b) => b.variant.length - a.variant.length);

  let index = 0;
  let out = "";
  while (index < input.length) {
    const atToken = index === 0 || isBoundary(input[index - 1]);
    if (!atToken) {
      out += input[index];
      index += 1;
      continue;
    }
    const rest = input.slice(index);
    const exactHit = exactVariants.find((item) => startsWithVariant(rest, item.variant, from.os) && isBoundary(rest[item.variant.length]));
    if (exactHit) {
      out += exactHit.to;
      index += exactHit.variant.length;
      continue;
    }
    const prefix = prefixes.find((item) => startsWithVariant(rest, item, from.os) && (isBoundary(rest[item.length]) || rest[item.length] === "/" || rest[item.length] === "\\"));
    if (!prefix) {
      out += input[index];
      index += 1;
      continue;
    }
    let end = prefix.length;
    while (end < rest.length && !isBoundary(rest[end])) end += 1;
    const token = rest.slice(0, end);
    const mapped = exactMap.get(pathKey(token, from.os));
    out += mapped ?? rewritePath(token, from, to);
    index += end;
  }
  return out;
}

/** Destination folder: the projects folder from setup, plus the project name. */
export function defaultDestination(os: OsName, projects: string, folderName: string): string {
  const root = projects.trim();
  if (!root) throw new Error("run pi-teleport setup before using teleport");
  const safeName = folderName.replace(/[\\/]/g, "").trim();
  if (!safeName) throw new Error("a destination folder name is required");
  return joinOs(os, root, safeName);
}

export function folderNameOf(project: string): string {
  const fwd = toForward(project);
  const parts = fwd.split("/").filter((part) => part.length > 0 && !DRIVE.test(part));
  return parts.at(-1) ?? "project";
}

/** Refuse destinations that would replace the home directory or a drive root. */
export function assertSafeDestination(dest: string, home: string, os: OsName): void {
  if (!isAbsolutePath(dest, os)) throw new Error("destination path must be absolute");
  const destFwd = toForward(dest);
  const homeFwd = toForward(home);
  const lowered = os === "linux" ? destFwd : destFwd.toLowerCase();
  const homeCmp = os === "linux" ? homeFwd : homeFwd.toLowerCase();
  if (lowered === "/" || /^[a-z]:$/i.test(lowered)) throw new Error("destination cannot be a drive root");
  if (lowered === homeCmp) throw new Error("destination cannot be the home folder");
  if (homeCmp.startsWith(`${lowered}/`)) throw new Error("destination cannot be a parent of the home folder");
  const depth = lowered.split("/").filter((part) => part.length > 0 && !DRIVE.test(part)).length;
  if (depth < 1) throw new Error("destination path is too shallow");
}

/** Encode a cwd the way pi names `~/.pi/agent/sessions/--<path>--`. */
export function piSessionDirName(cwd: string): string {
  const trimmed = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return `--${trimmed}--`;
}
