import { createCloudAllocationAtoms } from "@t3tools/client-runtime/state/cloud-allocations";
import { connectionAtomRuntime } from "../connection/runtime";

export const cloudAllocations = createCloudAllocationAtoms(connectionAtomRuntime);
