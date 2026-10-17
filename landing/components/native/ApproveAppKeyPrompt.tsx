"use client";

/**
 * Prompt shown when a native-space action needs the user to approve their
 * on-device Ed25519 app key in the Farcaster app. Renders a QR code of the
 * approval deep link (primary path — desktop users scan it with their phone)
 * plus a secondary "open link" fallback for same-device approval, and a
 * "waiting for approval" state while polling.
 */

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Modal } from "@/components/ui/modal";
import { Button, LinkButton } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { isSafeApprovalUrl } from "@/lib/native/appKeyApproval";

export interface ApproveAppKeyPromptProps {
  open: boolean;
  approvalUrl: string | null;
  isApproving: boolean;
  onClose: () => void;
}

export function ApproveAppKeyPrompt({
  open,
  approvalUrl,
  isApproving,
  onClose,
}: ApproveAppKeyPromptProps) {
  const [qr, setQr] = useState<string | null>(null);
  // Only ever open / render / QR-encode an https approval URL.
  const safeUrl = isSafeApprovalUrl(approvalUrl) ? approvalUrl : null;

  useEffect(() => {
    let active = true;
    if (safeUrl) {
      QRCode.toDataURL(safeUrl, { width: 240, margin: 1 })
        .then((url) => {
          if (active) setQr(url);
        })
        .catch(() => {
          if (active) setQr(null);
        });
    } else {
      setQr(null);
    }
    return () => {
      active = false;
    };
  }, [safeUrl]);

  return (
    <Modal open={open} onClose={onClose} title="Approve your Farcaster app key">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-sm text-juke-text-on-dark-secondary">
          Native Farcaster spaces need a one-time approval of a device key on
          your account. Scan this code with your phone to approve in the
          Farcaster app — this page updates automatically once you do.
        </p>

        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL QR
          <img
            src={qr}
            alt="Scan to approve in the Farcaster app"
            className="rounded-xl border border-juke-border bg-white p-3"
            width={240}
            height={240}
          />
        ) : null}

        {safeUrl ? (
          <p className="w-full truncate text-[11px] text-juke-text-on-dark-tertiary">
            {safeUrl}
          </p>
        ) : null}

        {isApproving ? (
          <div className="flex items-center gap-2 text-sm text-juke-text-on-dark-secondary">
            <Spinner size="sm" />
            <span>Waiting for approval…</span>
          </div>
        ) : null}

        {safeUrl ? (
          <LinkButton
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            variant="ghost"
            fullWidth
          >
            On this device? Open link instead
          </LinkButton>
        ) : null}

        <Button variant="ghost" onClick={onClose} fullWidth>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
