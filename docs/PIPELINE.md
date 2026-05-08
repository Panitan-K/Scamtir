# Scamtir Pipeline Architecture

> **Status**: Implemented · `src/App.tsx`, `hybrid_backend.py`
> **Last revised**: 2026-05-08

---

## TL;DR

A **four-phase Gemini × YOLO-World pipeline** that turns a free-text query (in any language) and a video file into a timeline of incidents with bounding boxes, involved parties, and per-incident inspection traces.

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Phase 0  │──▶│ Phase 1  │──▶│ Phase 2  │──▶│ Phase 3  │
│ Gemini   │   │ Gemini   │   │  YOLO    │   │ Gemini   │
│ Interpret│   │ Screen   │   │ Annotate │   │ Localize │
└──────────┘   └──────────┘   └──────────┘   └──────────┘
```

Two iterations got us here. Earlier ones failed in instructive ways — see [Failed designs](#failed-designs).

---

## Phase 0 — Query Interpretation

Function: `geminiInterpretQuery()` · text-only Gemini call · ~1 second

The user writes free-text, often broad: `"อุบัติเหตุ"` ("accident"). A literal match is useless — Gemini needs concrete visual cues, and YOLO-World needs class names.

**Prompt** asks Gemini to expand the query into:

```json
{
  "english_translation": "accident",
  "expanded_meaning": "any traffic incident causing damage or near-miss",
  "visual_categories": [
    "vehicle-vehicle collision",
    "vehicle hitting roadside barrier",
    "pedestrian struck",
    "motorcycle fall",
    "rollover",
    "debris/obstacle on road",
    "rear-end crash",
    "near-miss"
  ],
  "target_objects": [
    "car", "truck", "motorcycle", "person", "bicycle", "bus",
    "traffic cone", "traffic barrier", "barricade", "guardrail",
    "road sign", "debris", "fallen object", "construction equipment"
  ]
}
```

This expansion drives every subsequent phase. Without it, queries like `"อุบัติเหตุ"` only match the literal Thai word, and YOLO never sees the obstacles the accident involves.

**Memoized** per query — switching videos doesn't re-interpret.

---

## Phase 1 — Batch Screening

Function: `geminiBatchScreen()` · Gemini multimodal · 4× parallel

The video is uploaded once via Gemini File API. Then it's chopped into **8-second batches**, screened in parallel (`SCREEN_CONCURRENCY = 4`), each asking:

> "Watch this short clip carefully and identify the EXACT second(s) when ANY of these events occurs: [interpretation.visual_categories]. Return `{flagged_sec, confidence, description}` per moment."

**Why batches and not whole-video?** With `videoMetadata: { startOffset, endOffset }` we can constrain Gemini's attention to a slice without re-uploading. Parallel batches finish 4× faster and avoid the long-context degradation that hits a single 60s+ video call.

Returns `FlaggedMoment[]` — sorted, deduped second-level findings across the whole scan range.

---

## Phase 2 — YOLO-World Annotation

Function: `yoloDetectSegment()` · backend `/yolo_detect` · 3 FPS

Flagged moments are merged into **±5s windows** (`buildMergedWindows()`) so overlapping events don't get scanned twice. Each window goes to the YOLO backend with:

- `start_sec` / `end_sec` — the merged window
- `yolo_fps: 3` — 30 frames per 10s window (good enough to catch impact, cheap enough to send all to Gemini)
- `classes` — universal defaults `[car, truck, motorcycle, person, bicycle, bus]` + Phase 0's `target_objects`, deduped, capped at 24 classes for YOLO-World responsiveness

YOLO-World accepts **arbitrary text classes** at inference time (no retraining), so `"traffic barrier"` becomes a detectable class for this query. The backend draws green rectangles + labels on each frame and returns `{ frame_sec, annotated_frame_b64, objects[] }`.

---

## Phase 3 — Localization (the critical part)

Function: `geminiFinalReasoning()` · Gemini multimodal · ~14 frames per window

This is the phase that earlier iterations got wrong. **Phase 1 has already confirmed an event happened.** Phase 3's job is to **locate the peak frame and name the parties**, NOT to re-litigate whether the event was real.

### What's sent

- A **time-even sample of 14 frames** (preserves first + last so the impact moment isn't dropped). Earlier iterations sent top-N-by-detection-density and missed mid-impact frames where YOLO sees fewer objects.
- The **full detection timeline** as JSON metadata for ALL frames (not just sent images), so Gemini can reason about object trajectories across the whole window even on un-sent frames.
- Phase 0's `expanded_meaning` and `visual_categories`.
- Phase 1's flagged moments + descriptions verbatim.

### What's asked

> "PHASE 1 has ALREADY screened this video and CONFIRMED matching moment(s). YOUR JOB IS NOT TO RE-LITIGATE WHETHER THE INCIDENT HAPPENED. Phase 1 saw the entire video; trust its description. Your job is: (1) LOCATE the peak frame, (2) IDENTIFY which detected objects are involved with roles, (3) refine the description. Only return `{ "incidents": [] }` if you can clearly prove Phase 1's finding is contradicted by YOLO evidence."

### Confidence floor

Final incident confidence = `max(Phase1_confidence × 0.9, localizer_confidence)`. The localizer can refine but can't invalidate.

### Phase 1 fallback

If Phase 3 returns `{ "incidents": [] }` AND Phase 1's top moment was ≥0.7, `phase1Fallback()` builds an Incident from the Phase 1 finding directly:

- Picks the YOLO frame closest to `topMoment.flagged_sec` as the peak frame.
- Promotes that frame's top 3 highest-confidence YOLO objects as `involved` parties (with role `"visible party"`) so the UI still has bboxes to render.
- Sets the Incident's description to Phase 1's description, severity `"medium"`, confidence = Phase 1's confidence.

This guarantees high-confidence Phase 1 findings can't be silently discarded.

---

## Data shape

```ts
interface Incident {
  id: number;
  timeSeconds: number;            // peak frame time
  duration: [number, number];     // ±1.5s window for "active" overlay state
  eventType: string;              // "collision", "fall", "debris", etc.
  description: string;            // refined by Phase 3 or copied from Phase 1
  severity: 'low' | 'medium' | 'high';
  confidence: number;             // floor-protected
  color: string;
  involved: InvolvedObject[];     // each = role + label + bbox + sourceFrameIdx
  trace: IncidentTrace;           // full inspection record
}

interface IncidentTrace {
  query: string;
  windowStart: number;
  windowEnd: number;
  flaggedMoments: FlaggedMoment[];           // Phase 1 raw output
  yoloFrames: YoloFrameRecord[];              // Phase 2 every annotated frame
  rawGeminiResponse: string;                  // Phase 3 raw JSON for forensics
}
```

The `IncidentTrace` is what powers the inspector modal — every phase's raw evidence is preserved per incident.

---

## UI rendering details

### Bounding box accuracy

The video element uses `object-fit: contain` (NOT `fill`). Letterbox/pillarbox is computed in JS via `ResizeObserver` → `videoFitRect`. The bbox layer is positioned to match the actual rendered pixels of the video, not the wrapper div. Bboxes use percentage coordinates within that layer, which exactly matches YOLO's normalized 0-1000 coordinate space across any aspect ratio.

### Multi-incident rendering

One Incident = one timeline marker = one chip = N bboxes (one per `InvolvedObject`). Earlier flat `Keyframe` model created N stacked markers per multi-party incident.

### Confidence threshold filter

Post-analysis slider filters which incidents render. Defaults to 0 (show everything from Phase 1 fallback up).

---

## Failed designs

The current architecture is the third iteration. Two earlier attempts failed for instructive reasons.

### v1 — YOLO-First (abandoned)

> Run YOLO-World on every frame to find the query, then send micro-clips to Gemini for verification.

**Why it failed:** YOLO-World uses CLIP, which is a text encoder trained on English. Thai queries like `"อุบัติเหตุ รถชน"` produce garbage embeddings → zero detections. YOLO is also an object detector, not a scene-understanding engine — asking it "is there an accident?" is wrong-tool. And if YOLO missed the moment, the pipeline halted entirely.

(Code remnant: `hybrid_backend.py:hybrid_trigger()` — kept as legacy fallback, not used.)

### v2 — Gemini-Screen + Top-N-by-density Verifier

> Gemini screens the video. YOLO annotates the flagged segment. Send the **top 5 frames with the most detected objects** to Gemini and ask "is this an incident?".

**Why it failed:** Mid-impact frames are often blurry → fewer YOLO boxes → ranked lower → discarded. The verifier prompt also asked `is_incident: boolean` and a `events.filter(e => e.is_incident !== false)` on the response — when the verifier was uncertain, it defaulted to false and got nuked. Real example from logs:

```
Phase 1: found accident @ 95% — "pickup truck crashes into orange traffic barriers"
Phase 2: 390 objects across 50 frames
Phase 3: sent 5 frames → got back []
Result: "No matches confirmed"
```

The 95% Phase 1 finding was thrown away. Three concrete bugs cascaded:
1. Top-N by density dropped the impact frames.
2. Phase 1's confident description was never passed to Phase 3.
3. YOLO classes were hardcoded `[car,truck,motorcycle,person,bicycle,bus]` — the orange barriers (the collision target) were invisible to it, so the verifier saw "truck driving normally" with no obstacle.

### v3 — Current

The fixes for each:
1. **Even sampling** + full detection timeline metadata.
2. **Locate-don't-relitigate** prompt + Phase 1 fallback + confidence floor.
3. **Phase 0 query interpretation** drives the YOLO class list dynamically.

---

## File map

| File | Phase | Notes |
|---|---|---|
| `src/App.tsx` :: `geminiInterpretQuery()` | 0 | Text-only Gemini call |
| `src/App.tsx` :: `geminiBatchScreen()` | 1 | Parallel 8s batches via `videoMetadata` |
| `src/App.tsx` :: `yoloDetectSegment()` | 2 | Calls backend `/yolo_detect` |
| `hybrid_backend.py` :: `/yolo_detect` | 2 | FastAPI + ultralytics + OpenCV |
| `src/App.tsx` :: `geminiFinalReasoning()` | 3 | Localizer + fallback |
| `src/App.tsx` :: `phase1Fallback()` | 3 | Builds Incident from Phase 1 alone |
| `hybrid_backend.py` :: `/hybrid_trigger` | — | Legacy v1 endpoint, unused by frontend |

---

## Token budget (rough estimates for 60s video at 720p)

| Phase | Cost |
|---|---|
| 0 — Interpret | ~1k input + 200 output (text) |
| 1 — Screen | ~16k video tokens × 1 batch (8s × N batches in parallel, video cached on Gemini side) |
| 2 — YOLO | Local CPU only — no API cost |
| 3 — Localize | ~14 images × ~250 tokens + 4-8k metadata per window |

**Net**: similar or lower Gemini cost than the v2 approach because most of the work is done by YOLO locally; Gemini only sees images for windows that Phase 1 already flagged.

See [GEMINI-API.md](GEMINI-API.md) for token math details.
