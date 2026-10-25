# SyncScreen — YouTube Watch Party

Watch YouTube videos together in real time. Create a room, invite friends, and enjoy synchronized playback, live chat, reactions, and a shared video queue.

<p align="center">
  <strong>Live demo:</strong>
  <a href="https://sync-screen.vercel.app">sync-screen.vercel.app</a>
  &nbsp;·&nbsp;
  <strong>API:</strong>
  <a href="https://syncscreen-api.onrender.com">syncscreen-api.onrender.com</a>
</p>

---

## Overview

**SyncScreen** is a collaborative watch-party web app designed to make watching YouTube with friends feel shared, even when everyone is in a different place. Create or join a room and interact with other participants while watching videos together.

## Features

- **Create and join rooms** — start a watch party or join one with a room code.
- **Synchronized playback** — coordinate video playback actions across room participants.
- **Live chat** — message other people in the room.
- **Typing indicators** — see when another participant is typing.
- **Shared video queue** — keep track of videos the group wants to watch.
- **Emoji reactions** — send reactions with on-screen animations.
- **Participant roles** — distinguish participants by role.
- **Responsive interface** — layouts designed for desktop and mobile screens.

> Playback synchronization can depend on YouTube embed permissions, browser behavior, and network conditions.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, React, TypeScript |
| Backend API | FastAPI, Python |
| Real-time communication | WebSockets |
| Video player | YouTube embedded player |
| Frontend hosting | Vercel |
| Backend hosting | Render |

## Live Deployment

- **Web app:** https://sync-screen.vercel.app
- **Backend API:** https://syncscreen-api.onrender.com
- **Health check:** https://syncscreen-api.onrender.com/health

The backend may take a short time to wake up after inactivity, depending on the hosting plan.

## Run Locally

### Prerequisites

- Python 3.12 recommended for local development
- Node.js and npm
- Git

### 1. Clone the repository

```bash
git clone https://github.com/OmmPrakash-07/SyncScreen.git
cd SyncScreen
```

### 2. Start the backend

Open a terminal:

```powershell
cd services\api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

If PowerShell blocks activation, use the virtual-environment Python directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

The API should be available at `http://127.0.0.1:8000`.

### 3. Configure the frontend

Open a second terminal:

```powershell
cd apps\web
```

Create a `.env.local` file in `apps/web` with these local development values:

```dotenv
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8000
```

Install dependencies and start Next.js:

```powershell
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

> Restart the frontend dev server after changing `.env.local`.

## Run Tests

From the repository root:

```powershell
cd services\api
.\.venv\Scripts\python.exe -m pytest -v
```

## Deployment Configuration

### Vercel (frontend)

Set the project root directory to `apps/web` and configure:

```dotenv
NEXT_PUBLIC_API_URL=https://syncscreen-api.onrender.com
NEXT_PUBLIC_WS_URL=wss://syncscreen-api.onrender.com
```

Redeploy the frontend after changing environment variables.

### Render (backend)

Set the service root directory to `services/api`. A typical configuration is:

- **Build command:** `pip install -r requirements.txt`
- **Start command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`

Ensure the backend CORS configuration allows the deployed frontend origin:

```text
https://sync-screen.vercel.app
```

Keep secrets out of source control. Store sensitive configuration in your hosting provider's environment-variable settings.

## Project Structure

```text
SyncScreen/
├── apps/
│   └── web/                 # Next.js frontend
│       ├── src/
│       │   ├── app/         # Pages and room UI
│       │   └── lib/         # Frontend API helpers
│       └── package.json
├── services/
│   └── api/                 # FastAPI backend
│       ├── main.py
│       ├── test_main.py
│       └── requirements.txt
└── README.md
```

## Screenshots

Add screenshots of the home page, an active watch room, and the mobile layout. For example, store them in `docs/screenshots/` and embed them here with relative Markdown image links once the files are added.

## Current Limitations

- Room state is stored in memory, so active room data may be lost when the backend restarts.
- Treat this as a demo/MVP until identity, authorization, persistence, rate limiting, and production security controls have been fully reviewed.
- YouTube playback depends on the selected video's embed settings and YouTube's player behavior.

## Roadmap Ideas

- Persistent rooms and room history
- Stronger participant identity and room access controls
- Improved reconnection and synchronization recovery
- Automated tests for real-time multi-user scenarios
- Accessibility and performance refinements

## Contributing

Contributions and suggestions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make your changes and run the relevant tests.
4. Open a pull request describing the change.

## License

No license is specified in this README. If you intend to publish the project under an open-source license, add a `LICENSE` file and update this section.

---

<p align="center">
  Built with ❤️ using Next.js, FastAPI, and WebSockets.
</p>
