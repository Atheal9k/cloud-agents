import { RunAllocationAttempt, RunAllocationId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { createFirecrackerFleetStore } from "./firecrackerFleet.ts";
import { type CloudHypervisorHost } from "./firecrackerPlacement.ts";

const allocationId = Schema.decodeSync(RunAllocationId)("allocation-1");
const secondAllocationId = Schema.decodeSync(RunAllocationId)("allocation-2");
const attempt = Schema.decodeSync(RunAllocationAttempt)(1);

const hosts: ReadonlyArray<CloudHypervisorHost> = [
  {
    id: "hv-1",
    accountId: "999999999999",
    cpuMillis: 8_000,
    memoryMib: 16_384,
    diskGib: 200,
    cpuOversubscribeRatio: 2,
    profiles: ["linux-web"],
    credentialsPath: "/var/lib/t3-hypervisor/hv-1/credentials",
    kvm: true,
  },
  {
    id: "hv-2",
    accountId: "999999999999",
    cpuMillis: 8_000,
    memoryMib: 16_384,
    diskGib: 200,
    cpuOversubscribeRatio: 2,
    profiles: ["linux-web"],
    credentialsPath: "/var/lib/t3-hypervisor/hv-2/credentials",
    kvm: true,
  },
];

describe("firecrackerFleet", () => {
  it("proves the Firecracker sequence on the packed fleet", () => {
    const fleet = createFirecrackerFleetStore(hosts);
    const proof = fleet.prove();
    expect(proof.ok).toBe(true);
    expect(proof.steps).toContain("kvm");
    expect(proof.steps).toContain("guest-kernel");
    expect(proof.steps).toContain("networking");
    expect(proof.steps).toContain("block-snapshot");
    expect(proof.steps).toContain("console");
    expect(proof.steps).toContain("teardown");
    expect(proof.blocked.hypervisorCredentials).toBe(true);
    expect(proof.blocked.instanceMetadata).toBe(true);
  });

  it("reschedules a hibernated guest when its hypervisor disappears", () => {
    const fleet = createFirecrackerFleetStore(hosts);
    const live = fleet.place({
      allocationId,
      attempt,
      profileId: "linux-web",
      agentId: "agent-live",
    });
    const idle = fleet.place({
      allocationId: secondAllocationId,
      attempt,
      profileId: "linux-web",
      agentId: "agent-idle",
    });
    expect("guest" in live).toBe(true);
    expect("guest" in idle).toBe(true);
    if (!("guest" in live) || !("guest" in idle)) return;
    expect(fleet.hibernate(idle.guest.guestId)).toBe(true);
    const result = fleet.rescheduleLostHost(live.guest.hostId);
    expect(result.lost.some((entry) => entry.guest.agentId === "agent-live")).toBe(true);
    expect(result.rescheduled.some((guest) => guest.agentId === "agent-idle")).toBe(true);
    expect(result.rescheduled[0]?.hostId).not.toBe(live.guest.hostId);
  });
});
