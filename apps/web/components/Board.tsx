"use client";

import {
  serverMessageSchema,
  type ClientMessage,
  type Peer,
  type Stroke,
} from "@drawx/protocol";
import { useEffect, useRef, useState } from "react";

type Point = { x: number; y: number };
type Camera = { x: number; y: number; zoom: number };
type Tool = "select" | "pencil" | "eraser" | "line" | "rect" | "ellipse";

const COLORS = ["#f5f5f5", "#f43f5e", "#f59e0b", "#22c55e", "#38bdf8", "#a78bfa"];
const WIDTHS = [3, 8];
const TOOLS: Tool[] = ["select", "pencil", "eraser", "line", "rect", "ellipse"];
const BOARD_COLOR = "#111111";
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const SOCKET_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

export function Board({ boardId }: { boardId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const draftRef = useRef<Stroke | null>(null);
  const dragRef = useRef<{ snapshot: Stroke; origin: Point } | null>(null);
  const dragPreviewRef = useRef<Stroke | null>(null);
  const previewsRef = useRef<Map<string, Stroke>>(new Map());
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const spaceRef = useRef(false);
  const colorRef = useRef(COLORS[0]);
  const widthRef = useRef(WIDTHS[0]);
  const toolRef = useRef<Tool>("pencil");
  const socketRef = useRef<WebSocket | null>(null);
  const joinedRef = useRef(false);
  const identityRef = useRef({ id: "", name: "Guest", color: COLORS[0] });
  const lastCursorRef = useRef(0);
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[0]);
  const [tool, setTool] = useState<Tool>("pencil");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [spaceDown, setSpaceDown] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [role, setRole] = useState<"owner" | "guest" | null>(null);
  const [collab, setCollab] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  colorRef.current = color;
  widthRef.current = width;
  toolRef.current = tool;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      redraw();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (event.ctrlKey || event.metaKey) {
        zoomAt(screen, Math.exp(-event.deltaY * 0.002));
        return;
      }

      let dx = event.deltaX;
      let dy = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        dx *= 16;
        dy *= 16;
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        dx *= rect.width;
        dy *= rect.height;
      }
      const camera = cameraRef.current;
      cameraRef.current = { ...camera, x: camera.x - dx, y: camera.y - dy };
      redraw();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        spaceRef.current = true;
        setSpaceDown(true);
      }

      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (!meta) return;
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceRef.current = false;
      setSpaceDown(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    identityRef.current = clientIdentity();
    joinedRef.current = false;
    const socket = new WebSocket(SOCKET_URL);
    socketRef.current = socket;
    setConnection("connecting");

    socket.onopen = () => {
      const identity = identityRef.current;
      send({
        type: "join",
        boardId,
        clientId: identity.id,
        name: identity.name,
        color: identity.color,
      });
    };
    socket.onclose = () => {
      joinedRef.current = false;
      setConnection("offline");
    };
    socket.onerror = () => setConnection("offline");
    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      const message = serverMessageSchema.safeParse(parsed);
      if (!message.success) return;

      if (message.data.type === "welcome") {
        strokesRef.current = message.data.strokes;
        redoRef.current = [];
        previewsRef.current = new Map();
        peersRef.current = new Map(message.data.peers.map((peer) => [peer.id, peer]));
        joinedRef.current = true;
        setConnection("live");
        setRole(message.data.owner ? "owner" : "guest");
        setCollab(message.data.collab);
        setError("");
        syncHistory();
        redraw();
        return;
      }

      if (message.data.type === "collab") {
        setCollab(message.data.enabled);
        return;
      }

      if (message.data.type === "error") {
        setError(message.data.message);
        setConnection("offline");
        return;
      }

      if (message.data.type === "stroke") {
        applyRemoteStroke(message.data.stroke);
        return;
      }

      if (message.data.type === "delete") {
        removeStroke(message.data.strokeId);
        syncHistory();
        redraw();
        return;
      }

      if (message.data.type === "clear") {
        strokesRef.current = [];
        redoRef.current = [];
        draftRef.current = null;
        previewsRef.current = new Map();
        syncHistory();
        redraw();
        return;
      }

      if (message.data.type === "cursor") {
        peersRef.current.set(message.data.clientId, {
          id: message.data.clientId,
          name: message.data.name,
          color: message.data.color,
          x: message.data.x,
          y: message.data.y,
        });
        redraw();
        return;
      }

      if (message.data.type === "preview") {
        if (message.data.stroke) previewsRef.current.set(message.data.clientId, message.data.stroke);
        else previewsRef.current.delete(message.data.clientId);
        redraw();
        return;
      }

      peersRef.current.delete(message.data.clientId);
      previewsRef.current.delete(message.data.clientId);
      redraw();
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [boardId]);

  function syncHistory() {
    setCanUndo(strokesRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  }

  function send(message: ClientMessage) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function applyRemoteStroke(stroke: Stroke) {
    const index = strokesRef.current.findIndex((item) => item.id === stroke.id);
    if (index === -1) strokesRef.current = [...strokesRef.current, stroke];
    else {
      const next = strokesRef.current.slice();
      next[index] = stroke;
      strokesRef.current = next;
    }
    redoRef.current = redoRef.current.filter((item) => item.id !== stroke.id);
    for (const [clientId, preview] of previewsRef.current) {
      if (preview.id === stroke.id) previewsRef.current.delete(clientId);
    }
    syncHistory();
    redraw();
  }

  function removeStroke(strokeId: string) {
    strokesRef.current = strokesRef.current.filter((stroke) => stroke.id !== strokeId);
    redoRef.current = redoRef.current.filter((stroke) => stroke.id !== strokeId);
  }

  function redraw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const camera = cameraRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BOARD_COLOR;
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    const hiddenId = dragRef.current?.snapshot.id;
    for (const stroke of strokesRef.current) {
      if (stroke.id !== hiddenId) drawStroke(ctx, stroke);
    }
    if (dragPreviewRef.current) drawStroke(ctx, dragPreviewRef.current);
    if (draftRef.current) drawStroke(ctx, draftRef.current);
    for (const preview of previewsRef.current.values()) drawStroke(ctx, preview);

    for (const peer of peersRef.current.values()) {
      ctx.fillStyle = peer.color;
      ctx.beginPath();
      ctx.arc(peer.x, peer.y, 4 / camera.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `${12 / camera.zoom}px sans-serif`;
      ctx.fillText(peer.name, peer.x + 8 / camera.zoom, peer.y - 8 / camera.zoom);
    }
  }

  function zoomAt(screen: Point, factor: number) {
    const camera = cameraRef.current;
    const boardX = (screen.x - camera.x) / camera.zoom;
    const boardY = (screen.y - camera.y) / camera.zoom;
    const zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    cameraRef.current = {
      zoom,
      x: screen.x - boardX * zoom,
      y: screen.y - boardY * zoom,
    };
    setZoomPercent(Math.round(zoom * 100));
    redraw();
  }

  function resetView() {
    cameraRef.current = { x: 0, y: 0, zoom: 1 };
    setZoomPercent(100);
    redraw();
  }

  function screenPoint(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function toBoard(screen: Point): Point {
    const camera = cameraRef.current;
    return {
      x: (screen.x - camera.x) / camera.zoom,
      y: (screen.y - camera.y) / camera.zoom,
    };
  }

  function publishCursor(point: Point) {
    const now = performance.now();
    if (now - lastCursorRef.current < 40) return;
    lastCursorRef.current = now;
    send({ type: "cursor", boardId, x: point.x, y: point.y });
  }

  function publishPreview(stroke: Stroke | null) {
    send({ type: "preview", boardId, stroke });
  }

  function publishStroke(stroke: Stroke) {
    send({ type: "stroke", boardId, stroke });
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const screen = screenPoint(event);
    if (event.button === 1 || spaceRef.current) {
      event.preventDefault();
      capturePointer(event.currentTarget, event.pointerId);
      panRef.current = { pointerId: event.pointerId, x: screen.x, y: screen.y };
      setGrabbing(true);
      return;
    }
    if (event.button !== 0 || !joinedRef.current || draftRef.current || dragRef.current) return;

    const point = toBoard(screen);
    publishCursor(point);
    capturePointer(event.currentTarget, event.pointerId);

    if (toolRef.current === "select") {
      const hit = hitTest(strokesRef.current, point);
      if (!hit) return;
      dragRef.current = { snapshot: hit, origin: point };
      dragPreviewRef.current = hit;
      return;
    }

    const id = crypto.randomUUID();
    if (toolRef.current === "pencil" || toolRef.current === "eraser") {
      draftRef.current = {
        id,
        kind: toolRef.current,
        points: [point],
        color: colorRef.current,
        width: widthRef.current,
      };
    } else {
      draftRef.current = {
        id,
        kind: toolRef.current,
        x: point.x,
        y: point.y,
        width: 0,
        height: 0,
        color: colorRef.current,
        strokeWidth: widthRef.current,
      };
    }
    publishPreview(draftRef.current);
    redraw();
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const screen = screenPoint(event);
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      const camera = cameraRef.current;
      cameraRef.current = {
        ...camera,
        x: camera.x + screen.x - pan.x,
        y: camera.y + screen.y - pan.y,
      };
      panRef.current = { pointerId: pan.pointerId, x: screen.x, y: screen.y };
      redraw();
      return;
    }

    const point = toBoard(screen);
    if (joinedRef.current) publishCursor(point);

    const drag = dragRef.current;
    if (drag) {
      const moved = moveStroke(drag.snapshot, point.x - drag.origin.x, point.y - drag.origin.y);
      dragPreviewRef.current = moved;
      publishPreview(moved);
      redraw();
      return;
    }

    const draft = draftRef.current;
    if (!draft) return;
    if (draft.kind === "pencil" || draft.kind === "eraser") {
      draft.points.push(point);
    } else {
      draft.width = point.x - draft.x;
      draft.height = point.y - draft.y;
    }
    publishPreview(draft);
    redraw();
  }

  function endPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
      setGrabbing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const drag = dragRef.current;
    if (drag) {
      const moved = dragPreviewRef.current ?? drag.snapshot;
      const index = strokesRef.current.findIndex((stroke) => stroke.id === moved.id);
      if (index !== -1) {
        const next = strokesRef.current.slice();
        next[index] = moved;
        strokesRef.current = next;
      }
      dragRef.current = null;
      dragPreviewRef.current = null;
      publishPreview(null);
      publishStroke(moved);
      redraw();
      return;
    }

    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    strokesRef.current = [...strokesRef.current, draft];
    redoRef.current = [];
    syncHistory();
    publishPreview(null);
    publishStroke(draft);
    redraw();
  }

  function undo() {
    const stroke = strokesRef.current.at(-1);
    if (!stroke) return;
    draftRef.current = null;
    strokesRef.current = strokesRef.current.slice(0, -1);
    redoRef.current = [...redoRef.current, stroke];
    syncHistory();
    redraw();
    send({ type: "delete", boardId, strokeId: stroke.id });
  }

  function redo() {
    const stroke = redoRef.current.at(-1);
    if (!stroke) return;
    draftRef.current = null;
    redoRef.current = redoRef.current.slice(0, -1);
    strokesRef.current = [...strokesRef.current, stroke];
    syncHistory();
    redraw();
    publishStroke(stroke);
  }

  function clear() {
    strokesRef.current = [];
    redoRef.current = [];
    draftRef.current = null;
    previewsRef.current = new Map();
    syncHistory();
    redraw();
    send({ type: "clear", boardId });
  }

  function setCollaboration(enabled: boolean) {
    send({ type: "collab", boardId, enabled });
  }

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const cursor = grabbing ? "cursor-grabbing" : spaceDown || tool === "select" ? "cursor-grab" : "cursor-crosshair";

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#111111]">
      <canvas
        ref={canvasRef}
        aria-label="Drawing canvas"
        role="application"
        className={`absolute inset-0 h-full w-full touch-none ${cursor}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onContextMenu={(event) => event.preventDefault()}
      />
      <p className="absolute top-3 right-3 rounded-full bg-zinc-900/90 px-3 py-1 text-sm text-zinc-200 ring-1 ring-white/10">
        <span
          className={`mr-2 inline-block h-2 w-2 rounded-full ${connection === "live" && collab ? "bg-emerald-400" : "bg-zinc-500"}`}
        />
        {connection === "connecting" ? "Connecting" : connection === "offline" ? "Offline" : collab ? "Live" : "Private"}
      </p>
      {error ? (
        <p className="absolute top-14 right-3 rounded-lg bg-rose-950 px-3 py-2 text-sm text-rose-100">{error}</p>
      ) : null}
      <div className="absolute top-3 left-3 flex max-w-[calc(100%-8rem)] flex-wrap items-center gap-2 rounded-xl bg-zinc-900/90 p-2 shadow-lg ring-1 ring-white/10">
        {TOOLS.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={tool === item}
            onClick={() => setTool(item)}
            className={`${toolButton} capitalize ${tool === item ? "bg-white/15" : ""}`}
          >
            {item}
          </button>
        ))}
        <span className="mx-1 h-6 w-px bg-white/15" />
        {COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={`Stroke color ${swatch}`}
            aria-pressed={color === swatch}
            onClick={() => setColor(swatch)}
            className={`h-7 w-7 rounded-full ${color === swatch ? "ring-2 ring-white ring-offset-2 ring-offset-zinc-900" : ""}`}
            style={{ backgroundColor: swatch }}
          />
        ))}
        <span className="mx-1 h-6 w-px bg-white/15" />
        {WIDTHS.map((strokeWidth) => (
          <button
            key={strokeWidth}
            type="button"
            aria-label={strokeWidth === WIDTHS[0] ? "Thin stroke" : "Thick stroke"}
            aria-pressed={width === strokeWidth}
            onClick={() => setWidth(strokeWidth)}
            className={`flex h-7 w-9 items-center justify-center rounded-md ${width === strokeWidth ? "bg-white/15" : "hover:bg-white/10"}`}
          >
            <span className="block w-5 rounded-full bg-white" style={{ height: strokeWidth }} />
          </button>
        ))}
        <span className="mx-1 h-6 w-px bg-white/15" />
        <button type="button" onClick={undo} disabled={!canUndo} className={toolButton}>
          Undo
        </button>
        <button type="button" onClick={redo} disabled={!canRedo} className={toolButton}>
          Redo
        </button>
        <button type="button" onClick={clear} className={toolButton}>
          Clear
        </button>
        {role === "owner" && !collab ? (
          <button type="button" onClick={() => setCollaboration(true)} className={toolButton}>
            Live collaboration
          </button>
        ) : null}
        {role === "owner" && collab ? (
          <button type="button" onClick={() => setCollaboration(false)} className={toolButton}>
            Stop session
          </button>
        ) : null}
        {role === "owner" && collab ? (
          <button type="button" onClick={copyLink} className={toolButton}>
            {copied ? "Copied" : "Copy link"}
          </button>
        ) : null}
        <span className="mx-1 h-6 w-px bg-white/15" />
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(viewportCenter(), 1 / 1.1)} className={toolButton}>
          −
        </button>
        <button type="button" aria-label="Reset view" onClick={resetView} className={`${toolButton} tabular-nums`}>
          {zoomPercent}%
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(viewportCenter(), 1.1)} className={toolButton}>
          +
        </button>
      </div>
    </div>
  );

  function viewportCenter(): Point {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
  }
}

const toolButton =
  "rounded-md px-2 py-1 text-sm text-zinc-200 capitalize hover:bg-white/10 disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent";

function clientIdentity() {
  let id = localStorage.getItem("drawx-client");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("drawx-client", id);
  }
  const name = localStorage.getItem("drawx-name")?.trim().slice(0, 24) || "Guest";
  let hash = 0;
  for (const char of id) hash = (hash + char.charCodeAt(0)) % COLORS.length;
  return { id, name, color: COLORS[hash] ?? COLORS[0] };
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  if (stroke.kind === "eraser") {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    drawPencil(ctx, stroke.points, "#000000", stroke.width);
    ctx.restore();
    return;
  }
  if (stroke.kind === "pencil") {
    drawPencil(ctx, stroke.points, stroke.color, stroke.width);
    return;
  }

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (stroke.kind === "line") {
    ctx.beginPath();
    ctx.moveTo(stroke.x, stroke.y);
    ctx.lineTo(stroke.x + stroke.width, stroke.y + stroke.height);
    ctx.stroke();
    return;
  }

  const x = Math.min(stroke.x, stroke.x + stroke.width);
  const y = Math.min(stroke.y, stroke.y + stroke.height);
  const width = Math.abs(stroke.width);
  const height = Math.abs(stroke.height);
  if (stroke.kind === "rect") {
    ctx.strokeRect(x, y, width, height);
    return;
  }
  ctx.beginPath();
  ctx.ellipse(x + width / 2, y + height / 2, Math.max(width / 2, 0.01), Math.max(height / 2, 0.01), 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPencil(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  color: string,
  width: number,
) {
  if (points.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y);
  else {
    for (let index = 1; index < points.length; index += 1) {
      ctx.lineTo(points[index].x, points[index].y);
    }
  }
  ctx.stroke();
}

function moveStroke(stroke: Stroke, dx: number, dy: number): Stroke {
  if (stroke.kind === "pencil" || stroke.kind === "eraser") {
    return {
      ...stroke,
      points: stroke.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    };
  }
  return { ...stroke, x: stroke.x + dx, y: stroke.y + dy };
}

function hitTest(strokes: Stroke[], point: Point) {
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index];
    if (stroke && hits(stroke, point)) return stroke;
  }
  return null;
}

function hits(stroke: Stroke, point: Point) {
  if (stroke.kind === "pencil" || stroke.kind === "eraser") {
    const limit = stroke.width / 2 + 6;
    for (let index = 0; index < stroke.points.length; index += 1) {
      const start = stroke.points[index];
      const end = stroke.points[index + 1] ?? start;
      if (start && end && distanceToSegment(point, start, end) <= limit) return true;
    }
    return false;
  }
  if (stroke.kind === "line") {
    return (
      distanceToSegment(point, { x: stroke.x, y: stroke.y }, { x: stroke.x + stroke.width, y: stroke.y + stroke.height }) <=
      stroke.strokeWidth / 2 + 6
    );
  }
  const x = Math.min(stroke.x, stroke.x + stroke.width) - 6;
  const y = Math.min(stroke.y, stroke.y + stroke.height) - 6;
  const width = Math.abs(stroke.width) + 12;
  const height = Math.abs(stroke.height) + 12;
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0, 1);
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function capturePointer(element: HTMLElement, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // The pointer can already be gone if the gesture ended before capture.
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
