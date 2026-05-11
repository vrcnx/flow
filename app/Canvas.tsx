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
type Doc = { blocks: Block[]; edges: Edge[] };
type View = { x: number; y: number; scale: number };
type Selection = { type: "block" | "edge"; id: string } | null;

const GRID = 24;
const BLOCK_W = 168; // 7 grid cells
const BLOCK_H = 72; // 3 grid cells
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const HISTORY_LIMIT = 200;

const EMPTY_DOC: Doc = { blocks: [], edges: [] };

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function snap(p: number) {
  return Math.round(p / GRID) * GRID;
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
      moved: boolean;
    }
  | { type: "connect"; from: string };

export default function Canvas() {
  const [doc, setDocState] = useState<Doc>(EMPTY_DOC);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [connectPreview, setConnectPreview] = useState<{
    from: string;
    worldX: number;
    worldY: number;
  } | null>(null);
  const [panning, setPanning] = useState(false);
  const [, setTick] = useState(0);

  const blocks = doc.blocks;
  const edges = doc.edges;

  const canvasRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const docRef = useRef(doc);
  docRef.current = doc;
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const interactionRef = useRef<Interaction>({ type: "none" });
  const historyRef = useRef<{ stack: Doc[]; index: number }>({
    stack: [EMPTY_DOC],
    index: 0,
  });
  const pendingCommitRef = useRef(false);

  const refresh = () => setTick((t) => t + 1);

  const setDoc = (updater: Doc | ((d: Doc) => Doc)) => {
    setDocState((d) => (typeof updater === "function" ? updater(d) : updater));
  };

  const setBlocks = (updater: Block[] | ((bs: Block[]) => Block[])) => {
    setDoc((d) => ({
      ...d,
      blocks: typeof updater === "function" ? updater(d.blocks) : updater,
    }));
  };

  const setEdges = (updater: Edge[] | ((es: Edge[]) => Edge[])) => {
    setDoc((d) => ({
      ...d,
      edges: typeof updater === "function" ? updater(d.edges) : updater,
    }));
  };

  // Mark that the next render's doc should be pushed to history.
  const commitHistory = () => {
    pendingCommitRef.current = true;
  };

  // After every render, if a commit was requested and the doc actually changed
  // since the last commit, push it onto the history stack.
  useEffect(() => {
    if (!pendingCommitRef.current) return;
    const h = historyRef.current;
    const top = h.stack[h.index];
    if (top === doc) {
      pendingCommitRef.current = false;
      return;
    }
    pendingCommitRef.current = false;
    const stack = [...h.stack.slice(0, h.index + 1), doc];
    while (stack.length > HISTORY_LIMIT) stack.shift();
    h.stack = stack;
    h.index = stack.length - 1;
    refresh();
  }, [doc]);

  const undo = () => {
    const h = historyRef.current;
    if (h.index <= 0) return;
    h.index -= 1;
    pendingCommitRef.current = false;
    setEditingId(null);
    setDoc(h.stack[h.index]);
    refresh();
  };

  const redo = () => {
    const h = historyRef.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    pendingCommitRef.current = false;
    setEditingId(null);
    setDoc(h.stack[h.index]);
    refresh();
  };

  const canUndo = historyRef.current.index > 0;
  const canRedo = historyRef.current.index < historyRef.current.stack.length - 1;

  const screenToWorld = (sx: number, sy: number) => {
    const v = viewRef.current;
    return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale };
  };

  // Center on mount so blocks created near origin appear in the middle
  useEffect(() => {
    if (canvasRef.current) {
      const r = canvasRef.current.getBoundingClientRect();
      setView({ x: r.width / 2, y: r.height / 2, scale: 1 });
    }
  }, []);

  const createBlockAtWorld = (wx: number, wy: number, focus: boolean) => {
    const id = uid();
    const x = snap(wx - BLOCK_W / 2);
    const y = snap(wy - BLOCK_H / 2);
    setBlocks((bs) => [...bs, { id, x, y, w: BLOCK_W, h: BLOCK_H, text: "" }]);
    setSelection({ type: "block", id });
    if (focus) setEditingId(id);
    commitHistory();
    return id;
  };

  const extendFrom = (block: Block) => {
    const id = uid();
    let newX = snap(block.x + block.w + GRID * 2);
    let newY = snap(block.y);
    // Avoid stacking on top of an existing block to the right
    const cur = docRef.current.blocks;
    while (
      cur.some(
        (b) => b.id !== block.id && b.x === newX && b.y === newY
      )
    ) {
      newY += BLOCK_H + GRID;
    }
    setBlocks((bs) => [
      ...bs,
      { id, x: newX, y: newY, w: BLOCK_W, h: BLOCK_H, text: "" },
    ]);
    setEdges((es) => {
      if (es.some((ed) => ed.from === block.id && ed.to === id)) return es;
      return [...es, { id: uid(), from: block.id, to: id }];
    });
    setSelection({ type: "block", id });
    setEditingId(id);
    commitHistory();
  };

  const addBlockAtCenter = () => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = screenToWorld(rect.width / 2, rect.height / 2);
    createBlockAtWorld(w.x, w.y, true);
  };

  const resetView = () => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setView({ x: rect.width / 2, y: rect.height / 2, scale: 1 });
  };

  const commitText = (id: string, newText: string) => {
    const cur = docRef.current.blocks.find((b) => b.id === id);
    if (!cur || cur.text === newText) return;
    setBlocks((bs) =>
      bs.map((b) => (b.id === id ? { ...b, text: newText } : b))
    );
    commitHistory();
  };

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
      createBlockAtWorld(w.x, w.y, true);
      interactionRef.current = { type: "none" };
      setPanning(false);
    },
    wheel: (e) => {
      const t = e.target;
      const onCanvas =
        t instanceof Element &&
        !!t.closest(".flow-canvas") &&
        !t.closest(".flow-toolbar");
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
      setView({
        scale: newScale,
        x: mx - wx * newScale,
        y: my - wy * newScale,
      });
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
        const newX = snap(s.startBlockX + dx);
        const newY = snap(s.startBlockY + dy);
        const cur = docRef.current.blocks.find((b) => b.id === s.id);
        if (!cur) return;
        if (cur.x === newX && cur.y === newY) {
          if (!s.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
            interactionRef.current = { ...s, moved: true };
          }
          return;
        }
        if (!s.moved) {
          interactionRef.current = { ...s, moved: true };
        }
        setBlocks((bs) =>
          bs.map((b) => (b.id === s.id ? { ...b, x: newX, y: newY } : b))
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
        let added = false;
        if (rect) {
          const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
          const target = docRef.current.blocks.find(
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
              if (es.some((ed) => ed.from === fromId && ed.to === target.id))
                return es;
              return [...es, { id: uid(), from: fromId, to: target.id }];
            });
            added = true;
          }
        }
        setConnectPreview(null);
        if (added) commitHistory();
      } else if (s.type === "drag") {
        if (s.moved) commitHistory();
      }
      if (s.type !== "none") {
        interactionRef.current = { type: "none" };
        setPanning(false);
      }
    },
    key: (e) => {
      // Undo
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        if (editingIdRef.current) return; // browser handles native undo in contentEditable
        e.preventDefault();
        undo();
        return;
      }
      // Redo
      if (
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")
      ) {
        if (editingIdRef.current) return;
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Escape") {
        setEditingId(null);
        setSelection(null);
        return;
      }
      if (editingIdRef.current) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selectionRef.current;
        let changed = false;
        if (sel?.type === "block") {
          const id = sel.id;
          setBlocks((bs) => bs.filter((b) => b.id !== id));
          setEdges((es) => es.filter((ed) => ed.from !== id && ed.to !== id));
          setSelection(null);
          changed = true;
        } else if (sel?.type === "edge") {
          const id = sel.id;
          setEdges((es) => es.filter((ed) => ed.id !== id));
          setSelection(null);
          changed = true;
        }
        if (changed) commitHistory();
      }
    },
  };

  if (typeof window !== "undefined") {
    window.__flowHandlers = handlers;
  }

  useEffect(() => {
    if (window.__flowAttached) return;
    window.__flowAttached = true;
    const proxy =
      <T extends Event>(name: keyof HandlerBag) =>
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
      moved: false,
    };
  };

  const startEditing = (block: Block) => {
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
            onStartEdit={() => startEditing(b)}
            onStartConnect={(e) => startConnect(e, b)}
            onExtend={() => extendFrom(b)}
            onTextChange={(t) =>
              setBlocks((bs) =>
                bs.map((x) => (x.id === b.id ? { ...x, text: t } : x))
              )
            }
            onTextBlur={(finalText) => {
              setEditingId(null);
              commitText(b.id, finalText);
            }}
          />
        ))}
      </div>

      <div className="flow-label">flow</div>

      <Toolbar
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onAdd={addBlockAtCenter}
        onReset={resetView}
      />

      {blocks.length === 0 && (
        <div className="flow-hint">
          <div className="flow-hint-main">double-click anywhere to create a block</div>
          <div className="flow-hint-dim">hover a block, drag the dot to connect &middot; double-click the dot to extend</div>
          <div className="flow-hint-dim">scroll to zoom &middot; drag to pan &middot; delete to remove &middot; ctrl+z to undo</div>
        </div>
      )}
    </div>
  );
}

type ToolbarProps = {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAdd: () => void;
  onReset: () => void;
};

function Toolbar({ canUndo, canRedo, onUndo, onRedo, onAdd, onReset }: ToolbarProps) {
  return (
    <div
      className="flow-toolbar"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <ToolbarButton tip="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M9 14l-4-4 4-4" />
          <path d="M5 10h9a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5h-4" />
        </svg>
      </ToolbarButton>
      <ToolbarButton tip="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M15 14l4-4-4-4" />
          <path d="M19 10h-9a5 5 0 0 0-5 5v0a5 5 0 0 0 5 5h4" />
        </svg>
      </ToolbarButton>
      <div className="flow-toolbar-divider" />
      <ToolbarButton tip="Add block" onClick={onAdd}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      </ToolbarButton>
      <ToolbarButton tip="Reset view" onClick={onReset}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  tip,
  disabled,
  onClick,
  children,
}: {
  tip: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      className="flow-toolbar-button"
    >
      {children}
    </button>
  );
}

type BlockViewProps = {
  block: Block;
  selected: boolean;
  editing: boolean;
  onStartDrag: (e: React.MouseEvent) => void;
  onStartEdit: () => void;
  onStartConnect: (e: React.MouseEvent) => void;
  onExtend: () => void;
  onTextChange: (t: string) => void;
  onTextBlur: (finalText: string) => void;
};

function BlockView({
  block,
  selected,
  editing,
  onStartDrag,
  onStartEdit,
  onStartConnect,
  onExtend,
  onTextChange,
  onTextBlur,
}: BlockViewProps) {
  const textRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  // Native dblclick on the block body — for the same React-delegation reasons
  // as the canvas listeners.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(".flow-handle")) return;
      e.stopPropagation();
      onStartEdit();
    };
    el.addEventListener("dblclick", handler);
    return () => el.removeEventListener("dblclick", handler);
  }, [onStartEdit]);

  // Native dblclick on the connection handle → auto-extend a new connected card.
  useEffect(() => {
    const el = handleRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onExtend();
    };
    el.addEventListener("dblclick", handler);
    return () => el.removeEventListener("dblclick", handler);
  }, [onExtend]);

  useEffect(() => {
    if (editing && textRef.current) {
      textRef.current.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(textRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  useEffect(() => {
    if (
      textRef.current &&
      document.activeElement !== textRef.current &&
      textRef.current.textContent !== block.text
    ) {
      textRef.current.textContent = block.text;
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
        ref={textRef}
        className="flow-block-text"
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={(e) => onTextBlur(e.currentTarget.textContent || "")}
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
        ref={handleRef}
        className="flow-handle"
        onMouseDown={onStartConnect}
        title="Drag to connect · double-click to extend"
      />
    </div>
  );
}
