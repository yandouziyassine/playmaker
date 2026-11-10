// Camera access for the Lab's live mode: rear camera first (phones), any camera as a fallback, clear messages.
// The stream is only drawn into canvases on this device: nothing is sent anywhere.

export type CameraProblem = "insecure" | "unsupported" | "denied" | "notfound" | "busy" | "other";

export const CAMERA_MESSAGES: Record<CameraProblem, string> = {
  insecure: "The camera needs a secure page: open the Lab over HTTPS (or on localhost while developing).",
  unsupported: "This browser cannot open a camera here. Picture mode still works.",
  denied: "Camera permission was refused. Allow the camera for this site in the browser settings, then tap Start again.",
  notfound: "No camera found on this device. Picture mode still works.",
  busy: "The camera is busy (another app or tab is using it). Close it, then tap Start again.",
  other: "The camera could not start. Tap Start to try again, or use Picture mode.",
};

/** Maps a getUserMedia error (DOMException name) to a problem with a user-facing message. */
export function cameraProblem(e: unknown): CameraProblem {
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "notfound";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  if (name === "InsecureContext") return "insecure";
  if (name === "Unsupported") return "unsupported";
  return "other";
}

const fail = (name: string) => Object.assign(new Error(name), { name });

/** Opens the rear camera (facingMode "environment"), or any camera when there is none. Video only, no audio. */
export async function openCamera(): Promise<MediaStream> {
  if (!window.isSecureContext) throw fail("InsecureContext");
  if (!navigator.mediaDevices?.getUserMedia) throw fail("Unsupported");
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, ...size } });
  } catch (e) {
    // a refused permission will not change with other constraints; anything else: try any camera
    if (cameraProblem(e) === "denied") throw e;
    return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
}

export function stopStream(s: MediaStream | null) {
  s?.getTracks().forEach((t) => t.stop());
}
