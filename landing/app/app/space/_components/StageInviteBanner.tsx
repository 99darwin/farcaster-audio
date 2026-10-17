"use client";

/**
 * Banner shown to a listener in a Farcaster-native space when the host has
 * invited them to the stage. Juke-only users don't receive Farcaster's push
 * notification, so the space screen polls the upstream participant list and
 * surfaces this accept/decline affordance when their own pending invite appears
 * (see `spaceStore.pendingStageInvite`).
 */

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { PendingStageInvite } from "@/lib/space/spaceStore";

interface StageInviteBannerProps {
  invite: PendingStageInvite;
  onAccept: () => void;
  onDecline: () => void;
  busy?: boolean;
}

export function StageInviteBanner({
  invite,
  onAccept,
  onDecline,
  busy = false,
}: StageInviteBannerProps) {
  const inviter = invite.inviterDisplayName;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-28 z-50 mx-auto max-w-2xl px-4"
    >
      <div className="flex items-center gap-3 rounded-2xl border border-juke-orange/40 bg-juke-surface/95 px-4 py-3 shadow-lg backdrop-blur">
        {invite.inviterPfpUrl !== null && (
          <Avatar
            src={invite.inviterPfpUrl}
            name={inviter ?? "Host"}
            size="sm"
          />
        )}
        <p className="flex-1 text-sm text-juke-text-on-dark">
          {inviter ? (
            <>
              <span className="font-semibold">{inviter}</span> invited you to
              speak
            </>
          ) : (
            "You've been invited to speak"
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onDecline}
          >
            Decline
          </Button>
          <Button size="sm" loading={busy} onClick={onAccept}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
