import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { configRoot, currentOs, loadConfig, loadIdentity, type TeleportConfig } from "./core/config.ts";
import { FREEZE_TYPE } from "./core/constants.ts";
import { connectToPeer, type RemotePeer } from "./core/dial.ts";
import { planExternalPlacement } from "./core/external.ts";
import {
  applyCollisionChoice,
  applyDestinationChoice,
  externalCollisionCandidates,
  needsOverwritePrompt,
  writesThatCollide,
} from "./core/overwrite.ts";
import { defaultDestination, folderNameOf, type OsName, type PathRoots } from "./core/paths.ts";
import type { JsonRecord } from "./core/session.ts";
import { buildSnapshot, listExternalFiles } from "./core/snapshot.ts";
import { probeDestination, sendPlan, type SendPlan } from "./core/transfer.ts";
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
    description: "Teleport this session and project to another computer",
    getArgumentCompletions: (prefix) => {
      const names = ["unfreeze", ...pairingNames()];
      const items = names.filter((name) => name.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
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
      try {
        await controlJson(config.controlPort, "/v1/status");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      const target = await chooseTarget(arg, config, ctx);
      if (!target) return;
      const identity = await loadIdentity(root);
      const peers = await controlJson(config.controlPort, "/v1/peers") as RemotePeer[];
      let link: PeerLink;
      let hello: { name: string; os?: OsName; home?: string; staticPub: string };
      let viaCode = false;
      let publicKey = "";
      try {
        const connected = await connectToPeer({
          target,
          config,
          identity,
          peers,
          ourName: config.name,
        });
        link = connected.link;
        hello = connected.hello;
        viaCode = connected.viaCode;
        publicKey = connected.publicKey;
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      try {
        if (!hello.os || !hello.home) throw new Error("the other computer did not announce its home directory");
        const from: PathRoots = { os: currentOs(), home: homedir(), project: ctx.cwd };
        const folderDefault = folderNameOf(ctx.cwd);
        const folder = (await ctx.ui.editor("Destination folder name", folderDefault))?.trim();
        if (!folder) return;
        let dest = (await ctx.ui.editor("Destination path", defaultDestination(from, { ...from, os: hello.os, home: hello.home }, folder)))?.trim();
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
              const nextPath = (await ctx.ui.editor("Destination path", defaultDestination(from, to, nextName)))?.trim();
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
        ctx.ui.setStatus("pi-teleport", `sending to ${hello.name}…`);
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
        const result = await sendWithResume(link, plan, async () => {
          const again = await connectToPeer({ target, config, identity, peers: await controlJson(config.controlPort, "/v1/peers") as RemotePeer[], ourName: config.name });
          link = again.link;
          return again.link;
        }, (text) => ctx.ui.setStatus("pi-teleport", text));
        pi.appendEntry(FREEZE_TYPE, { frozen: true, at: new Date().toISOString(), peer: hello.name, dest });
        showFrozen(ctx, true);
        ctx.ui.notify("Teleport finished. This session is frozen. /teleport unfreeze to continue here.", "info");
        if (!result.launched && result.launchCommand) ctx.ui.notify(`On the other computer: ${result.launchCommand}`, "info");
        for (const failure of result.symlinkFailures) ctx.ui.notify(failure, "error");
        if (result.primaryFallback > 0) {
          ctx.ui.notify(`${result.primaryFallback} files could not be written outside the project. The session uses the copies inside it.`, "warning");
        }
        if (viaCode) {
          const saved = (await ctx.ui.editor("Save this computer as a short name", hello.name))?.trim();
          if (saved) {
            await postJson(config.controlPort, "/v1/pairings", { name: saved, publicKey });
            ctx.ui.notify(`Saved as ${saved}. Next time: /teleport ${saved}`, "info");
          }
        }
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      } finally {
        link.finish();
        if (!frozen) ctx.ui.setStatus("pi-teleport", undefined);
      }
    },
  });
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

async function chooseTarget(arg: string, config: TeleportConfig, ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (arg) return arg;
  let peers: RemotePeer[] = [];
  try {
    peers = await controlJson(config.controlPort, "/v1/peers") as RemotePeer[];
  } catch {
    peers = [];
  }
  const names = [...new Set([...Object.keys(config.pairings), ...peers.map((peer) => peer.name)])];
  const choice = await ctx.ui.select("Teleport to", [...names, "Enter a one-time code"]);
  if (!choice) return undefined;
  if (choice === "Enter a one-time code") {
    const code = (await ctx.ui.editor("One-time code from the other computer", ""))?.trim();
    return code || undefined;
  }
  return choice;
}

async function sendWithResume(
  link: PeerLink,
  plan: SendPlan,
  redial: () => Promise<PeerLink>,
  status: (text: string) => void,
) {
  let current = link;
  let resume = false;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (attempt > 0) current = await redial();
      return await sendPlan(current, plan, { resume });
    } catch (error) {
      lastError = error as Error;
      current.finish();
      resume = true;
      status(`connection dropped, resuming (${attempt + 1})…`);
    }
  }
  throw lastError ?? new Error("transfer failed");
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
