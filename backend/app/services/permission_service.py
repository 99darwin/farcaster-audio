"""
Permission service — pure functions enforcing the role-based permission matrix.
No DB or external service calls. All functions take roles as strings.
"""

ROLE_HIERARCHY = {
    "host": 4,
    "co_host": 3,
    "speaker": 2,
    "listener": 1,
}


def _role_level(role: str) -> int:
    return ROLE_HIERARCHY.get(role, 0)


def can_publish_audio(role: str) -> bool:
    return role in ("host", "co_host", "speaker")


def can_self_mute(role: str) -> bool:
    return role in ("host", "co_host", "speaker")


def can_raise_hand(role: str) -> bool:
    return role == "listener"


def can_promote(actor_role: str, target_role: str) -> bool:
    """Can actor promote target to speaker?"""
    if actor_role not in ("host", "co_host"):
        return False
    # Can only promote listeners
    return target_role == "listener"


def can_demote(actor_role: str, target_role: str) -> bool:
    """Can actor demote target to listener?"""
    if actor_role not in ("host", "co_host"):
        return False
    # Co-host cannot demote host
    if actor_role == "co_host" and target_role == "host":
        return False
    # Can demote speakers and co_hosts (host can demote co_host)
    return target_role in ("speaker", "co_host") or (actor_role == "host" and target_role == "co_host")


def can_mute_other(actor_role: str, target_role: str) -> bool:
    """Can actor mute target?"""
    if actor_role not in ("host", "co_host"):
        return False
    if actor_role == "co_host" and target_role == "host":
        return False
    return True


def can_kick(actor_role: str, target_role: str) -> bool:
    """Can actor kick target?"""
    if actor_role not in ("host", "co_host"):
        return False
    if actor_role == "co_host" and target_role == "host":
        return False
    return True


def can_ban(actor_role: str, target_role: str) -> bool:
    """Can actor ban target?"""
    if actor_role not in ("host", "co_host"):
        return False
    if actor_role == "co_host" and target_role == "host":
        return False
    return True


def can_set_cohost(actor_role: str) -> bool:
    """Can actor set someone as co-host?"""
    return actor_role == "host"


def can_end_room(actor_role: str) -> bool:
    """Can actor end the room?"""
    return actor_role in ("host", "co_host")


def can_start_recording(actor_role: str) -> bool:
    """Can actor start/stop recording?"""
    return actor_role in ("host", "co_host")
