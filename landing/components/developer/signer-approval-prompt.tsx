"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Renders the Farcaster signer approval URL as a QR code so a desktop
 * user can scan it with their Farcaster mobile app. The approval URL
 * is a deeplink (`client.farcaster.xyz/deeplinks/signed-key-request`)
 * that opens blank in a desktop browser, so we never link to it
 * directly on desktop. On mobile we surface a tap-to-deeplink button
 * since the user might be approving on the same device.
 */
export function SignerApprovalPrompt({
  approvalUrl,
  onCancel,
}: {
  approvalUrl: string | null;
  onCancel: () => void;
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
      width: 232,
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
  }, [approvalUrl]);

  return (
    <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start">
      {qrDataUrl && (
        <img
          src={qrDataUrl}
          alt="Scan with your Farcaster app to sign in"
          width={232}
          height={232}
          className="h-[232px] w-[232px] shrink-0 rounded-xl bg-white p-2"
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
            className="inline-flex h-11 w-fit items-center justify-center rounded-full border border-white/15 bg-transparent px-4 text-sm font-medium text-white/80 transition hover:bg-white/5 sm:hidden"
          >
            Open in Farcaster
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
