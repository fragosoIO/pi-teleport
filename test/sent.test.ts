import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectOutboundSessions,
  loadResumedIds,
  outboundChoices,
  outboundFromJsonl,
  pendingOutbound,
  rememberResumed,
  resumedFile,
  sessionsSearchRoot,
} from "../src/core/sent.ts";

const sent = (peer: string, at: string, extra = "") => `${JSON.stringify({
  type: "session",
  version: 3,
  id: "sess-1",
  cwd: "/home/ada/work/app",
})}\n${JSON.stringify({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "write a short story" }] },
})}\n${extra}${JSON.stringify({
  type: "custom",
  customType: "pi-teleport:freeze",
  timestamp: at,
  data: { frozen: true, at, peer, dest: `/home/${peer}/projects/app` },
})}\n`;

test("a frozen send is listed with the first user message as its title", () => {
  const session = outboundFromJsonl(sent("hermes", "2026-11-05T21:19:00.709Z"), "/tmp/a.jsonl");
  assert.ok(session);
  assert.equal(session?.peer, "hermes");
  assert.equal(session?.title, "write a short story");
  assert.equal(session?.dest, "/home/hermes/projects/app");
  assert.equal(outboundChoices([session!])[0]?.label, "write a short story → hermes · 2026-11-05 21:19");
});

test("a session name replaces the first message", () => {
  const jsonl = `${JSON.stringify({ type: "session", id: "sess-1", cwd: "/home/ada/work/app" })}\n${JSON.stringify({
    type: "session_info",
    name: "Lighthouse",
  })}\n${JSON.stringify({
    type: "custom",
    customType: "pi-teleport:freeze",
    data: { frozen: true, at: "2026-11-05T21:19:00.709Z", peer: "hermes" },
  })}\n`;
  assert.equal(outboundFromJsonl(jsonl, "/tmp/a.jsonl")?.title, "Lighthouse");
});

test("unfreeze and a local session are omitted", () => {
  const open = `${JSON.stringify({ type: "session", id: "sess-1", cwd: "/home/ada/work/app" })}\n`;
  assert.equal(outboundFromJsonl(open, "/tmp/a.jsonl"), null);
  const thawed = `${sent("hermes", "2026-11-05T21:19:00.709Z")}${JSON.stringify({
    type: "custom",
    customType: "pi-teleport:freeze",
    data: { frozen: false, at: "2026-11-05T22:00:00.000Z" },
  })}\n`;
  assert.equal(outboundFromJsonl(thawed, "/tmp/a.jsonl"), null);
});

test("the latest freeze decides, and a broken line does not hide the send", () => {
  const jsonl = `${sent("laptop", "2026-11-05T20:00:00.000Z")}not json\n${JSON.stringify({
    type: "custom",
    customType: "pi-teleport:freeze",
    data: { frozen: true, at: "2026-11-05T23:00:00.000Z", peer: "desktop" },
  })}\n`;
  const session = outboundFromJsonl(jsonl, "/tmp/a.jsonl");
  assert.equal(session?.peer, "desktop");
  assert.equal(session?.sentAt, "2026-11-05T23:00:00.000Z");
});

test("duplicate labels keep a session id suffix", () => {
  const first = outboundFromJsonl(sent("hermes", "2026-11-05T21:19:00.709Z"), "/tmp/a.jsonl");
  const second = outboundFromJsonl(sent("hermes", "2026-11-05T21:19:00.709Z").replace("sess-1", "sess-2"), "/tmp/b.jsonl");
  assert.ok(first && second);
  const labels = outboundChoices([first, second]).map((item) => item.label);
  assert.equal(new Set(labels).size, 2);
  assert.match(labels[1] ?? "", /sess-2/);
});

test("the project directory is not the search root", () => {
  assert.equal(
    sessionsSearchRoot("/home/ada/.pi/agent/sessions/--home-ada-work-app--"),
    "/home/ada/.pi/agent/sessions",
  );
  assert.equal(sessionsSearchRoot("/custom/sessions"), "/custom/sessions");
});

test("the list is every still-frozen send, newest first", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teleport-sent-"));
  try {
    const olderDir = join(root, "--home-ada-work-app--");
    const newerDir = join(root, "--home-ada-work-other--");
    await mkdir(olderDir);
    await mkdir(newerDir);
    await writeFile(join(olderDir, "old.jsonl"), sent("hermes", "2026-11-05T21:19:00.709Z"));
    await writeFile(join(newerDir, "new.jsonl"), sent("desktop", "2026-11-05T22:00:00.000Z").replaceAll("sess-1", "sess-2"));
    await writeFile(join(newerDir, "open.jsonl"), `${JSON.stringify({ type: "session", id: "sess-3", cwd: "/home/ada/work/other" })}\n`);
    await writeFile(join(newerDir, "notes.txt"), "ignore");
    const sessions = await collectOutboundSessions([root, join(root, "missing")]);
    assert.deepEqual(sessions.map((session) => session.peer), ["desktop", "hermes"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a session already resumed here leaves the list", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-teleport-resumed-"));
  try {
    const file = resumedFile(root);
    assert.equal((await loadResumedIds(file)).size, 0);
    await rememberResumed(file, "sess-1");
    await rememberResumed(file, "sess-1");
    const session = outboundFromJsonl(sent("hermes", "2026-11-05T21:19:00.709Z"), "/tmp/a.jsonl");
    assert.ok(session);
    const waiting = pendingOutbound([session], await loadResumedIds(file));
    assert.deepEqual(waiting, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
