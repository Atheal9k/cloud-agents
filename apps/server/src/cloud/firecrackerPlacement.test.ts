import { describe, expect, it } from "vite-plus/test";

import {
  cpuCapacity,
  guestCanRead,
  instanceMetadataAddress,
  isolateGuest,
  placeGuest,
  releaseGuest,
  rescheduleAfterHypervisorLoss,
  runtimeParity,
  slotsForProfile,
  usedSlots,
  type CloudHypervisorFleet,
  type CloudHypervisorHost,
} from "./firecrackerPlacement.ts";

const host = (id: string, overrides?: Partial<CloudHypervisorHost>): CloudHypervisorHost => ({
  id,
  accountId: "999999999999",
  cpuMillis: 8_000,
  memoryMib: 32_768,
  diskGib: 400,
  cpuOversubscribeRatio: 2,
  profiles: ["linux-web"],
  credentialsPath: `/var/lib/t3-hypervisor/${id}/credentials`,
  kvm: true,
  ...overrides,
});

function emptyFleet(hosts: ReadonlyArray<CloudHypervisorHost>): CloudHypervisorFleet {
  return { hosts, guests: [] };
}

describe("firecrackerPlacement", () => {
  it("packs two linux-web guests by oversubscribing CPU without overcommitting memory", () => {
    const first = placeGuest(emptyFleet([host("hv-1")]), {
      agentId: "agent-a",
      profileId: "linux-web",
    });
    expect(first.status).toBe("placed");
    if (first.status !== "placed") return;
    const second = placeGuest(first.fleet, { agentId: "agent-b", profileId: "linux-web" });
    expect(second.status).toBe("placed");
    if (second.status !== "placed") return;
    expect(second.guest.isolation.vmId).not.toBe(first.guest.isolation.vmId);
    expect(second.guest.isolation.diskKeyId).not.toBe(first.guest.isolation.diskKeyId);
    expect(second.guest.isolation.network.ipv4).not.toBe(first.guest.isolation.network.ipv4);
    expect(usedSlots(second.fleet, "hv-1").memoryMib).toBe(16_384);
    expect(usedSlots(second.fleet, "hv-1").cpuMillis).toBe(4_000);
    expect(cpuCapacity(host("hv-1"))).toBe(16_000);
    const third = placeGuest(second.fleet, {
      agentId: "agent-c",
      profileId: "linux-web",
      slots: { cpuMillis: 2_000, memoryMib: 24_576, diskGib: 30 },
    });
    expect(third).toMatchObject({
      status: "no-capacity",
    });
  });

  it("rejects a memory placement that would OOM a neighbor even when CPU remains", () => {
    const tight = host("hv-mem", { memoryMib: 8_192, cpuMillis: 16_000, cpuOversubscribeRatio: 4 });
    const first = placeGuest(emptyFleet([tight]), { agentId: "agent-a", profileId: "linux-web" });
    expect(first.status).toBe("placed");
    if (first.status !== "placed") return;
    const second = placeGuest(first.fleet, { agentId: "agent-b", profileId: "linux-web" });
    expect(second.status).toBe("no-capacity");
  });

  it("hides hypervisor credentials, instance metadata, and sibling disks from a guest", () => {
    const first = placeGuest(emptyFleet([host("hv-1")]), {
      agentId: "agent-a",
      profileId: "linux-web",
    });
    const second = placeGuest(
      first.status === "placed" ? first.fleet : emptyFleet([host("hv-1")]),
      {
        agentId: "agent-b",
        profileId: "linux-web",
      },
    );
    expect(first.status).toBe("placed");
    expect(second.status).toBe("placed");
    if (first.status !== "placed" || second.status !== "placed") return;
    const hypervisor = host("hv-1");
    expect(
      guestCanRead({
        guest: first.guest,
        host: hypervisor,
        siblings: [second.guest],
        resource: { kind: "hypervisor-credentials", path: hypervisor.credentialsPath },
      }),
    ).toBe(false);
    expect(
      guestCanRead({
        guest: first.guest,
        host: hypervisor,
        siblings: [second.guest],
        resource: { kind: "instance-metadata", address: instanceMetadataAddress() },
      }),
    ).toBe(false);
    expect(
      guestCanRead({
        guest: first.guest,
        host: hypervisor,
        siblings: [second.guest],
        resource: { kind: "sibling-rootfs", vmId: second.guest.isolation.vmId },
      }),
    ).toBe(false);
    expect(
      guestCanRead({
        guest: first.guest,
        host: hypervisor,
        siblings: [second.guest],
        resource: { kind: "own-rootfs", vmId: first.guest.isolation.vmId },
      }),
    ).toBe(true);
    expect(isolateGuest({ hostId: "hv-1", vmIndex: 1 }).cgroupPath).toContain("firecracker");
  });

  it("reschedules snapshot-safe guests after hypervisor loss and refuses live migration", () => {
    const placed = placeGuest(emptyFleet([host("hv-1"), host("hv-2")]), {
      agentId: "agent-live",
      profileId: "linux-web",
    });
    expect(placed.status).toBe("placed");
    if (placed.status !== "placed") return;
    const idle = placeGuest(placed.fleet, { agentId: "agent-idle", profileId: "linux-web" });
    expect(idle.status).toBe("placed");
    if (idle.status !== "placed") return;
    const hibernatedFleet = releaseGuest(idle.fleet, idle.guest.guestId, "hibernated", "snap-idle");
    const result = rescheduleAfterHypervisorLoss(hibernatedFleet, "hv-1");
    expect(result.lost).toHaveLength(1);
    expect(result.lost[0]?.guest.agentId).toBe("agent-live");
    expect(result.lost[0]?.reason).toContain("not claimed");
    expect(result.rescheduled).toHaveLength(1);
    expect(result.rescheduled[0]?.hostId).toBe("hv-2");
    expect(result.rescheduled[0]?.snapshotId).toBe("snap-idle");
    expect(result.rescheduled[0]?.lifecycle).toBe("hibernated");
    expect(result.fleet.hosts.map((item) => item.id)).toEqual(["hv-2"]);
  });

  it("labels EC2 packing as a migration fallback rather than Cursor parity", () => {
    expect(runtimeParity("firecracker")).toBe("cursor-firecracker");
    expect(runtimeParity("ec2-fallback")).toBe("ec2-migration-fallback");
    expect(slotsForProfile("linux-web-browser").memoryMib).toBeGreaterThan(
      slotsForProfile("linux-web").memoryMib,
    );
    expect(slotsForProfile("linux-android").memoryMib).toBe(16_384);
    expect(
      placeGuest(emptyFleet([host("hv-android", { profiles: ["linux-android", "linux-web"] })]), {
        agentId: "agent-android",
        profileId: "linux-android",
      }).status,
    ).toBe("no-capacity");
  });

  it("releases compute slots when a guest hibernates", () => {
    const placed = placeGuest(emptyFleet([host("hv-small", { memoryMib: 8_192 })]), {
      agentId: "agent-a",
      profileId: "linux-web",
    });
    expect(placed.status).toBe("placed");
    if (placed.status !== "placed") return;
    expect(placeGuest(placed.fleet, { agentId: "agent-b", profileId: "linux-web" }).status).toBe(
      "no-capacity",
    );
    const hibernated = releaseGuest(placed.fleet, placed.guest.guestId, "hibernated", "snap-a");
    const again = placeGuest(hibernated, { agentId: "agent-b", profileId: "linux-web" });
    expect(again.status).toBe("placed");
  });
});
