
"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createRoom, joinRoom } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current); }, []);

  function announce(message: string) {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2000);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const room = await createRoom(username.trim());

      sessionStorage.setItem(
        `syncscreen:${room.roomId}`,
        JSON.stringify(room)
      );

      announce("Room created. Opening your party…");

      router.push(`/room/${room.roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room");
    } finally {
      setLoading(false);
    }
  }

  async function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const room = await joinRoom(roomCode.trim(), username.trim());

      sessionStorage.setItem(
        `syncscreen:${room.roomId}`,
        JSON.stringify(room)
      );

      announce("Joined room. Connecting…");

      router.push(`/room/${room.roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join room");
    } finally {
      setLoading(false);
    }
  }

  
return (
  <main className="glass-page">
    <div className="glass-container">
      <nav className="glass-nav home-nav">
        <div className="glass-brand">
          Sync<span>Screen</span>
        </div>
        <span className="glass-nav-label">
          WATCH TOGETHER · STAY IN SYNC
        </span>
      </nav>

      <header className="glass-hero home-hero">
        <div className="glass-pill">✦ &nbsp; WATCH TOGETHER</div>
        <h1>
          Your world.
          <br />
          <span className="glass-gradient-text">In perfect sync.</span>
        </h1>
        <p>
          Gather your friends, press play, and enjoy YouTube
          together from anywhere.
        </p>

        <div className="glass-features">
          <span className="glass-feature">▶ Synchronized playback</span>
          <span className="glass-feature">◉ Real-time rooms</span>
          <span className="glass-feature">✧ Shared experiences</span>
        </div>
      </header>

      <section className="glass-grid home-grid">
        <form onSubmit={handleCreate} className="glass-card">
          <div className="glass-icon">♛</div>
          <h2>Host a party</h2>
          <p>Create a room and invite your friends to watch together.</p>

          <label className="glass-label" htmlFor="create-name">
            Your name
          </label>
          <input
            id="create-name"
            className="glass-input"
            required
            maxLength={30}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your name"
          />

          <button className="glass-button" disabled={loading}>
            {loading ? "Creating room..." : "＋ Create Watch Party →"}
          </button>
        </form>

        <form onSubmit={handleJoin} className="glass-card">
          <div className="glass-icon">♧</div>
          <h2>Join a party</h2>
          <p>Enter your friend&apos;s room code and start watching together.</p>

          <label className="glass-label" htmlFor="join-name">
            Your name
          </label>
          <input
            id="join-name"
            className="glass-input"
            required
            maxLength={30}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your name"
          />

          <label className="glass-label" htmlFor="room-code">
            Room code
          </label>
          <input
            id="room-code"
            className="glass-input"
            required
            maxLength={8}
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            placeholder="e.g. ABC12345"
          />

          <button
            className="glass-button glass-button-secondary"
            disabled={loading}
          >
            {loading ? "Joining room..." : "↗ Join Watch Party →"}
          </button>
        </form>
      </section>

      {error && (
        <div className="glass-error" role="alert">
          {error}
        </div>
      )}

      {notice && <div className="toast" role="status">{notice}</div>}

      <footer className="glass-footer">
        Made for movie nights, music sessions, and shared moments.
      </footer>
    </div>
  </main>
);

}
