"use client";

/**
 * Thin wrapper around `navigator.mediaDevices` for enumerating audio inputs and
 * reacting to hot-plug (DJ gear / audio interface connected mid-space).
 *
 * The engine stream owns this module; the UI stream imports the types and
 * functions to populate the "Add device" menu and refresh it on `devicechange`.
 */

/** A selectable audio input device. */
export interface AudioInputDevice {
  deviceId: string;
  /** Device label; empty until the user has granted a media permission. */
  label: string;
}

function hasMediaDevices(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.enumerateDevices === "function"
  );
}

/**
 * List available audio input devices. Labels only populate after the first
 * successful `getUserMedia` grant, so call this after enabling the mic.
 *
 * Devices with an empty `deviceId` (some browsers emit a placeholder before a
 * grant) are filtered out so the caller never renders an unselectable row.
 */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  if (!hasMediaDevices()) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId)
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

/**
 * Subscribe to device hot-plug/unplug (`devicechange`). Returns an unsubscribe
 * fn. The UI re-fetches `listAudioInputs()` on each fire.
 */
export function subscribeDeviceChange(cb: () => void): () => void {
  if (!hasMediaDevices() || typeof navigator.mediaDevices.addEventListener !== "function") {
    return () => {};
  }
  const handler = () => cb();
  navigator.mediaDevices.addEventListener("devicechange", handler);
  return () => {
    navigator.mediaDevices.removeEventListener("devicechange", handler);
  };
}
