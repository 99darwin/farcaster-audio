"""Set the S3/Tigris bucket lifecycle rule that aborts incomplete
multipart uploads left behind by crashed recording workers.

Background: the recording worker checkpoints encoded audio as multipart
parts during recording (see ``recording_agent/worker.mjs``). A graceful
stop completes or aborts the upload; a hard crash leaves it *incomplete*.
Backend recovery (``StorageService.complete_orphaned_multipart_upload``)
completes those that map to a known orphaned recording — but an upload
that's never recovered would linger forever and accrue storage cost.

This installs a lifecycle rule that aborts incomplete multipart uploads
under the ``recordings/`` prefix N days after initiation (default 7),
giving recovery a comfortable window while bounding cost. Run once per
environment; it's idempotent (upserts a rule by a stable ID and preserves
any other lifecycle rules already on the bucket).

Usage:

    cd backend
    # uses the same AWS_* settings the app + worker use
    python -m scripts.set_recording_bucket_lifecycle

    # custom retention window / dry run:
    ABORT_INCOMPLETE_MPU_DAYS=14 python -m scripts.set_recording_bucket_lifecycle
    LIFECYCLE_DRY_RUN=1 python -m scripts.set_recording_bucket_lifecycle

Inputs (env):
    ABORT_INCOMPLETE_MPU_DAYS   Days after initiation to abort an
                                incomplete multipart upload (default 7).
    LIFECYCLE_DRY_RUN           If set/truthy, print the rule set that
                                would be applied and exit without writing.
"""

from __future__ import annotations

import json
import os
import sys

import boto3
from botocore.exceptions import ClientError

from app.config import settings

RULE_ID = "abort-incomplete-recording-multipart-uploads"
RECORDINGS_PREFIX = "recordings/"
DEFAULT_ABORT_DAYS = 7


def build_abort_mpu_rule(days: int, prefix: str = RECORDINGS_PREFIX) -> dict:
    """Build the lifecycle rule that aborts incomplete multipart uploads."""
    return {
        "ID": RULE_ID,
        "Status": "Enabled",
        "Filter": {"Prefix": prefix},
        "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": days},
    }


def merge_lifecycle_rules(
    existing_rules: list[dict], days: int, prefix: str = RECORDINGS_PREFIX
) -> list[dict]:
    """Upsert our abort-MPU rule into ``existing_rules`` by ``RULE_ID``.

    Any rule we didn't author is preserved untouched — we only replace a
    prior copy of our own rule so re-runs are idempotent and we never
    clobber expiration/transition rules someone else configured.
    """
    preserved = [r for r in existing_rules if r.get("ID") != RULE_ID]
    return [*preserved, build_abort_mpu_rule(days, prefix)]


def _get_existing_rules(client, bucket: str) -> list[dict]:
    try:
        resp = client.get_bucket_lifecycle_configuration(Bucket=bucket)
        return list(resp.get("Rules", []))
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        # First-time setup: no lifecycle config yet is the normal case.
        if code in ("NoSuchLifecycleConfiguration", "404", "NoSuchConfiguration"):
            return []
        raise


def main() -> int:
    bucket = settings.AWS_S3_BUCKET_NAME
    if not bucket:
        print("AWS_S3_BUCKET_NAME is not set — refusing to run.", file=sys.stderr)
        return 1

    try:
        days = int(os.environ.get("ABORT_INCOMPLETE_MPU_DAYS", DEFAULT_ABORT_DAYS))
    except ValueError:
        print("ABORT_INCOMPLETE_MPU_DAYS must be an integer.", file=sys.stderr)
        return 1
    if days < 1:
        print("ABORT_INCOMPLETE_MPU_DAYS must be >= 1.", file=sys.stderr)
        return 1

    dry_run = bool(os.environ.get("LIFECYCLE_DRY_RUN"))

    client = boto3.client(
        "s3",
        endpoint_url=settings.AWS_ENDPOINT_URL,
        aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
        aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
        region_name=settings.AWS_DEFAULT_REGION,
    )

    existing = _get_existing_rules(client, bucket)
    rules = merge_lifecycle_rules(existing, days)

    print(f"bucket={bucket} endpoint={settings.AWS_ENDPOINT_URL or '<aws default>'}")
    print(f"existing rules: {len(existing)} | abort-incomplete-MPU after {days} day(s)")
    print(json.dumps({"Rules": rules}, indent=2, default=str))

    if dry_run:
        print("LIFECYCLE_DRY_RUN set — not writing.")
        return 0

    try:
        client.put_bucket_lifecycle_configuration(
            Bucket=bucket,
            LifecycleConfiguration={"Rules": rules},
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        print(
            f"Failed to set lifecycle configuration (code={code}): {exc}",
            file=sys.stderr,
        )
        print(
            "If the provider doesn't support AbortIncompleteMultipartUpload "
            "lifecycle rules, configure an equivalent in its dashboard instead.",
            file=sys.stderr,
        )
        return 1

    print("Lifecycle configuration applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
