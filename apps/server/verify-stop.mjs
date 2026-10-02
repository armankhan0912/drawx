import { WebSocket } from "ws";

const ownerId = crypto.randomUUID();
const create = await fetch("http://localhost:4000/boards", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ownerId }),
});
if (!create.ok) throw new Error(`create ${create.status}`);
const { id } = await create.json();

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://localhost:4000/ws");
    const inbox = [];
    const waiters = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else inbox.push(message);
    });
    socket.on("error", reject);
    socket.once("open", () => {
      resolve({
        socket,
        next() {
          if (inbox.length) return Promise.resolve(inbox.shift());
          return new Promise((done) => waiters.push(done));
        },
        send(message) {
          socket.send(JSON.stringify(message));
        },
      });
    });
  });
}

function join(client, clientId, name) {
  client.send({ type: "join", boardId: id, clientId, name, color: "#ffffff" });
}

const owner = await connect();
join(owner, ownerId, "Ada");
const welcome = await owner.next();
if (!welcome.owner || welcome.collab) throw new Error(`welcome ${JSON.stringify(welcome)}`);

owner.send({ type: "collab", boardId: id, enabled: true });
const started = await owner.next();
if (started.type !== "collab" || started.enabled !== true) throw new Error(`start ${JSON.stringify(started)}`);

const guest = await connect();
join(guest, crypto.randomUUID(), "Bea");
const guestWelcome = await guest.next();
if (guestWelcome.type !== "welcome" || guestWelcome.owner) {
  throw new Error(`guest welcome ${JSON.stringify(guestWelcome)}`);
}

owner.send({ type: "collab", boardId: id, enabled: false });
const stopped = await owner.next();
const kicked = await guest.next();
if (stopped.type !== "collab" || stopped.enabled !== false) throw new Error(`stop ${JSON.stringify(stopped)}`);
if (kicked.type !== "error") throw new Error(`kick ${JSON.stringify(kicked)}`);

const late = await connect();
join(late, crypto.randomUUID(), "Cam");
const denied = await late.next();
if (denied.type !== "error") throw new Error(`late ${JSON.stringify(denied)}`);

owner.socket.close();
guest.socket.close();
late.socket.close();
console.log(JSON.stringify({ ok: true }));
