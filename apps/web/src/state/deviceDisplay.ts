import { createDeviceDisplayAtoms } from "@t3tools/client-runtime/state/device-display";

import { connectionAtomRuntime } from "../connection/runtime";

export const deviceDisplayEnvironment = createDeviceDisplayAtoms(connectionAtomRuntime);
