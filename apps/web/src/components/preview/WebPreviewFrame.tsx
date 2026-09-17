export function WebPreviewFrame(props: {
  readonly url: string;
  readonly visible: boolean;
  readonly refreshVersion: number;
  readonly onLoad: () => void;
}) {
  const sharesT3Origin =
    typeof window !== "undefined" && new URL(props.url).origin === window.location.origin;
  return (
    <iframe
      key={`${props.url}:${props.refreshVersion}`}
      src={props.url}
      title="Direct app preview"
      sandbox={
        sharesT3Origin
          ? "allow-downloads allow-forms allow-modals allow-popups allow-scripts"
          : "allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
      }
      referrerPolicy="no-referrer"
      onLoad={props.onLoad}
      aria-hidden={props.visible ? undefined : true}
      className="absolute inset-0 h-full w-full border-0 bg-white"
    />
  );
}
