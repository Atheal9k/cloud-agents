import type { RunAllocation } from "@t3tools/contracts";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "./catalog.ts";
import { BearerConnectionTarget } from "./model.ts";

export function cloudWorkerConnectionRegistration(
  allocation: RunAllocation,
): BearerConnectionRegistration | null {
  if (
    allocation.allocationState.status !== "ready" ||
    allocation.allocationState.route === undefined ||
    allocation.cleanupState.status !== "not-requested"
  ) {
    return null;
  }
  const { references, route } = allocation.allocationState;
  const connectionId = `cloud:${allocation.id}:${allocation.attempt}`;
  const label = `Cloud worker ${allocation.id}`;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: references.environmentId,
      connectionId,
      label,
    }),
    profile: new BearerConnectionProfile({
      environmentId: references.environmentId,
      connectionId,
      label,
      httpBaseUrl: route.httpBaseUrl,
      wsBaseUrl: route.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({ token: route.accessToken }),
  });
}
