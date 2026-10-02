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
type Tool = "select" | "pencil" | "eraser" | "line" | "arrow" | "rect" | "diamond" | "ellipse" | "text";
type PlacedStroke = { stroke: Stroke; index: number };
type HistoryAction = { type: "add"; stroke: Stroke; index: number } | { type: "erase"; strokes: PlacedStroke[] };

const COLORS = ["#f5f5f5", "#f43f5e", "#f59e0b", "#22c55e", "#38bdf8", "#a78bfa"];
const WIDTHS = [3, 8];
const TOOLS: Tool[] = ["select", "pencil", "eraser", "line", "arrow", "rect", "diamond", "ellipse", "text"];
const BOARD_COLOR = "#111111";
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const SOCKET_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

export function Board({ boardId }: { boardId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const undoRef = useRef<HistoryAction[]>([]);
  const redoRef = useRef<HistoryAction[]>([]);
  const draftRef = useRef<Stroke | null>(null);
  const eraseRef = useRef<{ pointerId: number; removed: PlacedStroke[] } | null>(null);
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
  const textPlaceRef = useRef<{ x: number; y: number; fontSize: number; color: string } | null>(null);
  const textIdRef = useRef("");
  const textInputRef = useRef<HTMLInputElement>(null);
  const [textEditor, setTextEditor] = useState<{ id: string; color: string; fontSize: number; initial: string } | null>(null);
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
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
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

    let frame = 0;
    let zoomFactor = 1;
    let zoomScreen = { x: 0, y: 0 };
    let panX = 0;
    let panY = 0;
    let zooming = false;
    let panning = false;

    const flush = () => {
      frame = 0;
      if (zooming) {
        zoomAt(zoomScreen, zoomFactor);
        zoomFactor = 1;
        zooming = false;
      }
      if (panning) {
        const camera = cameraRef.current;
        cameraRef.current = { ...camera, x: camera.x - panX, y: camera.y - panY };
        panX = 0;
        panY = 0;
        panning = false;
        redraw();
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      let dx = event.deltaX;
      let dy = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        dx *= 16;
        dy *= 16;
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        dx *= rect.width;
        dy *= rect.height;
      }
      if (event.ctrlKey || event.metaKey) {
        zoomScreen = screen;
        zoomFactor *= Math.exp(-dy * 0.0015);
        zooming = true;
      } else {
        panX += dx;
        panY += dy;
        panning = true;
      }
      if (!frame) frame = window.requestAnimationFrame(flush);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };

    const board = canvas.parentElement;
    if (!board) return;
    board.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      board.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
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
    if (!textEditor) return;
    const input = textInputRef.current;
    if (!input) return;
    input.value = textEditor.initial;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    placeTextInput();
  }, [textEditor]);

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
        undoRef.current = message.data.strokes.map((stroke, index) => ({ type: "add", stroke, index }));
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
        undoRef.current = [];
        redoRef.current = [];
        draftRef.current = null;
        eraseRef.current = null;
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
    setCanUndo(undoRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  }

  function forgetStroke(strokeId: string) {
    const clean = (actions: HistoryAction[]): HistoryAction[] => {
      const next: HistoryAction[] = [];
      for (const action of actions) {
        if (action.type === "add") {
          if (action.stroke.id !== strokeId) next.push(action);
          continue;
        }
        const strokes = action.strokes.filter((item) => item.stroke.id !== strokeId);
        if (strokes.length > 0) next.push({ type: "erase", strokes });
      }
      return next;
    };
    undoRef.current = clean(undoRef.current);
    redoRef.current = clean(redoRef.current);
  }

  function patchHistoryStroke(stroke: Stroke) {
    const patch = (action: HistoryAction): HistoryAction => {
      if (action.type === "add") return action.stroke.id === stroke.id ? { ...action, stroke } : action;
      return {
        type: "erase",
        strokes: action.strokes.map((item) => (item.stroke.id === stroke.id ? { ...item, stroke } : item)),
      };
    };
    undoRef.current = undoRef.current.map(patch);
    redoRef.current = redoRef.current.map(patch);
  }

  function rememberAdd(stroke: Stroke) {
    const index = strokesRef.current.findIndex((item) => item.id === stroke.id);
    undoRef.current = [...undoRef.current, { type: "add", stroke, index: index === -1 ? strokesRef.current.length : index }];
    redoRef.current = [];
  }

  function insertStroke(placed: PlacedStroke) {
    if (strokesRef.current.some((stroke) => stroke.id === placed.stroke.id)) return;
    const next = strokesRef.current.slice();
    next.splice(Math.max(0, Math.min(placed.index, next.length)), 0, placed.stroke);
    strokesRef.current = next;
  }

  function send(message: ClientMessage) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function applyRemoteStroke(stroke: Stroke) {
    const index = strokesRef.current.findIndex((item) => item.id === stroke.id);
    if (index === -1) {
      forgetStroke(stroke.id);
      strokesRef.current = [...strokesRef.current, stroke];
      undoRef.current = [...undoRef.current, { type: "add", stroke, index: strokesRef.current.length - 1 }];
    } else {
      const next = strokesRef.current.slice();
      next[index] = stroke;
      strokesRef.current = next;
      patchHistoryStroke(stroke);
    }
    for (const [clientId, preview] of previewsRef.current) {
      if (preview.id === stroke.id) previewsRef.current.delete(clientId);
    }
    syncHistory();
    redraw();
  }

  function removeStroke(strokeId: string) {
    strokesRef.current = strokesRef.current.filter((stroke) => stroke.id !== strokeId);
    forgetStroke(strokeId);
  }

  function redraw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const scale = canvas.width / Math.max(1, canvas.clientWidth);
    const camera = cameraRef.current;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = BOARD_COLOR;
    ctx.fillRect(0, 0, canvas.clientWidth + 1, canvas.clientHeight + 1);
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    const hiddenId = dragRef.current?.snapshot.id;
    const paint = (stroke: Stroke) => {
      if (stroke.kind === "text") drawSharpText(ctx, stroke, camera, scale);
      else drawStroke(ctx, stroke);
    };
    for (const stroke of strokesRef.current) {
      if (stroke.id === hiddenId || (textPlaceRef.current && stroke.id === textIdRef.current)) continue;
      paint(stroke);
    }
    if (dragPreviewRef.current) paint(dragPreviewRef.current);
    if (draftRef.current) paint(draftRef.current);
    for (const preview of previewsRef.current.values()) paint(preview);

    placeTextInput();

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
    const percent = Math.round(zoom * 100);
    setZoomPercent((current) => (current === percent ? current : percent));
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
    if (event.button !== 0 || !joinedRef.current || draftRef.current || dragRef.current || eraseRef.current) return;

    const point = toBoard(screen);
    publishCursor(point);

    if (toolRef.current === "text") {
      event.preventDefault();
      const closed = commitText();
      if (!closed) {
        if (!pointInsideText(strokesRef.current, point) && textPlaceRef.current) {
          textPlaceRef.current = { ...textPlaceRef.current, x: point.x, y: point.y };
          placeTextInput();
        }
        return;
      }
      const existing = textAt(strokesRef.current, point);
      if (existing) {
        editText(existing);
        return;
      }
      textPlaceRef.current = { x: point.x, y: point.y, fontSize: Math.max(18, widthRef.current * 6), color: colorRef.current };
      textIdRef.current = crypto.randomUUID();
      setError("");
      setTextEditor({ id: textIdRef.current, color: colorRef.current, fontSize: textPlaceRef.current.fontSize, initial: "" });
      return;
    }

    if (toolRef.current === "eraser") {
      capturePointer(event.currentTarget, event.pointerId);
      eraseRef.current = { pointerId: event.pointerId, removed: [] };
      eraseAt(point);
      return;
    }

    capturePointer(event.currentTarget, event.pointerId);

    if (toolRef.current === "select") {
      const hit = hitTest(strokesRef.current, point);
      if (!hit) return;
      dragRef.current = { snapshot: hit, origin: point };
      dragPreviewRef.current = hit;
      return;
    }

    const id = crypto.randomUUID();
    const tool = toolRef.current;
    if (tool === "pencil") {
      draftRef.current = {
        id,
        kind: tool,
        points: [point],
        color: colorRef.current,
        width: widthRef.current,
      };
    } else if (tool === "line" || tool === "arrow" || tool === "rect" || tool === "diamond" || tool === "ellipse") {
      draftRef.current = {
        id,
        kind: tool,
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

    const erase = eraseRef.current;
    if (erase && erase.pointerId === event.pointerId) {
      eraseAt(point);
      return;
    }

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
    if (draft.kind === "pencil") {
      draft.points.push(point);
    } else if (
      draft.kind === "line" ||
      draft.kind === "arrow" ||
      draft.kind === "rect" ||
      draft.kind === "diamond" ||
      draft.kind === "ellipse"
    ) {
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

    if (eraseRef.current?.pointerId === event.pointerId) {
      const removed = eraseRef.current.removed;
      eraseRef.current = null;
      if (removed.length > 0) {
        undoRef.current = [...undoRef.current, { type: "erase", strokes: removed }];
        redoRef.current = [];
        syncHistory();
      }
      return;
    }

    const drag = dragRef.current;
    if (drag) {
      let moved = dragPreviewRef.current ?? drag.snapshot;
      if (moved.kind === "text" && coversText(strokesRef.current, moved)) moved = drag.snapshot;
      const index = strokesRef.current.findIndex((stroke) => stroke.id === moved.id);
      if (index !== -1) {
        const next = strokesRef.current.slice();
        next[index] = moved;
        strokesRef.current = next;
      }
      dragRef.current = null;
      dragPreviewRef.current = null;
      publishPreview(null);
      patchHistoryStroke(moved);
      publishStroke(moved);
      redraw();
      return;
    }

    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    strokesRef.current = [...strokesRef.current, draft];
    rememberAdd(draft);
    syncHistory();
    publishPreview(null);
    publishStroke(draft);
    redraw();
  }

  function eraseAt(point: Point) {
    const gesture = eraseRef.current;
    if (!gesture) return;
    let changed = false;
    let hit = hitTest(strokesRef.current, point);
    while (hit) {
      const index = strokesRef.current.findIndex((stroke) => stroke.id === hit?.id);
      const stroke = index === -1 ? undefined : strokesRef.current[index];
      if (!stroke || index === -1) break;
      strokesRef.current = strokesRef.current.filter((item) => item.id !== stroke.id);
      gesture.removed.push({ stroke, index });
      if (textIdRef.current === stroke.id) {
        textPlaceRef.current = null;
        setTextEditor(null);
        setError("");
      }
      send({ type: "delete", boardId, strokeId: stroke.id });
      changed = true;
      hit = hitTest(strokesRef.current, point);
    }
    if (changed) redraw();
  }

  function commitText(editorId?: string) {
    if (editorId && editorId !== textIdRef.current) return true;
    const place = textPlaceRef.current;
    const input = textInputRef.current;
    if (!place || !input) return true;
    const text = input.value.trim().slice(0, 200);
    if (!text) {
      const id = textIdRef.current;
      textPlaceRef.current = null;
      setTextEditor(null);
      setError("");
      if (strokesRef.current.some((stroke) => stroke.id === id)) {
        const index = strokesRef.current.findIndex((stroke) => stroke.id === id);
        const existing = strokesRef.current[index];
        strokesRef.current = strokesRef.current.filter((stroke) => stroke.id !== id);
        if (existing && index !== -1) {
          undoRef.current = [...undoRef.current, { type: "erase", strokes: [{ stroke: existing, index }] }];
          redoRef.current = [];
        }
        syncHistory();
        send({ type: "delete", boardId, strokeId: id });
      }
      redraw();
      return true;
    }
    const stroke: Stroke = {
      id: textIdRef.current,
      kind: "text",
      x: place.x,
      y: place.y,
      text,
      color: place.color,
      fontSize: place.fontSize,
    };
    if (coversText(strokesRef.current, stroke)) {
      setError("Text can't cover other text.");
      return false;
    }
    textPlaceRef.current = null;
    setTextEditor(null);
    setError("");
    const index = strokesRef.current.findIndex((item) => item.id === stroke.id);
    if (index === -1) {
      strokesRef.current = [...strokesRef.current, stroke];
      rememberAdd(stroke);
    } else {
      const next = strokesRef.current.slice();
      next[index] = stroke;
      strokesRef.current = next;
      patchHistoryStroke(stroke);
    }
    syncHistory();
    publishStroke(stroke);
    redraw();
    return true;
  }

  function onDoubleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!joinedRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const existing = textAt(strokesRef.current, toBoard({ x: event.clientX - rect.left, y: event.clientY - rect.top }));
    if (!existing) return;
    event.preventDefault();
    dragRef.current = null;
    dragPreviewRef.current = null;
    if (!commitText()) return;
    const current = strokesRef.current.find((stroke) => stroke.id === existing.id);
    if (current?.kind === "text") editText(current);
  }

  function editText(stroke: Extract<Stroke, { kind: "text" }>) {
    textPlaceRef.current = { x: stroke.x, y: stroke.y, fontSize: stroke.fontSize, color: stroke.color };
    textIdRef.current = stroke.id;
    setError("");
    setTextEditor({ id: stroke.id, color: stroke.color, fontSize: stroke.fontSize, initial: stroke.text });
    redraw();
  }

  function placeTextInput() {
    const input = textInputRef.current;
    const place = textPlaceRef.current;
    if (!input || !place) return;
    const camera = cameraRef.current;
    const size = Math.max(1, Math.round(place.fontSize * camera.zoom));
    const width = Math.ceil(measureTextWidth(input.value || " ", place.fontSize) * camera.zoom) + 4;
    input.style.left = `${Math.round(place.x * camera.zoom + camera.x)}px`;
    input.style.top = `${Math.round(place.y * camera.zoom + camera.y)}px`;
    input.style.fontSize = `${size}px`;
    input.style.width = `${Math.max(width, size)}px`;
    input.style.fontFamily = "sans-serif";
  }

  function keepCaretInView() {
    const place = textPlaceRef.current;
    const input = textInputRef.current;
    const canvas = canvasRef.current;
    if (!place || !input || !canvas) return;
    placeTextInput();
    const camera = cameraRef.current;
    const caret = place.x * camera.zoom + camera.x + input.offsetWidth;
    const limit = canvas.clientWidth - 32;
    if (caret <= limit) return;
    cameraRef.current = { ...camera, x: camera.x + (limit - caret) };
    redraw();
  }

  function undo() {
    const action = undoRef.current.at(-1);
    if (!action) return;
    draftRef.current = null;
    undoRef.current = undoRef.current.slice(0, -1);
    if (action.type === "add") {
      const current = strokesRef.current.find((stroke) => stroke.id === action.stroke.id) ?? action.stroke;
      strokesRef.current = strokesRef.current.filter((stroke) => stroke.id !== action.stroke.id);
      redoRef.current = [...redoRef.current, { ...action, stroke: current }];
      send({ type: "delete", boardId, strokeId: action.stroke.id });
    } else {
      for (const placed of [...action.strokes].reverse()) {
        insertStroke(placed);
        publishStroke(placed.stroke);
      }
      redoRef.current = [...redoRef.current, action];
    }
    syncHistory();
    redraw();
  }

  function redo() {
    const action = redoRef.current.at(-1);
    if (!action) return;
    draftRef.current = null;
    redoRef.current = redoRef.current.slice(0, -1);
    if (action.type === "add") {
      insertStroke(action);
      publishStroke(action.stroke);
    } else {
      for (const placed of action.strokes) {
        strokesRef.current = strokesRef.current.filter((stroke) => stroke.id !== placed.stroke.id);
        send({ type: "delete", boardId, strokeId: placed.stroke.id });
      }
    }
    undoRef.current = [...undoRef.current, action];
    syncHistory();
    redraw();
  }

  function clear() {
    strokesRef.current = [];
    undoRef.current = [];
    redoRef.current = [];
    draftRef.current = null;
    eraseRef.current = null;
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
        onDoubleClick={onDoubleClick}
        onContextMenu={(event) => event.preventDefault()}
      />
      {textEditor ? (
        <input
          key={textEditor.id}
          ref={textInputRef}
          aria-label="Board text"
          data-editor-id={textEditor.id}
          className="absolute z-20 min-w-4 bg-transparent font-sans leading-none outline-none"
          style={{ color: textEditor.color, fontSize: textEditor.fontSize }}
          onInput={keepCaretInView}
          onBlur={(event) => commitText(event.currentTarget.dataset.editorId)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              commitText();
            } else if (event.key === "Escape") {
              event.preventDefault();
              textPlaceRef.current = null;
              setTextEditor(null);
              redraw();
            }
          }}
        />
      ) : null}
      <p className="absolute top-3 right-3 z-30 rounded-full bg-zinc-900 px-3 py-1 text-sm text-zinc-200 ring-1 ring-white/10">
        <span
          className={`mr-2 inline-block h-2 w-2 rounded-full ${connection === "live" && collab ? "bg-emerald-400" : "bg-zinc-500"}`}
        />
        {connection === "connecting" ? "Connecting" : connection === "offline" ? "Offline" : collab ? "Live" : "Private"}
      </p>
      {error ? (
        <p className="absolute top-14 right-3 z-30 rounded-lg bg-rose-950 px-3 py-2 text-sm text-rose-100">{error}</p>
      ) : null}
      <div className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 flex-nowrap items-center justify-center gap-2 rounded-xl bg-zinc-900 p-2.5 shadow-lg ring-1 ring-white/10">
        {TOOLS.map((item) => (
          <button
            key={item}
            type="button"
            aria-label={TOOL_LABELS[item]}
            title={TOOL_LABELS[item]}
            aria-pressed={tool === item}
            onClick={() => setTool(item)}
            className={`${iconButton} ${tool === item ? "bg-white/15" : ""}`}
          >
            <ToolbarIcon name={item} />
          </button>
        ))}
        <span className="mx-1 h-7 w-px shrink-0 bg-white/15" />
        {COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={`Stroke color ${swatch}`}
            aria-pressed={color === swatch}
            onClick={() => setColor(swatch)}
            className={`h-9 w-9 shrink-0 rounded-full ${color === swatch ? "ring-2 ring-white ring-offset-2 ring-offset-zinc-900" : ""}`}
            style={{ backgroundColor: swatch }}
          />
        ))}
        <span className="mx-1 h-7 w-px shrink-0 bg-white/15" />
        {WIDTHS.map((strokeWidth) => (
          <button
            key={strokeWidth}
            type="button"
            aria-label={strokeWidth === WIDTHS[0] ? "Thin stroke" : "Thick stroke"}
            aria-pressed={width === strokeWidth}
            onClick={() => setWidth(strokeWidth)}
            className={`flex h-10 w-12 shrink-0 items-center justify-center rounded-md ${width === strokeWidth ? "bg-white/15" : "hover:bg-white/10"}`}
          >
            <span className="block w-5 rounded-full bg-white" style={{ height: strokeWidth }} />
          </button>
        ))}
        <span className="mx-1 h-7 w-px shrink-0 bg-white/15" />
        <button type="button" aria-label="Undo" title="Undo" onClick={undo} disabled={!canUndo} className={iconButton}>
          <ToolbarIcon name="undo" />
        </button>
        <button type="button" aria-label="Redo" title="Redo" onClick={redo} disabled={!canRedo} className={iconButton}>
          <ToolbarIcon name="redo" />
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
        <span className="mx-1 h-7 w-px shrink-0 bg-white/15" />
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
  "shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-base text-zinc-200 capitalize hover:bg-white/10 disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent";

const iconButton =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-zinc-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent";

const TOOL_LABELS: Record<Tool, string> = {
  select: "Select",
  pencil: "Pencil",
  eraser: "Eraser",
  line: "Line",
  arrow: "Arrow",
  rect: "Rectangle",
  diamond: "Diamond",
  ellipse: "Ellipse",
  text: "Text",
};

function ToolbarIcon({ name }: { name: Tool | "undo" | "redo" }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {name === "select" ? <path d="M5 3.5v12.4l3.4-3.2 2.2 6.1 2.2-.8-2.3-6.1H16.5L5 3.5z" /> : null}
      {name === "pencil" ? (
        <>
          <path d="M14 5.2 18.8 10 9 19.8H4.2V15z" />
          <path d="M12.6 6.6 17.4 11.4" />
        </>
      ) : null}
      {name === "eraser" ? (
        <>
          <path d="M4.5 14.5 11 5.5l8 6.2-6.5 8.3H8.2z" />
          <path d="m9.2 12.2 4.6 3.6" />
        </>
      ) : null}
      {name === "line" ? <path d="M5 19 19 5" /> : null}
      {name === "arrow" ? (
        <>
          <path d="M5 18 18 6" />
          <path d="M10 6h8v8" />
        </>
      ) : null}
      {name === "rect" ? <rect x="5" y="6" width="14" height="12" rx="1.5" /> : null}
      {name === "diamond" ? <path d="M12 4 20 12 12 20 4 12Z" /> : null}
      {name === "ellipse" ? <ellipse cx="12" cy="12" rx="7.5" ry="6.5" /> : null}
      {name === "text" ? (
        <>
          <path d="M5 6h14" />
          <path d="M12 6v13" />
        </>
      ) : null}
      {name === "undo" ? (
        <>
          <path d="M8 8h7.5a4.5 4.5 0 0 1 0 9H9" />
          <path d="M11 5 7 8l4 3" />
        </>
      ) : null}
      {name === "redo" ? (
        <>
          <path d="M16 8H8.5a4.5 4.5 0 0 0 0 9H15" />
          <path d="m13 5 4 3-4 3" />
        </>
      ) : null}
    </svg>
  );
}

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
  if (stroke.kind === "text") return;

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.kind === "line" || stroke.kind === "arrow") {
    const end = { x: stroke.x + stroke.width, y: stroke.y + stroke.height };
    ctx.beginPath();
    ctx.moveTo(stroke.x, stroke.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    if (stroke.kind === "arrow") {
      const angle = Math.atan2(stroke.height, stroke.width);
      const head = Math.max(14, stroke.strokeWidth * 4);
      ctx.beginPath();
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - head * Math.cos(angle - 0.45), end.y - head * Math.sin(angle - 0.45));
      ctx.moveTo(end.x, end.y);
      ctx.lineTo(end.x - head * Math.cos(angle + 0.45), end.y - head * Math.sin(angle + 0.45));
      ctx.stroke();
    }
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
  if (stroke.kind === "diamond") {
    ctx.beginPath();
    ctx.moveTo(x + width / 2, y);
    ctx.lineTo(x + width, y + height / 2);
    ctx.lineTo(x + width / 2, y + height);
    ctx.lineTo(x, y + height / 2);
    ctx.closePath();
    ctx.stroke();
    return;
  }
  ctx.beginPath();
  ctx.ellipse(x + width / 2, y + height / 2, Math.max(width / 2, 0.01), Math.max(height / 2, 0.01), 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawSharpText(
  ctx: CanvasRenderingContext2D,
  stroke: Extract<Stroke, { kind: "text" }>,
  camera: { x: number; y: number; zoom: number },
  scale: number,
) {
  const transform = ctx.getTransform();
  const size = Math.max(1, Math.round(stroke.fontSize * camera.zoom));
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.font = `${size}px sans-serif`;
  ctx.fillStyle = stroke.color;
  ctx.textBaseline = "top";
  ctx.fillText(stroke.text, Math.round(stroke.x * camera.zoom + camera.x), Math.round(stroke.y * camera.zoom + camera.y));
  ctx.setTransform(transform);
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
  if (stroke.kind === "line" || stroke.kind === "arrow") {
    return (
      distanceToSegment(point, { x: stroke.x, y: stroke.y }, { x: stroke.x + stroke.width, y: stroke.y + stroke.height }) <=
      stroke.strokeWidth / 2 + 6
    );
  }
  if (stroke.kind === "text") {
    const box = textBounds(stroke);
    return point.x >= box.x - 6 && point.x <= box.x + box.width + 6 && point.y >= box.y - 6 && point.y <= box.y + box.height + 6;
  }
  const x = Math.min(stroke.x, stroke.x + stroke.width) - 6;
  const y = Math.min(stroke.y, stroke.y + stroke.height) - 6;
  const width = Math.abs(stroke.width) + 12;
  const height = Math.abs(stroke.height) + 12;
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
}

function textBounds(stroke: { x: number; y: number; text: string; fontSize: number }) {
  const width = measureTextWidth(stroke.text, stroke.fontSize);
  return { x: stroke.x, y: stroke.y, width, height: stroke.fontSize };
}

let textMeasure: CanvasRenderingContext2D | null = null;

function measureTextWidth(text: string, fontSize: number) {
  if (!textMeasure) textMeasure = document.createElement("canvas").getContext("2d");
  if (!textMeasure) return text.length * fontSize * 0.55;
  textMeasure.font = `${fontSize}px sans-serif`;
  return textMeasure.measureText(text).width;
}

function coversText(strokes: Stroke[], next: Extract<Stroke, { kind: "text" }>) {
  const box = textBounds(next);
  return strokes.some(
    (stroke) => stroke.kind === "text" && stroke.id !== next.id && boxesOverlap(box, textBounds(stroke)),
  );
}

function pointInsideText(strokes: Stroke[], point: Point) {
  return textAt(strokes, point) !== null;
}

function textAt(strokes: Stroke[], point: Point) {
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    const stroke = strokes[index];
    if (stroke?.kind === "text" && pointInBox(point, textBounds(stroke))) return stroke;
  }
  return null;
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function pointInBox(point: Point, box: { x: number; y: number; width: number; height: number }) {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
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
