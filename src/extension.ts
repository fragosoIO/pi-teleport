import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { configRoot, currentOs, loadConfig, loadIdentity, SETUP_HINT, setupComplete, type TeleportConfig } from "./core/config.ts";
import { FREEZE_TYPE } from "./core/constants.ts";
import { connectToPeer, peerChoiceValue, resolveDial, type RemotePeer } from "./core/dial.ts";
import { planExternalPlacement } from "./core/external.ts";
import {
  applyCollisionChoice,
  applyDestinationChoice,
  externalCollisionCandidates,
  needsOverwritePrompt,
  writesThatCollide,
} from "./core/overwrite.ts";
import { defaultDestination, folderNameOf, type OsName, type PathRoots } from "./core/paths.ts";
import {
  barFilled,
  createProgressThrottle,
  formatProgress,
  listingState,
  readingState,
  retryState,
  sendingState,
  type ProgressState,
} from "./core/progress.ts";
import type { JsonRecord } from "./core/session.ts";
import { buildSnapshot, listExternalFiles } from "./core/snapshot.ts";
import { collectOutboundSessions, loadResumedIds, outboundChoices, pendingOutbound, rememberResumed, resumedFile, sessionSearchRoots } from "./core/sent.ts";
import { probeDestination, sendPlan, type SendPlan, type SendProgress } from "./core/transfer.ts";
import type { PeerLink } from "./core/link.ts";

interface FreezeData {
  frozen?: boolean;
}

export default function (pi: ExtensionAPI) {
  let frozen = false;

  const showFrozen = (ctx: ExtensionCommandContext | { ui: ExtensionCommandContext["ui"] }, value: boolean) => {
    frozen = value;
    ctx.ui.setStatus("pi-teleport", value ? "frozen" : undefined);
    ctx.ui.setWidget("pi-teleport", value ? ["pi-teleport: frozen — /teleport unfreeze"] : undefined);
  };

  pi.on("session_start", (_event, ctx) => {
    showFrozen(ctx, readFrozen(ctx.sessionManager.getBranch()));
  });

  pi.on("input", (event, ctx) => {
    if (!frozen) return { action: "continue" };
    const text = event.text.trim();
    if (text === "/teleport" || text.startsWith("/teleport ")) return { action: "continue" };
    ctx.ui.notify("Session is frozen. /teleport unfreeze to continue here.", "warning");
    return { action: "handled" };
  });

  pi.on("tool_call", () => {
    if (!frozen) return;
    return { block: true, reason: "Session is frozen after teleport. /teleport unfreeze to continue." };
  });

  pi.registerCommand("teleport", {
    description: "Teleport this session, resume one sent earlier, or unfreeze",
    getArgumentCompletions: (prefix) => {
      const names = ["resume", "unfreeze", ...pairingNames()];
      const items = names.filter((name) => name.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "resume") {
        await resumeSent(ctx);
        return;
      }
      if (frozen || arg === "unfreeze") {
        if (arg && arg !== "unfreeze") {
          ctx.ui.notify("This session is frozen. Run /teleport unfreeze before sending again.", "warning");
          return;
        }
        if (!frozen) {
          ctx.ui.notify("This session is not frozen.", "info");
          return;
        }
        const ok = await ctx.ui.confirm(
          "Unfreeze this session?",
          "The copy on the other computer will not update. The two sides can then diverge.",
        );
        if (!ok) return;
        pi.appendEntry(FREEZE_TYPE, { frozen: false, at: new Date().toISOString() });
        showFrozen(ctx, false);
        ctx.ui.notify("Session unfrozen. The two sides can diverge.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Teleport needs an interactive session.", "error");
        return;
      }
      await ctx.waitForIdle();
      const root = configRoot();
      let config: TeleportConfig;
      try {
        config = await loadConfig(root);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      if (!setupComplete(config)) {
        ctx.ui.notify(SETUP_HINT, "error");
        return;
      }
      try {
        await controlJson(config.controlPort, "/v1/status");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      let peers: RemotePeer[] = [];
      try {
        peers = await controlJson(config.controlPort, "/v1/peers") as RemotePeer[];
      } catch {
        peers = [];
      }
      const chosen = await chooseTarget(arg, config, peers, ctx);
      if (!chosen) return;
      const target = chosen.target;
      let dialCode = chosen.code;
      const first = resolveDial({ target, code: dialCode, pairings: config.pairings, peers });
      if (first.kind === "need-code") {
        dialCode = (await ctx.ui.editor(`One-time code from ${first.name}`, ""))?.trim();
        if (!dialCode) return;
      } else if (first.kind === "unknown") {
        ctx.ui.notify(`No pi-teleport service named ${first.target} is visible on this network or VPN.`, "error");
        return;
      }
      const identity = await loadIdentity(root);
      let link: PeerLink | undefined;
      let hello: { name: string; os?: OsName; home?: string; projects?: string; staticPub: string } | undefined;
      let dialTarget = target;
      try {
        const connected = await connectToPeer({
          target,
          code: dialCode,
          config,
          identity,
          peers,
          ourName: config.name,
        });
        link = connected.link;
        hello = connected.hello;
        const known = Object.values(config.pairings).some((item) => item.publicKey === connected.publicKey);
        if (!known) {
          const saved = await rememberPeer(config, hello.name, connected.publicKey, ctx, connected.viaCode);
          if (saved) {
            config.pairings[saved] = { publicKey: connected.publicKey };
            dialTarget = saved;
            dialCode = undefined;
          }
        }
      } catch (error) {
        link?.finish();
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      if (!link || !hello) return;
      let progress: { stop(): void } | undefined;
      try {
        if (!hello.os || !hello.home) throw new Error("the other computer did not announce its home directory");
        const remoteProjects = hello.projects?.trim() ?? "";
        if (!remoteProjects) {
          throw new Error("the other computer's listener started before pi-teleport setup. On that computer run: systemctl --user restart pi-teleport");
        }
        const from: PathRoots = { os: currentOs(), home: homedir(), project: ctx.cwd };
        const folderDefault = folderNameOf(ctx.cwd);
        const folder = (await ctx.ui.editor("Destination folder name", folderDefault))?.trim();
        if (!folder) return;
        let dest = (await ctx.ui.editor("Destination path", defaultDestination(hello.os, remoteProjects, folder)))?.trim();
        if (!dest) return;
        const entries = JSON.parse(JSON.stringify(ctx.sessionManager.getEntries())) as JsonRecord[];
        const external = await listExternalFiles(entries, ctx.cwd, from.home, from.os, ctx.sessionManager.getSessionFile() ?? undefined);
        let overwriteDest = false;
        let skipIds: string[] = [];
        for (;;) {
          const to: PathRoots = { os: hello.os, home: hello.home, project: dest };
          const placements = external
            .map((sourcePath) => planExternalPlacement(sourcePath, from, to, true))
            .filter((item): item is NonNullable<typeof item> => item !== null);
          const candidates = externalCollisionCandidates(placements);
          const probe = await probeDestination(link, dest, candidates.map((item) => item.targetPath));
          if (probe.error) throw new Error(probe.error);
          if (probe.destExists && !overwriteDest) {
            const choice = await ctx.ui.select("That folder already exists", ["Overwrite", "Pick a new name", "Cancel"]);
            const mapped = choice === "Overwrite" ? "overwrite" : choice === "Pick a new name" ? "rename" : "cancel";
            const action = applyDestinationChoice(mapped, true);
            if (action.action === "cancel") return;
            if (action.action === "rename") {
              const nextName = (await ctx.ui.editor("Destination folder name", `${folder}-2`))?.trim();
              if (!nextName) return;
              const nextPath = (await ctx.ui.editor("Destination path", defaultDestination(hello.os, remoteProjects, nextName)))?.trim();
              if (!nextPath) return;
              dest = nextPath;
              continue;
            }
            overwriteDest = true;
          }
          const collisions = writesThatCollide(candidates, (path) => probe.collisions.includes(path));
          if (needsOverwritePrompt(collisions)) {
            const choice = await ctx.ui.select("Some files already exist on that computer", ["Overwrite those", "Skip those", "Cancel"]);
            const mapped = choice === "Overwrite those" ? "overwrite" : choice === "Skip those" ? "skip" : "cancel";
            const applied = applyCollisionChoice(mapped, collisions);
            if (!applied.proceed) return;
            skipIds = applied.skipIds;
          }
          break;
        }
        let latest: ProgressState = { peer: hello.name, status: "Listing project files", done: 0 };
        const paint = createProgressThrottle((state) => showProgress(ctx, state));
        progress = paint;
        const show = (state: ProgressState) => {
          latest = state;
          paint.push(state);
        };
        show(latest);
        const header = ctx.sessionManager.getHeader();
        const sessionJsonl = `${JSON.stringify(header ?? { type: "session", version: 3, id: ctx.sessionManager.getSessionId(), timestamp: new Date().toISOString(), cwd: ctx.cwd })}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
        const snapshot = await buildSnapshot({
          project: ctx.cwd,
          home: from.home,
          os: from.os,
          name: config.name,
          peerName: hello.name,
          target: { os: hello.os, home: hello.home, project: dest },
          destPath: dest,
          sessionJsonl,
          entries,
          sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
          onProgress: (event) => {
            if (event.phase === "listing") show(listingState(event.done, event.file, hello.name));
            else show(readingState(event, hello.name));
          },
        });
        for (const failure of snapshot.failures) ctx.ui.notify(failure, "warning");
        const plan: SendPlan = {
          transferId: randomUUID(),
          destPath: dest,
          overwriteDest,
          manifest: snapshot.manifest,
          skipSourcePaths: skipIds,
          files: snapshot.files,
        };
        const bytes = snapshot.files.reduce((sum, file) => sum + file.size, 0);
        show({
          peer: hello.name,
          status: snapshot.files.length > 0 ? `Sending  1/${snapshot.files.length}` : "Sending",
          done: 0,
          total: bytes,
        });
        const result = await sendWithResume(link, plan, async () => {
          const again = await connectToPeer({
            target: dialTarget,
            code: dialCode,
            config,
            identity,
            peers: await controlJson(config.controlPort, "/v1/peers") as RemotePeer[],
            ourName: config.name,
          });
          link = again.link;
          return again.link;
        }, {
          onProgress: (event) => show(sendingState(event, hello.name)),
          onRetry: (attempt) => {
            show(retryState(latest, attempt));
            paint.flush();
          },
        });
        paint.stop();
        pi.appendEntry(FREEZE_TYPE, { frozen: true, at: new Date().toISOString(), peer: hello.name, dest });
        showFrozen(ctx, true);
        ctx.ui.notify("Teleport finished. This session is frozen. /teleport unfreeze to continue here.", "info");
        if (result.launched) ctx.ui.notify(`Session resumed on ${hello.name}.`, "info");
        else if (result.launchCommand) ctx.ui.notify(`On ${hello.name}, run: ${result.launchCommand}`, "info");
        for (const failure of result.symlinkFailures) ctx.ui.notify(failure, "error");
        if (result.primaryFallback > 0) {
          ctx.ui.notify(`${result.primaryFallback} files could not be written outside the project. The session uses the copies inside it.`, "warning");
        }
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      } finally {
        progress?.stop();
        link?.finish();
        if (!frozen) {
          ctx.ui.setStatus("pi-teleport", undefined);
          ctx.ui.setWidget("pi-teleport", undefined);
        }
      }
    },
  });
}

async function resumeSent(ctx: ExtensionCommandContext): Promise<void> {
  const root = configRoot();
  const resumed = await loadResumedIds(resumedFile(root));
  const sessions = pendingOutbound(
    await collectOutboundSessions(sessionSearchRoots(ctx.sessionManager.getSessionDir(), homedir())),
    resumed,
  );
  if (sessions.length === 0) {
    ctx.ui.notify("No sessions sent to other computers are waiting to resume here.", "info");
    return;
  }
  const choices = outboundChoices(sessions);
  if (!ctx.hasUI) {
    for (const choice of choices) ctx.ui.notify(choice.label, "info");
    return;
  }
  const selected = await ctx.ui.select("Sessions sent to other computers", choices.map((choice) => choice.label));
  if (!selected) return;
  const session = choices.find((choice) => choice.label === selected)?.session;
  if (!session) return;
  const file = resumedFile(root);
  if (session.sessionFile === ctx.sessionManager.getSessionFile()) {
    await rememberResumed(file, session.sessionId).catch(() => undefined);
    ctx.ui.notify(`This session is already open. It was sent to ${session.peer} and stays frozen until /teleport unfreeze.`, "info");
    return;
  }
  try {
    const result = await ctx.switchSession(session.sessionFile, {
      withSession: async (next) => {
        await rememberResumed(file, session.sessionId).catch(() => undefined);
        next.ui.notify(`Opened the session sent to ${session.peer}. It stays frozen until /teleport unfreeze.`, "info");
      },
    });
    if (result.cancelled) return;
  } catch (error) {
    ctx.ui.notify((error as Error).message, "error");
  }
}

function readFrozen(entries: readonly { type?: string; customType?: string; data?: unknown }[]): boolean {
  let value = false;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === FREEZE_TYPE) {
      value = Boolean((entry.data as FreezeData | undefined)?.frozen);
    }
  }
  return value;
}

function pairingNames(): string[] {
  try {
    const config = JSON.parse(readFileSync(join(configRoot(), "config.json"), "utf8")) as TeleportConfig;
    return Object.keys(config.pairings ?? {});
  } catch {
    return [];
  }
}

async function chooseTarget(
  arg: string,
  config: TeleportConfig,
  peers: readonly RemotePeer[],
  ctx: ExtensionCommandContext,
): Promise<{ target: string; code?: string } | undefined> {
  if (arg) return { target: arg };
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const peer of peers) {
    const saved = Object.entries(config.pairings).find(([, pairing]) => pairing.publicKey === peer.publicKey);
    const label = saved ? saved[0] : peerChoiceValue(peer, peers);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  for (const name of Object.keys(config.pairings)) {
    if (!seen.has(name)) labels.push(name);
  }
  const choice = await ctx.ui.select("Teleport to", [...labels, "Enter a one-time code"]);
  if (!choice) return undefined;
  if (choice === "Enter a one-time code") {
    const code = (await ctx.ui.editor("One-time code from the other computer", ""))?.trim();
    return code ? { target: code, code } : undefined;
  }
  return { target: choice };
}

async function rememberPeer(
  config: TeleportConfig,
  name: string,
  publicKey: string,
  ctx: ExtensionCommandContext,
  usedCode: boolean,
): Promise<string | undefined> {
  const existing = Object.entries(config.pairings).find(([, pairing]) => pairing.publicKey === publicKey);
  if (existing) return existing[0];
  let next = name;
  for (;;) {
    try {
      await postJson(config.controlPort, "/v1/pairings", { name: next, publicKey });
      const note = usedCode ? " The code is not needed again." : "";
      ctx.ui.notify(`Paired with ${next}.${note}`, "info");
      return next;
    } catch (error) {
      const message = (error as Error).message;
      if (!message.includes("different key")) throw error;
      const renamed = (await ctx.ui.editor(`${next} is already used. Save this computer as`, `${next}-2`))?.trim();
      if (!renamed) return undefined;
      next = renamed;
    }
  }
}

async function sendWithResume(
  link: PeerLink,
  plan: SendPlan,
  redial: () => Promise<PeerLink>,
  hooks: {
    onProgress: (event: SendProgress) => void;
    onRetry: (attempt: number) => void;
  },
) {
  let current = link;
  let resume = false;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (attempt > 0) current = await redial();
      return await sendPlan(current, plan, { resume, onProgress: hooks.onProgress });
    } catch (error) {
      lastError = error as Error;
      current.finish();
      resume = true;
      hooks.onRetry(attempt + 1);
    }
  }
  throw lastError ?? new Error("transfer failed");
}

function showProgress(ctx: ExtensionCommandContext, state: ProgressState): void {
  const theme = ctx.ui.theme;
  const view = formatProgress(state);
  const bar = (filled: number, width: number) =>
    theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(Math.max(0, width - filled)));
  const meter = [bar(view.filled, view.width), view.percent, view.amounts].filter((part) => part).join("  ");
  ctx.ui.setWidget("pi-teleport", [
    theme.fg("text", view.title),
    meter,
    theme.fg("muted", view.detail),
  ]);
  const status = [bar(barFilled(view.fraction, 12), 12), view.percent, theme.fg("muted", view.status)]
    .filter((part) => part)
    .join("  ");
  ctx.ui.setStatus("pi-teleport", status);
}

function controlJson(port: number, path: string, method = "GET", body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 300) {
          reject(new Error(text || `listener returned ${res.statusCode}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          reject(new Error("listener returned malformed JSON"));
        }
      });
    });
    req.on("error", () => reject(new Error("The listener is not running. Start it with: pi-teleport listen")));
    if (payload) req.write(payload);
    req.end();
  });
}

function postJson(port: number, path: string, body: unknown): Promise<unknown> {
  return controlJson(port, path, "POST", body);
}
