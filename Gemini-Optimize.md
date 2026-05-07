# Scamtir Chunked Multi-Phase Pipeline

> **Status**: Active Implementation
> **Updated**: 2026-05-07
> **Author**: Scamtir Engineering

---

## Why a chunked pipeline

Multimodal transformers (Gemini included) lose precision when the input video is long — context gets diluted and small/short events get smoothed away. They also natively sample at 1 FPS, which means events shorter than a second can disappear entirely.

To fix both problems we **chunk first, zoom in second**:

1. **Cheap, short-context screening** decides *when* something is interesting.
2. **Targeted, high-FPS verification** decides *what* actually happened.

YOLO sits between the two phases as a spatial annotator — it tells Gemini *where* objects are inside the suspicious window so the final reasoning step can refer to them by coordinate.

---

## Pipeline

```
┌────────────────────────────────────────────────────────────────────────┐
│                       CHUNKED MULTI-PHASE PIPELINE                     │
│                                                                        │
│  PHASE 1                  PHASE 2                  PHASE 3             │
│  ┌──────────┐             ┌──────────┐             ┌──────────┐        │
│  │ Gemini   │             │  YOLO    │             │ Gemini   │        │
│  │  Batch   │ ──flagged──▶│ Annotate │ ──30 frames─▶│  Final   │        │
│  │  Screen  │   seconds   │ @ 3 FPS  │  + bboxes   │ Reasoning│        │
│  └──────────┘             └──────────┘             └──────────┘        │
│                                                                        │
│  "Which exact     "Where are the         "What event happened          │
│   second has      vehicles/people        and which boxes are           │
│   the event?"     in this 10s window?"   involved?"                    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Gemini Batch Screening

**Goal**: Find the *exact* second(s) in the video where the queried event happens.

- Upload the compressed video **once** via the Gemini File API.
- Split the duration into **8-second batches** (`BATCH_SIZE_SEC = 8`).
- For each batch, call `generateContent` with `videoMetadata.startOffset`/`endOffset` set to that batch's range. This tells Gemini to only attend to those frames — full short-context isolation, no re-upload.
- Run up to `SCREEN_CONCURRENCY = 4` batches in parallel.
- Each batch returns:

```json
[
  { "flagged_sec": 12.4, "confidence": 0.83, "description": "motorcycle swerves into car" }
]
```

`flagged_sec` is a **point in time**, not a 10-second bucket — that's important so Phase 2 can build a tight ±5s window around it.

**Why short batches**: An 8-second clip is short enough that Gemini's attention isn't spread thin, so it can pinpoint the exact second of an event instead of returning a vague "happens somewhere between 40s and 50s."

---

## Phase 2 — YOLO Annotation @ 3 FPS

**Goal**: Give Gemini high-temporal-resolution spatial context exactly where it matters.

For each `flagged_sec`:

1. Build a window `[flagged_sec − 5s, flagged_sec + 5s]` (10 seconds total, `PADDING_SEC = 5`).
2. **Merge overlapping windows** so YOLO doesn't redo work when two flagged seconds are close together (e.g., flagged at 12s and 14s → one combined window 7–19s).
3. Send each window to the backend `POST /yolo_detect`:

```json
{
  "file": "<original video>",
  "start_sec": 7.0,
  "end_sec": 19.0,
  "yolo_fps": 3,
  "classes": "car,truck,motorcycle,person,bicycle,bus"
}
```

4. Backend uses `cap.grab()` for skipped frames (decode-skip optimization) and only fully decodes 1-in-N frames at the requested FPS. Returns:

```json
{
  "detections": [
    {
      "frame_sec": 12.33,
      "annotated_frame_b64": "<base64 JPEG with green YOLO boxes>",
      "objects": [
        { "label": "car", "confidence": 0.91, "bbox": [320, 410, 720, 880] }
      ]
    }
  ]
}
```

A 10s window @ 3 FPS = **30 annotated frames** — 3× Gemini's native 1 FPS rate, which is more than enough to catch fast events that 1 FPS would miss.

**bbox format**: `[ymin, xmin, ymax, xmax]` normalized to 0–1000 (matches Gemini's spatial token convention).

---

## Phase 3 — Gemini Final Reasoning

**Goal**: Decide *what* happened and *which* objects are involved.

Send all 30 annotated frames + the bbox metadata back to Gemini as one call:

```
prompt = "...30 frames sampled at 3 FPS spanning 7s..19s. Each has YOLO boxes drawn.
Detection metadata: [{frame_idx, timestamp_sec, detected_objects: [{object_id, label, bbox_1000}]}]
Determine: (1) did the event happen, (2) which frame is the peak, (3) what kind of event, (4) which object_ids are involved."
```

Gemini returns a single JSON object:

```json
{
  "incident_detected": true,
  "incident_frame_idx": 14,
  "incident_timestamp_sec": 12.33,
  "event_type": "rear-end collision",
  "description": "Sedan strikes the back of a stopped motorcycle.",
  "severity": "high",
  "confidence": 0.88,
  "involved_objects": [
    { "object_id": "f14_o0", "role": "striking vehicle" },
    { "object_id": "f14_o2", "role": "victim" }
  ]
}
```

The frontend resolves each `object_id` (`f<frameIdx>_o<objectIdx>`) back to its bbox from the YOLO response and renders one keyframe per involved object — each gets its own colored bbox overlay with the role label (`striking vehicle`, `victim`, etc.).

---

## What changed vs. the old design

| Aspect                | Old "10s buckets"                     | New "chunked + zoom"                   |
|-----------------------|---------------------------------------|----------------------------------------|
| Phase 1 input         | Whole video, single Gemini call       | 8s chunks, parallel calls, isolated context |
| Phase 1 output        | Vague 10s ranges                      | Exact `flagged_sec` (sub-second)       |
| Phase 1 re-uploads    | 1 (full video)                        | 1 (full video) — chunks via `videoMetadata` |
| Phase 2 sampling      | Configurable (default 5 FPS)          | **3 FPS** over a tight ±5s window      |
| Phase 2 frames sent   | Top-5 by object count                 | All 30 frames in the window            |
| Window de-duplication | None                                  | Overlapping windows merged             |
| YOLO skipped frames   | Decoded then thrown away              | `cap.grab()` — no decode               |
| YOLO class encoding   | Re-encoded every call                 | Cached by class string                 |

---

## Constants (in `App.tsx`)

```ts
const BATCH_SIZE_SEC = 8;        // Phase 1 chunk length
const PADDING_SEC = 5;           // Phase 2 window = ±5s
const SCREEN_CONCURRENCY = 4;    // Phase 1 parallelism
const YOLO_WINDOW_FPS = 3;       // Phase 2 sample rate
```

---

## Key files

- **`hybrid_backend.py`** — `/yolo_detect` endpoint (Phase 2). Default `yolo_fps=3`, `cap.grab()` skip, cached `set_classes`.
- **`src/App.tsx`** — `geminiBatchScreen` (Phase 1), `buildMergedWindows`, `yoloDetectSegment` (Phase 2), `geminiFinalReasoning` (Phase 3).
