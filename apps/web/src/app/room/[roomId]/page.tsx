
"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import YouTube, { type YouTubeEvent } from "react-youtube";

type Role = "host" | "moderator" | "participant";

interface Participant {
  userId: string;
  username: string;
  role: Role;
}

interface RoomSession {
  roomId: string;
  userId: string;
  username: string;
  role: Role;
}

interface RoomState {
  roomId: string;
  videoId: string;
  playState: "playing" | "paused";
  currentTime: number;
  participants: Participant[];
  queue?: QueueEntry[];
}

interface QueueEntry { entryId: string; videoId: string; userId: string; username: string }
interface Reaction { id: string; emoji: string; username: string; drift?: number }
interface TypingMember { userId: string; username: string }

interface ChatMessage {
  userId: string;
  username: string;
  text: string;
  timestamp: string;
}

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://127.0.0.1:8000";

type YouTubePlayer = {
  getVideoData: () => { video_id?: string };
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  loadVideoById: (options: { videoId: string; startSeconds: number }) => void;
  cueVideoById: (options: { videoId: string; startSeconds: number }) => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  pauseVideo: () => void;
};

function formatTime(value: number) {
  const seconds = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function WatchRoomPage() {
  return <Suspense fallback={<main className="glass-page"><div className="glass-container"><section className="glass-card">Loading room…</section></div></main>}><WatchRoom /></Suspense>;
}

function WatchRoom() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = params.roomId.toUpperCase();

  const socketRef = useRef<WebSocket | null>(null);
  const playerReadyRef = useRef(false);
  const receivedSyncStateRef = useRef(false);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const remoteUpdateRef = useRef(false);
  const pendingSeekRef = useRef(false);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommandRef = useRef("");
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const reactionTimersRef = useRef<number[]>([]);
  const reactionIdsRef = useRef(new Set<string>());
  const typingTimerRef = useRef<number | null>(null);
  const staleTypingTimerRef = useRef<number | null>(null);
  const lastTypingSentRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);

  // Keep the first render identical on the server and browser. Session storage
  // is read after hydration in the connection effect below.
  const [session, setSession] = useState<RoomSession | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState("");
  const [chatError, setChatError] = useState("");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<"chat" | "participants" | "queue">("chat");
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [typingMembers, setTypingMembers] = useState<TypingMember[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [queueInput, setQueueInput] = useState("");
  const [syncReady, setSyncReady] = useState(false);

  const canControl =
    session?.role === "host" || session?.role === "moderator";

  const send = useCallback((type: string, payload: object = {}) => {
    const socket = socketRef.current;

    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type, payload }));
    }
  }, []);

  useEffect(() => {
    const stored = window.sessionStorage.getItem(`syncscreen:${roomId}`);
    if (!stored) {
      router.replace("/");
      return;
    }

    let parsed: RoomSession;
    try {
      parsed = JSON.parse(stored) as RoomSession;
    } catch {
      router.replace("/");
      return;
    }

    let socket: WebSocket | null = null;
    let disposed = false;
    // Deferring by one task lets React Strict Mode's development-only
    // setup/cleanup cycle cancel the first attempt before it reaches the API.
    const connectTimer = window.setTimeout(() => {
      if (disposed) return;
      const activeSocket = new WebSocket(
        `${WS_URL}/ws/${encodeURIComponent(roomId)}/${encodeURIComponent(parsed.userId)}/${encodeURIComponent(parsed.username)}`
      );
      socket = activeSocket;
      socketRef.current = activeSocket;

    activeSocket.onopen = () => {
      setSession(parsed);
      setConnected(true);
      setError("");
      setSyncReady(false);
    };

    activeSocket.onmessage = (event) => {
      let message: { type?: string; state?: RoomState; message?: string | ChatMessage; participants?: Participant[]; userId?: string; queue?: QueueEntry[]; reaction?: Reaction; typing?: TypingMember[] };

      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "error") {
        const errorMessage = typeof message.message === "string" ? message.message : "WebSocket error";
        if (errorMessage.toLowerCase().includes("chat")) setChatError(errorMessage);
        else { setError(errorMessage); showToast(errorMessage); }
        return;
      }

      if (message.type === "chat_message" && typeof message.message === "object" && message.message) {
        setChatMessages((previous) => [...previous, message.message as ChatMessage].slice(-100));
        return;
      }

      if (message.type === "queue_update" && Array.isArray(message.queue)) { setQueue(message.queue as QueueEntry[]); return; }
      if (message.type === "reaction_update" && message.reaction && typeof message.reaction === "object") {
        const reaction = message.reaction as Reaction;
        addReactionAnimation(reaction);
        return;
      }
      if (message.type === "typing_update" && Array.isArray(message.typing)) {
        setTypingMembers((message.typing as TypingMember[]).filter((member) => member.userId !== parsed.userId));
        if (staleTypingTimerRef.current) clearTimeout(staleTypingTimerRef.current);
        staleTypingTimerRef.current = window.setTimeout(() => setTypingMembers([]), 5000);
        return;
      }

      if (message.type === "sync_state") {
        const state = message.state as RoomState;
        setSession(parsed);
        setRoom(state);
        setQueue(state.queue ?? []);
        receivedSyncStateRef.current = true;
        setSyncReady(playerReadyRef.current);

        const actualUser = state.participants.find(
          (participant) => participant.userId === parsed.userId
        );

        if (actualUser) {
          setSession((previous) =>
            previous ? { ...previous, role: actualUser.role } : previous
          );
        }

        const player = playerRef.current;

        if (player && state.videoId) {
          const currentVideo = player.getVideoData?.().video_id;

          if (currentVideo !== state.videoId) {
            applyRemoteState(state, true);
          } else {
            const currentTime = player.getCurrentTime?.() ?? 0;
            const needsSeek = Math.abs(currentTime - state.currentTime) > 2;
            const needsState = state.playState === "playing"
              ? player.getPlayerState?.() !== 1
              : player.getPlayerState?.() !== 2;
            if (needsSeek || needsState) applyRemoteState(state, false, needsSeek);
          }
        }
      }

      if (
        message.type === "user_joined" ||
        message.type === "user_left" ||
        message.type === "role_assigned" ||
        message.type === "participant_removed"
      ) {
        setRoom((previous) =>
          previous
            ? { ...previous, participants: message.participants ?? [] }
            : previous
        );

        if (
          message.type === "participant_removed" &&
          message.userId === parsed.userId
        ) {
          activeSocket.close();
          sessionStorage.removeItem(`syncscreen:${roomId}`);
          router.replace("/");
        }
      }
    };

    activeSocket.onclose = (event) => {
      setConnected(false);
      setSyncReady(false);
      if (socketRef.current === activeSocket) socketRef.current = null;

      if (event.code === 4003 || event.code === 4004) {
        sessionStorage.removeItem(`syncscreen:${roomId}`);
        router.replace("/");
      } else if (event.code !== 1000) {
        setError("Disconnected from the room. Return home to reconnect.");
      }
    };

    activeSocket.onerror = () => {
      setError("Unable to connect to the room WebSocket.");
    };
    }, 0);

    const reactionTimers = reactionTimersRef.current;
    return () => {
      disposed = true;
      window.clearTimeout(connectTimer);
      if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (staleTypingTimerRef.current) clearTimeout(staleTypingTimerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      reactionTimers.forEach((timer) => window.clearTimeout(timer));

      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [roomId, router, reconnectAttempt]);

  function showToast(message: string) {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 2200);
  }

  function addReactionAnimation(reaction: Reaction) {
    if (reactionIdsRef.current.has(reaction.id)) return;
    reactionIdsRef.current.add(reaction.id);
    const animatedReaction = {
      ...reaction,
      drift: reaction.drift ?? (([...reaction.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 35) - 17),
    };
    setReactions((items) => [...items, animatedReaction].slice(-12));
    const timer = window.setTimeout(() => {
      setReactions((items) => items.filter((item) => item.id !== reaction.id));
      reactionIdsRef.current.delete(reaction.id);
      const timerIndex = reactionTimersRef.current.indexOf(timer);
      if (timerIndex >= 0) reactionTimersRef.current.splice(timerIndex, 1);
    }, 1250);
    reactionTimersRef.current.push(timer);
  }

  function react(emoji: string) {
    if (!connected) return;
    const id = crypto.randomUUID();
    addReactionAnimation({ id, emoji, username: session?.username ?? "You" });
    send("reaction", { emoji, eventId: id });
  }

  async function copyText(value: string, label: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      showToast(`${label} copied`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(`Unable to copy ${label.toLowerCase()}. Check browser clipboard permissions.`);
    }
  }

  function extractVideoId(value: string) {
    const text = value.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
    try {
      const url = new URL(text);
      if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0];
      if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
        return url.searchParams.get("v") ?? url.pathname.split("/").filter(Boolean).at(-1) ?? "";
      }
    } catch { /* A non-URL is not a supported video ID. */ }
    return "";
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages]);

  function applyRemoteState(state: RoomState, changeVideo = false, seek = true) {
    const player = playerRef.current;
    if (!player) return;
    remoteUpdateRef.current = true;
    if (changeVideo) {
      if (state.playState === "playing") player.loadVideoById({ videoId: state.videoId, startSeconds: state.currentTime });
      else player.cueVideoById({ videoId: state.videoId, startSeconds: state.currentTime });
    } else {
      if (seek) player.seekTo(state.currentTime, true);
      if (state.playState === "playing" && player.getPlayerState() !== 1) player.playVideo();
      else if (state.playState === "paused" && player.getPlayerState() !== 2) player.pauseVideo();
    }
    window.setTimeout(() => { remoteUpdateRef.current = false; }, 900);
  }

  function playerTime() {
    const player = playerRef.current;
    const time = Number(player?.getCurrentTime?.() ?? 0);
    if (Number.isFinite(time)) setCurrentTime(time);
    const total = Number(player?.getDuration?.() ?? 0);
    if (Number.isFinite(total)) setDuration(total);
    return Number.isFinite(time) ? time : 0;
  }

  function sendPlayback(type: "play" | "pause", time = playerTime()) {
    if (!canControl || !connected) return;
    const command = `${type}:${time.toFixed(1)}`;
    if (lastCommandRef.current === command) return;
    lastCommandRef.current = command;
    send(type, { time });
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      const player = playerRef.current;
      if (player?.getPlayerState?.() === 1) playerTime();
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  function onPlayerReady(event: YouTubeEvent) {
    playerRef.current = event.target;
    playerReadyRef.current = true;
    if (receivedSyncStateRef.current) setSyncReady(true);
    setDuration(Number(event.target.getDuration?.() ?? 0));

    if (room) {
      const actualVideo = event.target.getVideoData?.().video_id;
      applyRemoteState(room, actualVideo !== room.videoId);
    }
  }

  function onPlayerStateChange(event: YouTubeEvent) {
    playerTime();
    if (remoteUpdateRef.current) return;
    if (event.data === 1 && canControl && !pendingSeekRef.current) sendPlayback("play");
    else if (event.data === 2 && canControl && room?.playState === "playing") sendPlayback("pause");
    else if (event.data === 0 && canControl) sendPlayback("pause", playerTime());
  }

  function togglePlayback() {
    const player = playerRef.current;
    if (!player || !canControl || !connected) return;
    if (player.getPlayerState?.() === 1) {
      const time = playerTime();
      player.pauseVideo();
      sendPlayback("pause", time);
    } else {
      player.playVideo();
      sendPlayback("play", playerTime());
    }
  }

  function stepPlayback(delta: number) {
    const player = playerRef.current;
    if (!player || !canControl) return;
    const total = Number(player.getDuration?.() ?? duration);
    const time = Math.max(0, Math.min(total || 86400, playerTime() + delta));
    seekTo(time);
  }

  function loadVideo() {
    if (!canControl) return;

    try {
      const videoId = extractVideoId(videoUrl);
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        setError("Enter a valid YouTube video URL.");
        return;
      }

      setError("");
      send("change_video", { videoId });
      showToast("Room video updated");
    } catch {
      setError("Enter a valid YouTube video URL.");
    }
  }

  function seekTo(value: number) {
    if (!canControl || !playerRef.current) return;

    pendingSeekRef.current = true;
    remoteUpdateRef.current = true;
    playerRef.current.seekTo(value, true);
    setCurrentTime(value);
    send("seek", { time: value });
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => {
      pendingSeekRef.current = false;
      remoteUpdateRef.current = false;
    }, 1000);
  }

  function changeRole(userId: string, role: Role) {
    if (session?.role !== "host") return;
    send("assign_role", { userId, role });
  }

  function removeParticipant(userId: string) {
    if (session?.role !== "host") return;
    send("remove_participant", { userId });
  }

  function sendChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    if (text.length > 500) {
      setChatError("Messages are limited to 500 characters.");
      return;
    }
    if (!connected || socketRef.current?.readyState !== WebSocket.OPEN) {
      setChatError("Chat is unavailable while disconnected. Try again when reconnected.");
      return;
    }

    socketRef.current.send(JSON.stringify({ type: "chat_message", payload: { text } }));
    setChatText("");
    setChatError("");
    send("typing_stop");
    showToast("Message sent");
  }

  function updateChatText(value: string) {
    setChatText(value);
    if (chatError) setChatError("");
    if (!connected || !value.trim()) { send("typing_stop"); return; }
    const now = Date.now();
    if (now - lastTypingSentRef.current > 1500) { send("typing_start"); lastTypingSentRef.current = now; }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => send("typing_stop"), 1800);
  }

  function addToQueue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const videoId = extractVideoId(queueInput);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) { setError("Enter a valid YouTube video URL or 11-character video ID."); return; }
    if (queue.some((entry) => entry.videoId === videoId)) { setError("That video is already in the queue."); return; }
    send("queue_add", { videoId });
    setQueueInput("");
    setError("");
    showToast("Video added to queue");
  }

  if (!session) {
    return (
      <main className="glass-page">
        <div className="glass-container">
          <section className="glass-card">
            {error || "Loading room..."}
            {error && (
              <button
                className="glass-button"
                onClick={() => router.push("/")}
              >
                Back home
              </button>
            )}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="glass-page">
      <div className="glass-container">
        <nav className="glass-nav room-nav">
          <button className="glass-brand brand-button" onClick={() => router.push("/")} aria-label="SyncScreen home">
            Sync<span>Screen</span>
          </button>
          <span className="glass-nav-label">
            ROOM {roomId} · {connected ? "CONNECTED" : "CONNECTING"}
          </span>
          <div className="room-nav-right">
            <div className="room-code"><span>ROOM</span><strong>{roomId}</strong><button className="icon-button" onClick={() => void copyText(roomId, "Room code")} aria-label="Copy room code">{copied ? "Copied" : "Copy"}</button></div>
            <button className="icon-button invite-button" onClick={() => void copyText(`${window.location.origin}/room/${encodeURIComponent(roomId)}`, "Invite link")}>Copy invite link</button>
            <div className="profile-chip"><span className="online-dot" />{session.username}<span className="profile-role">{session.role}</span></div>
          </div>
          <button
            className="leave-button"
            style={{ width: "auto", marginTop: 0 }}
            onClick={() => router.push("/")}
          >
            Leave room
          </button>
        </nav>

        <header className="room-title-row">
          <div className="section-kicker">
            {connected ? "● LIVE WATCH PARTY" : "◌ CONNECTING"}
          </div>
          <h1>
            Watch <span>together.</span>
          </h1>
          <p>
            {session.username} · {session.role}
          </p>
        </header>

        {error && <div className="glass-error">{error}</div>}

        <div className="room-layout">
          <section className="glass-card player-panel">
            <div className="panel-title-row"><div><div className="section-kicker">NOW PLAYING</div><h2>{room?.videoId ?? "Waiting for playback state"}</h2></div><span className={`sync-badge ${!connected ? "sync-offline" : syncReady ? "sync-ready" : "sync-waiting"}`} aria-live="polite"><span className="online-dot" />{!connected ? "Disconnected" : syncReady ? "Synced" : "Updating"}</span></div>

            <div
              className="player-frame"
              style={{
                overflow: "hidden",
                borderRadius: 16,
                background: "#050816",
              }}
            >
              <YouTube
                videoId={room?.videoId ?? "1lCoQi1IcQ0"}
                className="w-full"
                iframeClassName="aspect-video w-full"
                onReady={onPlayerReady}
                onStateChange={onPlayerStateChange}
                onPlaybackQualityChange={() => playerTime()}
                onPlaybackRateChange={() => playerTime()}
                opts={{
                  width: "100%",
                  height: "100%",
                  playerVars: {
                    playsinline: 1,
                    origin:
                      typeof window !== "undefined"
                        ? window.location.origin
                        : "",
                  },
                }}
              />
            </div>

            <div className="reaction-area" aria-label="Room reactions">
              <div className="reaction-feed" aria-live="polite">{reactions.map((reaction) => <span className="floating-reaction" key={reaction.id} style={{ "--reaction-drift": `${reaction.drift ?? 0}px` } as CSSProperties} aria-label={`${reaction.username} reacted ${reaction.emoji}`}>{reaction.emoji}</span>)}</div>
              <div className="reaction-bar" aria-label="Send a reaction">{["❤️", "😂", "🔥", "👏", "😮"].map((emoji) => <button key={emoji} className="reaction-button" disabled={!connected} onClick={() => react(emoji)} aria-label={`React ${emoji}`}>{emoji}</button>)}</div>
            </div>

            <label className="glass-label" htmlFor="video-url">
              YouTube URL
            </label>
            <input
              id="video-url"
              className="glass-input"
              value={videoUrl}
              onChange={(event) => setVideoUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              disabled={!canControl}
            />

            <button
              className="glass-button"
              onClick={loadVideo}
              disabled={!canControl || !connected}
            >
              Change room video
            </button>

            <label className="glass-label" htmlFor="seek">Playback</label>
            <div className="playback-times">
              <span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span>
            </div>
            <input id="seek" aria-label="Seek position" type="range" min={0} max={duration || 1} step={0.25} value={Math.min(currentTime, duration || currentTime)} className="glass-seek" disabled={!canControl || !duration} onChange={(event) => { const time = Number(event.target.value); setCurrentTime(time); pendingSeekRef.current = true; if (seekTimerRef.current) clearTimeout(seekTimerRef.current); seekTimerRef.current = setTimeout(() => { pendingSeekRef.current = false; seekTo(time); }, 180); }} />

            <div className="playback-buttons" style={{ marginTop: 12 }}>
              <button className="glass-button glass-button-secondary" style={{ marginTop: 0 }} disabled={!canControl || !connected} onClick={() => stepPlayback(-10)}>↶ Rewind 10s</button>
              <button
                className="glass-button"
                style={{ marginTop: 0 }}
                disabled={!canControl || !connected}
                onClick={togglePlayback}
              >
                ▶ Play
              </button>
              <button
                className="glass-button glass-button-secondary"
                style={{ marginTop: 0 }}
                disabled={!canControl || !connected}
                onClick={togglePlayback}
              >
                ❚❚ Pause
              </button>
              <button className="glass-button glass-button-secondary" style={{ marginTop: 0 }} disabled={!canControl || !connected} onClick={() => stepPlayback(10)}>Skip 10s ↷</button>
            </div>

            {!canControl && (
              <button
                className="glass-button glass-button-secondary"
                onClick={() => send("request_control")}
                disabled={!connected}
              >
                Request playback control
              </button>
            )}
          </section>

          <aside className="glass-card room-sidebar">
            <div className="sidebar-tabs" role="tablist" aria-label="Room panel">
              <button id="room-tab-chat" role="tab" aria-controls="room-panel-chat" aria-selected={activeTab === "chat"} className={activeTab === "chat" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setActiveTab("chat")}><i aria-hidden="true">▤</i>Chat <span>{chatMessages.length}</span></button>
              <button id="room-tab-people" role="tab" aria-controls="room-panel-people" aria-selected={activeTab === "participants"} className={activeTab === "participants" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setActiveTab("participants")}><i aria-hidden="true">♙</i>People <span>{room?.participants.length ?? 0}</span></button>
              <button id="room-tab-queue" role="tab" aria-controls="room-panel-queue" aria-selected={activeTab === "queue"} className={activeTab === "queue" ? "sidebar-tab active" : "sidebar-tab"} onClick={() => setActiveTab("queue")}><i aria-hidden="true">☷</i>Queue <span>{queue.length}</span></button>
            </div>
            {activeTab === "participants" && <div id="room-panel-people" role="tabpanel" aria-labelledby="room-tab-people" tabIndex={0} className="participants-tab">
            <h2>Party members</h2>
            <p>{room?.participants.length ?? 0} connected members</p>

            <div className="participant-list">
              {(room?.participants ?? []).map((participant) => (
                <div
                  key={participant.userId}
                  className="participant-item"
                >
                  <div className="participant-name">
                    {participant.username}
                    {participant.userId === session.userId ? " (You)" : ""}
                  </div>

                  <div className="participant-role">
                    {participant.role}
                  </div>

                  {session.role === "host" &&
                    participant.userId !== session.userId && (
                      <>
                        <label className="glass-label">
                          Assign role
                        </label>
                        <select
                          className="glass-input"
                          value={participant.role}
                          onChange={(event) =>
                            changeRole(
                              participant.userId,
                              event.target.value as Role
                            )
                          }
                        >
                          <option value="participant">Participant</option>
                          <option value="moderator">Moderator</option>
                        </select>

                        <button
                          className="glass-button glass-button-secondary"
                          onClick={() =>
                            removeParticipant(participant.userId)
                          }
                        >
                          Remove participant
                        </button>
                      </>
                    )}
                </div>
              ))}
            </div>

            <button
              className="glass-button glass-button-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(roomId);
                } catch {
                  setError("Unable to copy room code.");
                }
              }}
            >
              Copy room code
            </button>
            </div>}

            {activeTab === "queue" && <div id="room-panel-queue" role="tabpanel" aria-labelledby="room-tab-queue" tabIndex={0} className="participants-tab queue-tab">
              <h2>Watch queue</h2><p>Suggestions are shared with this room. Titles are not available from the current YouTube integration.</p>
              <form className="queue-form" onSubmit={addToQueue}><label className="sr-only" htmlFor="queue-video">YouTube URL or video ID</label><input id="queue-video" className="glass-input" value={queueInput} onChange={(event) => setQueueInput(event.target.value)} placeholder="YouTube URL or video ID" disabled={!connected} /><button className="glass-button" disabled={!connected || !queueInput.trim()}>Add</button></form>
              <ol className="queue-list">{queue.map((entry, index) => <li key={entry.entryId}><span className="queue-position">{index + 1}</span><div className="queue-info"><strong>{entry.videoId}</strong><small>Added by {entry.username}</small></div>{canControl && <div className="queue-actions"><button className="icon-button" disabled={!connected} onClick={() => { send("queue_play", { entryId: entry.entryId }); showToast("Playing queued video"); }}>Play</button><button className="icon-button" disabled={!connected} onClick={() => send("queue_remove", { entryId: entry.entryId })}>Remove</button></div>}</li>)}{queue.length === 0 && <li className="queue-empty">The queue is empty. Add a video suggestion.</li>}</ol>
            </div>}

          {activeTab === "chat" && <div id="room-panel-chat" role="tabpanel" aria-labelledby="room-tab-chat" tabIndex={0} className="chat-panel" aria-label="Room chat">
            <div className="chat-heading">
              <div>
                <h2>Room chat</h2>
                <p>Messages are shared with everyone in this room.</p>
              </div>
              <span className="chat-count">{chatMessages.length}</span>
            </div>
            <div className="chat-history" aria-live="polite" aria-relevant="additions">
              {chatMessages.length === 0 ? (
                <div className="chat-empty">No messages yet. Start the conversation.</div>
              ) : chatMessages.map((message, index) => (
                <article className="chat-message" key={`${message.timestamp}-${message.userId}-${index}`}>
                  <div className="chat-message-meta">
                    <strong>{message.username}</strong>
                    <time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))}
              <div ref={chatEndRef} />
            </div>
            {typingMembers.length > 0 && <div className="typing-indicator" aria-live="polite">{typingMembers.length === 1 ? `${typingMembers[0].username} is typing…` : "Several people are typing…"}</div>}
            {chatError && <div className="chat-error" role="alert">{chatError}</div>}
            <form className="chat-form" onSubmit={sendChat}>
              <label className="sr-only" htmlFor="chat-message">Message</label>
              <input
                id="chat-message"
                className="glass-input"
                value={chatText}
                onChange={(event) => updateChatText(event.target.value)}
                placeholder={connected ? "Write a message…" : "Connecting to chat…"}
                maxLength={500}
                disabled={!connected}
                autoComplete="off"
              />
              {connected ? (
                <button className="glass-button" type="submit" disabled={!chatText.trim()}>
                  Send
                </button>
              ) : (
                <button className="glass-button glass-button-secondary" type="button" onClick={() => setReconnectAttempt((attempt) => attempt + 1)}>
                  Reconnect
                </button>
              )}
            </form>
            <div className="chat-character-count">{chatText.length}/500</div>
          </div>}
          </aside>
        </div>
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </main>
  );
}
