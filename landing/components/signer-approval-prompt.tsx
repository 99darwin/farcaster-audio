"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Renders the Farcaster signer approval URL as a QR code (for scan-from-
 * another-device) plus an explicit "I'm on my mobile device" link that
 * deeplinks into the Farcaster app on the same device. The approval URL
 * is `client.farcaster.xyz/deeplinks/signed-key-request?...` — a
 * Farcaster deeplink, not a normal web page, so it renders blank in a
 * desktop browser. The QR is the desktop primary path; the deeplink
 * button is the mobile primary path.
 *
 * `qrSize` lets the embed iframe (narrow card) request a smaller code
 * than the developer dashboard (wide card). 232 default matches the
 * dashboard; 160 fits inside the 420×620 embed.
 */
export function SignerApprovalPrompt({
  approvalUrl,
  onCancel,
  qrSize = 232,
}: {
  approvalUrl: string | null;
  onCancel: () => void;
  qrSize?: number;
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!approvalUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(approvalUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: qrSize,
      color: { dark: "#0f0f23", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [approvalUrl, qrSize]);

  return (
    <div className="mt-5 flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-5">
      {qrDataUrl && (
        <img
          src={qrDataUrl}
          alt="Scan with your Farcaster app to sign in"
          width={qrSize}
          height={qrSize}
          style={{ width: qrSize, height: qrSize }}
          className="shrink-0 rounded-xl bg-white p-2"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="text-sm text-juke-text-on-dark-secondary">
          Scan this code with your Farcaster app to approve sign-in. The
          page will update automatically once you confirm.
        </p>
        {approvalUrl && (
          <a
            href={approvalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 w-fit items-center justify-center rounded-full border border-white/15 bg-transparent px-4 text-sm font-medium text-white/80 transition hover:bg-white/5"
          >
            I&apos;m on my mobile device
          </a>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-11 w-fit items-center justify-center rounded-full border border-white/15 bg-transparent px-4 text-sm font-medium text-white/80 transition hover:bg-white/5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
