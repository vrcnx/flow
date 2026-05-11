"use client";

import { useState, useRef, useEffect } from "react";

// Shared handler bag — listeners are attached once and call into the latest
// handlers via this object, so they survive any component remounts.
type HandlerBag = {
  down?: (e: MouseEvent) => void;
  dbl?: (e: MouseEvent) => void;
  wheel?: (e: WheelEvent) => void;
  move?: (e: MouseEvent) => void;
  up?: (e: MouseEvent) => void;
  key?: (e: KeyboardEvent) => void;
};

declare global {
  interface Window {
    __flowHandlers?: HandlerBag;
    __flowAttached?: boolean;
  }
}

type Block = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
};
type Edge = { id: string; from: string; to: string };
type View = { x: number; y: number; scale: number };
type Selection = { type: "block" | "edge"; id: string } | null;

const GRID = 24;
const BLOCK_W = 160;
const BLOCK_H = 60;
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(Math.abs(x2 - x1) * 0.5, 40);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

type Interaction =
  | { type: "none" }
  | {
      type: "pan";
      startMouseX: number;
      startMouseY: number;
      startViewX: number;
      startViewY: number;
    }
  | {
      type: "drag";
      id: string;
      startMouseX: number;
      startMouseY: number;
      startBlockX: number;
      startBlockY: number;
    }
  | { type: "connect"; from: string };

export default function Canvas() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [connectPreview, setConnectPreview] = useState<{
    from: string;
    worldX: number;
    worldY: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);

  // Live mirrors for use inside native event handlers
  const viewRef = useRef(view);
  viewRef.current = view;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const interactionRef = useRef<Interaction>({ type: "none" });

  const screenToWorld = (sx: number, sy: number) => {
    const v = viewRef.current;
    return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale };
  };

  // Center the view on mount so blocks created near (0,0) appear in the middle
  useEffect(() => {
    if (canvasRef.current) {
      const r = canvasRef.current.getBoundingClientRect();
      setView({ x: r.width / 2, y: r.height / 2, scale: 1 });
    }
  }, []);

  // Always-fresh handler functions — these are recreated each render so they
  // reference the latest state setters and the latest interaction state.
  const handlers: HandlerBag = {
    down: (e) => {
      const t = e.target;
      const isBg = t instanceof Element && t.classList.contains("flow-canvas");
      if (!isBg) return;
      if (e.button !== 0) return;
      setSelection(null);
      setEditingId(null);
      interactionRef.current = {
        type: "pan",
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startViewX: viewRef.current.x,
        startViewY: viewRef.current.y,
      };
      setPanning(true);
    },
    dbl: (e) => {
      const t = e.target;
      const isBg = t instanceof Element && t.classList.contains("flow-canvas");
      if (!isBg) return;
      const el = canvasRef.current;
      if (!el) return;
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      const rect = el.getBoundingClientRect();
      const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const id = uid();
      setBlocks((bs) => [
        ...bs,
        {
          id,
          x: w.x - BLOCK_W / 2,
          y: w.y - BLOCK_H / 2,
          w: BLOCK_W,
          h: BLOCK_H,
          text: "",
        },
      ]);
      setSelection({ type: "block", id });
      setEditingId(id);
      interactionRef.current = { type: "none" };
      setPanning(false);
    },
    wheel: (e) => {
      const t = e.target;
      const onCanvas = t instanceof Element && !!t.closest(".flow-canvas");
      if (!onCanvas) return;
      e.preventDefault();
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      if (newScale === v.scale) return;
      const wx = (mx - v.x) / v.scale;
      const wy = (my - v.y) / v.scale;
      setView({ scale: newScale, x: mx - wx * newScale, y: my - wy * newScale });
    },
    move: (e) => {
      const s = interactionRef.current;
      if (s.type === "pan") {
        setView((v) => ({
          ...v,
          x: s.startViewX + (e.clientX - s.startMouseX),
          y: s.startViewY + (e.clientY - s.startMouseY),
        }));
      } else if (s.type === "drag") {
        const scale = viewRef.current.scale;
        const dx = (e.clientX - s.startMouseX) / scale;
        const dy = (e.clientY - s.startMouseY) / scale;
        setBlocks((bs) =>
          bs.map((b) =>
            b.id === s.id
              ? { ...b, x: s.startBlockX + dx, y: s.startBlockY + dy }
              : b
          )
        );
      } else if (s.type === "connect") {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        setConnectPreview({ from: s.from, worldX: w.x, worldY: w.y });
      }
    },
    up: (e) => {
      const s = interactionRef.current;
      if (s.type === "connect") {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
          const target = blocksRef.current.find(
            (b) =>
              w.x >= b.x &&
              w.x <= b.x + b.w &&
              w.y >= b.y &&
              w.y <= b.y + b.h &&
              b.id !== s.from
          );
          if (target) {
            const fromId = s.from;
            setEdges((es) => {
              if (es.some((ed) => ed.from === fromId && ed.to === target.id)) return es;
              return [...es, { id: uid(), from: fromId, to: target.id }];
            });
          }
        }
        setConnectPreview(null);
      }
      if (s.type !== "none") {
        interactionRef.current = { type: "none" };
        setPanning(false);
      }
    },
    key: (e) => {
      if (e.key === "Escape") {
        setEditingId(null);
        setSelection(null);
        return;
      }
      if (editingIdRef.current) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selectionRef.current;
        if (sel?.type === "block") {
          const id = sel.id;
          setBlocks((bs) => bs.filter((b) => b.id !== id));
          setEdges((es) => es.filter((ed) => ed.from !== id && ed.to !== id));
          setSelection(null);
        } else if (sel?.type === "edge") {
          const id = sel.id;
          setEdges((es) => es.filter((ed) => ed.id !== id));
          setSelection(null);
        }
      }
    },
  };
  // Publish the latest handlers so the once-attached listeners delegate to them
  if (typeof window !== "undefined") {
    window.__flowHandlers = handlers;
  }

  // Attach DOM listeners exactly once per page load — survives any component
  // remount churn (Next dev tools / HMR) because we never detach.
  useEffect(() => {
    if (window.__flowAttached) return;
    window.__flowAttached = true;
    const proxy = <T extends Event>(name: keyof HandlerBag) =>
      ((e: T) => window.__flowHandlers?.[name]?.(e as never)) as EventListener;
    document.addEventListener("mousedown", proxy("down"));
    document.addEventListener("dblclick", proxy("dbl"));
    document.addEventListener("wheel", proxy("wheel"), { passive: false });
    window.addEventListener("mousemove", proxy("move"));
    window.addEventListener("mouseup", proxy("up"));
    window.addEventListener("keydown", proxy("key"));
  }, []);

  const startBlockDrag = (e: React.MouseEvent, block: Block) => {
    if (editingId === block.id) return;
    e.stopPropagation();
    setSelection({ type: "block", id: block.id });
    interactionRef.current = {
      type: "drag",
      id: block.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startBlockX: block.x,
      startBlockY: block.y,
    };
  };

  const startEditing = (e: React.MouseEvent, block: Block) => {
    e.stopPropagation();
    setSelection({ type: "block", id: block.id });
    setEditingId(block.id);
  };

  const startConnect = (e: React.MouseEvent, block: Block) => {
    e.stopPropagation();
    setSelection({ type: "block", id: block.id });
    interactionRef.current = { type: "connect", from: block.id };
    setConnectPreview({
      from: block.id,
      worldX: block.x + block.w,
      worldY: block.y + block.h / 2,
    });
  };

  const selectEdge = (e: React.MouseEvent, edge: Edge) => {
    e.stopPropagation();
    setSelection({ type: "edge", id: edge.id });
  };

  const gridSize = GRID * view.scale;
  const dotSize = Math.max(0.6, Math.min(1.8, view.scale));

  return (
    <div
      ref={canvasRef}
      className="flow-canvas"
      style={{
        cursor: panning ? "grabbing" : "default",
        backgroundColor: "#0a0a0a",
        backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.18) ${dotSize}px, transparent ${dotSize}px)`,
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
    >
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          overflow: "visible",
        }}
      >
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#ffffff" />
          </marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {edges.map((edge) => {
            const from = blocks.find((b) => b.id === edge.from);
            const to = blocks.find((b) => b.id === edge.to);
            if (!from || !to) return null;
            const x1 = from.x + from.w;
            const y1 = from.y + from.h / 2;
            const x2 = to.x;
            const y2 = to.y + to.h / 2;
            const isSelected =
              selection?.type === "edge" && selection.id === edge.id;
            const d = edgePath(x1, y1, x2, y2);
            return (
              <g key={edge.id}>
                <path
                  d={d}
                  stroke="transparent"
                  strokeWidth={18 / view.scale}
                  fill="none"
                  pointerEvents="stroke"
                  style={{ cursor: "pointer" }}
                  onMouseDown={(e) => selectEdge(e, edge)}
                />
                <path
                  d={d}
                  stroke="#ffffff"
                  strokeOpacity={isSelected ? 1 : 0.85}
                  strokeWidth={(isSelected ? 2.5 : 1.5) / view.scale}
                  fill="none"
                  markerEnd="url(#flow-arrow)"
                  pointerEvents="none"
                />
              </g>
            );
          })}
          {connectPreview &&
            (() => {
              const from = blocks.find((b) => b.id === connectPreview.from);
              if (!from) return null;
              const x1 = from.x + from.w;
              const y1 = from.y + from.h / 2;
              return (
                <path
                  d={edgePath(x1, y1, connectPreview.worldX, connectPreview.worldY)}
                  stroke="#ffffff"
                  strokeOpacity={0.8}
                  strokeWidth={1.5 / view.scale}
                  strokeDasharray={`${6 / view.scale} ${4 / view.scale}`}
                  fill="none"
                />
              );
            })()}
        </g>
      </svg>

      <div
        className="flow-world"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        {blocks.map((b) => (
          <BlockView
            key={b.id}
            block={b}
            selected={selection?.type === "block" && selection.id === b.id}
            editing={editingId === b.id}
            onStartDrag={(e) => startBlockDrag(e, b)}
            onStartEdit={(e) => startEditing(e, b)}
            onStartConnect={(e) => startConnect(e, b)}
            onTextChange={(t) =>
              setBlocks((bs) =>
                bs.map((x) => (x.id === b.id ? { ...x, text: t } : x))
              )
            }
            onTextBlur={() => setEditingId(null)}
          />
        ))}
      </div>

      <div className="flow-label">flow</div>

      {blocks.length === 0 && (
        <div className="flow-hint">
          <div className="flow-hint-main">double-click anywhere to create a block</div>
          <div className="flow-hint-dim">hover a block, drag the dot to connect</div>
          <div className="flow-hint-dim">scroll to zoom &middot; drag to pan &middot; delete to remove</div>
        </div>
      )}
    </div>
  );
}

type BlockViewProps = {
  block: Block;
  selected: boolean;
  editing: boolean;
  onStartDrag: (e: React.MouseEvent) => void;
  onStartEdit: (e: React.MouseEvent) => void;
  onStartConnect: (e: React.MouseEvent) => void;
  onTextChange: (t: string) => void;
  onTextBlur: () => void;
};

function BlockView({
  block,
  selected,
  editing,
  onStartDrag,
  onStartEdit,
  onStartConnect,
  onTextChange,
  onTextBlur,
}: BlockViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Native dblclick on the block — for the same React-delegation reasons as the canvas
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      e.stopPropagation();
      onStartEdit(e as unknown as React.MouseEvent);
    };
    el.addEventListener("dblclick", handler);
    return () => el.removeEventListener("dblclick", handler);
  }, [onStartEdit]);

  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  useEffect(() => {
    if (
      ref.current &&
      document.activeElement !== ref.current &&
      ref.current.textContent !== block.text
    ) {
      ref.current.textContent = block.text;
    }
  }, [block.text]);

  return (
    <div
      ref={wrapRef}
      className={`flow-block${selected ? " is-selected" : ""}${
        editing ? " is-editing" : ""
      }`}
      style={{
        left: block.x,
        top: block.y,
        width: block.w,
        height: block.h,
      }}
      onMouseDown={onStartDrag}
    >
      <div
        ref={ref}
        className="flow-block-text"
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={(e) => {
          onTextChange(e.currentTarget.textContent || "");
          onTextBlur();
        }}
        onInput={(e) => onTextChange(e.currentTarget.textContent || "")}
        onMouseDown={(e) => {
          if (editing) e.stopPropagation();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).blur();
          }
        }}
      />
      <div
        className="flow-handle"
        onMouseDown={onStartConnect}
        title="Drag to connect"
      />
    </div>
  );
}
