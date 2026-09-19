export type PreviewPanelKind = "web" | "android" | "ios";

/**
 * Worker profile decides the thread preview. linux-web keeps the ordinary app
 * and agent-browser surfaces; Android and iOS workers show that platform's
 * device instead of a mobile website.
 */
export function previewPanelKind(
  deviceDisplay: "android" | "ios" | undefined,
): PreviewPanelKind {
  return deviceDisplay ?? "web";
}
