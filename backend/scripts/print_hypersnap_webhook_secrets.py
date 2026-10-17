"""Print the ``HYPERSNAP_WEBHOOK_SECRET_*`` values for Juke's managed webhooks.

``POST /v1/admin/setup-webhooks`` provisions the webhooks but deliberately
no longer returns their signing secrets (an HTTP response is the wrong
channel for verification secrets: it lands in proxies, client logs and any
session that can reach an admin route). Ops reads them out-of-band with
this script instead, from a shell that already holds
``FARCASTER_APP_MNEMONIC`` (e.g. ``railway run``):

    cd backend
    railway run python -m scripts.print_hypersnap_webhook_secrets

It lists the app FID's webhooks (read-only, nothing is created or
changed) and prints one ``VAR=value`` line per secret setting, comma-joined
across shards, to stdout only. Copy them into the deployment's env and
redeploy. Never paste the output into tickets, chat or logs.
"""

from __future__ import annotations

import asyncio
import sys

from app.clients.hypersnap_webhooks import (
    HypersnapWebhookClient,
    HypersnapWebhookConfigError,
    active_secret,
    app_webhook_signer,
)
from app.services.hypersnap_webhook_service import _wanted_webhooks, secret_env


async def collect_secret_env(client: HypersnapWebhookClient) -> dict[str, str]:
    """``{SECRET_VAR: "s1,s2"}`` for every managed webhook that exists."""
    existing = {
        record.get("title"): record
        for record in await client.list()
        if record.get("webhook_id")
    }
    results = [
        {
            "secret_var": webhook.secret_setting,
            "secret": active_secret(existing[name]),
        }
        for webhook, name in _wanted_webhooks(0, existing)
        if name in existing
    ]
    return secret_env(results)


async def main() -> int:
    try:
        client = HypersnapWebhookClient(app_webhook_signer())
    except HypersnapWebhookConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    env = await collect_secret_env(client)
    if not env:
        print("No managed webhooks found; run setup-webhooks first.", file=sys.stderr)
        return 1
    for var, value in sorted(env.items()):
        print(f"{var}={value}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
