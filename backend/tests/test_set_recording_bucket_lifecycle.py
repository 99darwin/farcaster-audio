"""Tests for the abort-incomplete-multipart-upload lifecycle script's
pure rule-merging logic."""

from __future__ import annotations

from scripts.set_recording_bucket_lifecycle import (
    RECORDINGS_PREFIX,
    RULE_ID,
    build_abort_mpu_rule,
    merge_lifecycle_rules,
)


def test_build_rule_shape():
    rule = build_abort_mpu_rule(7)
    assert rule["ID"] == RULE_ID
    assert rule["Status"] == "Enabled"
    assert rule["Filter"]["Prefix"] == RECORDINGS_PREFIX
    assert rule["AbortIncompleteMultipartUpload"]["DaysAfterInitiation"] == 7


def test_merge_into_empty_adds_our_rule():
    rules = merge_lifecycle_rules([], 7)
    assert len(rules) == 1
    assert rules[0]["ID"] == RULE_ID


def test_merge_preserves_other_rules():
    other = {"ID": "expire-old-recordings", "Status": "Enabled"}
    rules = merge_lifecycle_rules([other], 7)
    assert other in rules
    assert any(r["ID"] == RULE_ID for r in rules)
    assert len(rules) == 2


def test_merge_is_idempotent_replacing_prior_copy():
    first = merge_lifecycle_rules([], 7)
    # Re-run with a different retention window — must update in place, not
    # append a duplicate.
    second = merge_lifecycle_rules(first, 14)
    ours = [r for r in second if r["ID"] == RULE_ID]
    assert len(ours) == 1
    assert ours[0]["AbortIncompleteMultipartUpload"]["DaysAfterInitiation"] == 14
    assert len(second) == 1


def test_merge_updates_ours_while_keeping_others():
    other = {"ID": "transition-to-ia", "Status": "Enabled"}
    start = merge_lifecycle_rules([other], 7)
    updated = merge_lifecycle_rules(start, 30)
    assert other in updated
    ours = [r for r in updated if r["ID"] == RULE_ID]
    assert len(ours) == 1
    assert ours[0]["AbortIncompleteMultipartUpload"]["DaysAfterInitiation"] == 30
