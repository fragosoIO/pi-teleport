import assert from "node:assert/strict";
import test from "node:test";

import { rewriteSession } from "../src/core/session.ts";
import {
  convertAbsolute,
  defaultDestination,
  piSessionDirName,
  rewritePath,
  rewriteText,
  type PathRoots,
} from "../src/core/paths.ts";

const linux: PathRoots = { os: "linux", home: "/home/ada", project: "/home/ada/work/app" };
const mac: PathRoots = { os: "darwin", home: "/Users/ada", project: "/Users/ada/work/app" };
const win: PathRoots = { os: "win32", home: "C:\\Users\\ada", project: "C:\\Users\\ada\\work\\app" };

test("rewrites a project path across linux, macOS, and windows", () => {
  const linuxFile = "/home/ada/work/app/src/a.ts";
  assert.equal(rewritePath(linuxFile, linux, mac), "/Users/ada/work/app/src/a.ts");
  assert.equal(rewritePath(linuxFile, linux, win), "C:\\Users\\ada\\work\\app\\src\\a.ts");
  assert.equal(rewritePath("C:\\Users\\ada\\work\\app\\src\\a.ts", win, linux), "/home/ada/work/app/src/a.ts");
  assert.equal(rewritePath("/Users/ada/work/app/src/a.ts", mac, win), "C:\\Users\\ada\\work\\app\\src\\a.ts");
  assert.equal(rewritePath(linuxFile, linux, linux), linuxFile);
});

test("rewrites a home path and leaves the project root itself", () => {
  assert.equal(rewritePath("/home/ada/.config/foo", linux, mac), "/Users/ada/.config/foo");
  assert.equal(rewritePath("/Users/ada/.config/foo", mac, win), "C:\\Users\\ada\\.config\\foo");
  assert.equal(rewritePath("C:\\Users\\ada\\.config\\foo", win, linux), "/home/ada/.config/foo");
  assert.equal(rewritePath("/home/ada/work/app", linux, win), "C:\\Users\\ada\\work\\app");
});

test("rewrites absolute paths that sit outside home", () => {
  assert.equal(convertAbsolute("/etc/hosts", "linux", "win32"), "C:\\etc\\hosts");
  assert.equal(convertAbsolute("/etc/hosts", "linux", "darwin"), "/etc/hosts");
  assert.equal(rewritePath("/etc/hosts", linux, win), "C:\\etc\\hosts");
  assert.equal(rewritePath("/etc/hosts", linux, mac), "/etc/hosts");
  assert.equal(
    rewritePath("C:\\Windows\\System32\\cmd.exe", win, linux),
    "/c/Windows/System32/cmd.exe",
  );
  assert.equal(
    rewritePath("C:\\Windows\\System32\\cmd.exe", win, mac),
    "/c/Windows/System32/cmd.exe",
  );
  assert.equal(rewritePath("/opt/data/file", mac, linux), "/opt/data/file");
});

test("does not treat a longer folder name as the home prefix", () => {
  const text = "see /home/ada2/notes and /home/ada/work/app/src/a.ts";
  const rewritten = rewriteText(text, linux, win);
  assert.match(rewritten, /\/home\/ada2\/notes/);
  assert.match(rewritten, /C:\\Users\\ada\\work\\app\\src\\a.ts/);
});

test("session jsonl cwd and tool paths follow the destination OS", () => {
  const jsonl = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "01999999-aaaa-7bbb-8ccc-ddddeeeeffff",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/home/ada/work/app",
    }),
    JSON.stringify({
      type: "model_change",
      id: "m1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      provider: "vllm",
      modelId: "local",
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      parentId: "m1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "/home/ada/work/app/src/a.ts" } }],
      },
    }),
  ].join("\n");

  const result = rewriteSession(jsonl, linux, win, "C:\\Users\\ada\\work\\app", [], { sourceCwd: linux.project });
  const lines = result.jsonl.trim().split("\n").map((line) => JSON.parse(line) as { type: string; cwd?: string; parentId?: string | null; provider?: string; message?: { content: { arguments: { path: string } }[] } });
  assert.equal(lines[0].type, "session");
  assert.equal(lines[0].cwd, "C:\\Users\\ada\\work\\app");
  assert.notEqual(lines[0].id, "01999999-aaaa-7bbb-8ccc-ddddeeeeffff");
  assert.equal(lines.some((line) => line.type === "model_change"), false);
  const message = lines.find((line) => line.type === "message");
  assert.equal(message?.parentId, null);
  assert.equal(message?.message?.content[0].arguments.path, "C:\\Users\\ada\\work\\app\\src\\a.ts");
  assert.equal(piSessionDirName("/home/ada/work/app"), "--home-ada-work-app--");
  assert.equal(piSessionDirName("C:\\Users\\ada\\work\\app"), "--C--Users-ada-work-app--");
});

test("destination is the projects folder plus the project name", () => {
  assert.equal(defaultDestination("darwin", "/Users/ada/Projects", "app"), "/Users/ada/Projects/app");
  assert.equal(defaultDestination("win32", "D:\\src", "renamed"), "D:\\src\\renamed");
  assert.equal(defaultDestination("darwin", "/Users/ada/Projects", "nested/name"), "/Users/ada/Projects/nestedname");
});

test("destination requires the projects folder from setup", () => {
  assert.throws(() => defaultDestination("linux", "  ", "app"), /pi-teleport setup/);
  assert.throws(() => defaultDestination("linux", "/Users/ada/Projects", " / "), /folder name is required/);
});
