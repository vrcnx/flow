# flow

A minimal flow chart diagram maker. Dark mode, white outlined blocks, white connections, infinite dot-grid canvas.

## Interactions

- **Double-click** anywhere to create a block (starts typing immediately)
- **Type → Enter** to commit text, **Esc** to cancel
- **Hover a block** to reveal its connection dot — drag it to another block to draw an arrow
- **Click + drag** a block to move it
- **Click + drag** empty space to pan
- **Scroll** to zoom around the cursor
- **Click** a block or arrow to select; **Delete / Backspace** to remove

## Running locally

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript.
