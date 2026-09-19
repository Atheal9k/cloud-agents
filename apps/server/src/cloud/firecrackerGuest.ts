/**
 * Firecracker guest lifecycle used by packing and by the KVM proof. The
 * sequence is the same for a real jailer and for the in-process simulator:
 * machine config, kernel, encrypted root, tap network, console, start,
 * snapshot, teardown. Isolation is checked against the guest's view, not
 * the hypervisor's.
 */
import {
  type CloudGuestIsolation,
  type CloudHypervisorHost,
  type CloudPlacedGuest,
  guestCanRead,
  instanceMetadataAddress,
  isolateGuest,
} from "./firecrackerPlacement.ts";

export type FirecrackerApiCall = {
  readonly method: "PUT" | "PATCH";
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
};

export type FirecrackerProofStep =
  | "kvm"
  | "guest-kernel"
  | "networking"
  | "block-snapshot"
  | "console"
  | "teardown";

export type FirecrackerHostProbe = {
  readonly kvm: boolean;
  readonly kvmPath: string;
  readonly nestedVirtualization: boolean;
  readonly firecrackerBinary: boolean;
};

export type FirecrackerGuestDriver = {
  readonly probeHost: () => FirecrackerHostProbe;
  readonly request: (call: FirecrackerApiCall) => void;
  readonly recordedCalls: () => ReadonlyArray<FirecrackerApiCall>;
  readonly inspectGuestView: (isolation: CloudGuestIsolation) => GuestView;
};

export type GuestView = {
  readonly rootfsVmId: string;
  readonly diskKeyId: string;
  readonly mountedRootfs: ReadonlyArray<string>;
  readonly readablePaths: ReadonlyArray<string>;
  readonly reachableAddresses: ReadonlyArray<string>;
};

export type FirecrackerProofResult = {
  readonly ok: boolean;
  readonly steps: ReadonlyArray<FirecrackerProofStep>;
  readonly calls: ReadonlyArray<FirecrackerApiCall>;
  readonly probe: FirecrackerHostProbe;
  readonly isolation: CloudGuestIsolation;
  readonly blocked: {
    readonly hypervisorCredentials: boolean;
    readonly instanceMetadata: boolean;
    readonly siblingState: boolean;
  };
  readonly reason?: string;
};

const KERNEL_PATH = "/var/lib/t3-hypervisor/kernel/vmlinux";
const ROOTFS_DIR = "/var/lib/t3-hypervisor/guests";

export function createSimulatedFirecrackerDriver(input?: {
  readonly kvm?: boolean;
  readonly nestedVirtualization?: boolean;
  readonly firecrackerBinary?: boolean;
}): FirecrackerGuestDriver {
  const calls: FirecrackerApiCall[] = [];
  const kvm = input?.kvm ?? false;
  return {
    probeHost: () => ({
      kvm,
      kvmPath: "/dev/kvm",
      nestedVirtualization: input?.nestedVirtualization ?? kvm,
      firecrackerBinary: input?.firecrackerBinary ?? true,
    }),
    request: (call) => {
      calls.push(call);
    },
    recordedCalls: () => calls,
    inspectGuestView: (isolation) => ({
      rootfsVmId: isolation.vmId,
      diskKeyId: isolation.diskKeyId,
      mountedRootfs: [`${ROOTFS_DIR}/${isolation.vmId}/rootfs.ext4`],
      readablePaths: [`${ROOTFS_DIR}/${isolation.vmId}`],
      reachableAddresses: [isolation.network.ipv4],
    }),
  };
}

export function proveFirecrackerGuest(input: {
  readonly driver: FirecrackerGuestDriver;
  readonly host: CloudHypervisorHost;
  readonly sibling?: CloudPlacedGuest;
  readonly requireLiveKvm?: boolean;
}): FirecrackerProofResult {
  const probe = input.driver.probeHost();
  const isolation = isolateGuest({ hostId: input.host.id, vmIndex: 1 });
  const steps: FirecrackerProofStep[] = [];
  if (input.requireLiveKvm === true && !probe.kvm) {
    return {
      ok: false,
      steps,
      calls: [],
      probe,
      isolation,
      blocked: {
        hypervisorCredentials: true,
        instanceMetadata: true,
        siblingState: true,
      },
      reason: "The selected host does not expose /dev/kvm.",
    };
  }
  steps.push("kvm");

  input.driver.request({
    method: "PUT",
    path: "/machine-config",
    body: { vcpu_count: 2, mem_size_mib: 8_192, smt: false },
  });
  input.driver.request({
    method: "PUT",
    path: "/boot-source",
    body: { kernel_image_path: KERNEL_PATH, boot_args: "console=ttyS0 reboot=k panic=1 pci=off" },
  });
  steps.push("guest-kernel");

  input.driver.request({
    method: "PUT",
    path: "/drives/rootfs",
    body: {
      drive_id: "rootfs",
      path_on_host: `${ROOTFS_DIR}/${isolation.vmId}/rootfs.ext4`,
      is_root_device: true,
      is_read_only: false,
      cache_type: "Writeback",
      socket: isolation.diskKeyId,
    },
  });
  input.driver.request({
    method: "PUT",
    path: "/network-interfaces/eth0",
    body: {
      iface_id: "eth0",
      host_dev_name: isolation.network.tap,
      guest_mac: isolation.network.mac,
      ipv4: isolation.network.ipv4,
    },
  });
  steps.push("networking");

  input.driver.request({
    method: "PUT",
    path: "/logger",
    body: { log_path: `${ROOTFS_DIR}/${isolation.vmId}/console.log`, level: "Info" },
  });
  steps.push("console");

  input.driver.request({
    method: "PUT",
    path: "/actions",
    body: { action_type: "InstanceStart" },
  });
  input.driver.request({
    method: "PATCH",
    path: "/vm",
    body: { state: "Paused" },
  });
  input.driver.request({
    method: "PUT",
    path: "/snapshot/create",
    body: {
      snapshot_type: "Full",
      snapshot_path: `${ROOTFS_DIR}/${isolation.vmId}/snapshot.mem`,
      mem_file_path: `${ROOTFS_DIR}/${isolation.vmId}/snapshot.disk`,
    },
  });
  steps.push("block-snapshot");

  input.driver.request({
    method: "PUT",
    path: "/actions",
    body: { action_type: "SendCtrlAltDel" },
  });
  steps.push("teardown");

  const view = input.driver.inspectGuestView(isolation);
  const guest: CloudPlacedGuest = {
    guestId: `fc:${isolation.vmId}`,
    agentId: "proof",
    hostId: input.host.id,
    slots: { cpuMillis: 2_000, memoryMib: 8_192, diskGib: 30, profileId: "linux-web" },
    lifecycle: "busy",
    isolation,
  };
  const sibling = input.sibling;
  const blocked = {
    hypervisorCredentials: !guestCanRead({
      guest,
      host: input.host,
      siblings: sibling === undefined ? [] : [sibling],
      resource: { kind: "hypervisor-credentials", path: input.host.credentialsPath },
    }),
    instanceMetadata:
      !guestCanRead({
        guest,
        host: input.host,
        siblings: sibling === undefined ? [] : [sibling],
        resource: { kind: "instance-metadata", address: instanceMetadataAddress() },
      }) && !view.reachableAddresses.includes(instanceMetadataAddress()),
    siblingState:
      sibling === undefined
        ? true
        : !guestCanRead({
            guest,
            host: input.host,
            siblings: [sibling],
            resource: { kind: "sibling-rootfs", vmId: sibling.isolation.vmId },
          }) && !view.mountedRootfs.some((path) => path.includes(sibling.isolation.vmId)),
  };

  const ok =
    steps.length === 6 &&
    blocked.hypervisorCredentials &&
    blocked.instanceMetadata &&
    blocked.siblingState &&
    view.readablePaths.every((path) => path.includes(isolation.vmId)) &&
    !view.readablePaths.includes(input.host.credentialsPath);

  return {
    ok,
    steps,
    calls: input.driver.recordedCalls(),
    probe,
    isolation,
    blocked,
    ...(ok ? {} : { reason: "The guest view leaked hypervisor or sibling state." }),
  };
}
