"""Device tokens unique per token; widen developer webhook secrets.

- ``device_tokens``: an Expo push token identifies one device, so it may
  belong to only one fid (latest registration wins). Duplicates across
  fids are collapsed to the most recently updated row, then
  ``(fid, expo_push_token)`` uniqueness is replaced by ``expo_push_token``.
- ``developer_webhooks.secret``: VARCHAR(128) -> TEXT so it can hold the
  AES-GCM blob (``v1:``/``v2:<kid>:`` + base64). Existing plaintext
  ``whsec_`` rows are re-encrypted by the app at startup
  (``dev_webhook_service.encrypt_legacy_secrets``), not here, because the
  key lives only in the app environment.

Revision ID: 039
Revises: 038
Create Date: 2026-10-17
"""

from alembic import op
import sqlalchemy as sa

revision = "039"
down_revision = "038"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Keep one row per token: newest updated_at, ties broken by highest id.
    op.execute(
        """
        DELETE FROM device_tokens
        WHERE id IN (
            SELECT id FROM (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY expo_push_token
                        ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST,
                                 id DESC
                    ) AS rank
                FROM device_tokens
            ) ranked
            WHERE ranked.rank > 1
        )
        """
    )
    op.drop_constraint("uq_device_tokens_fid_token", "device_tokens", type_="unique")
    op.create_unique_constraint(
        "uq_device_tokens_token", "device_tokens", ["expo_push_token"]
    )

    op.alter_column(
        "developer_webhooks",
        "secret",
        existing_type=sa.String(128),
        type_=sa.Text(),
        existing_nullable=False,
    )


def downgrade() -> None:
    # The secret column stays TEXT: narrowing would truncate encrypted
    # blobs. (Code from before 039 cannot read encrypted secrets anyway.)
    op.drop_constraint("uq_device_tokens_token", "device_tokens", type_="unique")
    op.create_unique_constraint(
        "uq_device_tokens_fid_token", "device_tokens", ["fid", "expo_push_token"]
    )
