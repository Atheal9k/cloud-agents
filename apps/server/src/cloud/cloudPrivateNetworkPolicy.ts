/**
 * Environment-scoped private dependency access and company-network overlays.
 * Egress modes and the admin lock live in `cloudSecurityPolicy`; this module
 * checks submodule, LFS, and registry destinations against that policy and
 * says which destination failed.
 */
import {
  type CloudEgressPolicy,
  type CloudPrivateDependency,
  type CloudPrivateDependencyCheck,
  cloudPrivateDependencyHost,
} from "@t3tools/contracts";

import { evaluateCloudEgress } from "./cloudSecurityPolicy.ts";

export function checkCloudPrivateDependencies(input: {
  readonly policy: CloudEgressPolicy;
  readonly dependencies: ReadonlyArray<CloudPrivateDependency>;
  readonly probes?: ReadonlyArray<{
    readonly id: string;
    readonly reachable: boolean;
    readonly detail?: string;
  }>;
}): ReadonlyArray<CloudPrivateDependencyCheck> {
  const probes = new Map((input.probes ?? []).map((probe) => [probe.id, probe]));
  return input.dependencies.map((dependency) => {
    const host = cloudPrivateDependencyHost(dependency.destination);
    if (host === undefined) {
      return {
        id: dependency.id,
        kind: dependency.kind,
        destination: dependency.destination,
        host: dependency.destination,
        status: "failed",
        reason: `Private ${dependency.kind} '${dependency.id}' has no usable destination host.`,
      };
    }
    const egress = evaluateCloudEgress({ policy: input.policy, host });
    if (!egress.allowed) {
      return {
        id: dependency.id,
        kind: dependency.kind,
        destination: dependency.destination,
        host,
        status: "failed",
        reason: `Private ${dependency.kind} '${dependency.id}' cannot reach ${host}: ${egress.reason}`,
      };
    }
    const probe = probes.get(dependency.id);
    if (probe !== undefined && !probe.reachable) {
      return {
        id: dependency.id,
        kind: dependency.kind,
        destination: dependency.destination,
        host,
        status: "failed",
        reason: `Private ${dependency.kind} '${dependency.id}' failed at ${host}${
          probe.detail === undefined ? "." : `: ${probe.detail}`
        }`,
      };
    }
    return {
      id: dependency.id,
      kind: dependency.kind,
      destination: dependency.destination,
      host,
      status: "ok",
      reason: `Private ${dependency.kind} '${dependency.id}' can reach ${host}.`,
    };
  });
}

export function firstFailedCloudPrivateDependency(
  checks: ReadonlyArray<CloudPrivateDependencyCheck>,
): CloudPrivateDependencyCheck | undefined {
  return checks.find((check) => check.status === "failed");
}
