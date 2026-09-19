const CLOUD_LAUNCH_DIALOG_EVENT = "t3code:open-cloud-launch-dialog";

export type CloudLaunchDialogIntent =
  | { readonly kind: "task" }
  | { readonly kind: "env-setup"; readonly repository?: string };

export function openCloudLaunchDialog(intent: CloudLaunchDialogIntent = { kind: "task" }): void {
  window.dispatchEvent(
    new CustomEvent<CloudLaunchDialogIntent>(CLOUD_LAUNCH_DIALOG_EVENT, { detail: intent }),
  );
}

export function onOpenCloudLaunchDialog(
  listener: (intent: CloudLaunchDialogIntent) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<CloudLaunchDialogIntent>).detail;
    listener(detail ?? { kind: "task" });
  };
  window.addEventListener(CLOUD_LAUNCH_DIALOG_EVENT, handler);
  return () => window.removeEventListener(CLOUD_LAUNCH_DIALOG_EVENT, handler);
}
