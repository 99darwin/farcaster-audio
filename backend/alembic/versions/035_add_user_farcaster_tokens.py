"""Direct Casts: user_farcaster_tokens table.

Holds each user's custody-minted ``client.farcaster.xyz`` bearer (AES-GCM
encrypted with ``SIGNER_ENCRYPTION_KEY``), exchanged from a device-signed
``generateToken`` request. See docs/messaging-design.md section 2.

Revision ID: 035
Revises: 034
Create Date: 2026-10-16
"""

from alembic import op
import sqlalchemy as sa

revision = "035"
down_revision = "034"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_farcaster_tokens",
        sa.Column("fid", sa.BigInteger(), primary_key=True),
        sa.Column("encrypted_token", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("user_farcaster_tokens")
