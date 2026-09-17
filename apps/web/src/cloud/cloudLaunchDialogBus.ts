const CLOUD_LAUNCH_DIALOG_EVENT = "t3code:open-cloud-launch-dialog";

export function openCloudLaunchDialog(): void {
  window.dispatchEvent(new Event(CLOUD_LAUNCH_DIALOG_EVENT));
}

export function onOpenCloudLaunchDialog(listener: () => void): () => void {
  window.addEventListener(CLOUD_LAUNCH_DIALOG_EVENT, listener);
  return () => window.removeEventListener(CLOUD_LAUNCH_DIALOG_EVENT, listener);
}
