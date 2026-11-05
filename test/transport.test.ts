import assert from "node:assert/strict";
import test from "node:test";

import { selectTransport, tailscaleInterfacePresent, TRANSPORT_ORDER } from "../src/core/transport.ts";

test("transport order is LAN, then Tailscale, then the relay", () => {
  assert.deepEqual([...TRANSPORT_ORDER], ["lan", "tailscale", "relay"]);
});

test("the first reachable transport wins", () => {
  assert.equal(
    selectTransport({ lan: true, tailscaleDetected: true, tailscale: true, relay: true }),
    "lan",
  );
  assert.equal(
    selectTransport({ lan: false, tailscaleDetected: true, tailscale: true, relay: true }),
    "tailscale",
  );
  assert.equal(
    selectTransport({ lan: false, tailscaleDetected: true, tailscale: false, relay: true }),
    "relay",
  );
  assert.equal(
    selectTransport({ lan: false, tailscaleDetected: false, tailscale: false, relay: false }),
    null,
  );
});

test("Tailscale is skipped unless this machine actually has it", () => {
  assert.equal(
    selectTransport({ lan: false, tailscaleDetected: false, tailscale: true, relay: true }),
    "relay",
  );
  assert.equal(tailscaleInterfacePresent(["eth0", "tailscale0"]), true);
  assert.equal(tailscaleInterfacePresent(["eth0", "utun3", "lo"]), false);
});
