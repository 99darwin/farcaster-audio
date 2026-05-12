"""Add developer API keys

Revision ID: 019
Revises: 018
Create Date: 2026-05-11
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "019"
down_revision = "018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "developer_access_status",
            sa.String(length=20),
            server_default="none",
            nullable=False,
        ),
    )
    op.create_index(
        "ix_users_developer_access_status",
        "users",
        ["developer_access_status"],
    )
    op.create_check_constraint(
        "ck_users_developer_access_status",
        "users",
        "developer_access_status IN ('none', 'pending', 'approved', 'suspended')",
    )

    op.create_table(
        "developer_apps",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_fid", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("website_url", sa.String(length=500), nullable=True),
        sa.Column(
            "allowed_origins",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default="active",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_fid"], ["users.fid"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "status IN ('active', 'suspended', 'deleted')",
            name="ck_developer_apps_status",
        ),
    )
    op.create_index("ix_developer_apps_owner_fid", "developer_apps", ["owner_fid"])
    op.create_index(
        "ix_developer_apps_owner_status",
        "developer_apps",
        ["owner_fid", "status"],
    )

    op.create_table(
        "developer_applications",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("project_name", sa.String(length=120), nullable=False),
        sa.Column("website_url", sa.String(length=500), nullable=True),
        sa.Column("use_case", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default="pending",
            nullable=False,
        ),
        sa.Column("reviewed_by_fid", sa.BigInteger(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["fid"], ["users.fid"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'suspended')",
            name="ck_developer_applications_status",
        ),
    )
    op.create_index(
        "ix_developer_applications_fid", "developer_applications", ["fid"]
    )
    op.create_index(
        "ix_developer_applications_status", "developer_applications", ["status"]
    )

    op.create_table(
        "developer_api_keys",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("app_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("key_id", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("public_key_hash", sa.String(length=64), nullable=False),
        sa.Column("secret_key_hash", sa.String(length=64), nullable=False),
        sa.Column("encrypted_secret_once", sa.Text(), nullable=True),
        sa.Column("reveal_token_hash", sa.String(length=64), nullable=True),
        sa.Column("reveal_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revealed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rotated_from_key_id", sa.String(length=32), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["app_id"], ["developer_apps.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "public_key_hash", name="uq_developer_api_keys_public_hash"
        ),
        sa.UniqueConstraint(
            "secret_key_hash", name="uq_developer_api_keys_secret_hash"
        ),
        sa.UniqueConstraint("key_id"),
    )
    op.create_index("ix_developer_api_keys_app_id", "developer_api_keys", ["app_id"])
    op.create_index("ix_developer_api_keys_key_id", "developer_api_keys", ["key_id"])


def downgrade() -> None:
    op.drop_index("ix_developer_api_keys_key_id", table_name="developer_api_keys")
    op.drop_index("ix_developer_api_keys_app_id", table_name="developer_api_keys")
    op.drop_table("developer_api_keys")
    op.drop_index(
        "ix_developer_applications_status", table_name="developer_applications"
    )
    op.drop_index("ix_developer_applications_fid", table_name="developer_applications")
    op.drop_table("developer_applications")
    op.drop_index("ix_developer_apps_owner_status", table_name="developer_apps")
    op.drop_index("ix_developer_apps_owner_fid", table_name="developer_apps")
    op.drop_table("developer_apps")
    op.drop_constraint("ck_users_developer_access_status", "users", type_="check")
    op.drop_index("ix_users_developer_access_status", table_name="users")
    op.drop_column("users", "developer_access_status")
