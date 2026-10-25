
import asyncio
import json
import logging
import re
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, field_validator


Role = Literal["host", "moderator", "participant"]
CONTROL_ROLES = {"host", "moderator"}


@dataclass
class Participant:
    user_id: str
    username: str
    role: Role
    websocket: WebSocket
    last_reaction: float = 0.0
    last_queue_add: float = 0.0
    typing: bool = False


@dataclass
class Room:
    room_id: str
    host_id: str
    video_id: str = "jfKfPfyJRdk"
    play_state: Literal["playing", "paused"] = "paused"
    current_time: float = 0.0
    participants: dict[str, Participant] = field(default_factory=dict)
    queue: list[dict] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


rooms: dict[str, Room] = {}
logger = logging.getLogger("syncscreen.websocket")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    rooms.clear()


app = FastAPI(
    title="SyncScreen API",
    description="Real-time YouTube Watch Party backend",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
    "http://localhost:3000",
    "https://sync-screen.vercel.app",
	],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateRoomRequest(BaseModel):
    username: str = Field(min_length=1, max_length=30)


class JoinRoomRequest(BaseModel):
    username: str = Field(min_length=1, max_length=30)


class AssignRoleRequest(BaseModel):
    actor_id: str
    user_id: str
    role: Literal["moderator", "participant"]


class RemoveParticipantRequest(BaseModel):
    actor_id: str
    user_id: str


class PlaybackPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    time: StrictFloat | StrictInt | None = Field(
        default=None, ge=0, le=86400, allow_inf_nan=False
    )

    @field_validator("time", mode="before")
    @classmethod
    def reject_boolean_time(cls, value: object) -> object:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Playback time must be a number.")
        return value


class VideoPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    videoId: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")


class ChatPayload(BaseModel):
    # Older clients may include a username, but identity always comes from
    # the validated room connection below.
    model_config = ConfigDict(extra="ignore")
    text: str = Field(min_length=1, max_length=500)

    @field_validator("text")
    @classmethod
    def trim_and_reject_empty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Chat messages cannot be empty.")
        return value


class ReactionPayload(BaseModel):
    # Ignore legacy display-name fields; never use them as sender identity.
    model_config = ConfigDict(extra="ignore")
    emoji: Literal["❤️", "😂", "🔥", "👏", "😮"]
    eventId: str | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class QueueAddPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    videoId: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")


class QueueEntryPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entryId: str = Field(min_length=1, max_length=32)


def public_participants(room: Room):
    return [
        {
            "userId": p.user_id,
            "username": p.username,
            "role": p.role,
        }
        for p in room.participants.values()
    ]


async def send_json(websocket: WebSocket, payload: dict):
    await websocket.send_json(payload)


async def broadcast(room: Room, payload: dict):
    disconnected = []

    for user_id, participant in list(room.participants.items()):
        try:
            await send_json(participant.websocket, payload)
        except Exception:
            disconnected.append(user_id)

    for user_id in disconnected:
        room.participants.pop(user_id, None)


def room_snapshot(room: Room):
    return {
        "roomId": room.room_id,
        "videoId": room.video_id,
        "playState": room.play_state,
        "currentTime": room.current_time,
        "participants": public_participants(room),
        "queue": [dict(entry) for entry in room.queue],
    }


def valid_video_id(value: str) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]{11}", value))


async def broadcast_queue(room: Room):
    await broadcast(room, {"type": "queue_update", "queue": [dict(entry) for entry in room.queue]})


@app.get("/")
async def root():
    return {
        "message": "Welcome to SyncScreen API",
        "status": "running",
        "docs": "/docs",
        "health": "/health",
    }


@app.get("/health")
async def health():
    return {"status": "healthy", "application": "SyncScreen"}


@app.post("/api/rooms")
async def create_room(request: CreateRoomRequest):
    username = request.username.strip()
    if not username:
        return {"error": "Username cannot be empty"}

    room_id = secrets.token_urlsafe(6).replace("-", "A").replace("_", "B")[:8].upper()
    user_id = secrets.token_urlsafe(12)

    # A room is registered before its creator connects by WebSocket.
    room = Room(room_id=room_id, host_id=user_id)
    rooms[room_id] = room

    return {
        "roomId": room_id,
        "userId": user_id,
        "username": username,
        "role": "host",
        "joinUrl": f"/room/{room_id}",
    }


@app.post("/api/rooms/{room_id}/join")
async def join_room(room_id: str, request: JoinRoomRequest):
    room = rooms.get(room_id.upper())
    if room is None:
        return {"error": "Room not found"}

    username = request.username.strip()
    if not username:
        return {"error": "Username cannot be empty"}

    return {
        "roomId": room.room_id,
        "userId": secrets.token_urlsafe(12),
        "username": username,
        "role": "participant",
    }


@app.websocket("/ws/{room_id}/{user_id}/{username}")
async def room_socket(
    websocket: WebSocket,
    room_id: str,
    user_id: str,
    username: str,
):
    room_id = room_id.upper()
    room = rooms.get(room_id)

    if room is None:
        logger.warning("websocket_rejected reason=room_not_found room=%s", room_id)
        await websocket.close(code=4004, reason="Room not found")
        return

    await websocket.accept()

    async with room.lock:
        if user_id in room.participants:
            logger.warning("websocket_rejected reason=duplicate_connection room=%s", room_id)
            await websocket.close(code=4009, reason="Already connected")
            return

        role: Role = "host" if user_id == room.host_id else "participant"

        participant = Participant(
            user_id=user_id,
            username=username[:30],
            role=role,
            websocket=websocket,
        )
        room.participants[user_id] = participant

        await websocket.send_json({
            "type": "sync_state",
            "state": room_snapshot(room),
            "yourUserId": user_id,
        })
        await websocket.send_json({"type": "queue_update", "queue": room.queue})

        await broadcast(room, {
            "type": "user_joined",
            "participants": public_participants(room),
        })

    try:
        while True:
            try:
                message = await websocket.receive_json()
            except (json.JSONDecodeError, ValueError):
                await websocket.send_json({"type": "error", "message": "Invalid JSON event."})
                continue
            if not isinstance(message, dict) or not isinstance(message.get("type"), str):
                await websocket.send_json({"type": "error", "message": "Invalid event."})
                continue
            event = message["type"]
            data = message.get("payload", {})
            if not isinstance(data, dict):
                await websocket.send_json({"type": "error", "message": "Invalid event payload."})
                continue

            async with room.lock:
                current = room.participants.get(user_id)
                if current is None:
                    break

                if event in {"play", "pause", "seek", "change_video"}:
                    if current.role not in CONTROL_ROLES:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Only the Host or Moderator can control playback.",
                        })
                        continue

                    if event in {"play", "pause", "seek"}:
                        try:
                            payload = PlaybackPayload.model_validate(data)
                        except Exception:
                            await websocket.send_json({"type": "error", "message": "Invalid playback position."})
                            continue
                        if payload.time is None:
                            await websocket.send_json({"type": "error", "message": "Playback position is required."})
                            continue

                        # Assign only after strict validation has completed.
                        playback_time = float(payload.time)

                    if event == "play":
                        room.current_time = playback_time
                        room.play_state = "playing"

                    elif event == "pause":
                        room.current_time = playback_time
                        room.play_state = "paused"

                    elif event == "seek":
                        room.current_time = playback_time

                    elif event == "change_video":
                        try:
                            video_payload = VideoPayload.model_validate(data)
                        except Exception:
                            await websocket.send_json({
                                "type": "error",
                                "message": "Invalid YouTube video ID.",
                            })
                            continue
                        room.video_id = video_payload.videoId
                        room.current_time = 0.0
                        room.play_state = "paused"

                    await broadcast(room, {"type": "sync_state", "state": room_snapshot(room)})

                elif event == "assign_role":
                    if current.role != "host":
                        await websocket.send_json({
                            "type": "error",
                            "message": "Only the Host can assign roles.",
                        })
                        continue

                    target_id = data.get("userId")
                    new_role = data.get("role")
                    if not isinstance(target_id, str):
                        await websocket.send_json({"type": "error", "message": "Invalid target participant."})
                        continue
                    target = room.participants.get(target_id)

                    if target is None or target_id == room.host_id:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Invalid target participant.",
                        })
                        continue

                    if new_role not in {"moderator", "participant"}:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Invalid role.",
                        })
                        continue

                    target.role = new_role
                    await broadcast(room, {
                        "type": "role_assigned",
                        "participants": public_participants(room),
                    })

                elif event == "remove_participant":
                    if current.role != "host":
                        await websocket.send_json({
                            "type": "error",
                            "message": "Only the Host can remove participants.",
                        })
                        continue

                    target_id = data.get("userId")
                    if not isinstance(target_id, str) or target_id == room.host_id or target_id not in room.participants:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Invalid target participant.",
                        })
                        continue

                    target = room.participants.pop(target_id)
                    await target.websocket.close(
                        code=4003,
                        reason="Removed by Host",
                    )

                    await broadcast(room, {
                        "type": "participant_removed",
                        "userId": target_id,
                        "participants": public_participants(room),
                    })

                elif event == "request_control":
                    await websocket.send_json({
                        "type": "control_request_received",
                        "message": "Control requests will be implemented next.",
                    })

                elif event == "chat_message":
                    try:
                        chat = ChatPayload.model_validate(data)
                    except Exception:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Chat message must contain 1 to 500 non-whitespace characters.",
                        })
                        continue

                    await broadcast(room, {
                        "type": "chat_message",
                        "message": {
                            "userId": current.user_id,
                            "username": current.username,
                            "text": chat.text,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        },
                    })

                elif event == "reaction":
                    try:
                        reaction = ReactionPayload.model_validate(data)
                    except Exception:
                        await websocket.send_json({"type": "error", "message": "Choose an available reaction."})
                        continue
                    now = asyncio.get_running_loop().time()
                    if now - current.last_reaction < 1.0:
                        await websocket.send_json({"type": "error", "message": "Please wait before reacting again."})
                        continue
                    current.last_reaction = now
                    await broadcast(room, {
                        "type": "reaction_update",
                        "reaction": {"emoji": reaction.emoji, "userId": current.user_id, "username": current.username, "id": reaction.eventId or secrets.token_hex(5)},
                    })

                elif event in {"typing_start", "typing_stop"}:
                    if data.keys() - {"username"}:
                        await websocket.send_json({"type": "error", "message": "Invalid typing event payload."})
                        continue
                    current.typing = event == "typing_start"
                    await broadcast(room, {
                        "type": "typing_update",
                        "typing": [{"userId": p.user_id, "username": p.username} for p in room.participants.values() if p.typing],
                    })

                elif event == "queue_add":
                    try:
                        queued_video = QueueAddPayload.model_validate(data)
                    except Exception:
                        await websocket.send_json({"type": "error", "message": "Enter a valid 11-character YouTube video ID or supported URL."})
                        continue
                    now = asyncio.get_running_loop().time()
                    if now - current.last_queue_add < 1.0:
                        await websocket.send_json({"type": "error", "message": "Please wait before adding another video."})
                        continue
                    if len(room.queue) >= 50:
                        await websocket.send_json({"type": "error", "message": "The watch queue is full (50 videos maximum)."})
                        continue
                    if any(entry["videoId"] == queued_video.videoId for entry in room.queue):
                        await websocket.send_json({"type": "error", "message": "That video is already in the queue."})
                        continue
                    current.last_queue_add = now
                    room.queue.append({"entryId": secrets.token_hex(8), "videoId": queued_video.videoId, "userId": current.user_id, "username": current.username})
                    await broadcast_queue(room)

                elif event == "queue_remove":
                    if current.role not in CONTROL_ROLES:
                        await websocket.send_json({"type": "error", "message": "Only the Host or Moderator can manage the queue."})
                        continue
                    try:
                        entry_payload = QueueEntryPayload.model_validate(data)
                    except Exception:
                        await websocket.send_json({"type": "error", "message": "Invalid queue entry."})
                        continue
                    room.queue = [entry for entry in room.queue if entry["entryId"] != entry_payload.entryId]
                    await broadcast_queue(room)

                elif event == "queue_play":
                    if current.role not in CONTROL_ROLES:
                        await websocket.send_json({"type": "error", "message": "Only the Host or Moderator can play queued videos."})
                        continue
                    try:
                        entry_payload = QueueEntryPayload.model_validate(data)
                    except Exception:
                        await websocket.send_json({"type": "error", "message": "Invalid queue entry."})
                        continue
                    entry = next((item for item in room.queue if item["entryId"] == entry_payload.entryId), None)
                    if entry is None:
                        await websocket.send_json({"type": "error", "message": "That video is no longer in the queue."})
                        continue
                    room.video_id = entry["videoId"]
                    room.current_time = 0.0
                    room.play_state = "playing"
                    await broadcast(room, {"type": "sync_state", "state": room_snapshot(room)})
                    # The authoritative playback update is sent before the
                    # selected entry is removed from the shared queue.
                    room.queue = [item for item in room.queue if item["entryId"] != entry_payload.entryId]
                    await broadcast_queue(room)

                else:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Unknown event.",
                    })

    except WebSocketDisconnect:
        pass
    finally:
        async with room.lock:
            if room.participants.get(user_id, None) is participant:
                participant.typing = False
                room.participants.pop(user_id, None)
                if room.participants:
                    await broadcast(room, {"type": "typing_update", "typing": [{"userId": p.user_id, "username": p.username} for p in room.participants.values() if p.typing]})
                    await broadcast(room, {
                        "type": "user_left",
                        "userId": user_id,
                        "participants": public_participants(room),
                    })
                # Keep the room snapshot in memory so the same validated room
                # session can reconnect after a transient disconnect. Membership
                # itself is removed above; a new socket must register again.
