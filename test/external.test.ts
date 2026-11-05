import assert from "node:assert/strict";
import test from "node:test";

import { externalReplacements, planExternalPlacement } from "../src/core/external.ts";
import { rewriteText, type PathRoots } from "../src/core/paths.ts";
import { rewriteSession } from "../src/core/session.ts";

const linux: PathRoots = { os: "linux", home: "/home/ada", project: "/home/ada/work/app" };
const mac: PathRoots = { os: "darwin", home: "/Users/ada", project: "/Users/ada/work/app" };
const win: PathRoots = { os: "win32", home: "C:\\Users\\ada", project: "D:\\src\\app" };

test("a home file is written at the home path and as a spare copy inside the project", () => {
  const placed = planExternalPlacement("/home/ada/.config/foo", linux, mac, true);
  assert.ok(placed);
  assert.equal(placed.kind, "home");
  assert.equal(placed.primaryPath, "/Users/ada/.config/foo");
  assert.equal(placed.spareRelative, ".pi-teleport/external/home/.config/foo");
  assert.equal(placed.sparePath, "/Users/ada/work/app/.pi-teleport/external/home/.config/foo");
  assert.equal(placed.sessionPath, "/Users/ada/.config/foo");
  assert.equal(placed.writePrimary, true);
});

test("an absolute file outside home keeps that absolute path and a spare copy", () => {
  const placed = planExternalPlacement("/etc/hosts", linux, win, true);
  assert.ok(placed);
  assert.equal(placed.kind, "absolute");
  assert.equal(placed.primaryPath, "C:\\etc\\hosts");
  assert.equal(placed.sparePath, "D:\\src\\app\\.pi-teleport\\external\\abs\\etc\\hosts");
  assert.equal(placed.sessionPath, "C:\\etc\\hosts");
});

test("when the primary write cannot be done, session references move to the spare copy", () => {
  const placed = planExternalPlacement("/home/ada/.config/foo", linux, mac, false);
  assert.ok(placed);
  assert.equal(placed.writePrimary, false);
  assert.equal(placed.sessionPath, placed.sparePath);
  const text = "open /home/ada/.config/foo now";
  const rewritten = rewriteText(text, linux, mac, externalReplacements([placed]));
  assert.equal(rewritten, `open ${placed.sparePath} now`);
  assert.doesNotMatch(rewritten, /\/Users\/ada\/\.config\/foo/);
});

test("a file inside the project is not an external file", () => {
  assert.equal(planExternalPlacement("/home/ada/work/app/src/a.ts", linux, mac, true), null);
});

test("restored session keeps the home path when the primary write is allowed", () => {
  const placed = planExternalPlacement("/home/ada/.config/foo", linux, win, true);
  assert.ok(placed);
  const jsonl = [
    JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: linux.project }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/home/ada/.config/foo" } }] },
    }),
  ].join("\n");
  const result = rewriteSession(jsonl, linux, win, win.project, externalReplacements([placed]), { sourceCwd: linux.project });
  assert.match(result.jsonl, /C:\\\\Users\\\\ada\\\\\.config\\\\foo/);
  assert.doesNotMatch(result.jsonl, /external\\\\home/);
});
