"""Test helpers for legacy ``custody_env`` developer bots.

Self-serve ``POST /v1/developer/bots`` refuses custody mode (C1), so tests
that need a custody bot seed the row directly, the way an admin would, and
admit it through every mint-time gate:

* the ``DEVELOPER_CUSTODY_KEY_REFS`` allowlist (``app_id:VAR``),
* the env var itself (``JUKE_DEV_BOT_CUSTODY_`` prefix),
* the on-chain custody lookup (``key_gateway.custody_of``), faked here.

The keys are throwaway test constants, not associated with any real FID.
"""

from __future__ import annotations

import uuid

import pytest
from eth_account import Account
from sqlalchemy.ext.asyncio import AsyncSession

import app.services.farcaster_spaces_service as fcsp_module
from app.config import settings
from app.models.developer_app_bot import DeveloperAppBot


def custody_address_for(private_key_hex: str) -> str:
    return Account.from_key(private_key_hex).address


class FakeOnchainCustody:
    """Stands in for ``key_gateway.custody_of``: ``{fid: address}``."""

    def __init__(self) -> None:
        self.by_fid: dict[int, str] = {}

    async def custody_of(self, fid: int, **_kwargs) -> str | None:
        return self.by_fid.get(fid)


def install_custody_fakes(monkeypatch: pytest.MonkeyPatch) -> FakeOnchainCustody:
    """Reset the allowlist and swap in a fake on-chain custody lookup."""
    monkeypatch.setattr(settings, "DEVELOPER_CUSTODY_KEY_REFS", "")
    fake = FakeOnchainCustody()
    monkeypatch.setattr(fcsp_module.key_gateway, "custody_of", fake.custody_of)
    return fake


def allowlist_custody_ref(app_id: uuid.UUID | str, env_var: str) -> None:
    """Append ``app_id:env_var`` to the allowlist.

    Call only after :func:`install_custody_fakes` (which monkeypatches the
    setting, so this mutation is undone at teardown).
    """
    entry = f"{app_id}:{env_var}"
    current = settings.DEVELOPER_CUSTODY_KEY_REFS
    settings.DEVELOPER_CUSTODY_KEY_REFS = f"{current},{entry}" if current else entry


async def seed_custody_bot(
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    onchain: FakeOnchainCustody,
    *,
    app_id: uuid.UUID | str,
    fid: int,
    private_key_hex: str,
    env_var: str,
    label: str | None = "host-bot",
) -> DeveloperAppBot:
    """Insert an admin-provisioned custody bot that passes every gate."""
    app_uuid = uuid.UUID(str(app_id))
    address = custody_address_for(private_key_hex)
    monkeypatch.setenv(env_var, private_key_hex)
    allowlist_custody_ref(app_uuid, env_var)
    onchain.by_fid[fid] = address
    bot = DeveloperAppBot(
        app_id=app_uuid,
        fid=fid,
        custody_address=address,
        custody_key_ref=f"env:{env_var}",
        label=label,
        is_active=True,
        auth_mode="custody_env",
    )
    db.add(bot)
    await db.commit()
    await db.refresh(bot)
    return bot
