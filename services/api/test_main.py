import asyncio
import main


class FakeWebSocket:
    def __init__(self, user_id, messages=()):
        self.user_id = user_id
        self.messages = list(messages)
        self.sent = []
        self.closed = None

    async def accept(self):
        pass

    async def close(self, code=1000, reason=None):
        self.closed = code

    async def send_json(self, payload):
        self.sent.append(payload)

    async def receive_json(self):
        if self.messages:
            return self.messages.pop(0)
        raise main.WebSocketDisconnect()


def run_socket(room, user_id, messages, username="Test"):
    socket = FakeWebSocket(user_id, messages)
    existing = room.participants.get(user_id)
    if existing is not None:
        socket = existing.websocket
        socket.messages = list(messages)
        room.participants.pop(user_id)
    asyncio.run(main.room_socket(socket, room.room_id, user_id, username))
    return socket


def setup_function():
    main.rooms.clear()


def test_pause_resume_keeps_playback_position():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    run_socket(room, "host", [
        {"type": "pause", "payload": {"time": 31.5}},
        {"type": "play", "payload": {"time": 31.5}},
    ])
    assert room.current_time == 31.5
    assert room.play_state == "playing"


def test_seek_broadcasts_authoritative_position():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    socket = run_socket(room, "host", [{"type": "seek", "payload": {"time": 75}}])
    assert room.current_time == 75
    assert any(m.get("type") == "sync_state" and m["state"]["currentTime"] == 75 for m in socket.sent)


def test_participant_cannot_control_playback():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    socket = run_socket(room, "guest", [{"type": "play", "payload": {"time": 20}}])
    assert room.play_state == "paused"
    assert any(m.get("type") == "error" for m in socket.sent)


def test_new_participant_receives_video_position_and_play_state():
    room = main.Room("ROOM", "host", video_id="abcdefghijk", play_state="playing", current_time=42.25)
    main.rooms[room.room_id] = room
    socket = run_socket(room, "guest", [])
    snapshot = next(m["state"] for m in socket.sent if m.get("type") == "sync_state")
    assert (snapshot["videoId"], snapshot["currentTime"], snapshot["playState"]) == ("abcdefghijk", 42.25, "playing")


def test_disconnected_host_can_reconnect_without_losing_room_state():
    room = main.Room("ROOM", "host", video_id="abcdefghijk", play_state="playing", current_time=19)
    main.rooms[room.room_id] = room
    run_socket(room, "host", [])

    assert main.rooms[room.room_id] is room
    socket = run_socket(room, "host", [])
    snapshot = next(item["state"] for item in socket.sent if item.get("type") == "sync_state")
    assert snapshot["videoId"] == "abcdefghijk"
    assert snapshot["playState"] == "playing"
    assert snapshot["currentTime"] == 19


def test_duplicate_live_connection_is_rejected_with_safe_reason(caplog):
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    existing = FakeWebSocket("host")
    room.participants["host"] = main.Participant("host", "Host", "host", existing)
    duplicate = FakeWebSocket("host")

    asyncio.run(main.room_socket(duplicate, room.room_id, "host", "Host"))

    assert duplicate.closed == 4009
    assert "reason=duplicate_connection" in caplog.text
    assert room.participants["host"].websocket is existing


def test_malformed_playback_and_video_payloads_are_rejected():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    socket = run_socket(room, "host", [
        {"type": "pause", "payload": {"time": True}},
        {"type": "change_video", "payload": {"videoId": "bad"}},
    ])
    assert room.current_time == 0
    assert room.video_id == "jfKfPfyJRdk"
    assert sum(m.get("type") == "error" for m in socket.sent) == 2
    assert not any(
        message.get("type") == "sync_state"
        and message["state"]["currentTime"] == 1
        for message in socket.sent
    )


def test_invalid_seek_values_leave_state_unchanged():
    room = main.Room("ROOM", "host", current_time=12.5)
    main.rooms[room.room_id] = room
    socket = run_socket(room, "host", [
        {"type": "seek", "payload": {"time": True}},
        {"type": "pause", "payload": {"time": "24"}},
        {"type": "play", "payload": {"time": 86401}},
    ])
    assert room.current_time == 12.5
    assert room.play_state == "paused"
    assert sum(message.get("type") == "error" for message in socket.sent) == 3


def test_video_id_validation_rejects_wrong_length_and_type():
    assert main.valid_video_id("abcdefghijk")
    assert not main.valid_video_id("bad")
    assert not main.valid_video_id(12345678901)


def test_chat_broadcasts_trimmed_message_with_server_identity_and_timestamp():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    peer_socket = FakeWebSocket("peer")
    room.participants["peer"] = main.Participant("peer", "Peer", "participant", peer_socket)
    socket = run_socket(room, "host", [
        {"type": "chat_message", "payload": {"text": "  hello room  ", "username": "Impersonator"}},
    ], username="Actual Host")

    for recipient in (socket, peer_socket):
        message = next(item["message"] for item in recipient.sent if item.get("type") == "chat_message")
        assert message["username"] == "Actual Host"
        assert message["text"] == "hello room"
        assert message["userId"] == "host"
        assert message["timestamp"]


def test_chat_rejects_empty_and_oversized_messages_without_broadcast():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    peer_socket = FakeWebSocket("peer")
    room.participants["peer"] = main.Participant("peer", "Peer", "participant", peer_socket)
    socket = run_socket(room, "host", [
        {"type": "chat_message", "payload": {"text": "   "}},
        {"type": "chat_message", "payload": {"text": "x" * 501}},
    ])

    assert not any(item.get("type") == "chat_message" for item in socket.sent + peer_socket.sent)
    assert sum(item.get("type") == "error" for item in socket.sent) == 2


def test_chat_broadcast_is_limited_to_connected_members_of_its_room():
    room = main.Room("ROOM", "host")
    other_room = main.Room("OTHER", "other")
    main.rooms.update({room.room_id: room, other_room.room_id: other_room})
    in_room_socket = FakeWebSocket("peer")
    other_socket = FakeWebSocket("other")
    room.participants["peer"] = main.Participant("peer", "Peer", "participant", in_room_socket)
    other_room.participants["other"] = main.Participant("other", "Other", "host", other_socket)

    run_socket(room, "host", [{"type": "chat_message", "payload": {"text": "room only"}}])

    assert any(item.get("type") == "chat_message" for item in in_room_socket.sent)
    assert not any(item.get("type") == "chat_message" for item in other_socket.sent)


def test_valid_reaction_is_server_identified_and_room_scoped():
    room = main.Room("ROOM", "host")
    other = main.Room("OTHER", "other")
    main.rooms.update({room.room_id: room, other.room_id: other})
    peer = FakeWebSocket("peer")
    outsider = FakeWebSocket("elsewhere")
    room.participants["peer"] = main.Participant("peer", "Peer", "participant", peer)
    other.participants["elsewhere"] = main.Participant("elsewhere", "Other", "host", outsider)
    host = run_socket(room, "host", [{"type": "reaction", "payload": {"emoji": "🔥", "username": "spoof"}}], "Real Host")
    reaction = next(item["reaction"] for item in peer.sent if item.get("type") == "reaction_update")
    assert reaction["username"] == "Real Host"
    assert reaction["userId"] == "host"
    assert reaction["emoji"] == "🔥"
    assert not any(item.get("type") == "reaction_update" for item in outsider.sent)
    assert not any(item.get("type") == "sync_state" for item in host.sent[1:])


def test_invalid_and_rate_limited_reactions_do_not_broadcast():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    peer = FakeWebSocket("peer")
    room.participants["peer"] = main.Participant("peer", "Peer", "participant", peer)
    host = run_socket(room, "host", [
        {"type": "reaction", "payload": {"emoji": "💣"}},
        {"type": "reaction", "payload": {"emoji": "👏"}},
        {"type": "reaction", "payload": {"emoji": "👏"}},
    ])
    assert sum(item.get("type") == "error" for item in host.sent) == 2
    assert sum(item.get("type") == "reaction_update" for item in peer.sent) == 1


def test_reaction_echoes_client_event_id_for_animation_deduplication():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    event_id = "react-123456"
    socket = run_socket(room, "host", [{
        "type": "reaction",
        "payload": {"emoji": "\U0001F525", "eventId": event_id},
    }])
    event = next(item for item in socket.sent if item.get("type") == "reaction_update")
    assert event["reaction"]["id"] == event_id
    assert event["reaction"]["emoji"] == "\U0001F525"


def test_queue_add_update_and_privileged_actions():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    guest = FakeWebSocket("guest")
    room.participants["guest"] = main.Participant("guest", "Guest", "participant", guest)
    socket = run_socket(room, "host", [{"type": "queue_add", "payload": {"videoId": "abcdefghijk"}}])
    assert len(room.queue) == 1
    entry = room.queue[0]
    assert entry["username"] == "Test"
    assert any(item.get("type") == "queue_update" and item["queue"] == room.queue for item in guest.sent)
    guest_socket = run_socket(room, "guest", [{"type": "queue_remove", "payload": {"entryId": entry["entryId"]}}])
    assert room.queue
    assert any(item.get("type") == "error" for item in guest_socket.sent)
    run_socket(room, "host", [{"type": "queue_play", "payload": {"entryId": entry["entryId"]}}])
    assert room.video_id == "abcdefghijk"
    assert room.play_state == "playing"
    assert room.current_time == 0
    assert room.queue == []


def test_queue_rejects_invalid_video_ids_and_is_room_scoped():
    first = main.Room("FIRST", "host")
    second = main.Room("SECOND", "second")
    main.rooms.update({first.room_id: first, second.room_id: second})
    peer = FakeWebSocket("peer")
    second.participants["peer"] = main.Participant("peer", "Peer", "participant", peer)
    host = run_socket(first, "host", [{"type": "queue_add", "payload": {"videoId": "https://youtube.com/watch?v=bad"}}])
    assert first.queue == []
    assert any(item.get("type") == "error" for item in host.sent)
    assert not any(item.get("type") == "queue_update" for item in peer.sent)


def test_typing_events_broadcast_without_identity_spoof_and_disconnect_cleans_up():
    room = main.Room("ROOM", "host")
    main.rooms[room.room_id] = room
    peer = FakeWebSocket("peer")
    room.participants["peer"] = main.Participant("peer", "Peer", "participant", peer)
    host = run_socket(room, "host", [
        {"type": "typing_start", "payload": {"username": "spoof"}},
    ], "Real Host")
    update = next(item for item in peer.sent if item.get("type") == "typing_update")
    assert update["typing"] == [{"userId": "host", "username": "Real Host"}]
    assert not room.participants.get("host")
    assert any(item.get("type") == "typing_update" and item["typing"] == [] for item in peer.sent)


def test_malformed_event_payload_does_not_change_room_state():
    room = main.Room("ROOM", "host", current_time=12.5)
    main.rooms[room.room_id] = room
    socket = run_socket(room, "host", [
        {"type": "reaction", "payload": "🔥"},
        {"type": "queue_add", "payload": {"videoId": 123}},
        {"type": "typing_stop", "payload": {"userId": "host"}},
    ])
    assert room.current_time == 12.5
    assert room.queue == []
    assert sum(item.get("type") == "error" for item in socket.sent) == 3
