import { RunAllocationAttempt, RunAllocationId } from "@t3tools/contracts";

import {
  type CloudHypervisorFleet,
  type CloudHypervisorHost,
  type CloudPlacedGuest,
  placeGuest,
  releaseGuest,
  removeGuest,
  rescheduleAfterHypervisorLoss,
  type CloudHypervisorLossResult,
} from "./firecrackerPlacement.ts";
import {
  createSimulatedFirecrackerDriver,
  proveFirecrackerGuest,
  type FirecrackerProofResult,
} from "./firecrackerGuest.ts";

type GuestState = "pending" | "running" | "shutting-down" | "terminated" | "stopping" | "stopped";

type GuestResource = {
  readonly instanceId: string;
  readonly state: GuestState;
  readonly identity: {
    readonly status: "matched";
    readonly allocationId: RunAllocationId;
    readonly attempt: RunAllocationAttempt;
  };
  readonly registrationCredentialPresent: boolean;
};

export type BoundFirecrackerGuest = {
  readonly guest: CloudPlacedGuest;
  readonly allocationId: RunAllocationId;
  readonly attempt: RunAllocationAttempt;
  readonly state: GuestState;
  readonly registrationCredentialPresent: boolean;
};

export type FirecrackerFleetStore = {
  readonly hosts: () => ReadonlyArray<CloudHypervisorHost>;
  readonly guests: () => ReadonlyArray<BoundFirecrackerGuest>;
  readonly place: (input: {
    readonly allocationId: RunAllocationId;
    readonly attempt: RunAllocationAttempt;
    readonly profileId: string;
    readonly agentId: string;
  }) => BoundFirecrackerGuest | { readonly status: "no-capacity"; readonly reason: string };
  readonly find: (input: {
    readonly allocationId: RunAllocationId;
    readonly attempt: RunAllocationAttempt;
  }) => ReadonlyArray<GuestResource>;
  readonly list: () => ReadonlyArray<GuestResource>;
  readonly hibernate: (guestId: string) => boolean;
  readonly restore: (input: {
    readonly guestId: string;
    readonly allocationId: RunAllocationId;
    readonly attempt: RunAllocationAttempt;
  }) => { readonly instanceId: string; readonly state: GuestState } | undefined;
  readonly revoke: (guestId: string) => void;
  readonly terminate: (guestId: string) => void;
  readonly prove: () => FirecrackerProofResult;
  readonly rescheduleLostHost: (hostId: string) => CloudHypervisorLossResult;
};

export function createFirecrackerFleetStore(
  hosts: ReadonlyArray<CloudHypervisorHost>,
): FirecrackerFleetStore {
  let fleet: CloudHypervisorFleet = { hosts, guests: [] };
  let bounds = new Map<string, BoundFirecrackerGuest>();

  const resource = (bound: BoundFirecrackerGuest): GuestResource => ({
    instanceId: bound.guest.guestId,
    state: bound.state,
    identity: {
      status: "matched",
      allocationId: bound.allocationId,
      attempt: bound.attempt,
    },
    registrationCredentialPresent: bound.registrationCredentialPresent,
  });

  return {
    hosts: () => fleet.hosts,
    guests: () => [...bounds.values()],
    place: (input) => {
      const placed = placeGuest(fleet, {
        agentId: input.agentId,
        profileId: input.profileId,
      });
      if (placed.status !== "placed") {
        return { status: "no-capacity", reason: placed.reason };
      }
      fleet = placed.fleet;
      const bound: BoundFirecrackerGuest = {
        guest: placed.guest,
        allocationId: input.allocationId,
        attempt: input.attempt,
        state: "pending",
        registrationCredentialPresent: true,
      };
      bounds.set(placed.guest.guestId, bound);
      return bound;
    },
    find: (input) =>
      [...bounds.values()]
        .filter(
          (bound) => bound.allocationId === input.allocationId && bound.attempt === input.attempt,
        )
        .map(resource),
    list: () => [...bounds.values()].filter((bound) => bound.state !== "terminated").map(resource),
    hibernate: (guestId) => {
      const bound = bounds.get(guestId);
      if (bound === undefined) return false;
      const snapshotId = `snap:${guestId}`;
      fleet = releaseGuest(fleet, guestId, "hibernated", snapshotId);
      const guest = fleet.guests.find((item) => item.guestId === guestId);
      if (guest === undefined) return false;
      bounds.set(guestId, { ...bound, guest, state: "stopped" });
      return true;
    },
    restore: (input) => {
      const bound = bounds.get(input.guestId);
      if (bound === undefined) return undefined;
      const restoredGuest = { ...bound.guest, lifecycle: "busy" as const };
      fleet = {
        hosts: fleet.hosts,
        guests: fleet.guests.map((guest) =>
          guest.guestId === input.guestId ? restoredGuest : guest,
        ),
      };
      const restored: BoundFirecrackerGuest = {
        guest: restoredGuest,
        allocationId: input.allocationId,
        attempt: input.attempt,
        state: "pending",
        registrationCredentialPresent: true,
      };
      bounds.set(input.guestId, restored);
      return { instanceId: input.guestId, state: "pending" };
    },
    revoke: (guestId) => {
      const bound = bounds.get(guestId);
      if (bound === undefined) return;
      bounds.set(guestId, { ...bound, registrationCredentialPresent: false });
    },
    terminate: (guestId) => {
      fleet = removeGuest(fleet, guestId);
      const bound = bounds.get(guestId);
      if (bound !== undefined) {
        bounds.set(guestId, { ...bound, state: "terminated" });
      }
    },
    prove: () => {
      const host = fleet.hosts[0];
      if (host === undefined) {
        throw new Error("A Firecracker fleet needs at least one hypervisor host.");
      }
      const sibling = [...bounds.values()][0]?.guest;
      return proveFirecrackerGuest({
        driver: createSimulatedFirecrackerDriver({ kvm: host.kvm, nestedVirtualization: host.kvm }),
        host,
        ...(sibling === undefined ? {} : { sibling }),
      });
    },
    rescheduleLostHost: (hostId) => {
      const result = rescheduleAfterHypervisorLoss(fleet, hostId);
      fleet = result.fleet;
      for (const lost of result.lost) {
        bounds.delete(lost.guest.guestId);
      }
      for (const guest of result.rescheduled) {
        const previous = [...bounds.values()].find(
          (bound) => bound.guest.agentId === guest.agentId,
        );
        if (previous === undefined) continue;
        bounds.delete(previous.guest.guestId);
        bounds.set(guest.guestId, {
          guest,
          allocationId: previous.allocationId,
          attempt: previous.attempt,
          state: guest.lifecycle === "hibernated" ? "stopped" : "pending",
          registrationCredentialPresent: previous.registrationCredentialPresent,
        });
      }
      return result;
    },
  };
}
