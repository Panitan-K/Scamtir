<p align="center"><strong>SCAMTIFY.</strong> <code>GEMINI × YOLO-WORLD</code></p>

<h1 align="center">Scamtir — AI Video Intelligence Console</h1>

<p align="center">
  <em>Ask any video anything, in any language. Multilingual natural-language queries → frame-accurate incident timelines.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-Active%20Development-blueviolet?style=flat-square" alt="Status" />
  <img src="https://img.shields.io/badge/frontend-React%20%2B%20Vite%20%2B%20TS-61dafb?style=flat-square" alt="Frontend" />
  <img src="https://img.shields.io/badge/backend-FastAPI%20%2B%20YOLO--World-009688?style=flat-square" alt="Backend" />
  <img src="https://img.shields.io/badge/AI-Gemini%20Multimodal-4285f4?style=flat-square" alt="AI" />
  <img src="https://img.shields.io/badge/hackathon-DOH%202026-fbbf24?style=flat-square" alt="Hackathon" />
</p>

---

## What it does

Type `"อุบัติเหตุ"` (or `"person in red shirt on motorcycle"`, or any free-text query in any language). Scamtir scans your video and returns a timeline of confirmed incidents with bounding boxes, involved parties, and a per-incident inspection trace showing exactly what each AI phase saw.

Built for the **Thailand DOH Innovation Hackathon 2026**. Originally targeted at highway camera footage; the architecture is general.

---

## How it works (4-phase pipeline)

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Phase 0  │──▶│ Phase 1  │──▶│ Phase 2  │──▶│ Phase 3  │
│ Gemini   │   │ Gemini   │   │  YOLO    │   │ Gemini   │
│ Interpret│   │ Screen   │   │ Annotate │   │ Localize │
└──────────┘   └──────────┘   └──────────┘   └──────────┘
 expand query   batch screen   draw boxes     locate peak
 → categories   8s parallel    on flagged     frame +
 + classes      windows        windows        roles
```

| Phase | Where | What |
|---|---|---|
| **0 — Interpret** | Gemini (text only) | Expand broad queries (`"อุบัติเหตุ"` → `["vehicle collision", "vehicle hitting barrier", "rollover", "debris", ...]`) and infer YOLO class hints (`"traffic barrier", "guardrail", "debris"`). |
| **1 — Screen** | Gemini (video, parallel 8s batches) | Find exact seconds where ANY interpreted category occurs. Returns `flagged_sec + confidence + description`. |
| **2 — Annotate** | YOLO-World backend | For each flagged window, run YOLO-World @ 3 FPS with the inferred class list. Returns annotated frames + bbox metadata. |
| **3 — Localize** | Gemini (vision) | Trust Phase 1's confirmation. Pinpoint the peak frame, identify involved parties by role. Falls back to Phase 1 if it can't contradict. |

**Why this works:** Gemini understands context and Thai natively but can't draw pixel-perfect boxes; YOLO-World draws boxes but can't reason about events. We use each for what it's good at, and the localizer-not-verifier framing in Phase 3 stops the pipeline from discarding Phase 1's confident findings.

For the full design rationale, see [docs/PIPELINE.md](docs/PIPELINE.md).

---

## Quick start

You need **two processes** running:

### 1. Frontend (`:5173`)

```bash
cd Scamtir
pnpm install
pnpm dev
```

### 2. YOLO backend (`:8000`)

```bash
pip install ultralytics fastapi uvicorn opencv-python tqdm
python hybrid_backend.py
```

First run downloads `yolov8s-worldv2.pt` (~26 MB) and loads YOLO-World (~30 s).

### 3. API key

Open `http://localhost:5173`, paste your Gemini API key in the modal (stored in `localStorage`), or set `VITE_GEMINI_API_KEY` in `.env.local` to skip the prompt. Get one at [ai.google.dev](https://ai.google.dev).

---

## Using it

1. **Upload a video** — drag/drop an MP4 into the upload zone.
2. **Write a query** — free-text, any language. Or click a preset.
3. **Set scan range** — start/end seconds (defaults: full video).
4. **Run pipeline** — watch the live progress panel: Phase 0 interpretation logs the expanded categories, Phase 1 streams flagged moments, Phase 2 reports YOLO detections, Phase 3 confirms incidents.
5. **Inspect** — each incident chip has an info button → opens a modal showing query interpretation, Phase 1 flagged moments, Phase 2 YOLO frame thumbnails (annotated), Phase 3 involved-objects with bbox coordinates, and the raw Gemini JSON response.

---

## Project structure

```
Scamtir/
├── README.md                    ← you are here
├── docs/
│   ├── PIPELINE.md              ← 4-phase architecture rationale
│   ├── GEMINI-API.md            ← Gemini File API behavior, token costs
│   └── ROADMAP.md               ← hackathon phases, market expansion
│
├── src/                         ← Frontend (React + TypeScript + Vite)
│   ├── App.tsx                  ←   The whole app: pipeline + UI + inspector modal
│   ├── App.css                  ←   All styles
│   └── main.tsx                 ←   React entry
│
├── hybrid_backend.py            ← Backend (FastAPI + YOLO-World)
│                                  Two endpoints: /yolo_detect, /hybrid_trigger (legacy)
│
├── yolov8s-worldv2.pt           ← YOLO-World model weights (auto-downloaded)
├── package.json, pnpm-lock.yaml, vite.config.ts, tsconfig.*.json
├── .env.example                 ← VITE_GEMINI_API_KEY template
└── public/
```

---

## Tech stack

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React 19 · TypeScript · Vite | Single-file app (`App.tsx`), no router |
| Video compression | `@ffmpeg/ffmpeg` (WebAssembly) | Transcodes >5 MB videos to 360p @ 2 FPS in-browser before upload |
| Multimodal AI | Gemini API (`gemini-3-flash-preview`) | Phase 0/1/3; uses File API + `videoMetadata` startOffset/endOffset for chunked screening |
| Object detection | YOLO-World (`yolov8s-worldv2.pt`) via `ultralytics` | Phase 2; open-vocabulary — accepts arbitrary text classes |
| Backend | FastAPI · OpenCV · uvicorn | Stateless YOLO endpoint, serial frame processing |

---

## Documentation

- **[docs/PIPELINE.md](docs/PIPELINE.md)** — Why we ended up with this 4-phase architecture, what previous designs failed, and the exact prompts each phase uses.
- **[docs/GEMINI-API.md](docs/GEMINI-API.md)** — Gemini File API behavior, 1 FPS sampling, token costs, frame-precision limits.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — Hackathon implementation phases, market expansion plan, future R&D priorities.

---

<p align="center"><sub>© 2026 Scamtify AI Systems · Built for DOH Innovation Hackathon 2026</sub></p>
