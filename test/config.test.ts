import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configuredProjects, defaultConfig, defaultProjectsDir, normalizeProjectsDir, parsePairingMode, parseYesNo, resolveProjectsDir, SUGGESTED_PROJECTS } from "../src/core/config.ts";

test("projects folder expands home and refuses a drive root", () => {
  assert.equal(normalizeProjectsDir("~/Documents/Projects", "/home/ada"), "/home/ada/Documents/Projects");
  assert.equal(normalizeProjectsDir("~", "/home/ada"), "/home/ada");
  assert.throws(() => normalizeProjectsDir("/", "/home/ada"), /drive root/);
  assert.throws(() => normalizeProjectsDir("   ", "/home/ada"), /required/);
});

test("the suggested projects folder is created when it is missing", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-teleport-default-"));
  try {
    assert.equal(SUGGESTED_PROJECTS, "~/.pi-teleport/projects");
    assert.equal(defaultProjectsDir(home), join(home, ".pi-teleport", "projects"));
    const dir = await resolveProjectsDir(SUGGESTED_PROJECTS, home);
    assert.equal(dir, defaultProjectsDir(home));
    assert.equal((await stat(dir)).isDirectory(), true);
    await assert.rejects(() => resolveProjectsDir(join(home, "missing"), home), /no such folder/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("teleport requires setup to choose a projects folder and a pairing rule", () => {
  assert.throws(() => configuredProjects(defaultConfig()), /pi-teleport setup/);
  assert.throws(() => configuredProjects({ ...defaultConfig(), projects: "/home/ada/Projects" }), /pi-teleport setup/);
  assert.equal(
    configuredProjects({ ...defaultConfig(), projects: "/home/ada/Projects", requireCode: false }),
    "/home/ada/Projects",
  );
});

test("setup answers are code or all, and y or n", () => {
  assert.equal(parsePairingMode("code"), "code");
  assert.equal(parsePairingMode("accept all"), "all");
  assert.equal(parseYesNo("y"), true);
  assert.equal(parseYesNo("no"), false);
  assert.throws(() => parsePairingMode(""), /code or all/);
  assert.throws(() => parseYesNo(""), /y or n/);
});
