"use client";

import { useEffect, useRef, useState } from "react";

type Point = { x: number; y: number };

type Stroke = {
  id: string;
  points: Point[];
  color: string;
  width: number;
};

type Camera = { x: number; y: number; zoom: number };

const COLORS = ["#f5f5f5", "#f43f5e", "#f59e0b", "#22c55e", "#38bdf8", "#a78bfa"];
const WIDTHS = [3, 8];
const BOARD_COLOR = "#111111";
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

export function Board() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const draftRef = useRef<Stroke | null>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const spaceRef = useRef(false);
  const colorRef = useRef(COLORS[0]);
  const widthRef = useRef(WIDTHS[0]);
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[0]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [spaceDown, setSpaceDown] = useState(false);
  const [grabbing, setGrabbing] = useState(false);

  colorRef.current = color;
  widthRef.current = width;

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
      zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event.deltaY < 0 ? 1.1 : 1 / 1.1);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
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

  function syncHistory() {
    setCanUndo(strokesRef.current.length > 0);
    setCanRedo(redoRef.current.length > 0);
  }

  function redraw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.width / dpr;
    const cssHeight = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BOARD_COLOR;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const camera = cameraRef.current;
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    for (const stroke of strokesRef.current) {
      drawStroke(ctx, stroke);
    }
    if (draftRef.current) {
      drawStroke(ctx, draftRef.current);
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
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function toBoard(screen: Point): Point {
    const camera = cameraRef.current;
    return {
      x: (screen.x - camera.x) / camera.zoom,
      y: (screen.y - camera.y) / camera.zoom,
    };
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
    if (event.button !== 0 || draftRef.current) return;

    capturePointer(event.currentTarget, event.pointerId);
    draftRef.current = {
      id: crypto.randomUUID(),
      points: [toBoard(screen)],
      color: colorRef.current,
      width: widthRef.current,
    };
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

    const draft = draftRef.current;
    if (!draft) return;
    draft.points.push(toBoard(screen));
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

    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    strokesRef.current = [...strokesRef.current, draft];
    redoRef.current = [];
    syncHistory();
    redraw();
  }

  function undo() {
    const strokes = strokesRef.current;
    if (strokes.length === 0) return;
    draftRef.current = null;
    const stroke = strokes[strokes.length - 1];
    strokesRef.current = strokes.slice(0, -1);
    redoRef.current = [...redoRef.current, stroke];
    syncHistory();
    redraw();
  }

  function redo() {
    const stroke = redoRef.current[redoRef.current.length - 1];
    if (!stroke) return;
    draftRef.current = null;
    redoRef.current = redoRef.current.slice(0, -1);
    strokesRef.current = [...strokesRef.current, stroke];
    syncHistory();
    redraw();
  }

  function clear() {
    strokesRef.current = [];
    redoRef.current = [];
    draftRef.current = null;
    syncHistory();
    redraw();
  }

  const cursor = grabbing ? "cursor-grabbing" : spaceDown ? "cursor-grab" : "cursor-crosshair";

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
      <div className="absolute top-3 left-3 flex items-center gap-2 rounded-xl bg-zinc-900/90 p-2 shadow-lg ring-1 ring-white/10">
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
        <span className="mx-1 h-6 w-px bg-white/15" />
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => zoomAt(viewportCenter(), 1 / 1.1)}
          className={toolButton}
        >
          −
        </button>
        <button type="button" aria-label="Reset view" onClick={resetView} className={`${toolButton} tabular-nums`}>
          {zoomPercent}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => zoomAt(viewportCenter(), 1.1)}
          className={toolButton}
        >
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
  "rounded-md px-2 py-1 text-sm text-zinc-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent";

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const { points } = stroke;
  if (points.length === 0) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  if (points.length === 1) {
    ctx.lineTo(points[0].x + 0.01, points[0].y);
  } else {
    for (let index = 1; index < points.length; index += 1) {
      ctx.lineTo(points[index].x, points[index].y);
    }
  }
  ctx.stroke();
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
