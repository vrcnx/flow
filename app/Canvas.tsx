"use client";

import { useState, useRef, useEffect, useMemo } from "react";

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
type SearchState = { open: boolean; query: string; index: number };

const GRID = 24;
const BLOCK_W = 168; // 7 grid cells
const BLOCK_H = 72; // 3 grid cells
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const HISTORY_LIMIT = 200;
const STORAGE_CURRENT = "flow:current";
const STORAGE_SNAPSHOTS = "flow:snapshots";

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

function isExternalInputFocused() {
  const ae = document.activeElement;
  if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return true;
  // Treat block contentEditable separately from save manager / search input
  if (ae instanceof HTMLElement && ae.isContentEditable) return false;
  return false;
}

function looseDocValidate(value: unknown): Doc | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { blocks?: unknown; edges?: unknown };
  if (!Array.isArray(v.blocks) || !Array.isArray(v.edges)) return null;
  return { blocks: v.blocks as Block[], edges: v.edges as Edge[] };
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
  | {
      type: "connect";
      from: string;
      startMouseX: number;
      startMouseY: number;
    };

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
  const [search, setSearch] = useState<SearchState>({ open: false, query: "", index: 0 });
  const [managerOpen, setManagerOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<string, Doc>>({});
  const [, setTick] = useState(0);

  const blocks = doc.blocks;
  const edges = doc.edges;

  const canvasRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
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
  const initialLoadDoneRef = useRef(false);

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

  const commitHistory = () => {
    pendingCommitRef.current = true;
  };

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

  // Initial mount: center view, then load saved state from localStorage.
  useEffect(() => {
    if (canvasRef.current) {
      const r = canvasRef.current.getBoundingClientRect();
      setView({ x: r.width / 2, y: r.height / 2, scale: 1 });
    }
    try {
      const raw = localStorage.getItem(STORAGE_CURRENT);
      if (raw) {
        const parsed = looseDocValidate(JSON.parse(raw));
        if (parsed) {
          setDoc(parsed);
          historyRef.current = { stack: [parsed], index: 0 };
        }
      }
    } catch {
      // ignore corrupted storage
    }
    try {
      const raw = localStorage.getItem(STORAGE_SNAPSHOTS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const cleaned: Record<string, Doc> = {};
          for (const [name, val] of Object.entries(parsed)) {
            const d = looseDocValidate(val);
            if (d) cleaned[name] = d;
          }
          setSnapshots(cleaned);
        }
      }
    } catch {
      // ignore
    }
    initialLoadDoneRef.current = true;
  }, []);

  // Auto-save current doc to localStorage (debounced)
  useEffect(() => {
    if (!initialLoadDoneRef.current) return;
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_CURRENT, JSON.stringify(doc));
      } catch {
        // quota full / private mode; nothing to do
      }
    }, 250);
    return () => window.clearTimeout(id);
  }, [doc]);

  // Persist snapshots whenever they change
  useEffect(() => {
    if (!initialLoadDoneRef.current) return;
    try {
      localStorage.setItem(STORAGE_SNAPSHOTS, JSON.stringify(snapshots));
    } catch {
      // ignore
    }
  }, [snapshots]);

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
    const cur = docRef.current.blocks;
    while (cur.some((b) => b.id !== block.id && b.x === newX && b.y === newY)) {
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

  const clearAll = () => {
    if (docRef.current.blocks.length === 0 && docRef.current.edges.length === 0) return;
    setDoc(EMPTY_DOC);
    setSelection(null);
    setEditingId(null);
    setSearch({ open: false, query: "", index: 0 });
    commitHistory();
  };

  const commitText = (id: string, newText: string) => {
    const cur = docRef.current.blocks.find((b) => b.id === id);
    if (!cur || cur.text === newText) return;
    setBlocks((bs) =>
      bs.map((b) => (b.id === id ? { ...b, text: newText } : b))
    );
    commitHistory();
  };

  // Tab navigation between cards
  const navigateBlocks = (reverse: boolean) => {
    const wasEditing = !!editingIdRef.current;
    const sel = selectionRef.current;
    const list = docRef.current.blocks;
    if (list.length === 0) return;
    let nextIdx: number;
    if (sel?.type === "block") {
      const idx = list.findIndex((b) => b.id === sel.id);
      if (idx === -1) {
        nextIdx = reverse ? list.length - 1 : 0;
      } else {
        nextIdx = reverse
          ? (idx - 1 + list.length) % list.length
          : (idx + 1) % list.length;
      }
    } else {
      nextIdx = reverse ? list.length - 1 : 0;
    }
    const next = list[nextIdx];
    setSelection({ type: "block", id: next.id });
    setEditingId(wasEditing ? next.id : null);
    centerOn(next);
  };

  const centerOn = (block: Block) => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const v = viewRef.current;
    setView({
      scale: v.scale,
      x: rect.width / 2 - (block.x + block.w / 2) * v.scale,
      y: rect.height / 2 - (block.y + block.h / 2) * v.scale,
    });
  };

  // Search matches and pan-to-match
  const matches = useMemo(() => {
    if (!search.open || !search.query.trim()) return [] as Block[];
    const q = search.query.toLowerCase();
    return blocks.filter((b) => b.text.toLowerCase().includes(q));
  }, [search.open, search.query, blocks]);

  const matchedIds = useMemo(() => new Set(matches.map((m) => m.id)), [matches]);
  const currentMatch = matches.length > 0
    ? matches[Math.min(search.index, matches.length - 1)]
    : null;

  useEffect(() => {
    if (!search.open || !currentMatch) return;
    centerOn(currentMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch?.id]);

  // Save manager actions
  const saveSnapshot = (rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    setSnapshots((s) => ({ ...s, [name]: docRef.current }));
  };

  const loadSnapshot = (name: string) => {
    const s = snapshots[name];
    if (!s) return;
    setDoc(s);
    setSelection(null);
    setEditingId(null);
    commitHistory();
  };

  const deleteSnapshot = (name: string) => {
    setSnapshots((s) => {
      const next = { ...s };
      delete next[name];
      return next;
    });
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
        !t.closest(".flow-toolbar") &&
        !t.closest(".flow-search") &&
        !t.closest(".flow-manager");
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
        let changed = false;
        const fromId = s.from;
        if (rect) {
          const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
          const target = docRef.current.blocks.find(
            (b) =>
              w.x >= b.x &&
              w.x <= b.x + b.w &&
              w.y >= b.y &&
              w.y <= b.y + b.h &&
              b.id !== fromId
          );
          if (target) {
            setEdges((es) => {
              if (es.some((ed) => ed.from === fromId && ed.to === target.id))
                return es;
              return [...es, { id: uid(), from: fromId, to: target.id }];
            });
            changed = true;
          } else {
            // Drop on empty space → if the user actually dragged, spawn a
            // new card at the drop location and wire it up.
            const source = docRef.current.blocks.find((b) => b.id === fromId);
            const overSource =
              !!source &&
              w.x >= source.x &&
              w.x <= source.x + source.w &&
              w.y >= source.y &&
              w.y <= source.y + source.h;
            const ddx = e.clientX - s.startMouseX;
            const ddy = e.clientY - s.startMouseY;
            const draggedEnough = ddx * ddx + ddy * ddy > 20 * 20;
            if (source && !overSource && draggedEnough) {
              const newId = uid();
              const newX = snap(w.x - BLOCK_W / 2);
              const newY = snap(w.y - BLOCK_H / 2);
              setBlocks((bs) => [
                ...bs,
                { id: newId, x: newX, y: newY, w: BLOCK_W, h: BLOCK_H, text: "" },
              ]);
              setEdges((es) => [
                ...es,
                { id: uid(), from: fromId, to: newId },
              ]);
              setSelection({ type: "block", id: newId });
              setEditingId(newId);
              changed = true;
            }
          }
        }
        setConnectPreview(null);
        if (changed) commitHistory();
      } else if (s.type === "drag") {
        if (s.moved) commitHistory();
      }
      if (s.type !== "none") {
        interactionRef.current = { type: "none" };
        setPanning(false);
      }
    },
    key: (e) => {
      const externalInput = isExternalInputFocused();
      const editingBlock = !!editingIdRef.current;

      // Ctrl/Cmd+F: open the finder (always wins, even when editing)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearch((s) => ({ ...s, open: true }));
        queueMicrotask(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }

      // Tab / Shift+Tab: navigate cards
      if (e.key === "Tab") {
        if (externalInput) return; // browser handles tab inside search/manager inputs
        e.preventDefault();
        navigateBlocks(e.shiftKey);
        return;
      }

      // Undo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (editingBlock || externalInput) return;
        e.preventDefault();
        undo();
        return;
      }
      // Redo
      if (
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")
      ) {
        if (editingBlock || externalInput) return;
        e.preventDefault();
        redo();
        return;
      }

      if (e.key === "Escape") {
        if (search.open) {
          setSearch({ open: false, query: "", index: 0 });
        }
        if (managerOpen) setManagerOpen(false);
        setEditingId(null);
        setSelection(null);
        return;
      }

      // Enter on a selected block (not editing, not in input) → enter edit mode
      if (e.key === "Enter" && !editingBlock && !externalInput) {
        const sel = selectionRef.current;
        if (sel?.type === "block") {
          e.preventDefault();
          setEditingId(sel.id);
          return;
        }
      }

      if (editingBlock || externalInput) return;
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
    interactionRef.current = {
      type: "connect",
      from: block.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
    };
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
              const wx = connectPreview.worldX;
              const wy = connectPreview.worldY;

              const overTarget = blocks.find(
                (b) =>
                  b.id !== connectPreview.from &&
                  wx >= b.x &&
                  wx <= b.x + b.w &&
                  wy >= b.y &&
                  wy <= b.y + b.h
              );
              const overSource =
                wx >= from.x &&
                wx <= from.x + from.w &&
                wy >= from.y &&
                wy <= from.y + from.h;

              let lineEndX = wx;
              let lineEndY = wy;
              let ghost: { x: number; y: number } | null = null;
              if (!overTarget && !overSource) {
                const dx = wx - x1;
                const dy = wy - y1;
                if (dx * dx + dy * dy > (BLOCK_W * 0.3) * (BLOCK_W * 0.3)) {
                  const gx = snap(wx - BLOCK_W / 2);
                  const gy = snap(wy - BLOCK_H / 2);
                  ghost = { x: gx, y: gy };
                  lineEndX = gx;
                  lineEndY = gy + BLOCK_H / 2;
                }
              }

              return (
                <g>
                  <path
                    d={edgePath(x1, y1, lineEndX, lineEndY)}
                    stroke="#ffffff"
                    strokeOpacity={0.8}
                    strokeWidth={1.5 / view.scale}
                    strokeDasharray={`${6 / view.scale} ${4 / view.scale}`}
                    fill="none"
                  />
                  {ghost && (
                    <rect
                      x={ghost.x}
                      y={ghost.y}
                      width={BLOCK_W}
                      height={BLOCK_H}
                      rx={6}
                      fill="rgba(255, 255, 255, 0.02)"
                      stroke="#ffffff"
                      strokeOpacity={0.4}
                      strokeWidth={1.5 / view.scale}
                      strokeDasharray={`${5 / view.scale} ${4 / view.scale}`}
                    />
                  )}
                </g>
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
            matched={matchedIds.has(b.id)}
            isCurrentMatch={search.open && currentMatch?.id === b.id}
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
        onSearch={() => {
          setSearch((s) => ({ ...s, open: true }));
          queueMicrotask(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
          });
        }}
        onToggleManager={() => setManagerOpen((m) => !m)}
        managerOpen={managerOpen}
        onClear={clearAll}
      />

      {search.open && (
        <SearchBar
          inputRef={searchInputRef}
          query={search.query}
          matchIndex={matches.length === 0 ? 0 : Math.min(search.index, matches.length - 1)}
          matchCount={matches.length}
          onChange={(q) => setSearch({ open: true, query: q, index: 0 })}
          onNext={() =>
            setSearch((s) =>
              matches.length === 0
                ? s
                : { ...s, index: (Math.min(s.index, matches.length - 1) + 1) % matches.length }
            )
          }
          onPrev={() =>
            setSearch((s) =>
              matches.length === 0
                ? s
                : { ...s, index: (Math.min(s.index, matches.length - 1) - 1 + matches.length) % matches.length }
            )
          }
          onClose={() => setSearch({ open: false, query: "", index: 0 })}
        />
      )}

      {managerOpen && (
        <SaveManager
          snapshots={snapshots}
          onSave={(name) => saveSnapshot(name)}
          onLoad={(name) => loadSnapshot(name)}
          onDelete={(name) => deleteSnapshot(name)}
          onClose={() => setManagerOpen(false)}
        />
      )}

      {blocks.length === 0 && !managerOpen && (
        <div className="flow-hint">
          <div className="flow-hint-main">double-click anywhere to create a block</div>
          <div className="flow-hint-dim">drag from a card&rsquo;s dot to connect &middot; drop on empty space for a new card</div>
          <div className="flow-hint-dim">tab to navigate &middot; ctrl+f to find &middot; ctrl+z to undo</div>
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
  onSearch: () => void;
  onToggleManager: () => void;
  managerOpen: boolean;
  onClear: () => void;
};

function Toolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAdd,
  onReset,
  onSearch,
  onToggleManager,
  managerOpen,
  onClear,
}: ToolbarProps) {
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
      <div className="flow-toolbar-divider" />
      <ToolbarButton tip="Find (Ctrl+F)" onClick={onSearch}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M20 20l-4.2-4.2" />
        </svg>
      </ToolbarButton>
      <ToolbarButton
        tip={managerOpen ? "Hide saved flows" : "Saved flows"}
        onClick={onToggleManager}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M4 5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" />
          <path d="M14 3v6h6" />
        </svg>
      </ToolbarButton>
      <ToolbarButton tip="Clear canvas" onClick={onClear}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M4 7h16" />
          <path d="M10 11v6M14 11v6" />
          <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
          <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
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

type SearchBarProps = {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  matchIndex: number;
  matchCount: number;
  onChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
};

function SearchBar({
  inputRef,
  query,
  matchIndex,
  matchCount,
  onChange,
  onNext,
  onPrev,
  onClose,
}: SearchBarProps) {
  return (
    <div
      className="flow-search"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <svg viewBox="0 0 24 24" className="flow-search-icon" aria-hidden>
        <circle cx="11" cy="11" r="6.5" />
        <path d="M20 20l-4.2-4.2" />
      </svg>
      <input
        ref={inputRef}
        className="flow-search-input"
        value={query}
        placeholder="Find a card&hellip;"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="flow-search-count">
        {matchCount === 0 ? "0 / 0" : `${matchIndex + 1} / ${matchCount}`}
      </span>
      <button
        type="button"
        className="flow-search-nav"
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="Previous match"
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M15 6l-6 6 6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="flow-search-nav"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match"
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="flow-search-close"
        onClick={onClose}
        aria-label="Close search"
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
    </div>
  );
}

type SaveManagerProps = {
  snapshots: Record<string, Doc>;
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
};

function SaveManager({ snapshots, onSave, onLoad, onDelete, onClose }: SaveManagerProps) {
  const [name, setName] = useState("");
  const names = Object.keys(snapshots).sort((a, b) => a.localeCompare(b));

  const handleSave = () => {
    const t = name.trim();
    if (!t) return;
    onSave(t);
    setName("");
  };

  return (
    <div
      className="flow-manager"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="flow-manager-header">
        <span>Saved flows</span>
        <button
          type="button"
          className="flow-manager-close"
          onClick={onClose}
          aria-label="Close save manager"
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      </div>
      <div className="flow-manager-list">
        {names.length === 0 ? (
          <div className="flow-manager-empty">No snapshots yet. Save one below.</div>
        ) : (
          names.map((n) => (
            <div className="flow-manager-row" key={n}>
              <button
                type="button"
                className="flow-manager-load"
                onClick={() => onLoad(n)}
                title="Load this flow"
              >
                {n}
              </button>
              <button
                type="button"
                className="flow-manager-delete"
                onClick={() => onDelete(n)}
                aria-label={`Delete ${n}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M6 6l12 12M6 18L18 6" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
      <div className="flow-manager-save">
        <input
          className="flow-manager-input"
          value={name}
          placeholder="Snapshot name"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSave();
            }
          }}
        />
        <button
          type="button"
          className="flow-manager-save-btn"
          onClick={handleSave}
          disabled={!name.trim()}
        >
          Save
        </button>
      </div>
      <div className="flow-manager-foot">Auto-saved to this browser</div>
    </div>
  );
}

type BlockViewProps = {
  block: Block;
  selected: boolean;
  editing: boolean;
  matched: boolean;
  isCurrentMatch: boolean;
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
  matched,
  isCurrentMatch,
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
      }${matched ? " is-match" : ""}${isCurrentMatch ? " is-current-match" : ""}`}
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
        title="Drag to connect &middot; double-click to extend"
      />
    </div>
  );
}
