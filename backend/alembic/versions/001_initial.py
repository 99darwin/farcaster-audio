"""Initial schema — users, rooms, participants, bans

Revision ID: 001
Revises:
Create Date: 2026-03-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic
revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # users
    # ------------------------------------------------------------------
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("signer_uuid", sa.String(128), nullable=False),
        sa.Column("username", sa.String(64), nullable=True),
        sa.Column("display_name", sa.String(256), nullable=True),
        sa.Column("pfp_url", sa.Text(), nullable=True),
        sa.Column("custody_address", sa.String(42), nullable=True),
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
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("fid", name="uq_users_fid"),
    )
    op.create_index("ix_users_fid", "users", ["fid"], unique=True)

    # ------------------------------------------------------------------
    # rooms
    # ------------------------------------------------------------------
    op.create_table(
        "rooms",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("host_fid", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("livekit_room_id", sa.String(128), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_speakers", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("max_listeners", sa.Integer(), nullable=False, server_default="500"),
        sa.Column("recording", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("recording_url", sa.Text(), nullable=True),
        sa.Column("cast_hash", sa.String(66), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["host_fid"],
            ["users.fid"],
            name="fk_rooms_host_fid",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_rooms_status", "rooms", ["status"])
    op.create_index("ix_rooms_host_fid", "rooms", ["host_fid"])
    op.create_index(
        "ix_rooms_started_at_desc",
        "rooms",
        ["started_at"],
        postgresql_ops={"started_at": "DESC"},
    )

    # ------------------------------------------------------------------
    # participants
    # ------------------------------------------------------------------
    op.create_table(
        "participants",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("fid", sa.BigInteger(), nullable=False),
        sa.Column("role", sa.String(20), nullable=False, server_default="listener"),
        sa.Column("is_muted", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("hand_raised", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("hand_raised_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name="fk_participants_room_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["fid"],
            ["users.fid"],
            name="fk_participants_fid",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("room_id", "fid", name="uq_participants_room_fid"),
    )
    op.create_index("ix_participants_room_id", "participants", ["room_id"])
    op.create_index(
        "ix_participants_room_id_active",
        "participants",
        ["room_id"],
        postgresql_where=sa.text("left_at IS NULL"),
    )

    # ------------------------------------------------------------------
    # bans
    # ------------------------------------------------------------------
    op.create_table(
        "bans",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("room_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("banned_fid", sa.BigInteger(), nullable=False),
        sa.Column("banned_by_fid", sa.BigInteger(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["rooms.id"],
            name="fk_bans_room_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["banned_fid"],
            ["users.fid"],
            name="fk_bans_banned_fid",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["banned_by_fid"],
            ["users.fid"],
            name="fk_bans_banned_by_fid",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("room_id", "banned_fid", name="uq_bans_room_banned_fid"),
    )
    op.create_index("ix_bans_room_banned_fid", "bans", ["room_id", "banned_fid"])
    op.create_index("ix_bans_banned_fid", "bans", ["banned_fid"])


def downgrade() -> None:
    op.drop_table("bans")
    op.drop_table("participants")
    op.drop_table("rooms")
    op.drop_table("users")
