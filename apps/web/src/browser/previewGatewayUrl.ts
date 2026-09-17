import type { PreviewGatewayGrant, PreviewGatewayIssueInput, ThreadId } from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

export interface PreviewGatewayRequest {
  readonly input: PreviewGatewayIssueInput;
  readonly hash: string;
}

export function previewGatewayRequest(
  environmentHttpBaseUrl: string,
  threadId: ThreadId,
  rawUrl: string,
): PreviewGatewayRequest | null {
  const environmentUrl = new URL(environmentHttpBaseUrl);
  if (environmentUrl.protocol !== "https:" || isLoopbackHost(environmentUrl.hostname)) return null;
  const target = new URL(normalizePreviewUrl(rawUrl));
  if (!isLoopbackHost(target.hostname)) return null;
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return {
    input: {
      threadId,
      port,
      protocol: target.protocol === "https:" ? "https" : "http",
      path: `${target.pathname}${target.search}`,
    },
    hash: target.hash,
  };
}

export function previewGatewayBootstrapUrl(
  environmentHttpBaseUrl: string,
  grant: PreviewGatewayGrant,
  hash: string,
): string {
  const url = new URL(grant.bootstrapPath, environmentHttpBaseUrl);
  url.hash = hash;
  return url.toString();
}
