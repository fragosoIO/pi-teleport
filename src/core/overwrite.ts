/**
 * The user is interrupted only when a write would replace something already
 * on the target. Destination-folder conflicts are a separate question, asked
 * on every send.
 */

export type CollisionChoice = "overwrite" | "skip" | "cancel";
export type DestinationChoice = "overwrite" | "rename" | "cancel";

export interface PlannedWrite {
  id: string;
  targetPath: string;
}

export function writesThatCollide(writes: readonly PlannedWrite[], exists: (path: string) => boolean): PlannedWrite[] {
  return writes.filter((write) => exists(write.targetPath));
}

export function needsOverwritePrompt(collisions: readonly PlannedWrite[]): boolean {
  return collisions.length > 0;
}

export function applyCollisionChoice(
  choice: CollisionChoice,
  collisions: readonly PlannedWrite[],
): { proceed: false; reason: "cancel" } | { proceed: true; skipIds: string[] } {
  if (choice === "cancel") return { proceed: false, reason: "cancel" };
  if (choice === "skip") return { proceed: true, skipIds: collisions.map((item) => item.id) };
  return { proceed: true, skipIds: [] };
}

/**
 * External primary paths are the only writes that can collide outside the
 * destination folder. Project files are covered by the destination choice.
 * A primary that cannot be written is not offered as a collision.
 */
export function externalCollisionCandidates(
  placements: readonly { sourcePath: string; primaryPath: string; writePrimary: boolean }[],
): PlannedWrite[] {
  return placements.filter((item) => item.writePrimary).map((item) => ({ id: item.sourcePath, targetPath: item.primaryPath }));
}

export function applyDestinationChoice(
  choice: DestinationChoice,
  destExists: boolean,
): { action: "use" } | { action: "rename" } | { action: "cancel" } {
  if (!destExists) return { action: "use" };
  if (choice === "overwrite") return { action: "use" };
  if (choice === "rename") return { action: "rename" };
  return { action: "cancel" };
}
