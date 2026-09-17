import type { SharedBrowserGrant } from "@t3tools/contracts";

export function sharedBrowserGatewayUrl(
  environmentHttpBaseUrl: string,
  grant: SharedBrowserGrant,
  requestNonce: number,
): string {
  const url = new URL(grant.bootstrapPath, environmentHttpBaseUrl);
  url.searchParams.set("viewer", String(requestNonce));
  return url.toString();
}
