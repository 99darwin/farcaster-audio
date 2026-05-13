"""Operator-aware parser for the global cast search query string.

Pure, no I/O. The router uses this to extract Twitter/X-style filters
(`from:user`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`) plus a remaining
free-text portion that preserves double-quoted phrases verbatim.

Design notes
------------
- Operators are recognised case-insensitively (e.g. ``From:DWR``).
- ``from:`` with no value, or a date operator with a malformed date, is
  passed through as a literal token rather than raising — the parser is
  tolerant by design because users will type imperfectly.
- Quoted phrases (``"juke audio"``) are kept intact inside the residual
  text. An unmatched trailing quote is treated as a literal character.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Iterator

from pydantic import BaseModel


class ParsedCastQuery(BaseModel):
    """Parsed components of a free-text cast search query."""

    author_username: str | None = None
    before: date | None = None
    after: date | None = None
    text: str = ""


# Tokeniser: emit quoted phrases (including the surrounding quotes) as a
# single token; everything else splits on whitespace runs.
_TOKEN_RE = re.compile(r'"[^"]*"?|\S+')

# Operator detection — case-insensitive prefix match, captures the literal
# value after the colon. The value can be empty (handled downstream).
_OPERATOR_RE = re.compile(r"^(?P<op>from|before|after):(?P<value>.*)$", re.IGNORECASE)


def _tokenize(q: str) -> Iterator[str]:
    """Yield tokens; quoted phrases stay glued together."""
    for match in _TOKEN_RE.finditer(q):
        yield match.group(0)


def _try_parse_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def parse_cast_query(q: str) -> ParsedCastQuery:
    """Split ``q`` into structured operators plus a residual text query.

    Operators recognised: ``from:<username>``, ``before:YYYY-MM-DD``,
    ``after:YYYY-MM-DD``. Malformed/empty operator values are left in the
    free-text portion so the upstream search can still try to match them.
    """
    author_username: str | None = None
    before: date | None = None
    after: date | None = None
    residual: list[str] = []

    for token in _tokenize(q):
        # Quoted phrases never participate in operator parsing.
        if token.startswith('"'):
            residual.append(token)
            continue

        match = _OPERATOR_RE.match(token)
        if not match:
            residual.append(token)
            continue

        op = match.group("op").lower()
        value = match.group("value").strip()

        if not value:
            # Empty operator value (e.g. "from:") — ignore silently.
            continue

        if op == "from" and author_username is None:
            author_username = value.lstrip("@").lower()
            continue

        if op in ("before", "after"):
            parsed = _try_parse_date(value)
            if parsed is None:
                # Leave the literal token in residual text so upstream search
                # gets a chance at it (and tests can assert on it).
                residual.append(token)
                continue
            if op == "before" and before is None:
                before = parsed
            elif op == "after" and after is None:
                after = parsed
            continue

        # Operator recognised but already populated — keep the token as text
        # rather than dropping it on the floor.
        residual.append(token)

    text = " ".join(residual).strip()
    return ParsedCastQuery(
        author_username=author_username,
        before=before,
        after=after,
        text=text,
    )
