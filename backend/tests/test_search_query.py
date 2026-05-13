"""Unit tests for the cast-query operator parser."""

from datetime import date

from app.services.search_query import parse_cast_query


def test_from_operator_with_trailing_text():
    parsed = parse_cast_query("from:dwr juke audio")
    assert parsed.author_username == "dwr"
    assert parsed.text == "juke audio"
    assert parsed.before is None
    assert parsed.after is None


def test_quoted_phrase_preserved_verbatim():
    parsed = parse_cast_query('"exact phrase"')
    assert parsed.text == '"exact phrase"'
    assert parsed.author_username is None


def test_from_operator_combined_with_quoted_phrase():
    parsed = parse_cast_query('from:dwr "exact phrase"')
    assert parsed.author_username == "dwr"
    assert parsed.text == '"exact phrase"'


def test_before_and_after_with_text():
    parsed = parse_cast_query("before:2026-01-01 after:2025-01-01 hello")
    assert parsed.before == date(2026, 1, 1)
    assert parsed.after == date(2025, 1, 1)
    assert parsed.text == "hello"


def test_operators_are_case_insensitive():
    parsed = parse_cast_query("From:DWR")
    assert parsed.author_username == "dwr"
    assert parsed.text == ""


def test_empty_from_value_is_ignored():
    # "from: " — operator with no value should be dropped silently.
    parsed = parse_cast_query("from: hello world")
    assert parsed.author_username is None
    assert parsed.text == "hello world"


def test_bad_date_left_as_literal_text():
    parsed = parse_cast_query("before:notadate hello")
    assert parsed.before is None
    # The literal "before:notadate" stays in the text portion so upstream
    # search can at least try to match it.
    assert "before:notadate" in parsed.text
    assert "hello" in parsed.text


def test_plain_text_passes_through_unchanged():
    parsed = parse_cast_query("just a regular query")
    assert parsed.author_username is None
    assert parsed.before is None
    assert parsed.after is None
    assert parsed.text == "just a regular query"


def test_multiple_spaces_are_collapsed_in_residual_text():
    parsed = parse_cast_query("from:dwr    juke     audio")
    assert parsed.author_username == "dwr"
    assert parsed.text == "juke audio"


def test_from_username_strips_leading_at_and_lowercases():
    parsed = parse_cast_query("from:@DWR hello")
    assert parsed.author_username == "dwr"
    assert parsed.text == "hello"


def test_unmatched_trailing_quote_is_literal():
    # Token "hello — the parser should treat it as a literal rather than
    # raising.
    parsed = parse_cast_query('hello "world')
    assert parsed.author_username is None
    assert "hello" in parsed.text
    assert '"world' in parsed.text


def test_operators_can_appear_anywhere_in_string():
    parsed = parse_cast_query("hello from:dwr world before:2026-01-01")
    assert parsed.author_username == "dwr"
    assert parsed.before == date(2026, 1, 1)
    assert parsed.text == "hello world"
