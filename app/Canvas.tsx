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
  ctx?: (e: MouseEvent) => void;
};

declare global {
  interface Window {
    __flowHandlers?: HandlerBag;
    __flowAttachVersion?: number;
    __flowDetach?: () => void;
  }
}

// Bump this whenever the listener set changes — forces previous-build
// listeners (from HMR) to be torn down so the new set takes effect cleanly.
const ATTACH_VERSION = 3;

type Block = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
};
type Title = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
};
type Edge = { id: string; from: string; to: string };
type Doc = { blocks: Block[]; edges: Edge[]; titles: Title[] };
type View = { x: number; y: number; scale: number };
type Selection = { type: "block" | "edge" | "title"; id: string } | null;
type SearchState = { open: boolean; query: string; index: number };

type MenuItem =
  | { kind: "action"; label: string; shortcut?: string; destructive?: boolean; onClick: () => void; disabled?: boolean }
  | { kind: "divider" };

type ContextMenuState = { x: number; y: number; items: MenuItem[] } | null;

const GRID = 24;
const BLOCK_W = 168; // 7 grid cells
const BLOCK_H = 72; // 3 grid cells
const TITLE_W = 240; // 10 grid cells
const TITLE_H = 48; // 2 grid cells
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const HISTORY_LIMIT = 200;
const STORAGE_CURRENT = "flow:current";
const STORAGE_SNAPSHOTS = "flow:snapshots";

const EMPTY_DOC: Doc = { blocks: [], edges: [], titles: [] };

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
  return false;
}

function looseDocValidate(value: unknown): Doc | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { blocks?: unknown; edges?: unknown; titles?: unknown };
  if (!Array.isArray(v.blocks) || !Array.isArray(v.edges)) return null;
  return {
    blocks: v.blocks as Block[],
    edges: v.edges as Edge[],
    titles: Array.isArray(v.titles) ? (v.titles as Title[]) : [],
  };
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
      kind: "block" | "title";
      id: string;
      startMouseX: number;
      startMouseY: number;
      startX: number;
      startY: number;
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
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [, setTick] = useState(0);

  const blocks = doc.blocks;
  const edges = doc.edges;
  const titles = doc.titles;

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

  const setTitles = (updater: Title[] | ((ts: Title[]) => Title[])) => {
    setDoc((d) => ({
      ...d,
      titles: typeof updater === "function" ? updater(d.titles) : updater,
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

  const eventToWorld = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
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
      // ignore
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
        // ignore
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

  // ───────────────  Creation / mutation helpers  ───────────────

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

  const createTitleAtWorld = (wx: number, wy: number, focus: boolean) => {
    const id = uid();
    const x = snap(wx - TITLE_W / 2);
    const y = snap(wy - TITLE_H / 2);
    setTitles((ts) => [...ts, { id, x, y, w: TITLE_W, h: TITLE_H, text: "" }]);
    setSelection({ type: "title", id });
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

  const duplicateBlock = (block: Block) => {
    const id = uid();
    const x = snap(block.x + GRID * 2);
    const y = snap(block.y + GRID * 2);
    setBlocks((bs) => [...bs, { id, x, y, w: block.w, h: block.h, text: block.text }]);
    setSelection({ type: "block", id });
    commitHistory();
  };

  const duplicateTitle = (title: Title) => {
    const id = uid();
    const x = snap(title.x + GRID * 2);
    const y = snap(title.y + GRID * 2);
    setTitles((ts) => [...ts, { id, x, y, w: title.w, h: title.h, text: title.text }]);
    setSelection({ type: "title", id });
    commitHistory();
  };

  const deleteBlock = (id: string) => {
    setBlocks((bs) => bs.filter((b) => b.id !== id));
    setEdges((es) => es.filter((ed) => ed.from !== id && ed.to !== id));
    setSelection((s) => (s?.type === "block" && s.id === id ? null : s));
    setEditingId((e) => (e === id ? null : e));
    commitHistory();
  };

  const deleteTitle = (id: string) => {
    setTitles((ts) => ts.filter((t) => t.id !== id));
    setSelection((s) => (s?.type === "title" && s.id === id ? null : s));
    setEditingId((e) => (e === id ? null : e));
    commitHistory();
  };

  const deleteEdge = (id: string) => {
    setEdges((es) => es.filter((ed) => ed.id !== id));
    setSelection((s) => (s?.type === "edge" && s.id === id ? null : s));
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

  const newFlow = () => {
    const empty =
      docRef.current.blocks.length === 0 &&
      docRef.current.edges.length === 0 &&
      docRef.current.titles.length === 0;
    setSelection(null);
    setEditingId(null);
    setSearch({ open: false, query: "", index: 0 });
    setContextMenu(null);
    if (!empty) {
      setDoc(EMPTY_DOC);
      commitHistory();
    }
    const el = canvasRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      setView({ x: rect.width / 2, y: rect.height / 2, scale: 1 });
    }
  };

  const commitText = (id: string, newText: string) => {
    const b = docRef.current.blocks.find((x) => x.id === id);
    if (b) {
      if (b.text !== newText) {
        setBlocks((bs) =>
          bs.map((x) => (x.id === id ? { ...x, text: newText } : x))
        );
        commitHistory();
      }
      return;
    }
    const t = docRef.current.titles.find((x) => x.id === id);
    if (t) {
      const trimmed = newText.trim();
      if (trimmed === "" && t.text.trim() === "") {
        // brand-new empty title that the user dismissed — discard it
        setTitles((ts) => ts.filter((x) => x.id !== id));
        commitHistory();
        return;
      }
      if (t.text !== newText) {
        setTitles((ts) =>
          ts.map((x) => (x.id === id ? { ...x, text: newText } : x))
        );
        commitHistory();
      }
    }
  };

  // Tab navigation only walks blocks (titles are floating labels).
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

  const centerOn = (rect: { x: number; y: number; w: number; h: number }) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const v = viewRef.current;
    setView({
      scale: v.scale,
      x: r.width / 2 - (rect.x + rect.w / 2) * v.scale,
      y: r.height / 2 - (rect.y + rect.h / 2) * v.scale,
    });
  };

  // Search across both blocks and titles
  const matches = useMemo(() => {
    if (!search.open || !search.query.trim()) return [] as Array<Block | Title>;
    const q = search.query.toLowerCase();
    const blockHits = blocks.filter((b) => b.text.toLowerCase().includes(q));
    const titleHits = titles.filter((t) => t.text.toLowerCase().includes(q));
    return [...blockHits, ...titleHits];
  }, [search.open, search.query, blocks, titles]);

  const matchedIds = useMemo(() => new Set(matches.map((m) => m.id)), [matches]);
  const currentMatch = matches.length > 0
    ? matches[Math.min(search.index, matches.length - 1)]
    : null;

  useEffect(() => {
    if (!search.open || !currentMatch) return;
    centerOn(currentMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch?.id]);

  // ───────────────  Save manager actions  ───────────────

  const exportDoc = () => {
    try {
      const json = JSON.stringify(docRef.current, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `flow-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so the download triggers reliably first.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.warn("[flow] export failed", err);
    }
  };

  const importDoc = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      file
        .text()
        .then((text) => {
          let parsed: Doc | null = null;
          try {
            parsed = looseDocValidate(JSON.parse(text));
          } catch {
            parsed = null;
          }
          if (!parsed) {
            window.alert("That file doesn't look like a flow JSON.");
            return;
          }
          setDoc(parsed);
          setSelection(null);
          setEditingId(null);
          setSearch({ open: false, query: "", index: 0 });
          commitHistory();
          const el = canvasRef.current;
          if (el) {
            const rect = el.getBoundingClientRect();
            setView({ x: rect.width / 2, y: rect.height / 2, scale: 1 });
          }
        })
        .catch((err) => {
          console.warn("[flow] import failed", err);
          window.alert("Failed to read that file.");
        });
    };
    document.body.appendChild(input);
    input.click();
  };

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

  // ───────────────  Context menu  ───────────────

  const positionMenu = (cx: number, cy: number, itemCount: number) => {
    const menuWidth = 196;
    const approxItemH = 30;
    const padding = 8;
    const menuHeight = itemCount * approxItemH + 8;
    let x = cx;
    let y = cy;
    if (x + menuWidth + padding > window.innerWidth) x = Math.max(padding, x - menuWidth);
    if (y + menuHeight + padding > window.innerHeight) y = Math.max(padding, y - menuHeight);
    return { x, y };
  };

  const buildCanvasMenu = (worldX: number, worldY: number): MenuItem[] => [
    {
      kind: "action",
      label: "New block",
      onClick: () => createBlockAtWorld(worldX, worldY, true),
    },
    {
      kind: "action",
      label: "New title",
      onClick: () => createTitleAtWorld(worldX, worldY, true),
    },
    { kind: "divider" },
    {
      kind: "action",
      label: "Find…",
      shortcut: "Ctrl+F",
      onClick: () => {
        setSearch((s) => ({ ...s, open: true }));
        queueMicrotask(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      },
    },
    { kind: "action", label: "Reset view", onClick: resetView },
  ];

  const buildBlockMenu = (block: Block): MenuItem[] => [
    {
      kind: "action",
      label: "Edit text",
      onClick: () => {
        setSelection({ type: "block", id: block.id });
        setEditingId(block.id);
      },
    },
    { kind: "action", label: "Extend right", onClick: () => extendFrom(block) },
    { kind: "action", label: "Duplicate", onClick: () => duplicateBlock(block) },
    { kind: "divider" },
    {
      kind: "action",
      label: "Delete",
      shortcut: "Del",
      destructive: true,
      onClick: () => deleteBlock(block.id),
    },
  ];

  const buildTitleMenu = (title: Title): MenuItem[] => [
    {
      kind: "action",
      label: "Edit text",
      onClick: () => {
        setSelection({ type: "title", id: title.id });
        setEditingId(title.id);
      },
    },
    { kind: "action", label: "Duplicate", onClick: () => duplicateTitle(title) },
    { kind: "divider" },
    {
      kind: "action",
      label: "Delete",
      shortcut: "Del",
      destructive: true,
      onClick: () => deleteTitle(title.id),
    },
  ];

  const buildEdgeMenu = (edge: Edge): MenuItem[] => [
    {
      kind: "action",
      label: "Delete arrow",
      shortcut: "Del",
      destructive: true,
      onClick: () => deleteEdge(edge.id),
    },
  ];

  const openContextMenuForEvent = (e: MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest(".flow-toolbar")) {
      // suppress browser menu over toolbar but offer nothing custom
      return;
    }
    if (e.target.closest(".flow-search") || e.target.closest(".flow-manager") || e.target.closest(".flow-context-menu")) {
      // let inputs have their native menu for paste etc.
      e.stopPropagation();
      return;
    }
    if (!e.target.closest(".flow-canvas")) return;

    let items: MenuItem[] | null = null;

    const blockEl = e.target.closest('[data-node-kind="block"]') as HTMLElement | null;
    const titleEl = e.target.closest('[data-node-kind="title"]') as HTMLElement | null;
    const edgeId = e.target instanceof Element ? e.target.getAttribute("data-edge-id") : null;

    if (blockEl) {
      const id = blockEl.getAttribute("data-id") || "";
      const block = docRef.current.blocks.find((b) => b.id === id);
      if (block) {
        items = buildBlockMenu(block);
        setSelection({ type: "block", id });
      }
    } else if (titleEl) {
      const id = titleEl.getAttribute("data-id") || "";
      const title = docRef.current.titles.find((t) => t.id === id);
      if (title) {
        items = buildTitleMenu(title);
        setSelection({ type: "title", id });
      }
    } else if (edgeId) {
      const edge = docRef.current.edges.find((ed) => ed.id === edgeId);
      if (edge) {
        items = buildEdgeMenu(edge);
        setSelection({ type: "edge", id: edge.id });
      }
    } else {
      const w = eventToWorld(e);
      items = buildCanvasMenu(w.x, w.y);
    }

    if (!items) return;
    const { x, y } = positionMenu(e.clientX, e.clientY, items.length);
    setContextMenu({ x, y, items });
    setEditingId(null);
  };

  // ───────────────  Native event handlers  ───────────────

  const handlers: HandlerBag = {
    down: (e) => {
      // Any mousedown outside the menu dismisses it.
      if (contextMenu) {
        const t = e.target;
        if (!(t instanceof Element) || !t.closest(".flow-context-menu")) {
          setContextMenu(null);
        }
      }
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
      const w = eventToWorld(e);
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
        !t.closest(".flow-manager") &&
        !t.closest(".flow-context-menu");
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
        const newX = snap(s.startX + dx);
        const newY = snap(s.startY + dy);
        const list = s.kind === "block" ? docRef.current.blocks : docRef.current.titles;
        const cur = list.find((b) => b.id === s.id);
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
        if (s.kind === "block") {
          setBlocks((bs) =>
            bs.map((b) => (b.id === s.id ? { ...b, x: newX, y: newY } : b))
          );
        } else {
          setTitles((ts) =>
            ts.map((b) => (b.id === s.id ? { ...b, x: newX, y: newY } : b))
          );
        }
      } else if (s.type === "connect") {
        const w = eventToWorld(e);
        setConnectPreview({ from: s.from, worldX: w.x, worldY: w.y });
      }
    },
    up: (e) => {
      const s = interactionRef.current;
      if (s.type === "connect") {
        let changed = false;
        const fromId = s.from;
        const w = eventToWorld(e);
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

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearch((s) => ({ ...s, open: true }));
        queueMicrotask(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }

      if (e.key === "Tab") {
        if (externalInput) return;
        e.preventDefault();
        navigateBlocks(e.shiftKey);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        if (editingBlock || externalInput) return;
        e.preventDefault();
        undo();
        return;
      }
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
        if (contextMenu) setContextMenu(null);
        if (search.open) setSearch({ open: false, query: "", index: 0 });
        if (managerOpen) setManagerOpen(false);
        setEditingId(null);
        setSelection(null);
        return;
      }

      if (e.key === "Enter" && !editingBlock && !externalInput) {
        const sel = selectionRef.current;
        if (sel?.type === "block" || sel?.type === "title") {
          e.preventDefault();
          setEditingId(sel.id);
          return;
        }
      }

      if (editingBlock || externalInput) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selectionRef.current;
        if (sel?.type === "block") deleteBlock(sel.id);
        else if (sel?.type === "title") deleteTitle(sel.id);
        else if (sel?.type === "edge") deleteEdge(sel.id);
      }
    },
    ctx: (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest(".flow-search") || e.target.closest(".flow-manager") || e.target.closest(".flow-context-menu")) {
        // Allow native menu inside inputs and inside our menu itself
        return;
      }
      e.preventDefault();
      openContextMenuForEvent(e);
    },
  };

  if (typeof window !== "undefined") {
    window.__flowHandlers = handlers;
  }

  useEffect(() => {
    if (window.__flowAttachVersion === ATTACH_VERSION) return;
    // Tear down any previous-version listeners before attaching this set.
    window.__flowDetach?.();

    const proxy =
      <T extends Event>(name: keyof HandlerBag) =>
      ((e: T) => window.__flowHandlers?.[name]?.(e as never)) as EventListener;
    const downP = proxy<MouseEvent>("down");
    const dblP = proxy<MouseEvent>("dbl");
    const wheelP = proxy<WheelEvent>("wheel");
    const ctxP = proxy<MouseEvent>("ctx");
    const moveP = proxy<MouseEvent>("move");
    const upP = proxy<MouseEvent>("up");
    const keyP = proxy<KeyboardEvent>("key");

    document.addEventListener("mousedown", downP);
    document.addEventListener("dblclick", dblP);
    document.addEventListener("wheel", wheelP, { passive: false });
    document.addEventListener("contextmenu", ctxP);
    window.addEventListener("mousemove", moveP);
    window.addEventListener("mouseup", upP);
    window.addEventListener("keydown", keyP);

    window.__flowAttachVersion = ATTACH_VERSION;
    window.__flowDetach = () => {
      document.removeEventListener("mousedown", downP);
      document.removeEventListener("dblclick", dblP);
      document.removeEventListener("wheel", wheelP);
      document.removeEventListener("contextmenu", ctxP);
      window.removeEventListener("mousemove", moveP);
      window.removeEventListener("mouseup", upP);
      window.removeEventListener("keydown", keyP);
      delete window.__flowAttachVersion;
      delete window.__flowDetach;
    };
  }, []);

  // ───────────────  React-side per-node handlers  ───────────────

  const startBlockDrag = (e: React.MouseEvent, block: Block) => {
    if (editingId === block.id) return;
    e.stopPropagation();
    setSelection({ type: "block", id: block.id });
    interactionRef.current = {
      type: "drag",
      kind: "block",
      id: block.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startX: block.x,
      startY: block.y,
      moved: false,
    };
  };

  const startTitleDrag = (e: React.MouseEvent, title: Title) => {
    if (editingId === title.id) return;
    e.stopPropagation();
    setSelection({ type: "title", id: title.id });
    interactionRef.current = {
      type: "drag",
      kind: "title",
      id: title.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startX: title.x,
      startY: title.y,
      moved: false,
    };
  };

  const startEditingBlock = (block: Block) => {
    setSelection({ type: "block", id: block.id });
    setEditingId(block.id);
  };

  const startEditingTitle = (title: Title) => {
    setSelection({ type: "title", id: title.id });
    setEditingId(title.id);
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
              <g key={edge.id} data-edge-id={edge.id}>
                <path
                  d={d}
                  stroke="transparent"
                  strokeWidth={18 / view.scale}
                  fill="none"
                  pointerEvents="stroke"
                  style={{ cursor: "pointer" }}
                  data-edge-id={edge.id}
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
        {titles.map((t) => (
          <TitleView
            key={t.id}
            title={t}
            selected={selection?.type === "title" && selection.id === t.id}
            editing={editingId === t.id}
            matched={matchedIds.has(t.id)}
            isCurrentMatch={search.open && currentMatch?.id === t.id}
            onStartDrag={(e) => startTitleDrag(e, t)}
            onStartEdit={() => startEditingTitle(t)}
            onTextChange={(nt) =>
              setTitles((ts) =>
                ts.map((x) => (x.id === t.id ? { ...x, text: nt } : x))
              )
            }
            onTextBlur={(finalText) => {
              setEditingId(null);
              commitText(t.id, finalText);
            }}
          />
        ))}
        {blocks.map((b) => (
          <BlockView
            key={b.id}
            block={b}
            selected={selection?.type === "block" && selection.id === b.id}
            editing={editingId === b.id}
            matched={matchedIds.has(b.id)}
            isCurrentMatch={search.open && currentMatch?.id === b.id}
            onStartDrag={(e) => startBlockDrag(e, b)}
            onStartEdit={() => startEditingBlock(b)}
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
        onNewFlow={newFlow}
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
          onExport={exportDoc}
          onImport={importDoc}
          onClose={() => setManagerOpen(false)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {blocks.length === 0 && titles.length === 0 && !managerOpen && (
        <div className="flow-hint">
          <div className="flow-hint-main">double-click anywhere to create a block</div>
          <div className="flow-hint-dim">right-click for the menu &middot; drop a drag on empty space for a new card</div>
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
  onNewFlow: () => void;
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
  onNewFlow,
}: ToolbarProps) {
  return (
    <div
      className="flow-toolbar"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
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
      <div className="flow-toolbar-divider" />
      <ToolbarButton tip="New flow" onClick={onNewFlow}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M5 4a1 1 0 0 1 1-1h7l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4z" />
          <path d="M13 3v4h4" />
          <path d="M9 14h6M12 11v6" />
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

type ContextMenuProps = {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
};

function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  return (
    <div
      className="flow-context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.kind === "divider") {
          return <div key={i} className="flow-context-divider" />;
        }
        return (
          <button
            key={i}
            type="button"
            className={`flow-context-item${item.destructive ? " is-destructive" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            <span className="flow-context-label">{item.label}</span>
            {item.shortcut && <span className="flow-context-shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
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
        placeholder="Find a card or title&hellip;"
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
  onExport: () => void;
  onImport: () => void;
  onClose: () => void;
};

function SaveManager({
  snapshots,
  onSave,
  onLoad,
  onDelete,
  onExport,
  onImport,
  onClose,
}: SaveManagerProps) {
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
      <div className="flow-manager-io">
        <button
          type="button"
          className="flow-manager-io-btn"
          onClick={onImport}
          title="Import a flow from a JSON file"
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 4v12" />
            <path d="M7 11l5 5 5-5" />
            <path d="M4 20h16" />
          </svg>
          <span>Import</span>
        </button>
        <button
          type="button"
          className="flow-manager-io-btn"
          onClick={onExport}
          title="Download the current flow as JSON"
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 20V8" />
            <path d="M7 13l5-5 5 5" />
            <path d="M4 4h16" />
          </svg>
          <span>Export</span>
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
      data-node-kind="block"
      data-id={block.id}
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

type TitleViewProps = {
  title: Title;
  selected: boolean;
  editing: boolean;
  matched: boolean;
  isCurrentMatch: boolean;
  onStartDrag: (e: React.MouseEvent) => void;
  onStartEdit: () => void;
  onTextChange: (t: string) => void;
  onTextBlur: (finalText: string) => void;
};

function TitleView({
  title,
  selected,
  editing,
  matched,
  isCurrentMatch,
  onStartDrag,
  onStartEdit,
  onTextChange,
  onTextBlur,
}: TitleViewProps) {
  const textRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: MouseEvent) => {
      e.stopPropagation();
      onStartEdit();
    };
    el.addEventListener("dblclick", handler);
    return () => el.removeEventListener("dblclick", handler);
  }, [onStartEdit]);

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
      textRef.current.textContent !== title.text
    ) {
      textRef.current.textContent = title.text;
    }
  }, [title.text]);

  return (
    <div
      ref={wrapRef}
      data-node-kind="title"
      data-id={title.id}
      className={`flow-title${selected ? " is-selected" : ""}${
        editing ? " is-editing" : ""
      }${matched ? " is-match" : ""}${isCurrentMatch ? " is-current-match" : ""}`}
      style={{
        left: title.x,
        top: title.y,
        width: title.w,
        minHeight: title.h,
      }}
      onMouseDown={onStartDrag}
    >
      <div
        ref={textRef}
        className="flow-title-text"
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder="Title"
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
    </div>
  );
}
