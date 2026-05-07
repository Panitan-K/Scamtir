# Scamtir Gemini-Optimized Pipeline Architecture

> **Status**: Active Implementation  
> **Created**: 2026-05-07  
> **Author**: Scamtir Engineering

---

## Problem Statement

The current "YOLO-First" approach is fundamentally flawed:

1. **YOLO-World uses CLIP** — a text encoder trained on English data. Thai queries like `"อุบัติเหตุ รถชน"` produce garbage embeddings → zero detections.
2. **YOLO scans blindly** — it processes the entire video frame-by-frame looking for a text query, which is both slow and semantically shallow.
3. **Sequential bottleneck** — YOLO runs on every frame before Gemini ever sees anything. If YOLO misses, the pipeline halts entirely.
4. **Wrong tool for the job** — YOLO is an object detector, not a scene understanding engine. Asking it "is there an accident?" is like asking a calculator to write poetry.

## New Architecture: Gemini-First, YOLO-Annotate, Gemini-Verify

```
┌─────────────────────────────────────────────────────────────────┐
│                    GEMINI-OPTIMIZED PIPELINE                    │
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  STEP 1  │───▶│  STEP 2  │───▶│  STEP 3  │───▶│  STEP 4  │  │
│  │ Gemini   │    │  YOLO    │    │ Gemini   │    │ Frontend │  │
│  │ Screening│    │ Labeling │    │ Verify   │    │ Render   │  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│                                                                 │
│  "Is there an    "What objects   "Describe the    Bounding      │
│   accident in     are in the      interaction      boxes +      │
│   these 10s?"     scene?"         with boxes"      keyframes    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Flow

### Step 1: Gemini Batch Screening (Frontend → Gemini API)

**Goal**: Quickly identify WHICH 10-second segments contain incidents.

- Upload the **full video** once via Gemini File API (upload + poll for ACTIVE).
- Send a single prompt asking Gemini to scan and return which time ranges contain the target incident.
- Gemini returns a JSON array of flagged time segments: `[{ start_sec: 45, end_sec: 55 }]`

**Why this is better**: Gemini understands Thai, understands context, understands "accident" semantically. One API call screens the entire video.

**Prompt Strategy**:
```
You are a video screening engine.
Scan this video and identify all 10-second segments where: "{query}"
Return ONLY a JSON array of objects with:
- "batch_start_sec": number
- "batch_end_sec": number  
- "confidence": number (0-1)
- "description": string (what you saw)
If nothing matches, return [].
```

### Step 2: YOLO Object Detection (Frontend → Backend `/yolo_detect`)

**Goal**: For each flagged segment, run YOLO at 5 FPS to draw bounding boxes on objects.

- Frontend sends each flagged 10s segment to the YOLO backend.
- Backend extracts frames at 5 FPS from that segment.
- YOLO detects objects using a broad class set: `["car", "truck", "motorcycle", "person", "bicycle"]`
- Returns **annotated frames as base64 images** + **detection metadata** (bounding box coordinates, labels, confidence).

**New Backend Endpoint**: `POST /yolo_detect`

```json
// Request (FormData)
{
  "file": <video>,
  "start_sec": 45,
  "end_sec": 55,
  "yolo_fps": 5,
  "classes": "car,truck,motorcycle,person,bicycle"
}

// Response
{
  "status": "ok",
  "detections": [
    {
      "frame_sec": 46.2,
      "annotated_frame_b64": "<base64 JPEG>",
      "objects": [
        {
          "label": "car",
          "confidence": 0.92,
          "bbox": [y1, x1, y2, x2]  // normalized 0-1000
        }
      ]
    }
  ]
}
```

### Step 3: Gemini Verification (Frontend → Gemini API)

**Goal**: Send YOLO-annotated frames + coordinates back to Gemini for detailed reasoning.

- For each batch of annotated frames, send them to Gemini along with the detection metadata.
- Gemini now sees the bounding boxes drawn on the frame AND knows the coordinates.
- It can reason: "The red box around the car at [120, 340, 450, 680] shows it colliding with the motorcycle at [200, 500, 400, 700]."
- Returns verified events with reasoning, timestamps, and refined bounding boxes.

**Prompt Strategy**:
```
You are a forensic video analyst.
I'm showing you frames from a video with YOLO detection boxes overlaid.
The detected objects and their coordinates are provided.

Query: "{query}"

For each frame, analyze the spatial relationships and motion between detected objects.
Return a JSON array of verified events:
- "timestamp_sec": number
- "is_incident": boolean
- "reasoning": string (what physically happened based on object positions)
- "involved_objects": array of { label, bbox_normalized_1000 }
- "severity": "low" | "medium" | "high"
```

### Step 4: Frontend Rendering

- Display keyframes on the timeline with bounding boxes.
- Show detection box movement across frames.
- Auto-jump to the highest-severity incident.

---

## Architecture Comparison

| Aspect | Old (YOLO-First) | New (Gemini-First) |
|--------|-------------------|---------------------|
| Initial scan | YOLO (English CLIP, blind) | Gemini (multilingual, semantic) |
| Thai support | ❌ Broken | ✅ Native |
| Detection quality | Shallow object matching | Deep scene understanding |
| YOLO role | Gate (blocks pipeline) | Annotator (enhances pipeline) |
| Gemini calls | 1 (verification only) | 2 (screening + verification) |
| Failure mode | Pipeline halts if YOLO misses | Only misses if Gemini misses |
| Speed for long videos | Slow (scans every frame) | Fast (1 API call for screening) |

---

## Token Budget Estimation

For a 120-second video:
- **Step 1 (Screening)**: ~1 upload + 1 generate call. Video at 1FPS = 120 frames. Cost: ~2,000 tokens input + video tokens.
- **Step 2 (YOLO)**: Local compute, no API cost. Only flagged segments processed.
- **Step 3 (Verification)**: N annotated frames sent as images. ~500 tokens per frame × N frames.

**Net result**: Similar or lower Gemini cost than current approach, but dramatically better accuracy.

---

## Implementation Plan

1. ✅ Create `Gemini-Optimize.md` (this document)
2. 🔄 Add new `POST /yolo_detect` endpoint to `hybrid_backend.py`
3. 🔄 Rewrite `runHybridAnalysis()` in `App.tsx` with the 3-step pipeline
4. 🔄 Update frontend UI to show pipeline progress stages
5. 🔄 Keep old `/hybrid_trigger` as legacy fallback

---

## File Changes Required

- **`hybrid_backend.py`**: Add `POST /yolo_detect` endpoint that accepts a video + time range + class list, runs YOLO, returns annotated frames as base64 + detection metadata.
- **`src/App.tsx`**: Rewrite the analysis pipeline to: Gemini screen → YOLO detect → Gemini verify → render.
