import { describe, expect, it } from "vite-plus/test";

import { isolateGuest, slotsForProfile, type CloudHypervisorHost } from "./firecrackerPlacement.ts";
import { createSimulatedFirecrackerDriver, proveFirecrackerGuest } from "./firecrackerGuest.ts";

const hypervisor: CloudHypervisorHost = {
  id: "hv-proof",
  accountId: "999999999999",
  cpuMillis: 16_000,
  memoryMib: 65_536,
  diskGib: 1_024,
  cpuOversubscribeRatio: 2,
  profiles: ["linux-web"],
  credentialsPath: "/var/lib/t3-hypervisor/hv-proof/credentials",
  kvm: true,
};

describe("firecrackerGuest", () => {
  it("proves the Firecracker boot, network, snapshot, console, and teardown sequence", () => {
    const driver = createSimulatedFirecrackerDriver({ kvm: true, nestedVirtualization: true });
    const siblingIsolation = isolateGuest({ hostId: "hv-1", vmIndex: 9 });
    const sibling = {
      guestId: `fc:${siblingIsolation.vmId}`,
      agentId: "agent-sibling",
      hostId: "hv-1" as const,
      slots: slotsForProfile("linux-web"),
      lifecycle: "busy" as const,
      isolation: siblingIsolation,
    };
    const proof = proveFirecrackerGuest({ driver, host: hypervisor, sibling });

    expect(proof.ok).toBe(true);
    expect(proof.steps).toEqual([
      "kvm",
      "guest-kernel",
      "networking",
      "console",
      "block-snapshot",
      "teardown",
    ]);
    expect(proof.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /machine-config",
      "PUT /boot-source",
      "PUT /drives/rootfs",
      "PUT /network-interfaces/eth0",
      "PUT /logger",
      "PUT /actions",
      "PATCH /vm",
      "PUT /snapshot/create",
      "PUT /actions",
    ]);
    expect(proof.calls.find((call) => call.path === "/boot-source")?.body).toMatchObject({
      kernel_image_path: "/var/lib/t3-hypervisor/kernel/vmlinux",
    });
    expect(
      proof.calls.find((call) => call.path === "/network-interfaces/eth0")?.body,
    ).toMatchObject({
      host_dev_name: isolateGuest({ hostId: "hv-proof", vmIndex: 1 }).network.tap,
    });
    expect(proof.blocked).toEqual({
      hypervisorCredentials: true,
      instanceMetadata: true,
      siblingState: true,
    });
    expect(proof.probe.kvm).toBe(true);
  });

  it("refuses a live-KVM proof when the host has no KVM device", () => {
    const driver = createSimulatedFirecrackerDriver({ kvm: false });
    const proof = proveFirecrackerGuest({
      driver,
      host: { ...hypervisor, kvm: false },
      requireLiveKvm: true,
    });
    expect(proof.ok).toBe(false);
    expect(proof.reason).toContain("/dev/kvm");
    expect(proof.steps).toEqual([]);
  });
});
