import { createSharedBrowserAtoms } from "@t3tools/client-runtime/state/shared-browser";

import { connectionAtomRuntime } from "../connection/runtime";

export const sharedBrowserEnvironment = createSharedBrowserAtoms(connectionAtomRuntime);
