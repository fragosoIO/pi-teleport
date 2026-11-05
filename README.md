# pi-teleport

A [pi](https://pi.dev) harness plugin. While you are coding in pi, `/teleport` sends the live session to another computer you control. That computer starts a **new** pi session from the same state. It does not attach to a pi process that is already running.

Both computers run code from this repo: the slash command, a small background listener, and (only when you need it) a relay. Nothing here calls Cursor. Models stay whatever pi is already configured to use on each machine.

The transfer is encrypted on every path (X25519, then AES-256-GCM). A relay only sees a short name or a one-time code so it can pair the two listeners. It cannot read the files.

## What is copied

- The whole project tree, including `node_modules`, build output, `.git`, and `.env`.
- Every file outside the project that this session actually read or wrote. Those files are included quietly. There is no file list on each send.
- The session itself, with paths rewritten for the destination folder and for Linux, macOS, or Windows.

Each outside file is written in both places when the target allows it: the same path relative to the home folder (or the same absolute path), and a spare copy inside the project at `.pi-teleport/external/`. The restored session keeps using the home or absolute path. If that write cannot be done, references in the session are rewritten to the spare copy.

You are asked only when a write would replace something that is already on the target: overwrite those files, skip those files, or cancel. Every send also asks for the destination folder name and path, with a default filled in. If that folder exists: overwrite, pick a new name, or cancel.

Symlinks are kept as symlinks. If that operating system cannot create one, that file fails in the open and the rest of the transfer continues.

Node, Docker, databases, and other binaries on `PATH` are **not** copied. `.pi-teleport/manifest.json` in the destination records that they were used.

A dropped transfer resumes from the last contiguous byte. After a successful send the source session freezes. `/teleport unfreeze` continues it and warns that the two sides can then diverge. Teleport back is the same command in the other direction.

## Install on each PC

Node.js 22 or newer, and pi 1.5 or newer. Copy this folder over SSH. There is no GitHub remote.

```bash
rsync -a ~/Documents/Projects/pi-teleport/ user@other:~/Documents/Projects/pi-teleport/
```

On **each** computer:

```bash
cd ~/Documents/Projects/pi-teleport
mkdir -p ~/.local/bin
ln -sfn "$PWD/src/cli.ts" ~/.local/bin/pi-teleport
# ~/.local/bin must be on PATH. Node runs the TypeScript file directly.

pi install "$PWD"
pi-teleport name laptop          # a short name for this computer
```

`pi install` writes the package path into `~/.pi/agent/settings.json`. Restart pi, or run `/reload`, so `/teleport` appears.

Check the install:

```bash
node --test test/*.test.ts
pi-teleport status
```

## Run the listener

Both computers need a listener before `/teleport`. It prints a one-time code and keeps it until you stop it.

```bash
pi-teleport listen
```

Leave that process running (a terminal, tmux, or a user service). The code is also in `~/.pi-teleport/code` (`pi-teleport code`).

The listener binds TCP `49721` and a UDP beacon on `49720`. The control API is only on `127.0.0.1:49722`.

## Pair

On the computer that will **receive**, read the code from `pi-teleport listen`.

On the computer you are coding on, in pi:

```text
/teleport
```

Choose "Enter a one-time code" and type it. Or pass it directly: `/teleport ABCD2345`.

When the send finishes, pi asks for a short name. Accept the other computer's name (or type one). Next time:

```text
/teleport laptop
```

`pi-teleport save <name> <public-key>` does the same thing from a shell. `pi-teleport status` prints this computer's public key. The listener also stores the sender's key under the sender's name after a code is used, so the return trip can use `/teleport <that-name>` without a new code.

## Reachability

The sender tries routes in this order and uses the first one that connects:

1. Same LAN (UDP beacon, then a direct TCP connection).
2. An existing private network such as Tailscale, if `tailscale` or a `tailscale*` interface is already on this machine. Tailscale is not installed or bundled by this repo.
3. The relay, if you configured one.

## Run the relay

Use the relay when the computers are not on the same LAN and Tailscale is not there. Run it on a machine both listeners can dial.

```bash
pi-teleport relay --listen 0.0.0.0:49730
```

On **each** computer, once:

```bash
pi-teleport relay-set 10.0.0.2:49730
```

Restart `pi-teleport listen` after changing the relay. Both listeners dial out. You do not open inbound ports on the two PCs.

## /teleport on two PCs

1. `pi-teleport listen` on both.
2. In pi, on the source: `/teleport laptop` (or a one-time code).
3. Confirm the folder name and path. The default is the project path relative to your home folder, mapped onto the other home folder.
4. The other listener writes the tree, rewrites the session, and starts `pi --session <file>` in a new terminal when it can find one.
5. The source session freezes.

On an SSH session with no graphical terminal, the listener does not open a window. In a terminal on the receiving computer:

```bash
pi-teleport attach
```

That starts a new pi with the received session. It is not attached to an existing pi process.

To send the session back, run `/teleport <the-other-name>` in the new session. The computer you are leaving freezes. The computer you return to gets a new pi session.

To keep working on a frozen session:

```text
/teleport unfreeze
```

pi asks you to confirm. The other copy will not update, and the two sides can diverge.

## Layout

| Path | Role |
| --- | --- |
| `src/extension.ts` | `/teleport` slash command |
| `src/cli.ts` | `pi-teleport` command |
| `src/listener.ts` | background listener |
| `src/relay.ts` | relay |
| `src/core/` | snapshot, path rewrite, encryption, resume |

Configuration and the identity key live in `~/.pi-teleport/` (`config.json`, `identity.json`). The identity file is created on first use and is the key other computers pin after pairing.
