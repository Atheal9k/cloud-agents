/**
 * Slot packing for Firecracker guests on a hypervisor fleet. CPU may run
 * oversubscribed within a measured ratio; memory and disk may not, so one
 * guest cannot OOM or fill a neighbor. Hypervisor loss only reschedules
 * work that already has a snapshot; a live process is not migrated.
 */
export const DEFAULT_PROFILE_SLOTS = {
  "linux-web": { cpuMillis: 2_000, memoryMib: 8_192, diskGib: 30 },
  "linux-web-browser": { cpuMillis: 2_000, memoryMib: 12_288, diskGib: 40 },
  "linux-android": { cpuMillis: 4_000, memoryMib: 16_384, diskGib: 80 },
} as const;

export type CloudRuntimeKind = "firecracker" | "ec2-fallback";
export type CloudRuntimeParity = "cursor-firecracker" | "ec2-migration-fallback";

export type CloudPlacementSlots = {
  readonly cpuMillis: number;
  readonly memoryMib: number;
  readonly diskGib: number;
  readonly profileId: string;
};

export type CloudGuestLifecycle = "busy" | "idle" | "hibernated" | "terminal";

export type CloudPlacedGuest = {
  readonly guestId: string;
  readonly agentId: string;
  readonly hostId: string;
  readonly slots: CloudPlacementSlots;
  readonly lifecycle: CloudGuestLifecycle;
  readonly isolation: CloudGuestIsolation;
  readonly snapshotId?: string;
};

export type CloudGuestIsolation = {
  readonly vmId: string;
  readonly diskKeyId: string;
  readonly cgroupPath: string;
  readonly network: {
    readonly tap: string;
    readonly mac: string;
    readonly ipv4: string;
  };
};

export type CloudHypervisorHost = {
  readonly id: string;
  readonly accountId: string;
  readonly cpuMillis: number;
  readonly memoryMib: number;
  readonly diskGib: number;
  readonly cpuOversubscribeRatio: number;
  readonly profiles: ReadonlyArray<string>;
  readonly credentialsPath: string;
  readonly kvm: boolean;
  /** Packer image tags, so an operator can see what a host is running. */
  readonly guestImageVersion?: string;
  readonly hypervisorImageVersion?: string;
};

export type CloudHypervisorFleet = {
  readonly hosts: ReadonlyArray<CloudHypervisorHost>;
  readonly guests: ReadonlyArray<CloudPlacedGuest>;
};

export type CloudPlacementRequest = {
  readonly agentId: string;
  readonly profileId: string;
  readonly slots?: Omit<CloudPlacementSlots, "profileId">;
};

export type CloudPlacementResult =
  | {
      readonly status: "placed";
      readonly guest: CloudPlacedGuest;
      readonly fleet: CloudHypervisorFleet;
    }
  | {
      readonly status: "no-capacity";
      readonly reason: string;
      readonly fleet: CloudHypervisorFleet;
    };

export type CloudHypervisorLossResult = {
  readonly rescheduled: ReadonlyArray<CloudPlacedGuest>;
  readonly lost: ReadonlyArray<{ readonly guest: CloudPlacedGuest; readonly reason: string }>;
  readonly fleet: CloudHypervisorFleet;
};

const IMDS_BLOCK = "169.254.169.254";
const GUEST_NETWORK_PREFIX = "10.77.";

export function runtimeParity(kind: CloudRuntimeKind): CloudRuntimeParity {
  return kind === "firecracker" ? "cursor-firecracker" : "ec2-migration-fallback";
}

export function slotsForProfile(profileId: string): CloudPlacementSlots {
  const defaults =
    profileId in DEFAULT_PROFILE_SLOTS
      ? DEFAULT_PROFILE_SLOTS[profileId as keyof typeof DEFAULT_PROFILE_SLOTS]
      : DEFAULT_PROFILE_SLOTS["linux-web"];
  return { ...defaults, profileId };
}

export function cpuCapacity(host: CloudHypervisorHost): number {
  return Math.floor(host.cpuMillis * host.cpuOversubscribeRatio);
}

export function usedSlots(fleet: CloudHypervisorFleet, hostId: string): CloudPlacementSlots {
  return fleet.guests
    .filter((guest) => guest.hostId === hostId && holdsCompute(guest))
    .reduce(
      (used, guest) => ({
        cpuMillis: used.cpuMillis + guest.slots.cpuMillis,
        memoryMib: used.memoryMib + guest.slots.memoryMib,
        diskGib: used.diskGib + guest.slots.diskGib,
        profileId: used.profileId,
      }),
      { cpuMillis: 0, memoryMib: 0, diskGib: 0, profileId: "*" },
    );
}

/** Hibernated and terminal guests keep their disk snapshot, not live compute. */
export function holdsCompute(guest: CloudPlacedGuest): boolean {
  return guest.lifecycle === "busy" || guest.lifecycle === "idle";
}

export function isSnapshotSafe(guest: CloudPlacedGuest): boolean {
  return (
    (guest.lifecycle === "hibernated" || guest.lifecycle === "terminal") &&
    guest.snapshotId !== undefined
  );
}

export function isolateGuest(input: {
  readonly hostId: string;
  readonly vmIndex: number;
}): CloudGuestIsolation {
  const vmId = `${input.hostId}-vm-${input.vmIndex}`;
  const octet = (input.vmIndex % 250) + 2;
  const net = Math.floor(input.vmIndex / 250) % 256;
  return {
    vmId,
    diskKeyId: `diskkey-${vmId}`,
    cgroupPath: `/sys/fs/cgroup/firecracker/${vmId}`,
    network: {
      tap: `fc-${input.vmIndex}`,
      mac: `02:fc:${toHex(net)}:${toHex(octet)}:00:01`,
      ipv4: `${GUEST_NETWORK_PREFIX}${net}.${octet}`,
    },
  };
}

export function guestCanRead(input: {
  readonly guest: CloudPlacedGuest;
  readonly host: CloudHypervisorHost;
  readonly siblings: ReadonlyArray<CloudPlacedGuest>;
  readonly resource: GuestVisibleResource;
}): boolean {
  switch (input.resource.kind) {
    case "own-rootfs":
      return input.resource.vmId === input.guest.isolation.vmId;
    case "own-disk-key":
      return input.resource.diskKeyId === input.guest.isolation.diskKeyId;
    case "hypervisor-credentials":
    case "instance-metadata":
      return false;
    case "sibling-rootfs":
    case "sibling-disk-key":
      return false;
  }
}

export type GuestVisibleResource =
  | { readonly kind: "own-rootfs"; readonly vmId: string }
  | { readonly kind: "own-disk-key"; readonly diskKeyId: string }
  | { readonly kind: "hypervisor-credentials"; readonly path: string }
  | { readonly kind: "instance-metadata"; readonly address: string }
  | { readonly kind: "sibling-rootfs"; readonly vmId: string }
  | { readonly kind: "sibling-disk-key"; readonly diskKeyId: string };

export function instanceMetadataAddress(): string {
  return IMDS_BLOCK;
}

export function placeGuest(
  fleet: CloudHypervisorFleet,
  request: CloudPlacementRequest,
): CloudPlacementResult {
  const slots = request.slots
    ? { ...request.slots, profileId: request.profileId }
    : slotsForProfile(request.profileId);
  if (slots.cpuMillis <= 0 || slots.memoryMib <= 0 || slots.diskGib <= 0) {
    return { status: "no-capacity", reason: "Placement slots must be positive.", fleet };
  }

  const host = fleet.hosts.find((candidate) => canPlaceOn(candidate, fleet, slots));
  if (host === undefined) {
    return {
      status: "no-capacity",
      reason: `No hypervisor has CPU, memory, disk, and profile slots for '${request.profileId}'.`,
      fleet,
    };
  }

  const vmIndex = nextVmIndex(fleet, host.id);
  const isolation = isolateGuest({ hostId: host.id, vmIndex });
  const guest: CloudPlacedGuest = {
    guestId: `fc:${isolation.vmId}`,
    agentId: request.agentId,
    hostId: host.id,
    slots,
    lifecycle: "busy",
    isolation,
  };
  return {
    status: "placed",
    guest,
    fleet: { hosts: fleet.hosts, guests: [...fleet.guests, guest] },
  };
}

export function releaseGuest(
  fleet: CloudHypervisorFleet,
  guestId: string,
  lifecycle: Extract<CloudGuestLifecycle, "hibernated" | "terminal">,
  snapshotId: string,
): CloudHypervisorFleet {
  return {
    hosts: fleet.hosts,
    guests: fleet.guests.map((guest) =>
      guest.guestId === guestId ? { ...guest, lifecycle, snapshotId } : guest,
    ),
  };
}

export function removeGuest(fleet: CloudHypervisorFleet, guestId: string): CloudHypervisorFleet {
  return {
    hosts: fleet.hosts,
    guests: fleet.guests.filter((guest) => guest.guestId !== guestId),
  };
}

/**
 * A dead hypervisor keeps snapshot-safe guests eligible on another host.
 * Busy and idle guests still have a live process, so they are marked lost
 * rather than claimed as migrated.
 */
export function rescheduleAfterHypervisorLoss(
  fleet: CloudHypervisorFleet,
  lostHostId: string,
): CloudHypervisorLossResult {
  const remainingHosts = fleet.hosts.filter((host) => host.id !== lostHostId);
  let nextFleet: CloudHypervisorFleet = {
    hosts: remainingHosts,
    guests: fleet.guests.filter((guest) => guest.hostId !== lostHostId),
  };
  const rescheduled: CloudPlacedGuest[] = [];
  const lost: Array<{ guest: CloudPlacedGuest; reason: string }> = [];

  for (const guest of fleet.guests.filter((candidate) => candidate.hostId === lostHostId)) {
    if (!isSnapshotSafe(guest)) {
      lost.push({
        guest,
        reason: "Active process migration is not claimed when a hypervisor is lost.",
      });
      continue;
    }
    const placed = placeGuest(nextFleet, {
      agentId: guest.agentId,
      profileId: guest.slots.profileId,
      slots: guest.slots,
    });
    if (placed.status !== "placed") {
      lost.push({ guest, reason: placed.reason });
      continue;
    }
    const restored: CloudPlacedGuest = {
      ...placed.guest,
      lifecycle: guest.lifecycle,
      ...(guest.snapshotId === undefined ? {} : { snapshotId: guest.snapshotId }),
    };
    nextFleet = {
      hosts: placed.fleet.hosts,
      guests: placed.fleet.guests.map((candidate) =>
        candidate.guestId === placed.guest.guestId ? restored : candidate,
      ),
    };
    rescheduled.push(restored);
  }

  return { rescheduled, lost, fleet: nextFleet };
}

function canPlaceOn(
  host: CloudHypervisorHost,
  fleet: CloudHypervisorFleet,
  slots: CloudPlacementSlots,
): boolean {
  if (!host.kvm) return false;
  if (!host.profiles.includes(slots.profileId)) return false;
  if (slots.profileId === "linux-android") return false;
  const used = usedSlots(fleet, host.id);
  if (used.cpuMillis + slots.cpuMillis > cpuCapacity(host)) return false;
  if (used.memoryMib + slots.memoryMib > host.memoryMib) return false;
  if (used.diskGib + slots.diskGib > host.diskGib) return false;
  return true;
}

function nextVmIndex(fleet: CloudHypervisorFleet, hostId: string): number {
  const used = fleet.guests
    .filter((guest) => guest.hostId === hostId)
    .map((guest) => Number(guest.isolation.vmId.split("-vm-").at(-1) ?? "0"));
  return (used.length === 0 ? 0 : Math.max(...used)) + 1;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
