# Drawx

A collaborative whiteboard. Boards start private. The owner can turn on live collaboration and share the link.

Built to learn raw WebSockets — not Socket.IO, not `@excalidraw/excalidraw`. Drawing is Canvas 2D.

## Features

- Infinite canvas with pan and zoom
- Tools: select, pencil, eraser, line, arrow, rectangle, diamond, ellipse, text
- Eraser removes whole strokes, not pixels
- Undo, redo, and clear
- Live cursors and in-progress stroke previews
- Private boards; owner can start or stop a live session
- Guest display name (saved in the browser, no accounts)

## Stack

| Piece | Choice |
| --- | --- |
| Monorepo | pnpm workspaces |
| Web | Next.js (App Router) on port 3000 |
| Server | One Node process: HTTP + WebSocket on port 4000 |
| Messages | Zod schemas in `@drawx/protocol` |
| Database | Neon Postgres (stroke list + owner / collab flag) |

```
apps/web          Next.js UI and canvas
apps/server       HTTP (create board) + /ws (live room)
packages/protocol Shared Zod types for client and server
```

The server keeps an in-memory room (sockets + strokes) per board. Neon stores the stroke list so a refresh or a later join can reload the drawing. Camera, zoom, and pan stay local.

## Requirements

- Node.js 22+
- pnpm 10
- A Neon Postgres database

## Setup

```bash
pnpm install
```

Copy `apps/server/.env.example` to `apps/server/.env` and set `DATABASE_URL` to your Neon connection string. Keep `PORT=4000`.

The web app talks to `http://localhost:4000` and `ws://localhost:4000/ws` by default. Override with `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` if needed.

## Run

From the repo root:

```bash
pnpm dev
```

That starts both apps:

- UI: [http://localhost:3000](http://localhost:3000)
- API + WebSocket: `http://localhost:4000` and `ws://localhost:4000/ws`

Open the homepage, pick a name, create a board. Use **Live collaboration** to share the URL. **Stop session** makes the board private again and kicks guests.

## How it works

1. Homepage `POST`s `{ ownerId }` to `/boards`. The owner id is a UUID in `localStorage` (`drawx-client`).
2. The board page opens a WebSocket, sends `join`, and receives `welcome` with strokes, peers, and whether you are the owner.
3. Draw, move, erase, undo, and clear go over the same socket as `stroke`, `delete`, and `clear`. The server upserts strokes, writes them to Neon, and broadcasts to other members.
4. Guests are refused until the owner enables collab.

Same browser, two tabs: they share `drawx-client`, so the second tab replaces the first socket. Use another browser or a private window to test a real guest.

## Notes

- Right-click on the canvas is disabled so it does not open the browser menu. Use F12 or Ctrl+Shift+I for DevTools, or right-click the toolbar.
- A draw-and-guess room is planned later. It is not in this codebase yet.
