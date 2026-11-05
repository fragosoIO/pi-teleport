import assert from "node:assert/strict";
import test from "node:test";

import { beaconPayload, ipv4Broadcast, peerIpsFromTailscaleStatus, peerIpsFromWgDump } from "../src/core/discover.ts";
import { peerChoiceValue, resolveDial, type RemotePeer } from "../src/core/dial.ts";
import { renderUserUnit } from "../src/core/service.ts";

function peer(name: string, publicKey: string): RemotePeer {
  return { name, publicKey, port: 49721, lan: ["192.168.1.20"], tailscale: ["100.64.0.2"], lastSeen: Date.now() };
}

test("the beacon carries the service identity and not the one-time code", () => {
  const body = JSON.parse(beaconPayload({
    v: 1,
    name: "laptop",
    pub: "pub",
    port: 49721,
    lan: ["192.168.1.9"],
    ts: ["100.64.0.1"],
  }).toString("utf8")) as Record<string, unknown>;
  assert.equal(body.name, "laptop");
  assert.equal("code" in body, false);
});

test("VPN peer lists come from Tailscale status and WireGuard /32 addresses", () => {
  const tailscale = peerIpsFromTailscaleStatus(JSON.stringify({
    Peer: {
      a: { Online: true, TailscaleIPs: ["100.64.0.2", "fd7a:115c::2"] },
      b: { Online: false, TailscaleIPs: ["100.64.0.3"] },
    },
  }));
  assert.deepEqual(tailscale, ["100.64.0.2"]);
  const dump = [
    "priv\tpub\t51820\toff",
    "peer\tnone\t1.2.3.4:51820\t10.8.0.2/32\t0\t0\t0\toff",
    "peer2\tnone\t1.2.3.5:51820\t10.8.0.3/24\t0\t0\t0\toff",
  ].join("\n");
  assert.deepEqual(peerIpsFromWgDump(dump), ["10.8.0.2"]);
});

test("directed broadcasts skip single-host VPN addresses", () => {
  assert.equal(ipv4Broadcast("192.168.1.20", "255.255.255.0"), "192.168.1.255");
  assert.equal(ipv4Broadcast("100.64.1.2", "255.255.255.255"), null);
});

test("an accept-all beacon says so and still omits the one-time code", () => {
  const body = JSON.parse(beaconPayload({
    v: 1,
    name: "laptop",
    pub: "pub",
    port: 49721,
    lan: ["192.168.1.9"],
    ts: [],
    open: true,
  }).toString("utf8")) as Record<string, unknown>;
  assert.equal(body.open, true);
  assert.equal("code" in body, false);
});

test("a visible service needs the code once, and a saved name does not", () => {
  const desktop = peer("desktop", "desktop-key");
  assert.equal(resolveDial({ target: "desktop", pairings: {}, peers: [desktop] }).kind, "need-code");
  const again = resolveDial({
    target: "desktop",
    pairings: { desktop: { publicKey: "desktop-key" } },
    peers: [desktop],
  });
  assert.equal(again.kind, "paired");
  const typed = resolveDial({ target: "ABCD2345", pairings: {}, peers: [desktop] });
  assert.equal(typed.kind, "introduce");
  if (typed.kind === "introduce") assert.equal(typed.code, "ABCD2345");
  assert.equal(resolveDial({ target: "missing", pairings: {}, peers: [] }).kind, "unknown");
  const open = peer("desktop", "desktop-key");
  open.acceptAll = true;
  assert.equal(resolveDial({ target: "desktop", pairings: {}, peers: [open] }).kind, "open");
});

test("two services with the same name stay distinct in the menu", () => {
  const peers = [peer("pi", "aaaa-key1"), peer("pi", "bbbb-key2")];
  assert.equal(peerChoiceValue(peers[0]!, peers), "pi (key1)");
  assert.equal(peerChoiceValue(peers[1]!, peers), "pi (key2)");
  const picked = resolveDial({ target: "pi (key2)", pairings: {}, peers });
  assert.equal(picked.kind, "need-code");
  if (picked.kind === "need-code") assert.equal(picked.name, "pi (key2)");
});

test("the user service runs the listener and comes back if it exits", () => {
  const unit = renderUserUnit({ node: "/usr/bin/node", script: "/opt/pi teleport/src/cli.ts" });
  assert.match(unit, /ExecStart=\/usr\/bin\/node "\/opt\/pi teleport\/src\/cli.ts" listen/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default.target/);
});
