/**
 * Files outside the project are written twice when the target allows it:
 * once at the same home-relative or absolute path, and once as a spare copy
 * inside the project. The restored session keeps the home or absolute path.
 * When that write cannot be done, session references move to the spare copy.
 */

import { SPARE_DIR } from "./constants.ts";
import { convertAbsolute, joinOs, relativeInside, rewritePath, type PathRoots } from "./paths.ts";

export interface ExternalPlacement {
  sourcePath: string;
  kind: "home" | "absolute";
  /** Where the file would live on the target, outside the project. */
  primaryPath: string;
  /** Project-relative spare path, always `/`-separated. */
  spareRelative: string;
  /** Absolute spare path on the target. */
  sparePath: string;
  /** Path the restored session should keep using. */
  sessionPath: string;
  /** True when the primary path should be written. */
  writePrimary: boolean;
}

export function planExternalPlacement(
  sourcePath: string,
  from: PathRoots,
  to: PathRoots,
  primaryAllowed: boolean,
): ExternalPlacement | null {
  if (relativeInside(from.project, sourcePath, from.os) !== null) return null;
  const homeRel = relativeInside(from.home, sourcePath, from.os);
  const kind = homeRel !== null ? "home" : "absolute";
  const primaryPath = rewritePath(sourcePath, from, to);
  const spareRelative = homeRel !== null
    ? `${SPARE_DIR}/home/${homeRel}`
    : `${SPARE_DIR}/abs/${absoluteSpareKey(sourcePath, from.os)}`;
  const sparePath = joinOs(to.os, to.project, spareRelative);
  return {
    sourcePath,
    kind,
    primaryPath,
    spareRelative,
    sparePath,
    sessionPath: primaryAllowed ? primaryPath : sparePath,
    writePrimary: primaryAllowed,
  };
}

function absoluteSpareKey(sourcePath: string, os: PathRoots["os"]): string {
  const converted = os === "win32" ? convertAbsolute(sourcePath, "win32", "linux") : sourcePath.replace(/\\/g, "/");
  return converted.replace(/^\/+/, "").replace(/^\/+/, "");
}

/** Session text replacements for external files. Project and home prefixes are added by the caller. */
export function externalReplacements(placements: readonly ExternalPlacement[]): { from: string; to: string }[] {
  return placements.map((item) => ({ from: item.sourcePath, to: item.sessionPath }));
}
