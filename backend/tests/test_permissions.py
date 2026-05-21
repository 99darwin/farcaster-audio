from app.services.permission_service import (
    can_publish_audio,
    can_self_mute,
    can_raise_hand,
    can_promote,
    can_demote,
    can_mute_other,
    can_kick,
    can_ban,
    can_set_cohost,
    can_end_room,
    can_start_recording,
)


class TestPermissions:
    def test_publish_audio(self):
        assert can_publish_audio("host") is True
        assert can_publish_audio("co_host") is True
        assert can_publish_audio("speaker") is True
        assert can_publish_audio("listener") is False

    def test_self_mute(self):
        assert can_self_mute("host") is True
        assert can_self_mute("co_host") is True
        assert can_self_mute("speaker") is True
        assert can_self_mute("listener") is False

    def test_raise_hand(self):
        assert can_raise_hand("listener") is True
        assert can_raise_hand("speaker") is False
        assert can_raise_hand("host") is False
        assert can_raise_hand("co_host") is False

    def test_promote(self):
        assert can_promote("host", "listener") is True
        assert can_promote("co_host", "listener") is True
        assert can_promote("speaker", "listener") is False
        assert can_promote("listener", "listener") is False
        assert can_promote("host", "speaker") is False  # Already a speaker

    def test_demote(self):
        assert can_demote("host", "speaker") is True
        assert can_demote("host", "co_host") is True
        assert can_demote("co_host", "speaker") is True
        assert can_demote("co_host", "host") is False  # Cannot demote host
        assert can_demote("speaker", "listener") is False
        assert can_demote("listener", "speaker") is False

    def test_mute_other(self):
        assert can_mute_other("host", "speaker") is True
        assert can_mute_other("host", "co_host") is True
        assert can_mute_other("co_host", "speaker") is True
        assert can_mute_other("co_host", "host") is False  # Cannot mute host
        assert can_mute_other("speaker", "listener") is False
        assert can_mute_other("listener", "speaker") is False

    def test_kick(self):
        assert can_kick("host", "speaker") is True
        assert can_kick("host", "listener") is True
        assert can_kick("co_host", "speaker") is True
        assert can_kick("co_host", "host") is False
        assert can_kick("speaker", "listener") is False

    def test_ban(self):
        assert can_ban("host", "speaker") is True
        assert can_ban("co_host", "speaker") is True
        assert can_ban("co_host", "host") is False
        assert can_ban("speaker", "listener") is False

    def test_set_cohost(self):
        assert can_set_cohost("host") is True
        assert can_set_cohost("co_host") is False
        assert can_set_cohost("speaker") is False
        assert can_set_cohost("listener") is False

    def test_end_room(self):
        assert can_end_room("host") is True
        assert can_end_room("co_host") is True
        assert can_end_room("speaker") is False
        assert can_end_room("listener") is False

    def test_start_recording(self):
        assert can_start_recording("host") is True
        assert can_start_recording("co_host") is True
        assert can_start_recording("speaker") is False
        assert can_start_recording("listener") is False
