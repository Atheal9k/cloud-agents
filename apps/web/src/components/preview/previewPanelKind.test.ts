import { describe, expect, it } from "vite-plus/test";

import { previewPanelKind } from "./previewPanelKind";

describe("previewPanelKind", () => {
  it("selects the web preview when the worker has no device display", () => {
    expect(previewPanelKind(undefined)).toBe("web");
  });

  it("selects Android or iOS independently from the advertised capability", () => {
    expect(previewPanelKind("android")).toBe("android");
    expect(previewPanelKind("ios")).toBe("ios");
    expect(previewPanelKind("android")).not.toBe("ios");
  });
});
