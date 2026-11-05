import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { findPiBinary, parseEnviron, pickGraphicalEnv, selectLaunch, withToolPath, type LaunchContext } from "../src/core/launch.ts";

const sessionFile = "/home/ada/.pi/agent/sessions/--home-ada-work-app--/2026-11-05T21-19-00-723Z_session.jsonl";
const piPath = "/home/ada/.pi/agent/bin/pi";

function context(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    sessionFile,
    cwd: "/home/ada/work/app",
    platform: "linux",
    env: { PATH: "/usr/bin", HOME: "/home/ada" },
    have: () => false,
    piPath,
    tmuxSession: null,
    zellijSession: null,
    wezterm: false,
    launchDisabled: false,
    ...overrides,
  };
}

test("a graphical terminal resumes the session file as its own argument", () => {
  const plan = selectLaunch(context({
    env: { PATH: "/usr/bin", DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-1" },
    have: (command) => command === "kitty",
  }));
  assert.equal(plan.started, true);
  assert.equal(plan.note, "kitty");
  assert.equal(plan.run?.file, "kitty");
  assert.deepEqual(plan.run?.args.slice(-2), ["--session", sessionFile]);
  assert.equal(plan.run?.args.includes(piPath), true);
  assert.equal(plan.command.includes("\n"), false);
});

test("without a display, an attached tmux session resumes the session", () => {
  const plan = selectLaunch(context({
    have: (command) => command === "kitty" || command === "tmux",
    tmuxSession: "main",
  }));
  assert.equal(plan.started, true);
  assert.equal(plan.note, "tmux");
  assert.equal(plan.run?.wait, true);
  assert.deepEqual(plan.run?.args, ["new-window", "-t", "main", "-c", "/home/ada/work/app", piPath, "--session", sessionFile]);
});

test("an attached zellij session resumes the session when no terminal is available", () => {
  const plan = selectLaunch(context({ zellijSession: "dev" }));
  assert.equal(plan.note, "zellij");
  assert.equal(plan.run?.args[0], "--session");
  assert.equal(plan.run?.args.at(-2), "--session");
  assert.equal(plan.run?.args.at(-1), sessionFile);
});

test("with no terminal, resume waits for pi-teleport attach", () => {
  const plan = selectLaunch(context());
  assert.equal(plan.started, false);
  assert.equal(plan.run, undefined);
  assert.equal(plan.command, "pi-teleport attach");
  assert.equal(plan.command.includes("\n"), false);
});

test("launch can be disabled", () => {
  const plan = selectLaunch(context({
    launchDisabled: true,
    env: { DISPLAY: ":1" },
    have: () => true,
    tmuxSession: "main",
  }));
  assert.equal(plan.started, false);
  assert.equal(plan.note, "launch disabled");
  assert.equal(plan.command, "pi-teleport attach");
});

test("the service display is taken from the logged-in session", () => {
  const env = pickGraphicalEnv(
    { PATH: "/usr/bin", HOME: "/home/ada" },
    [{ WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/should-not-replace" }],
  );
  assert.equal(env.WAYLAND_DISPLAY, "wayland-1");
  assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(env.PATH, "/usr/bin");
  assert.deepEqual(parseEnviron("DISPLAY=:1\0WAYLAND_DISPLAY=wayland-1\0\0"), {
    DISPLAY: ":1",
    WAYLAND_DISPLAY: "wayland-1",
  });
});

test("pi's directory is on PATH for the resumed process", () => {
  const env = withToolPath({ PATH: "/usr/bin", HOME: "/home/ada" }, "/home/ada");
  assert.equal(env.PATH?.startsWith("/home/ada/.pi/agent/bin:/home/ada/.local/bin:/usr/bin"), true);
});

test("findPiBinary uses the managed pi install", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-bin-"));
  const pi = join(home, ".pi", "agent", "bin", "pi");
  await mkdir(dirname(pi), { recursive: true });
  await writeFile(pi, "#!/bin/sh\n");
  await chmod(pi, 0o755);
  try {
    assert.equal(findPiBinary(home, { PATH: "/usr/bin" }), pi);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
