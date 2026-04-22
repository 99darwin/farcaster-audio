"""Add recording_key to rooms

Security: stores the stable S3 object key instead of relying solely on the
``recording_url`` field. Lets the user-facing recordings endpoint return a
short-lived presigned GET URL (generated per request) rather than a durable
public URL that could be hotlinked or enumerated.

Revision ID: 015
Revises: 014
Create Date: 2026-04-22
"""

from alembic import op
import sqlalchemy as sa


revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("recording_key", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rooms", "recording_key")
