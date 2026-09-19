import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CloudAgentId,
  CloudRunResultId,
  CLOUD_AGENT_REVIEW_PAGE_PREFIX,
  CLOUD_AGENT_REVIEW_SHARE_PREFIX,
  type CloudResultRetentionStatus,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { cast } from "effect/Function";
import {
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer, OtlpSerialization } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import { githubMediaResponse } from "./assets/GitHubMediaFetch.ts";
import { statMediaFile, streamMediaFile, type OpenMediaFile } from "./assets/MediaFile.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./assets/AttachmentUpload.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import * as CloudArtifactAccess from "./cloud/CloudArtifactAccess.ts";
import * as CloudAgentReview from "./cloud/CloudAgentReview.ts";
import { renderCloudAgentReviewPage } from "./cloud/cloudAgentReviewPage.ts";
import * as CloudRunResults from "./cloud/CloudRunResults.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// HTML previews are agent output, not the app. The sandbox gives the document an
// opaque origin: scripts run, but same-origin cookies, storage, and API calls are
// out of reach. Relative sibling assets still load through their signed URLs.
const HTML_CONTENT_SECURITY_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-modals";
const CLOUD_RESULT_PAGE_PREFIX = "/cloud/results/";
const CLOUD_RESULT_DOWNLOAD_PREFIX = "/api/cloud/results/";
const CLOUD_ARTIFACT_ACCESS_PREFIX = CloudArtifactAccess.CLOUD_ARTIFACT_ACCESS_PREFIX;
const CLOUD_ARTIFACT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLOUD_RESULT_INLINE_TEXT_LIMIT = 512 * 1024;
const decodeCloudResultId = Schema.decodeUnknownOption(CloudRunResultId);
const decodeCloudAgentId = Schema.decodeUnknownOption(CloudAgentId);
const CLOUD_REVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Types a browser may render as a document if a proxy strips the disposition
// header. Downloads of these fall back to octet-stream.
const DOWNLOAD_MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const isSafeDownloadMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) &&
  !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mimeType.trim().toLowerCase());
const isSafeInlineMediaMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) && /^(?:audio|video)\//i.test(mimeType);
const isSafeInlineDocumentMimeType = (mimeType: string): boolean =>
  mimeType.toLowerCase() === "application/pdf" || mimeType.toLowerCase() === "text/html";

/** RFC 6266 disposition with an ASCII fallback name plus a UTF-8 `filename*`. */
export function downloadContentDisposition(fileName?: string): string {
  if (fileName === undefined) {
    return "attachment";
  }
  // toWellFormed: encodeURIComponent throws URIError on unpaired surrogates.
  const sanitized = fileName.toWellFormed().replace(/[\p{Cc}"\\]/gu, "_");
  const asciiFallback = sanitized.replace(/[^\u0020-\u007e]/g, "_");
  const needsExtended = asciiFallback !== sanitized;
  const extendedName = encodeURIComponent(sanitized).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"${
    needsExtended ? `; filename*=UTF-8''${extendedName}` : ""
  }`;
}

export function assetResponseHeaders(
  filePath: string,
  options?: {
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
  },
): Record<string, string> {
  const lowerPath = filePath.toLowerCase();
  const inlineMimeType = options?.mimeType?.split(";", 1)[0]?.trim();
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(options?.download
      ? {
          "Content-Disposition": downloadContentDisposition(options.fileName),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type":
            options.mimeType !== undefined && isSafeDownloadMimeType(options.mimeType)
              ? options.mimeType
              : "application/octet-stream",
        }
      : inlineMimeType !== undefined && isSafeInlineMediaMimeType(inlineMimeType)
        ? { "Content-Type": inlineMimeType }
        : inlineMimeType !== undefined && isSafeInlineDocumentMimeType(inlineMimeType)
          ? {
              "Content-Type":
                inlineMimeType.toLowerCase() === "text/html"
                  ? "text/html; charset=utf-8"
                  : "application/pdf",
              ...(inlineMimeType.toLowerCase() === "text/html"
                ? { "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY }
                : {}),
            }
          : lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")
            ? {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY,
              }
            : {}),
    ...(!options?.download && lowerPath.endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

/** A single byte range for native media readers; unsupported range syntax uses the full file. */
function assetByteRange(header: string, size: bigint) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? BigInt(match[1]) : null;
  const last = match[2] ? BigInt(match[2]) : null;
  if (first !== null && last !== null && last < first) return null;
  if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n)) {
    return { _tag: "Unsatisfiable" as const };
  }
  const start = first ?? (last! >= size ? 0n : size - last!);
  const end = first === null || last === null || last >= size ? size - 1n : last;
  if (!Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end))) {
    return { _tag: "Unsatisfiable" as const };
  }
  return {
    _tag: "Range" as const,
    offset: start,
    bytesToRead: end - start + 1n,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

export const assetFileResponse = Effect.fn("assetFileResponse")(function* (
  asset: {
    readonly path: string;
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly file?: OpenMediaFile;
  },
  rangeHeader?: string,
  ifRangeHeader?: string,
  method: "GET" | "HEAD" = "GET",
) {
  const headers = assetResponseHeaders(asset.path, asset);
  const mediaFile = asset.file;
  const mediaInfo = mediaFile ? yield* statMediaFile(asset.path, mediaFile) : undefined;
  const isMedia = /^(?:audio|video)\//i.test(headers["Content-Type"] ?? "");
  if (isMedia) {
    // Host media can change in place. Do not invite conditional range requests
    // with validators that cannot establish byte-for-byte identity. Attachment media
    // carries no `file`, and must not outlive the signed URL that granted it either.
    headers["Cache-Control"] = "private, no-store";
  }
  let status = 200;
  let offset = 0n;
  let bytesToRead: bigint | undefined;
  if (isMedia) {
    headers["Accept-Ranges"] = "bytes";
    // If-Range requires a matching validator. A full response is safe when we cannot validate it.
    if (method === "GET" && rangeHeader && ifRangeHeader === undefined) {
      const fs = yield* FileSystem.FileSystem;
      const info = mediaInfo ?? (yield* fs.stat(asset.path));
      const range = assetByteRange(rangeHeader, info.size);
      if (range?._tag === "Unsatisfiable") {
        return HttpServerResponse.empty({
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${info.size}` },
        });
      }
      if (range?._tag === "Range") {
        status = 206;
        offset = range.offset;
        bytesToRead = range.bytesToRead;
        headers["Content-Range"] = range.contentRange;
      }
    }
  }
  if (mediaFile && mediaInfo) {
    const size = bytesToRead ?? mediaInfo.size;
    headers["Content-Type"] ??= Mime.getType(asset.path) ?? "application/octet-stream";
    headers["Content-Length"] = String(size);
    if (!isMedia) {
      headers["Last-Modified"] = mediaInfo.mtime.toUTCString();
      headers.ETag = `W/"${mediaInfo.size.toString(16)}-${mediaInfo.mtimeMs.toString(16)}"`;
    }
    if (method === "HEAD" || size === 0n) {
      return HttpServerResponse.empty({ status, headers });
    }
    const body = streamMediaFile(mediaFile, offset, size);
    if (!body) {
      return HttpServerResponse.text("File is too large to preview.", { status: 413 });
    }
    return HttpServerResponse.stream(body, {
      status,
      headers,
    });
  }
  return yield* HttpServerResponse.file(asset.path, { status, offset, bytesToRead, headers });
});

export const httpCompressionLayer = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function boundedCloudResultPreview(value: string): string {
  return value.length <= CLOUD_RESULT_INLINE_TEXT_LIMIT
    ? value
    : `${value.slice(0, CLOUD_RESULT_INLINE_TEXT_LIMIT)}\n\n[Preview truncated. Download the file for the complete output.]`;
}

export function renderCloudResultPage(input: {
  readonly status: CloudResultRetentionStatus;
  readonly diff?: string;
  readonly verification?: string;
}): string {
  const title = "Cloud run result";
  if (input.status.status === "retaining") {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>Retention is still in progress.</p></main></body></html>`;
  }
  if (input.status.status === "failed") {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>Retention failed.</p><p>${escapeHtml(input.status.message)}</p><p>${input.status.retryable ? "The controller can retry this capture." : "This capture cannot be retried after the compute deadline or a size-policy failure."}</p></main></body></html>`;
  }

  const manifest = input.status.manifest;
  const artifactLinks = manifest.artifacts
    .map(
      (artifact) =>
        `<li><a href="${escapeHtml(artifact.downloadPath)}">${escapeHtml(artifact.name)}</a> (${artifact.sizeBytes} bytes)</li>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><dl><dt>Repository base</dt><dd><code>${escapeHtml(manifest.baseCommit)}</code></dd><dt>Output branch</dt><dd><code>${escapeHtml(manifest.outputBranch)}</code></dd><dt>Capture window</dt><dd>${escapeHtml(manifest.captureStartedAt)} to ${escapeHtml(manifest.capturedAt)}</dd><dt>Expires</dt><dd>${escapeHtml(manifest.expiresAt)}</dd></dl><p><a href="${escapeHtml(manifest.workspaceDownloadPath)}">Download workspace checkpoint</a> · <a href="${escapeHtml(manifest.transcriptDownloadPath)}">Download transcript</a> · <a href="${escapeHtml(manifest.verificationDownloadPath)}">Download verification log</a> · <a href="${escapeHtml(manifest.diffDownloadPath)}">Download diff</a></p><h2>Diff</h2><pre>${escapeHtml(boundedCloudResultPreview(input.diff ?? ""))}</pre><h2>Verification</h2><pre>${escapeHtml(boundedCloudResultPreview(input.verification ?? ""))}</pre><h2>Artifacts</h2>${artifactLinks.length > 0 ? `<ul>${artifactLinks}</ul>` : "<p>No artifacts were retained.</p>"}</main></body></html>`;
}

function parseCloudResultPageId(pathname: string): CloudRunResultId | undefined {
  const suffix = pathname.slice(CLOUD_RESULT_PAGE_PREFIX.length);
  if (suffix.includes("/")) return undefined;
  return Option.getOrUndefined(decodeCloudResultId(suffix));
}

function parseCloudResultDownload(pathname: string) {
  const suffix = pathname.slice(CLOUD_RESULT_DOWNLOAD_PREFIX.length);
  const [resultIdInput, segment, fileId, ...rest] = suffix.split("/");
  if (segment !== "downloads" || !fileId || rest.length > 0) return undefined;
  const resultId = Option.getOrUndefined(decodeCloudResultId(resultIdInput));
  return resultId === undefined || !/^[a-z0-9-]+$/.test(fileId) ? undefined : { resultId, fileId };
}

const handleCloudResultPage = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const resultId = parseCloudResultPageId(url.value.pathname);
  if (resultId === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
  const results = yield* CloudRunResults.CloudRunResults;
  const status = yield* results.status(resultId).pipe(Effect.option);
  if (Option.isNone(status)) return HttpServerResponse.text("Not Found", { status: 404 });
  let texts: readonly [string, string] = ["", ""];
  if (status.value.status === "retained") {
    const retainedTexts = yield* Effect.all(
      [results.readText(resultId, "diff"), results.readText(resultId, "verification")],
      { concurrency: "unbounded" },
    ).pipe(Effect.option);
    if (Option.isNone(retainedTexts)) {
      return HttpServerResponse.text("Retained result is unavailable.", { status: 500 });
    }
    texts = retainedTexts.value;
  }
  return HttpServerResponse.text(
    renderCloudResultPage({ status: status.value, diff: texts[0], verification: texts[1] }),
    {
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; style-src 'none'; base-uri 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

function parseCloudArtifactDownload(pathname: string) {
  const suffix = pathname.slice(CLOUD_ARTIFACT_ACCESS_PREFIX.length);
  const [token, fileId, ...rest] = suffix.split("/");
  if (!token || !fileId || rest.length > 0) return undefined;
  if (!CLOUD_ARTIFACT_TOKEN_PATTERN.test(token) || !/^[a-z0-9-]+$/.test(fileId)) return undefined;
  return { token, fileId };
}

// Downloads authorized by a short-lived grant token instead of an environment
// session. The token is the bearer credential, so a granted URL can be embedded
// or attached without exposing session scopes; it stops resolving when the grant
// expires.
const handleCloudArtifactDownload = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const target = parseCloudArtifactDownload(url.value.pathname);
  if (target === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
  const access = yield* CloudArtifactAccess.CloudArtifactAccess;
  const resultId = yield* access.resolve(target.token);
  if (resultId === null) return HttpServerResponse.text("Not Found", { status: 404 });
  const results = yield* CloudRunResults.CloudRunResults;
  const download = yield* results.resolveDownload(resultId, target.fileId).pipe(Effect.option);
  if (Option.isNone(download)) return HttpServerResponse.text("Not Found", { status: 404 });
  return yield* HttpServerResponse.file(download.value.path, {
    headers: {
      ...assetResponseHeaders(download.value.path, {
        download: true,
        fileName: download.value.fileName,
        mimeType: download.value.mediaType,
      }),
      "Cache-Control": "private, no-store",
    },
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Not Found", { status: 404 })));
});

const handleCloudResultDownload = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const target = parseCloudResultDownload(url.value.pathname);
  if (target === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
  const results = yield* CloudRunResults.CloudRunResults;
  const download = yield* results
    .resolveDownload(target.resultId, target.fileId)
    .pipe(Effect.option);
  if (Option.isNone(download)) return HttpServerResponse.text("Not Found", { status: 404 });
  return yield* HttpServerResponse.file(download.value.path, {
    headers: {
      ...assetResponseHeaders(download.value.path, {
        download: true,
        fileName: download.value.fileName,
        mimeType: download.value.mediaType,
      }),
      "Cache-Control": "private, no-store",
    },
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Not Found", { status: 404 })));
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

function cloudAgentReviewResponse(review: Parameters<typeof renderCloudAgentReviewPage>[0]) {
  return HttpServerResponse.text(renderCloudAgentReviewPage(review), {
    contentType: "text/html; charset=utf-8",
    headers: {
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; style-src 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseCloudAgentReviewPageId(pathname: string): CloudAgentId | undefined {
  const suffix = pathname.slice(CLOUD_AGENT_REVIEW_PAGE_PREFIX.length);
  if (suffix.includes("/")) return undefined;
  return Option.getOrUndefined(decodeCloudAgentId(decodeURIComponent(suffix)));
}

const handleCloudAgentReviewPage = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const agentId = parseCloudAgentReviewPageId(url.value.pathname);
  if (agentId === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
  const reviews = yield* CloudAgentReview.CloudAgentReviewService;
  const review = yield* reviews.inspect({ agentId }).pipe(Effect.option);
  if (Option.isNone(review)) return HttpServerResponse.text("Not Found", { status: 404 });
  return cloudAgentReviewResponse(review.value);
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

function parseCloudAgentReviewShareToken(pathname: string): string | undefined {
  const suffix = pathname.slice(CLOUD_AGENT_REVIEW_SHARE_PREFIX.length);
  if (suffix.includes("/") || !CLOUD_REVIEW_TOKEN_PATTERN.test(suffix)) return undefined;
  return suffix;
}

const handleCloudAgentReviewSharePage = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const token = parseCloudAgentReviewShareToken(url.value.pathname);
  if (token === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
  const reviews = yield* CloudAgentReview.CloudAgentReviewService;
  const agentId = yield* reviews.resolveShare(token);
  if (agentId === null) return HttpServerResponse.text("Not Found", { status: 404 });
  const review = yield* reviews.inspect({ agentId }).pipe(Effect.option);
  if (Option.isNone(review)) return HttpServerResponse.text("Not Found", { status: 404 });
  return cloudAgentReviewResponse(review.value);
});

export const cloudResultRouteLayer = Layer.mergeAll(
  HttpRouter.add("GET", `${CLOUD_RESULT_PAGE_PREFIX}*`, handleCloudResultPage),
  HttpRouter.add("GET", `${CLOUD_RESULT_DOWNLOAD_PREFIX}*`, handleCloudResultDownload),
  HttpRouter.add("GET", `${CLOUD_ARTIFACT_ACCESS_PREFIX}*`, handleCloudArtifactDownload),
);

export const cloudAgentReviewRouteLayer = Layer.mergeAll(
  HttpRouter.add("GET", `${CLOUD_AGENT_REVIEW_PAGE_PREFIX}*`, handleCloudAgentReviewPage),
  HttpRouter.add("GET", `${CLOUD_AGENT_REVIEW_SHARE_PREFIX}*`, handleCloudAgentReviewSharePage),
);

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const otlpHeaders = config.otlpHeaders;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const serialization = yield* OtlpSerialization.OtlpSerialization;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: serialization.traces(bodyJson),
        headers: otlpHeaders,
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (asset.kind === "github-media") {
      return yield* githubMediaResponse(asset, request.headers).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to fetch GitHub media.", { url: asset.url, cause }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.empty({
            status: 502,
            headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
          }),
        ),
      );
    }
    return yield* assetFileResponse(
      asset,
      request.method === "GET" ? request.headers.range : undefined,
      request.headers["if-range"],
      request.method === "HEAD" ? "HEAD" : "GET",
    ).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const attachmentUploadRouteLayer = HttpRouter.add(
  "POST",
  `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const token = url.value.pathname.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
    if (!token) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const claims = yield* validateAttachmentUploadToken(token);
    if (!claims) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const contentLengthHeader = request.headers["content-length"];
    if (
      contentLengthHeader !== undefined &&
      (!Number.isInteger(Number(contentLengthHeader)) ||
        Number(contentLengthHeader) !== claims.sizeBytes)
    ) {
      return HttpServerResponse.text("Content-Length must match the upload size.", {
        status: 400,
      });
    }

    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    const stored = yield* storeAttachmentUpload(claims, Stream.fromPull(Effect.succeed(bodyPull)));
    return stored.ok
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.text(stored.detail, { status: stored.status });
  }),
);

const decodeBuildManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        css: Schema.optional(Schema.Array(Schema.String)),
        assets: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const loadImmutableBuildAssets = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const staticDir =
    config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
  if (!staticDir) return new Set<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(staticDir, ".vite", "manifest.json")).pipe(
    Effect.flatMap(decodeBuildManifest),
    Effect.map(
      (manifest) =>
        new Set(
          Object.values(manifest).flatMap((entry) => [
            entry.file,
            ...(entry.css ?? []),
            ...(entry.assets ?? []),
          ]),
        ),
    ),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});

const openStaticFile = Effect.fn("openStaticFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // Reject directories and special files before opening. Response metadata comes from the handle.
  const pathInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (pathInfo?.type !== "File") return null;
  const file = yield* fileSystem.open(filePath, { flag: "r" });
  const info = yield* file.stat;
  return info.type === "File" ? { file, info } : null;
});

const streamStaticFile = (file: FileSystem.File, size: bigint) =>
  Stream.unfold(
    0n,
    Effect.fnUntraced(function* (offset: bigint) {
      if (offset >= size) return;
      const remaining = size - offset;
      const bytes = yield* file.readAlloc(remaining < 65_536n ? remaining : 65_536n);
      if (Option.isNone(bytes)) return;
      return [bytes.value, offset + BigInt(bytes.value.byteLength)] as const;
    }),
  );

const handleStaticAndDevRequest = Effect.fn("handleStaticAndDevRequest")(
  function* (immutableBuildAssets: ReadonlySet<string>) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    let opened = yield* openStaticFile(filePath);
    if (!opened) {
      filePath = path.resolve(staticRoot, "index.html");
      opened = yield* openStaticFile(filePath);
      if (!opened) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }
    const fileInfo = opened.info;
    const mimeType = Mime.getType(filePath) ?? "application/octet-stream";
    const isHtml = mimeType === "text/html";

    // A hash-like name is not enough: custom static files can use the same naming pattern.
    const relativePath = path.relative(staticRoot, filePath).replaceAll("\\", "/");
    const immutable =
      !isHtml &&
      /^assets\/.+-[\w-]{8}\.[^/]+$/.test(relativePath) &&
      immutableBuildAssets.has(relativePath);
    const headers: Record<string, string> = {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    // Deployments can preserve HTML size and mtime while changing its bundle URLs.
    const modifiedAt = isHtml ? undefined : Option.getOrUndefined(fileInfo.mtime);
    const etag = modifiedAt
      ? `W/"${fileInfo.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`
      : undefined;
    if (etag !== undefined && modifiedAt !== undefined) {
      headers.ETag = etag;
      headers["Last-Modified"] = modifiedAt.toUTCString();
    }

    // If-None-Match takes precedence over dates and uses weak comparison for
    // GET/HEAD, including when compression changes the transferred bytes.
    const ifNoneMatch = request.headers["if-none-match"];
    const ifModifiedSince = request.headers["if-modified-since"];
    const unchanged =
      ifNoneMatch !== undefined
        ? ifNoneMatch.split(",").some((value) => {
            const candidate = value.trim();
            return (
              candidate === "*" ||
              (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2))
            );
          })
        : ifModifiedSince !== undefined &&
          modifiedAt !== undefined &&
          Date.parse(modifiedAt.toUTCString()) <= Date.parse(ifModifiedSince);
    if (!isHtml && unchanged) {
      return HttpServerResponse.empty({
        status: 304,
        headers: { ...headers, Vary: "Accept-Encoding" },
      });
    }

    const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
    // The request scope closes the handle for GET, HEAD, 304, errors, and cancellation.
    // HEAD still passes through compression, which selects headers without reading the stream.
    return HttpServerResponse.stream(streamStaticFile(opened.file, fileInfo.size), {
      headers,
      contentType,
      contentLength: Number(fileInfo.size),
    });
  },
  Effect.catchTags({
    PlatformError: () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
  }),
);

// Read the installed build's manifest once. Unknown files use revalidation.
export const staticAndDevRouteLayer = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets))),
  ),
);
