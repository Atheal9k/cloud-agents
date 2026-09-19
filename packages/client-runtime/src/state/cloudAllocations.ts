import {
  type CloudAdmissionControlInput,
  type CloudArtifactAccessInput,
  type CloudAgentReviewActInput,
  type CloudAgentReviewInspectInput,
  type CloudAgentReviewShareInput,
  type CloudHandoffExecuteInput,
  type CloudHandoffPreviewInput,
  type CloudEnvironmentBuildCancelInput,
  type CloudEnvironmentBuildSaveInput,
  type CloudEnvironmentBuildStaleThresholdInput,
  type CloudEnvironmentBuildStartInput,
  type CloudEnvironmentResolutionInput,
  type CloudEnvironmentRestoreInput,
  type CloudEnvironmentSaveInput,
  type CloudControllerDefaultsInput,
  type CloudGuidedSetupInput,
  type CloudReadinessCheckInput,
  type CloudScmConnectionInput,
  type RunAllocationCommand,
  WS_METHODS,
} from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { Atom } from "effect/unstable/reactivity";

export function createCloudAllocationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:cloud-allocations:snapshot",
    tag: WS_METHODS.subscribeCloudAllocations,
  });
  const dispatch = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-allocations:dispatch",
    tag: WS_METHODS.cloudAllocationDispatch,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.commandId}`,
    },
    execute: (input: RunAllocationCommand) => request(WS_METHODS.cloudAllocationDispatch, input),
  });
  const setAdmission = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-allocations:set-admission",
    tag: WS_METHODS.cloudAllocationSetAdmission,
    scheduler,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: (input: CloudAdmissionControlInput) =>
      request(WS_METHODS.cloudAllocationSetAdmission, input),
  });
  const setDefaults = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-allocations:set-defaults",
    tag: WS_METHODS.cloudAllocationSetDefaults,
    scheduler,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: (input: CloudControllerDefaultsInput) =>
      request(WS_METHODS.cloudAllocationSetDefaults, input),
  });
  const setSpendLimit = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-accounting:set-spend-limit",
    tag: WS_METHODS.cloudAccountingSetSpendLimit,
    scheduler,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: (input: import("@t3tools/contracts").CloudSpendLimitInput) =>
      request(WS_METHODS.cloudAccountingSetSpendLimit, input),
  });
  const recordInvoice = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-accounting:record-invoice",
    tag: WS_METHODS.cloudAccountingRecordInvoice,
    scheduler,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: (input: import("@t3tools/contracts").CloudInvoiceInput) =>
      request(WS_METHODS.cloudAccountingRecordInvoice, input),
  });
  const exportUsage = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-accounting:export",
    tag: WS_METHODS.cloudAccountingExport,
    scheduler,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: (input: import("@t3tools/contracts").CloudUsageExportInput) =>
      request(WS_METHODS.cloudAccountingExport, input),
  });
  const readiness = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-readiness:get",
    tag: WS_METHODS.cloudReadinessGet,
    scheduler,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: () => request(WS_METHODS.cloudReadinessGet, {}),
  });
  /** Keyed by the requested checks so re-running IAM does not cancel KVM. */
  const runReadinessChecks = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-readiness:check",
    tag: WS_METHODS.cloudReadinessCheck,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${[...input.checks].sort().join(",")}`,
    },
    execute: (input: CloudReadinessCheckInput) => request(WS_METHODS.cloudReadinessCheck, input),
  });
  const runGuidedSetup = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-readiness:guided-setup",
    tag: WS_METHODS.cloudReadinessGuidedSetup,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
    },
    execute: (input: CloudGuidedSetupInput) => request(WS_METHODS.cloudReadinessGuidedSetup, input),
  });
  const saveEnvironment = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environments:save",
    tag: WS_METHODS.cloudEnvironmentSave,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
    },
    execute: (input: CloudEnvironmentSaveInput) => request(WS_METHODS.cloudEnvironmentSave, input),
  });
  const restoreEnvironment = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environments:restore",
    tag: WS_METHODS.cloudEnvironmentRestore,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
    },
    execute: (input: CloudEnvironmentRestoreInput) =>
      request(WS_METHODS.cloudEnvironmentRestore, input),
  });
  const resolveEnvironment = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environments:resolve",
    tag: WS_METHODS.cloudEnvironmentResolve,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.repository}`,
    },
    execute: (input: CloudEnvironmentResolutionInput) =>
      request(WS_METHODS.cloudEnvironmentResolve, input),
  });
  const startBuild = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environment-builds:start",
    tag: WS_METHODS.cloudEnvironmentBuildStart,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.buildId}`,
    },
    execute: (input: CloudEnvironmentBuildStartInput) =>
      request(WS_METHODS.cloudEnvironmentBuildStart, input),
  });
  const cancelBuild = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environment-builds:cancel",
    tag: WS_METHODS.cloudEnvironmentBuildCancel,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.buildId}`,
    },
    execute: (input: CloudEnvironmentBuildCancelInput) =>
      request(WS_METHODS.cloudEnvironmentBuildCancel, input),
  });
  const saveBuild = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environment-builds:save",
    tag: WS_METHODS.cloudEnvironmentBuildSave,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.buildId}`,
    },
    execute: (input: CloudEnvironmentBuildSaveInput) =>
      request(WS_METHODS.cloudEnvironmentBuildSave, input),
  });
  const setBuildStaleThreshold = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-environment-builds:stale-threshold",
    tag: WS_METHODS.cloudEnvironmentBuildStaleThreshold,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.environmentId}`,
    },
    execute: (input: CloudEnvironmentBuildStaleThresholdInput) =>
      request(WS_METHODS.cloudEnvironmentBuildStaleThreshold, input),
  });
  const grantArtifactAccess = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-allocations:grant-artifact-access",
    tag: WS_METHODS.cloudArtifactsGrant,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.resultId}`,
    },
    execute: (input: CloudArtifactAccessInput) => request(WS_METHODS.cloudArtifactsGrant, input),
  });
  const inspectAgentReview = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-agents:inspect",
    tag: WS_METHODS.cloudAgentReviewInspect,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.agentId}`,
    },
    execute: (input: CloudAgentReviewInspectInput) =>
      request(WS_METHODS.cloudAgentReviewInspect, input),
  });
  const actAgentReview = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-agents:act",
    tag: WS_METHODS.cloudAgentReviewAct,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.commandId}`,
    },
    execute: (input: CloudAgentReviewActInput) => request(WS_METHODS.cloudAgentReviewAct, input),
  });
  const shareAgentReview = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-agents:share",
    tag: WS_METHODS.cloudAgentReviewShare,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:share:${input.agentId}`,
    },
    execute: (input: CloudAgentReviewShareInput) =>
      request(WS_METHODS.cloudAgentReviewShare, input),
  });
  const previewHandoff = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-handoff:preview",
    tag: WS_METHODS.cloudHandoffPreview,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) =>
        `${environmentId}:${input.direction}:${input.intent}:${input.localWorkspacePath}`,
    },
    execute: (input: CloudHandoffPreviewInput) => request(WS_METHODS.cloudHandoffPreview, input),
  });
  const executeHandoff = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-handoff:execute",
    tag: WS_METHODS.cloudHandoffExecute,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.transferId}`,
    },
    execute: (input: CloudHandoffExecuteInput) => request(WS_METHODS.cloudHandoffExecute, input),
  });
  const listScmConnections = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-collaboration:list-scm",
    tag: WS_METHODS.cloudCollaborationListScm,
    scheduler,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: () => request(WS_METHODS.cloudCollaborationListScm, {}),
  });
  const connectScm = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-collaboration:connect-scm",
    tag: WS_METHODS.cloudCollaborationConnectScm,
    scheduler,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    execute: (input: CloudScmConnectionInput) =>
      request(WS_METHODS.cloudCollaborationConnectScm, input),
  });
  const disconnectScm = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:cloud-collaboration:disconnect-scm",
    tag: WS_METHODS.cloudCollaborationDisconnectScm,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.connectionId}`,
    },
    execute: (input: { readonly connectionId: string }) =>
      request(WS_METHODS.cloudCollaborationDisconnectScm, input),
  });

  return {
    snapshot,
    dispatch,
    setAdmission,
    setDefaults,
    setSpendLimit,
    recordInvoice,
    exportUsage,
    readiness,
    runReadinessChecks,
    runGuidedSetup,
    saveEnvironment,
    restoreEnvironment,
    resolveEnvironment,
    startBuild,
    cancelBuild,
    saveBuild,
    setBuildStaleThreshold,
    grantArtifactAccess,
    inspectAgentReview,
    actAgentReview,
    shareAgentReview,
    previewHandoff,
    executeHandoff,
    listScmConnections,
    connectScm,
    disconnectScm,
  };
}
