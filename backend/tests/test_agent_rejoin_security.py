"""SECURITY (L7, L11b): agent session-token rejoin + agent-join logging.

The X-Session-Token rejoin paths must go through
``RoomService.join_room_as_agent`` so the per-room agent cap, ban check,
``allow_agents`` flag and ``is_agent`` token metadata all apply — the
generic ``join_room`` skipped them. The public agent-join handler must
also stop logging ``request.state`` attribute names at INFO.
"""

from __future__ import annotations

import inspect

import pytest

from app.routers import developer, participants


def _rejoin_block(source: str) -> str:
    start = source.index('request.headers.get("x-session-token")')
    end = source.index("finally:", start)
    return source[start:end]


@pytest.mark.parametrize(
    ("module", "handler_name"),
    [
        (participants, "agent_join_room"),
        (developer, "partner_agent_join_room"),
    ],
)
def test_session_rejoin_uses_agent_join_path(module, handler_name):
    handler = getattr(module, handler_name)
    block = _rejoin_block(inspect.getsource(handler))
    assert "join_room_as_agent(" in block
    assert "svc.join_room(" not in block
    assert "agent_fid=session.agent_fid" in block
    assert "agent_name=session.agent_name" in block


def test_agent_join_does_not_log_request_state():
    source = inspect.getsource(participants)
    assert "request.state: %s" not in source
    assert "vars(request.state)" not in source
