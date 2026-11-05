import assert from "node:assert/strict";
import test from "node:test";

import { planExternalPlacement } from "../src/core/external.ts";
import {
  applyCollisionChoice,
  applyDestinationChoice,
  externalCollisionCandidates,
  needsOverwritePrompt,
  writesThatCollide,
} from "../src/core/overwrite.ts";
import type { PathRoots } from "../src/core/paths.ts";

const from: PathRoots = { os: "linux", home: "/home/ada", project: "/home/ada/work/app" };
const to: PathRoots = { os: "darwin", home: "/Users/ada", project: "/Users/ada/work/app" };

test("only existing target paths are collisions, and an empty set does not prompt", () => {
  const writes = [
    { id: "/home/ada/.config/foo", targetPath: "/Users/ada/.config/foo" },
    { id: "/etc/hosts", targetPath: "/etc/hosts" },
  ];
  const collisions = writesThatCollide(writes, (path) => path === "/etc/hosts");
  assert.deepEqual(collisions.map((item) => item.id), ["/etc/hosts"]);
  assert.equal(needsOverwritePrompt(collisions), true);
  assert.equal(needsOverwritePrompt([]), false);
});

test("overwrite, skip, and cancel are the only collision choices", () => {
  const collisions = [{ id: "/etc/hosts", targetPath: "/etc/hosts" }];
  assert.deepEqual(applyCollisionChoice("overwrite", collisions), { proceed: true, skipIds: [] });
  assert.deepEqual(applyCollisionChoice("skip", collisions), { proceed: true, skipIds: ["/etc/hosts"] });
  assert.deepEqual(applyCollisionChoice("cancel", collisions), { proceed: false, reason: "cancel" });
});

test("destination exists: overwrite, rename, or cancel; a fresh path needs no choice", () => {
  assert.deepEqual(applyDestinationChoice("overwrite", true), { action: "use" });
  assert.deepEqual(applyDestinationChoice("rename", true), { action: "rename" });
  assert.deepEqual(applyDestinationChoice("cancel", true), { action: "cancel" });
  assert.deepEqual(applyDestinationChoice("cancel", false), { action: "use" });
});

test("project files are not collision candidates; skipped primaries are not written", () => {
  const home = planExternalPlacement("/home/ada/.config/foo", from, to, true);
  const blocked = planExternalPlacement("/etc/hosts", from, to, false);
  assert.ok(home && blocked);
  const candidates = externalCollisionCandidates([home, blocked]);
  assert.deepEqual(candidates, [{ id: "/home/ada/.config/foo", targetPath: "/Users/ada/.config/foo" }]);
});
