import { createServer, type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  clientMessageSchema,
  type Peer,
  type ServerMessage,
  type Stroke,
} from "@drawx/protocol";
import { ensureBoardsTable, insertBoard, readBoard, setCollab, setOwner, writeStrokes } from "./db.js";

type Member = {
  socket: WebSocket;
  clientId: string;
  name: string;
  color: string;
  x: number;
  y: number;
};

type Room = {
  id: string;
  ownerId: string | null;
  collab: boolean;
  strokes: Stroke[];
  members: Map<WebSocket, Member>;
  tail: Promise<void>;
};

const rooms = new Map<string, Room>();
const loading = new Map<string, Promise<Room | null>>();
const port = Number(process.env.PORT ?? 4000);

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(room: Room, except: WebSocket | null, message: ServerMessage) {
  for (const member of room.members.values()) {
    if (member.socket !== except) send(member.socket, message);
  }
}

function peersOf(room: Room, except: WebSocket): Peer[] {
  return [...room.members.values()]
    .filter((member) => member.socket !== except)
    .map((member) => ({
      id: member.clientId,
      name: member.name,
      color: member.color,
      x: member.x,
      y: member.y,
    }));
}

function upsertStroke(room: Room, stroke: Stroke) {
  const index = room.strokes.findIndex((item) => item.id === stroke.id);
  if (index === -1) room.strokes.push(stroke);
  else room.strokes[index] = stroke;
}

function enqueue(room: Room, task: () => Promise<void>) {
  const run = room.tail.then(task, task);
  room.tail = run;
  return run;
}

async function loadRoom(boardId: string) {
  const existing = rooms.get(boardId);
  if (existing) return existing;

  const inflight = loading.get(boardId);
  if (inflight) return inflight;

  const promise = readBoard(boardId).then((row) => {
    const again = rooms.get(boardId);
    if (again) return again;
    if (!row) return null;

    const room: Room = {
      id: boardId,
      ownerId: row.ownerId,
      collab: row.collab,
      strokes: row.strokes,
      members: new Map(),
      tail: Promise.resolve(),
    };
    rooms.set(boardId, room);
    return room;
  });

  loading.set(boardId, promise);
  try {
    return await promise;
  } finally {
    loading.delete(boardId);
  }
}

const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "POST" && request.url === "/boards") {
    const ownerId = await readOwnerId(request);
    if (!ownerId) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("ownerId is required");
      return;
    }
    const id = crypto.randomUUID();
    await insertBoard(id, ownerId);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ id }));
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

const sockets = new WebSocketServer({ server, path: "/ws" });

sockets.on("connection", (socket) => {
  let room: Room | null = null;
  let member: Member | null = null;

  socket.on("message", async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const message = clientMessageSchema.safeParse(parsed);
    if (!message.success) return;
    const data = message.data;

    if (data.type === "join") {
      const next = await loadRoom(data.boardId);
      if (!next) {
        send(socket, { type: "error", message: "This board does not exist." });
        socket.close();
        return;
      }

      if (!next.ownerId) {
        const clientId = data.clientId;
        await enqueue(next, async () => {
          if (next.ownerId) return;
          next.ownerId = clientId;
          await setOwner(next.id, clientId);
        });
      }

      if (next.ownerId !== data.clientId && !next.collab) {
        send(socket, { type: "error", message: "This board is private." });
        socket.close();
        return;
      }

      for (const current of next.members.values()) {
        if (current.clientId === data.clientId) {
          next.members.delete(current.socket);
          current.socket.close();
        }
      }

      room = next;
      member = {
        socket,
        clientId: data.clientId,
        name: data.name,
        color: data.color,
        x: 0,
        y: 0,
      };
      room.members.set(socket, member);
      send(socket, {
        type: "welcome",
        strokes: room.strokes,
        peers: peersOf(room, socket),
        owner: room.ownerId === member.clientId,
        collab: room.collab,
      });
      return;
    }

    if (!room || !member || data.boardId !== room.id) return;
    const active = room;
    const actor = member;

    if (data.type === "stroke") {
      await enqueue(active, async () => {
        upsertStroke(active, data.stroke);
        await writeStrokes(active.id, active.strokes);
        broadcast(active, socket, data);
      });
      return;
    }

    if (data.type === "delete") {
      await enqueue(active, async () => {
        active.strokes = active.strokes.filter((stroke) => stroke.id !== data.strokeId);
        await writeStrokes(active.id, active.strokes);
        broadcast(active, socket, data);
      });
      return;
    }

    if (data.type === "clear") {
      await enqueue(active, async () => {
        active.strokes = [];
        await writeStrokes(active.id, active.strokes);
        broadcast(active, socket, data);
      });
      return;
    }

    if (data.type === "collab") {
      if (actor.clientId !== active.ownerId || active.collab === data.enabled) return;
      const enabled = data.enabled;
      await enqueue(active, async () => {
        active.collab = enabled;
        await setCollab(active.id, enabled);
        const members = [...active.members.values()];
        for (const current of members) {
          if (enabled || current.clientId === active.ownerId) {
            send(current.socket, { type: "collab", enabled });
            continue;
          }
          send(current.socket, { type: "error", message: "This board is private." });
          current.socket.close();
        }
      });
      return;
    }

    if (data.type === "cursor") {
      actor.x = data.x;
      actor.y = data.y;
      broadcast(active, socket, {
        type: "cursor",
        boardId: active.id,
        clientId: actor.clientId,
        name: actor.name,
        color: actor.color,
        x: actor.x,
        y: actor.y,
      });
      return;
    }

    broadcast(active, socket, {
      type: "preview",
      boardId: active.id,
      clientId: actor.clientId,
      stroke: data.stroke,
    });
  });

  socket.on("close", () => {
    if (!room || !member) return;
    if (room.members.get(socket) !== member) return;
    room.members.delete(socket);
    broadcast(room, null, { type: "cursor-left", clientId: member.clientId });
    if (room.members.size === 0 && rooms.get(room.id) === room) rooms.delete(room.id);
  });
});

async function readOwnerId(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1000) return null;
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { ownerId?: unknown };
    if (typeof body.ownerId !== "string") return null;
    const ownerId = body.ownerId.trim();
    if (ownerId.length < 1 || ownerId.length > 80) return null;
    return ownerId;
  } catch {
    return null;
  }
}

await ensureBoardsTable();

server.listen(port, () => {
  console.log(`socket listening on ws://localhost:${port}/ws`);
});
