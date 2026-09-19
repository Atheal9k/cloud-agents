import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, type ProviderInstanceId } from "./providerInstance.ts";

/**
 * Built-in drivers that cloud execution must classify. Unknown fork drivers stay
 * unsupported until a later qualification record exists.
 */
export const CLOUD_PROVIDER_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
] as const;
export const CloudProviderDriver = Schema.Literals(CLOUD_PROVIDER_DRIVERS);
export type CloudProviderDriver = typeof CloudProviderDriver.Type;

export const CloudProviderQualificationStatus = Schema.Literals([
  "enabled",
  "unsupported",
  "blocked",
]);
export type CloudProviderQualificationStatus = typeof CloudProviderQualificationStatus.Type;

/**
 * Runtime proofs required before a provider may be `enabled` for cloud
 * execution. Each flag is an observed result on the advertised runtime, not a
 * local-adapter claim.
 */
export const CloudProviderRuntimeProofs = Schema.Struct({
  remoteLogin: Schema.Boolean,
  execution: Schema.Boolean,
  streaming: Schema.Boolean,
  interruption: Schema.Boolean,
  idleSnapshotWake: Schema.Boolean,
  authQuotaFailure: Schema.Boolean,
  cleanup: Schema.Boolean,
});
export type CloudProviderRuntimeProofs = typeof CloudProviderRuntimeProofs.Type;

export const CloudProviderCapabilityReport = Schema.Struct({
  filesystemRestore: Schema.Boolean,
  providerNativeResume: Schema.Boolean,
  contextTransfer: Schema.Boolean,
  modelSwitching: Schema.Boolean,
  computerUse: Schema.Boolean,
});
export type CloudProviderCapabilityReport = typeof CloudProviderCapabilityReport.Type;

export const CloudProviderCredentialIsolation = Schema.Struct({
  /** Distinct per-runtime home; two instances cannot share writable session files. */
  isolatedHome: Schema.Boolean,
  homeEnv: Schema.optionalKey(TrimmedNonEmptyString),
  workerPath: Schema.optionalKey(TrimmedNonEmptyString),
  detail: TrimmedNonEmptyString,
});
export type CloudProviderCredentialIsolation = typeof CloudProviderCredentialIsolation.Type;

export const CloudProviderHistoryTransfer = Schema.Literals([
  "native-resume",
  "seeded-continuation",
  "unsupported",
]);
export type CloudProviderHistoryTransfer = typeof CloudProviderHistoryTransfer.Type;

export const CloudProviderQualification = Schema.Struct({
  driver: CloudProviderDriver,
  status: CloudProviderQualificationStatus,
  advertisedRuntime: TrimmedNonEmptyString,
  evidence: TrimmedNonEmptyString,
  proofs: CloudProviderRuntimeProofs,
  capabilities: CloudProviderCapabilityReport,
  credentials: CloudProviderCredentialIsolation,
});
export type CloudProviderQualification = typeof CloudProviderQualification.Type;

const ALL_PROOFS_PASSED: CloudProviderRuntimeProofs = {
  remoteLogin: true,
  execution: true,
  streaming: true,
  interruption: true,
  idleSnapshotWake: true,
  authQuotaFailure: true,
  cleanup: true,
};

const NO_PROOFS: CloudProviderRuntimeProofs = {
  remoteLogin: false,
  execution: false,
  streaming: false,
  interruption: false,
  idleSnapshotWake: false,
  authQuotaFailure: false,
  cleanup: false,
};

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const GROK = ProviderDriverKind.make("grok");
const OPENCODE = ProviderDriverKind.make("opencode");
const ANTIGRAVITY = ProviderDriverKind.make("antigravity");

export const CLOUD_PROVIDER_QUALIFICATIONS: {
  readonly [Driver in CloudProviderDriver]: CloudProviderQualification;
} = {
  codex: {
    driver: "codex",
    status: "enabled",
    advertisedRuntime: "linux/x64 Amazon Linux 2023 worker image",
    evidence:
      "CA-01 unattended AWS proof on 17 September 2026 (Codex 0.154.0): device-auth or API-key injection, T3 app-server execution and streaming, interrupt, tmpfs CODEX_HOME plus auth.json writeback across idle snapshot/wake, auth/quota preflight, and worker cleanup.",
    proofs: ALL_PROOFS_PASSED,
    capabilities: {
      filesystemRestore: true,
      providerNativeResume: true,
      contextTransfer: false,
      modelSwitching: true,
      computerUse: true,
    },
    credentials: {
      isolatedHome: true,
      homeEnv: "CODEX_HOME",
      workerPath: "/run/t3-worker/credentials/codex",
      detail:
        "Workers restore one Codex home into tmpfs. Refresh-token writeback is serialized to one secret so two workers cannot rotate the same cache.",
    },
  },
  claudeAgent: {
    driver: "claudeAgent",
    status: "enabled",
    advertisedRuntime: "linux/x64 Amazon Linux 2023 worker image",
    evidence:
      "CA-01 unattended AWS proof on 17 September 2026 (Claude Code 2.1.273): setup-token injected as CLAUDE_CODE_OAUTH_TOKEN, Agent SDK execution and streaming, interrupt, token rehydrate on wake, auth/quota preflight, and worker cleanup. Session ids stay on the worker-owned thread.",
    proofs: ALL_PROOFS_PASSED,
    capabilities: {
      filesystemRestore: true,
      providerNativeResume: true,
      contextTransfer: false,
      modelSwitching: true,
      computerUse: false,
    },
    credentials: {
      isolatedHome: true,
      homeEnv: "CLAUDE_CONFIG_DIR",
      workerPath: "/run/t3-worker/credentials/claude",
      detail:
        "Workers inject a long-lived OAuth token and keep Claude config off the service user's home. The token is not copied from a desktop cache.",
    },
  },
  cursor: {
    driver: "cursor",
    status: "unsupported",
    advertisedRuntime: "linux/x64 worker image (not installed)",
    evidence:
      "The Cursor Agent adapter and Linux CLI probe exist, but the worker image does not install cursor-agent, Secrets Manager does not inject Cursor credentials, and Linux defaults to a memory credential store that cannot survive idle snapshot/wake. `agent login` is interactive.",
    proofs: NO_PROOFS,
    capabilities: {
      filesystemRestore: false,
      providerNativeResume: false,
      contextTransfer: false,
      modelSwitching: true,
      computerUse: false,
    },
    credentials: {
      isolatedHome: false,
      detail:
        "Linux memory or macOS keychain logins are not instance-scoped worker homes. File-store injection is required before this driver can be enabled.",
    },
  },
  grok: {
    driver: "grok",
    status: "unsupported",
    advertisedRuntime: "linux/x64 worker image (not installed)",
    evidence:
      "The Grok ACP adapter exists, but the worker image does not install the CLI, `grok login` is interactive, and there is no Secrets Manager injection. Default ~/.grok/auth.json would be shared unless GROK_HOME is set per instance.",
    proofs: NO_PROOFS,
    capabilities: {
      filesystemRestore: false,
      providerNativeResume: false,
      contextTransfer: false,
      modelSwitching: true,
      computerUse: false,
    },
    credentials: {
      isolatedHome: false,
      homeEnv: "GROK_HOME",
      detail:
        "Without a per-instance GROK_HOME on the worker, accounts would share ~/.grok. No isolated home is provisioned today.",
    },
  },
  opencode: {
    driver: "opencode",
    status: "blocked",
    advertisedRuntime: "linux/x64 worker image (not installed)",
    evidence:
      "T3-managed OpenCode can isolate one server per local thread, but cloud workers do not boot that layout. External OpenCode servers share mutable session and directory-scoped approval grants, so unattended cloud use would share credentials and permissions across runs.",
    proofs: NO_PROOFS,
    capabilities: {
      filesystemRestore: false,
      providerNativeResume: false,
      contextTransfer: false,
      modelSwitching: true,
      computerUse: false,
    },
    credentials: {
      isolatedHome: false,
      homeEnv: "XDG_DATA_HOME",
      detail:
        "External servers own auth.json and approvals. Cloud execution is blocked until a worker-owned per-thread server with an isolated XDG home exists.",
    },
  },
  antigravity: {
    driver: "antigravity",
    status: "unsupported",
    advertisedRuntime: "linux/x64 worker image (not installed)",
    evidence:
      "Linux ACP binaries and per-instance file profiles exist locally. Unattended Google OAuth needs the initiating client's loopback callback, the worker image does not install Antigravity, and API keys in settings are not scoped Secrets Manager material.",
    proofs: NO_PROOFS,
    capabilities: {
      filesystemRestore: false,
      providerNativeResume: false,
      contextTransfer: false,
      modelSwitching: true,
      computerUse: false,
    },
    credentials: {
      isolatedHome: false,
      homeEnv: "GEMINI_HOME",
      detail:
        "Local profiles isolate Google credentials, but workers do not create those profiles or inject an API key. Ambient GCP credentials must stay out of the launch environment.",
    },
  },
};

const DRIVER_BY_KIND = new Map<string, CloudProviderDriver>([
  [CODEX, "codex"],
  [CLAUDE, "claudeAgent"],
  [CURSOR, "cursor"],
  [GROK, "grok"],
  [OPENCODE, "opencode"],
  [ANTIGRAVITY, "antigravity"],
]);

export function cloudProviderQualification(
  driver: string,
): CloudProviderQualification | undefined {
  const known = DRIVER_BY_KIND.get(driver);
  return known === undefined ? undefined : CLOUD_PROVIDER_QUALIFICATIONS[known];
}

export function isCloudProviderEnabled(driver: string): boolean {
  return cloudProviderQualification(driver)?.status === "enabled";
}

export function cloudProviderDriverFromInstanceId(
  instanceId: string,
): CloudProviderDriver | undefined {
  return DRIVER_BY_KIND.get(instanceId);
}

export type CloudProviderAdmission =
  | {
      readonly status: "admitted";
      readonly qualification: CloudProviderQualification;
      readonly historyTransfer: CloudProviderHistoryTransfer;
    }
  | { readonly status: "rejected"; readonly message: string };

function instanceLabel(instanceId: string): string {
  return instanceId.length === 0 ? "the requested provider" : `'${instanceId}'`;
}

/**
 * Controller-side gate. Unknown instance ids are rejected unless they are a
 * built-in default (`codex`, `claudeAgent`, …) so a custom slug cannot skip
 * qualification. Workers still resolve custom ids through the provider registry.
 */
export function admitCloudProviderExecution(input: {
  readonly instanceId: string | ProviderInstanceId;
  readonly driver?: string;
  readonly previousInstanceId?: string | ProviderInstanceId;
  readonly computerUse?: boolean;
}): CloudProviderAdmission {
  const instanceId = String(input.instanceId);
  const driver =
    (input.driver === undefined ? undefined : DRIVER_BY_KIND.get(input.driver)) ??
    cloudProviderDriverFromInstanceId(instanceId);
  if (driver === undefined) {
    return {
      status: "rejected",
      message: `Provider instance ${instanceLabel(instanceId)} is not a qualified cloud provider. Cloud execution only admits the default Codex or Claude instance until that driver is qualified.`,
    };
  }
  const qualification = CLOUD_PROVIDER_QUALIFICATIONS[driver];
  if (qualification.status !== "enabled") {
    return {
      status: "rejected",
      message: `Provider '${driver}' is ${qualification.status} for cloud execution. ${qualification.evidence}`,
    };
  }
  if (input.computerUse === true && !qualification.capabilities.computerUse) {
    return {
      status: "rejected",
      message: `Provider '${driver}' does not advertise computer use. Keep that option off or choose a provider that lists it.`,
    };
  }
  const previousId =
    input.previousInstanceId === undefined ? undefined : String(input.previousInstanceId);
  if (previousId !== undefined && previousId !== instanceId) {
    const previousDriver = cloudProviderDriverFromInstanceId(previousId);
    if (previousDriver !== driver) {
      return {
        status: "rejected",
        message: `Switching from '${previousId}' to ${instanceLabel(instanceId)} does not transfer native provider history. Continue with the original provider or start a new agent.`,
      };
    }
    return {
      status: "admitted",
      qualification,
      historyTransfer: "seeded-continuation",
    };
  }
  return {
    status: "admitted",
    qualification,
    historyTransfer: qualification.capabilities.providerNativeResume
      ? "native-resume"
      : "unsupported",
  };
}

export function cloudProviderHistoryTransfer(input: {
  readonly previousInstanceId: string;
  readonly nextInstanceId: string;
}): CloudProviderHistoryTransfer {
  if (input.previousInstanceId === input.nextInstanceId) {
    const driver = cloudProviderDriverFromInstanceId(input.nextInstanceId);
    const qualification = driver === undefined ? undefined : CLOUD_PROVIDER_QUALIFICATIONS[driver];
    return qualification?.capabilities.providerNativeResume === true
      ? "native-resume"
      : "unsupported";
  }
  if (
    cloudProviderDriverFromInstanceId(input.previousInstanceId) !==
    cloudProviderDriverFromInstanceId(input.nextInstanceId)
  ) {
    return "unsupported";
  }
  return "seeded-continuation";
}

export function cloudProviderWorkerHomes(): ReadonlyArray<{
  readonly driver: CloudProviderDriver;
  readonly env: string;
  readonly path: string;
}> {
  return Object.values(CLOUD_PROVIDER_QUALIFICATIONS).flatMap((qualification) => {
    if (
      qualification.status !== "enabled" ||
      qualification.credentials.homeEnv === undefined ||
      qualification.credentials.workerPath === undefined
    ) {
      return [];
    }
    return [
      {
        driver: qualification.driver,
        env: qualification.credentials.homeEnv,
        path: qualification.credentials.workerPath,
      },
    ];
  });
}
