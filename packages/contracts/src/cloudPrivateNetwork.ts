import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Publication and infrastructure credentials stay on the controller. A private
 * dependency may name an NPM token; it may not name the GitHub or AWS key the
 * trusted wrapper already holds.
 */
export const CLOUD_PROTECTED_SECRET_PREFIXES = ["AWS_", "GH_", "GIT_", "SSH_", "T3CODE_"] as const;

export const CloudPrivateDependencyKind = Schema.Literals(["submodule", "lfs", "package-registry"]);
export type CloudPrivateDependencyKind = typeof CloudPrivateDependencyKind.Type;

/**
 * One private dependency an environment needs during Build or runtime setup.
 * `destination` is a host or URL; the check reports that host when it fails.
 * `secretName` is a declared secret, never a value.
 */
export const CloudPrivateDependency = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: CloudPrivateDependencyKind,
  destination: TrimmedNonEmptyString,
  secretName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudPrivateDependency = typeof CloudPrivateDependency.Type;

export const CloudNetworkProfileKind = Schema.Literals([
  "public",
  "stable-egress",
  "tailscale",
  "cloudflare-tunnel",
  "aws-privatelink",
]);
export type CloudNetworkProfileKind = typeof CloudNetworkProfileKind.Type;

export const CloudNetworkProfileCostClass = Schema.Literals([
  "included",
  "per-hour",
  "per-gb",
  "subscription",
]);
export type CloudNetworkProfileCostClass = typeof CloudNetworkProfileCostClass.Type;

/**
 * Optional company-network overlay. Disabling it falls back to public routing
 * with the documented controller/SCM/artifact/Cursor exceptions, so a broken
 * tunnel does not strand runs.
 */
export const CloudNetworkProfile = Schema.Struct({
  kind: CloudNetworkProfileKind,
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type CloudNetworkProfile = typeof CloudNetworkProfile.Type;

export const CloudNetworkProfileDetails = Schema.Struct({
  kind: CloudNetworkProfileKind,
  enabled: Schema.Boolean,
  costClass: CloudNetworkProfileCostClass,
  trustBoundary: TrimmedNonEmptyString,
  routing: TrimmedNonEmptyString,
  /** Present when the operator turned the overlay off without changing kind. */
  disabledFrom: Schema.optionalKey(CloudNetworkProfileKind),
});
export type CloudNetworkProfileDetails = typeof CloudNetworkProfileDetails.Type;

export const CLOUD_NETWORK_PROFILE_DETAILS = {
  public: {
    costClass: "included",
    trustBoundary: "The guest reaches the public internet directly.",
    routing: "Direct egress from the guest network.",
  },
  "stable-egress": {
    costClass: "per-gb",
    trustBoundary: "A controller-owned NAT with a stable public address.",
    routing: "All guest traffic exits through the stable NAT.",
  },
  tailscale: {
    costClass: "subscription",
    trustBoundary: "The tailnet identity, not the guest's public IP.",
    routing: "Private destinations ride the tailnet overlay.",
  },
  "cloudflare-tunnel": {
    costClass: "subscription",
    trustBoundary: "Cloudflare's edge, authenticated by the tunnel token.",
    routing: "Private destinations reach the named tunnel.",
  },
  "aws-privatelink": {
    costClass: "per-hour",
    trustBoundary: "VPC endpoint policies inside the execution account.",
    routing: "Private AWS services stay on PrivateLink.",
  },
} as const satisfies Record<
  CloudNetworkProfileKind,
  {
    readonly costClass: CloudNetworkProfileCostClass;
    readonly trustBoundary: string;
    readonly routing: string;
  }
>;

export const CloudPrivateDependencyCheck = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: CloudPrivateDependencyKind,
  destination: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  status: Schema.Literals(["ok", "failed"]),
  reason: TrimmedNonEmptyString,
});
export type CloudPrivateDependencyCheck = typeof CloudPrivateDependencyCheck.Type;

/** Files that must never enter a snapshot, cache, commit, or exported tree. */
export const CLOUD_CREDENTIAL_EXPORT_BASENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
]);

export function cloudNetworkProfileDetails(
  profile: CloudNetworkProfile | undefined,
): CloudNetworkProfileDetails {
  const kind = profile?.kind ?? "public";
  const enabled = profile?.enabled !== false;
  const facts = CLOUD_NETWORK_PROFILE_DETAILS[kind];
  if (enabled) {
    return { kind, enabled: true, ...facts };
  }
  return {
    ...CLOUD_NETWORK_PROFILE_DETAILS.public,
    kind: "public",
    enabled: false,
    ...(kind === "public" ? {} : { disabledFrom: kind }),
  };
}

/**
 * Turning a company-network overlay off keeps the documented exceptions and
 * public routing so in-flight and later runs are not stranded on a dead tunnel.
 */
export function disableCloudNetworkProfile(
  profile: CloudNetworkProfile | undefined,
): CloudNetworkProfileDetails {
  return cloudNetworkProfileDetails({ kind: profile?.kind ?? "public", enabled: false });
}

/** Public is the most open overlay; PrivateLink is the most closed. */
export function cloudNetworkProfileOpenness(kind: CloudNetworkProfileKind): number {
  switch (kind) {
    case "public":
      return 3;
    case "stable-egress":
      return 2;
    case "tailscale":
    case "cloudflare-tunnel":
      return 1;
    case "aws-privatelink":
      return 0;
  }
}

/**
 * A locked team overlay is a ceiling. Disable remains allowed: that is the
 * operator escape hatch, not a way to pick a more open overlay while it is on.
 */
export function resolveCloudNetworkProfile(input: {
  readonly environment?: CloudNetworkProfile | undefined;
  readonly team?: CloudNetworkProfile | undefined;
  readonly teamLocked?: boolean | undefined;
  readonly enabled?: boolean | undefined;
}): CloudNetworkProfileDetails {
  const requested = input.environment ?? input.team ?? { kind: "public" as const };
  let kind = requested.kind;
  if (input.teamLocked === true && input.team !== undefined && input.team.enabled !== false) {
    if (cloudNetworkProfileOpenness(kind) > cloudNetworkProfileOpenness(input.team.kind)) {
      kind = input.team.kind;
    }
  }
  const enabled = input.enabled !== false && requested.enabled !== false;
  return cloudNetworkProfileDetails({ kind, enabled });
}

export function cloudPrivateDependencyHost(destination: string): string | undefined {
  const trimmed = destination.trim();
  if (trimmed.length === 0) return undefined;
  const scp = /^[\w.-]+@([^:/\s]+):/.exec(trimmed);
  if (scp?.[1] !== undefined) return scp[1].toLowerCase();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.hostname.length > 0) return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return undefined;
}

export function isCloudProtectedSecretName(name: string): boolean {
  return CLOUD_PROTECTED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isCloudCredentialExportPath(relativePath: string): boolean {
  const parts = relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0);
  const base = parts.at(-1) ?? "";
  if (CLOUD_CREDENTIAL_EXPORT_BASENAMES.has(base)) return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  if (parts.includes(".ssh") && (base.startsWith("id_") || base === "authorized_keys")) return true;
  return parts.includes(".aws") && (base === "credentials" || base === "config");
}

export function cloudPrivateGitDependencyKinds(
  dependencies: ReadonlyArray<CloudPrivateDependency>,
): ReadonlyArray<"submodule" | "lfs"> {
  const kinds = new Set<"submodule" | "lfs">();
  for (const dependency of dependencies) {
    if (dependency.kind === "submodule" || dependency.kind === "lfs") kinds.add(dependency.kind);
  }
  return [...kinds];
}
