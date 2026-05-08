import { useState, useRef, useCallback, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import './App.css';

const ENV_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim();
const GEMINI_MODEL = 'gemini-3-flash-preview';

// ===== TYPES =====
interface LogEntry {
  id: number;
  timestamp: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'detect';
  message: string;
}

interface InvolvedObject {
  role: string;                               // "striking vehicle", "victim", "obstacle", ...
  label: string;                              // YOLO class: "car", "motorcycle"
  yoloConfidence: number;
  bbox: [number, number, number, number];     // [ymin, xmin, ymax, xmax] normalized 0-1000
  fromFrameIdx: number;                       // which YOLO frame the bbox was sampled from
}

interface IncidentTrace {
  query: string;
  windowStart: number;
  windowEnd: number;
  flaggedMoments: Array<{ flagged_sec: number; confidence: number; description: string }>;
  yoloFrames: Array<{
    frameSec: number;
    annotatedB64: string;                     // base64 JPEG (kept for the inspection modal)
    objects: Array<{ label: string; confidence: number; bbox: number[] }>;
  }>;
  rawGeminiResponse: string;
}

interface Incident {
  id: number;
  timeSeconds: number;                        // peak moment
  duration: [number, number];                 // bbox display window
  eventType: string;                          // short label, e.g. "rear-end collision"
  description: string;
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  color: string;                              // overlay accent color
  involved: InvolvedObject[];
  trace: IncidentTrace;
}

type PipelinePhase = 'idle' | 'compress' | 'upload' | 'screen' | 'yolo' | 'reason' | 'done' | 'error';

interface PipelineProgress {
  phase: PipelinePhase;
  message: string;
  batchesTotal: number;
  batchesDone: number;
  windowsTotal: number;
  windowsDone: number;
  incidentsFound: number;
}

interface PresetQuery {
  emoji: string;
  title: string;
  description: string;
  query: string;
}

// ===== PRESETS =====
const PRESET_QUERIES: PresetQuery[] = [
  {
    emoji: '👕',
    title: 'Clothing + Action',
    description: 'คนสวมเสื้อขาวยกมือ',
    query: 'person wearing a white shirt and raising a hand',
  },
  {
    emoji: '🏍️',
    title: 'Vehicle + Person',
    description: 'คนใส่เสื้อแดงขี่มอเตอร์ไซค์',
    query: 'person in a red shirt driving a motorcycle',
  },
  {
    emoji: '🔌',
    title: 'Cable Theft',
    description: 'คนกำลังถือสายไฟ / ตัดสายเคเบิล',
    query: 'person holding or cutting electrical cables near a utility pole',
  },
  {
    emoji: '🚧',
    title: 'Road Hazard',
    description: 'สิ่งกีดขวาง / เศษซาก / อุบัติเหตุ',
    query: 'fallen tree, debris, or vehicle accident blocking the road',
  },
  {
    emoji: '🏭',
    title: 'Safety Compliance',
    description: 'ไม่สวม PPE / มือใกล้เครื่องจักร',
    query: 'worker without helmet or safety vest near heavy machinery',
  },
];

// Keyframe colors for variety
const KEYFRAME_COLORS = [
  '#f87171', '#fbbf24', '#34d399', '#38bdf8', '#a78bfa',
  '#fb7185', '#22d3ee', '#818cf8', '#10b981', '#f59e0b',
];

// ===== HELPERS =====
function getTimestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

let logIdCounter = 0;
function createLog(type: LogEntry['type'], message: string): LogEntry {
  return { id: ++logIdCounter, timestamp: getTimestamp(), type, message };
}

function formatVideoTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

let keyframeIdCounter = 0;

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadingPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoadingPromise) return ffmpegLoadingPromise;

  ffmpegLoadingPromise = (async () => {
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await ffmpegLoadingPromise;
  } catch (err) {
    ffmpegLoadingPromise = null;
    throw err;
  }
}

async function compressVideoClientSide(videoFile: File, onLog: (msg: string) => void): Promise<File> {
  // If the file is already small (< 5MB), skip compression to save time
  if (videoFile.size < 5 * 1024 * 1024) {
    onLog(`[Optimization] Video is small enough (${(videoFile.size / 1024 / 1024).toFixed(1)}MB). Skipping compression.`);
    return videoFile;
  }

  onLog(`[Optimization] Loading WebAssembly FFmpeg for in-browser compression...`);
  const ff = await getFFmpeg();

  onLog(`[Optimization] Transcoding to 360p @ 2 FPS to reduce payload...`);
  const inputName = 'input.mp4';
  const outputName = 'output.mp4';

  await ff.writeFile(inputName, await fetchFile(videoFile));

  // Run ffmpeg: scale to 640px max width, 2 frames per second (plenty for Gemini screening), ultra fast preset, drop audio
  const exitCode = await ff.exec([
    '-i', inputName,
    '-vf', 'scale=640:-2,fps=2',
    '-c:v', 'libx264',
    '-crf', '30',
    '-preset', 'ultrafast',
    '-an',
    outputName
  ]);

  if (exitCode !== 0) {
    throw new Error(`FFmpeg transcoding failed with exit code ${exitCode}. The video format may not be supported for in-browser compression.`);
  }

  const data = await ff.readFile(outputName);
  const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: 'video/mp4' });

  onLog(`[Optimization] ✅ Compressed from ${(videoFile.size / 1024 / 1024).toFixed(1)}MB down to ${(blob.size / 1024 / 1024).toFixed(1)}MB!`);

  return new File([blob], 'opt_' + videoFile.name, { type: 'video/mp4' });
}

// Upload video via Gemini File API and poll until ACTIVE
async function uploadVideoToGemini(apiKey: string, videoFile: File, onLog: (msg: string) => void): Promise<{ fileUri: string; mimeType: string; fileName: string }> {
  // Compress before upload!
  const optimizedFile = await compressVideoClientSide(videoFile, onLog);

  onLog(`Uploading ${optimizedFile.name} (${(optimizedFile.size / 1024 / 1024).toFixed(1)}MB) via Gemini File API...`);
  const uploadRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey.trim()}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Header-Content-Length': optimizedFile.size.toString(),
      'X-Goog-Upload-Header-Content-Type': optimizedFile.type || 'video/mp4',
      'Content-Type': optimizedFile.type || 'video/mp4'
    },
    body: optimizedFile
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${await uploadRes.text()}`);
  }

  const fileInfo = await uploadRes.json();
  const fileName = fileInfo.file.name;
  const fileUri = fileInfo.file.uri;
  onLog(`Upload complete. File URI: ${fileUri}`);

  // Poll for processing
  let fileState = 'PROCESSING';
  let attempts = 0;
  while (fileState === 'PROCESSING') {
    onLog('Waiting for video processing on Google servers...');
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey.trim()}`);
    const pollData = await pollRes.json();
    fileState = pollData.state;
    attempts++;
    if (attempts > 60) throw new Error("Video processing timed out.");
  }

  if (fileState === 'FAILED') {
    throw new Error("Video processing failed on Google's servers.");
  }

  onLog('✅ Video is ACTIVE on Gemini.');
  return { fileUri, mimeType: fileInfo.file.mimeType, fileName };
}

// ===== PIPELINE CONSTANTS =====
const BATCH_SIZE_SEC = 8;          // Phase 1: screening batch length (transformers handle short clips better)
const PADDING_SEC = 5;             // Phase 2: ±5s window around each flagged second
const MAX_WINDOW_SEC = 10;         // Phase 2: hard cap on a single YOLO window — splits into chunks beyond this
const SCREEN_CONCURRENCY = 4;      // Max parallel Gemini screening calls
const YOLO_WINDOW_FPS = 3;         // Phase 2: 3 FPS × 10s = 30 annotated frames

interface FlaggedMoment {
  flagged_sec: number;
  confidence: number;
  description: string;
}

// ----- Phase 0: Query Interpretation -----
// One up-front Gemini text call that expands a broad query (e.g. "อุบัติเหตุ") into
// concrete visual cues + YOLO class hints. Phase 1/2/3 all use this expansion.
interface QueryInterpretation {
  english_translation: string;
  expanded_meaning: string;
  visual_categories: string[];   // e.g. "vehicle hitting roadside barrier", "motorcycle fall"
  target_objects: string[];       // YOLO-World class hints, e.g. "traffic barrier", "debris"
}

async function geminiInterpretQuery(
  apiKey: string,
  query: string,
  onLog: (msg: string) => void
): Promise<QueryInterpretation> {
  onLog(`🧭 Phase 0: Interpreting query "${query}"...`);

  const prompt = `You are a forensic video search query interpreter. The user query may be in Thai, English, or another language and is often broad/abstract (e.g. "อุบัติเหตุ" = "accident").

Expand the query into concrete visual cues a downstream object detector and frame-level analyst can act on. Be exhaustive — broad queries should expand to many sub-cases.

Return ONLY a JSON object:
{
  "english_translation": string,           // literal English translation of the query
  "expanded_meaning": string,              // one sentence describing what this query covers in practice
  "visual_categories": [string, ...],      // 4–10 specific event types this query could match (e.g. "vehicle-vehicle collision", "vehicle hitting roadside barrier", "pedestrian struck", "motorcycle fall", "rollover", "debris/obstacle on road", "rear-end crash", "near-miss"). NOT just the literal query.
  "target_objects": [string, ...]          // every kind of physical object that should be detected (e.g. "car", "truck", "motorcycle", "person", "bicycle", "bus", "traffic cone", "traffic barrier", "barricade", "guardrail", "road sign", "debris", "fallen object", "construction equipment"). Include obstacles and infrastructure, not just vehicles. Use plain English noun phrases YOLO-World can ground.
}

Query: "${query}"`;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey.trim()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(text) || {};
    const interp: QueryInterpretation = {
      english_translation: String(parsed.english_translation || query),
      expanded_meaning: String(parsed.expanded_meaning || query),
      visual_categories: Array.isArray(parsed.visual_categories) && parsed.visual_categories.length > 0 ? parsed.visual_categories.map(String) : [query],
      target_objects: Array.isArray(parsed.target_objects) && parsed.target_objects.length > 0 ? parsed.target_objects.map(String) : ['car', 'truck', 'motorcycle', 'person', 'bicycle', 'bus'],
    };
    onLog(`   • "${query}" → "${interp.english_translation}"`);
    onLog(`   • Looking for: ${interp.visual_categories.join(', ')}`);
    onLog(`   • Target objects: ${interp.target_objects.join(', ')}`);
    return interp;
  } catch (err) {
    onLog(`   ⚠️ Interpretation failed (${err instanceof Error ? err.message : String(err)}) — using literal query as fallback.`);
    return {
      english_translation: query,
      expanded_meaning: query,
      visual_categories: [query],
      target_objects: ['car', 'truck', 'motorcycle', 'person', 'bicycle', 'bus'],
    };
  }
}

// Step 1: Gemini Batch Screening — chop video into <10s windows, ask each for the EXACT second of the event
async function geminiBatchScreen(
  apiKey: string,
  fileUri: string,
  mimeType: string,
  query: string,
  interpretation: QueryInterpretation,
  videoDurationSec: number,
  scanStart: number,
  scanEnd: number,
  onLog: (msg: string) => void
): Promise<FlaggedMoment[]> {
  const start = Math.max(0, Math.floor(scanStart));
  const end = Math.min(Math.ceil(scanEnd > 0 ? scanEnd : videoDurationSec), Math.ceil(videoDurationSec));

  const batches: Array<{ start: number; end: number }> = [];
  for (let s = start; s < end; s += BATCH_SIZE_SEC) {
    const e = Math.min(s + BATCH_SIZE_SEC, end);
    if (e - s >= 1) batches.push({ start: s, end: e });
  }
  onLog(`📦 Phase 1: Screening ${batches.length} batch(es) of ≤${BATCH_SIZE_SEC}s for "${query}"...`);

  const screenPrompt = `You are a video screening engine.

USER QUERY: "${query}" — meaning: ${interpretation.expanded_meaning}
ANY of these events should be flagged (do NOT only match the literal query): ${interpretation.visual_categories.join('; ')}

Watch this short clip carefully and identify the EXACT second(s) when ANY matching event occurs.

Return ONLY a JSON array. Each item must have:
- "flagged_sec": number (the precise second in the ORIGINAL full video where the event occurs — use the timestamps you observe in this clip)
- "confidence": number between 0 and 1 — be confident (>0.8) when an event is clearly visible; only use <0.5 for ambiguous frames
- "description": string (one short, specific sentence: WHAT collided with WHAT, WHO fell, etc.)

Be precise. Pick the single most representative second per event. If multiple distinct events happen, list each.
It is critical that you do not miss real incidents. When in doubt, INCLUDE the moment with moderate confidence — Phase 3 will refine it.
If nothing in this clip matches, return [].`;

  async function screenOne(batch: { start: number; end: number }): Promise<FlaggedMoment[]> {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                fileData: { fileUri, mimeType },
                videoMetadata: {
                  startOffset: `${batch.start}s`,
                  endOffset: `${batch.end}s`
                }
              },
              { text: screenPrompt }
            ]
          }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        })
      });
      if (!res.ok) {
        onLog(`   ⚠️ Batch ${batch.start}-${batch.end}s screen failed: ${res.status}`);
        return [];
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      const arr: any[] = JSON.parse(text);
      const moments = arr
        .filter(x => typeof x.flagged_sec === 'number')
        .map(x => ({
          flagged_sec: Math.max(batch.start, Math.min(batch.end, Number(x.flagged_sec))),
          confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0.5)),
          description: String(x.description || query),
        }));
      if (moments.length > 0) {
        onLog(`   📍 Batch ${batch.start}-${batch.end}s: ${moments.length} moment(s) flagged.`);
      }
      return moments;
    } catch (err) {
      onLog(`   ⚠️ Batch ${batch.start}-${batch.end}s exception: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  const results: FlaggedMoment[] = [];
  for (let i = 0; i < batches.length; i += SCREEN_CONCURRENCY) {
    const slice = batches.slice(i, i + SCREEN_CONCURRENCY);
    const out = await Promise.all(slice.map(screenOne));
    out.forEach(m => results.push(...m));
  }

  results.sort((a, b) => a.flagged_sec - b.flagged_sec);
  onLog(`📋 Phase 1 complete: ${results.length} flagged moment(s) total.`);
  results.forEach(m => onLog(`   ⏱ ${m.flagged_sec.toFixed(1)}s (${(m.confidence * 100).toFixed(0)}%) — ${m.description}`));
  return results;
}

// Helper: merge nearby flagged seconds into ±padSec windows so YOLO doesn't redo overlapping work,
// but HARD-CAP every window at maxLenSec — past that, split into back-to-back chunks so each YOLO
// call processes ≤ maxLenSec of footage and the frontend can stream incidents window-by-window.
function buildMergedWindows(
  moments: FlaggedMoment[],
  padSec: number,
  videoDurationSec: number,
  maxLenSec: number = MAX_WINDOW_SEC
): Array<{ start: number; end: number; moments: FlaggedMoment[] }> {
  if (moments.length === 0) return [];
  const sorted = [...moments].sort((a, b) => a.flagged_sec - b.flagged_sec);

  // Step 1: greedy merge of overlapping ±padSec windows.
  type Win = { start: number; end: number; moments: FlaggedMoment[] };
  const merged: Win[] = [];
  for (const m of sorted) {
    const s = Math.max(0, m.flagged_sec - padSec);
    const e = Math.min(videoDurationSec, m.flagged_sec + padSec);
    const last = merged[merged.length - 1];
    if (last && s <= last.end) {
      last.end = Math.max(last.end, e);
      last.moments.push(m);
    } else {
      merged.push({ start: s, end: e, moments: [m] });
    }
  }

  // Step 2: split any window longer than maxLenSec into consecutive maxLenSec chunks.
  // Each chunk inherits the moments that fall inside its range; chunks with no moment
  // inside still inherit the closest one so phase1Fallback has something to anchor on.
  const out: Win[] = [];
  for (const w of merged) {
    const span = w.end - w.start;
    if (span <= maxLenSec) {
      out.push(w);
      continue;
    }
    const chunkCount = Math.ceil(span / maxLenSec);
    const chunkLen = span / chunkCount;
    for (let i = 0; i < chunkCount; i++) {
      const cStart = w.start + i * chunkLen;
      const cEnd = i === chunkCount - 1 ? w.end : cStart + chunkLen;
      const inRange = w.moments.filter(m => m.flagged_sec >= cStart && m.flagged_sec <= cEnd);
      // If no moment falls in this chunk's range, anchor it to the nearest moment so Phase 3
      // still has Phase 1 context (the merged window came from somewhere — the chunk just
      // happens to be the surrounding padding).
      const anchored = inRange.length > 0
        ? inRange
        : [w.moments.reduce((a, b) =>
            Math.abs(a.flagged_sec - (cStart + chunkLen / 2)) < Math.abs(b.flagged_sec - (cStart + chunkLen / 2)) ? a : b
          )];
      out.push({ start: cStart, end: cEnd, moments: anchored });
    }
  }
  return out;
}

// Step 2: YOLO Detection — send flagged segments to YOLO backend for object annotation
interface YoloDetection {
  frame_sec: number;
  annotated_frame_b64: string;
  objects: Array<{ label: string; confidence: number; bbox: number[] }>;
}

async function yoloDetectSegment(
  videoFile: File,
  startSec: number,
  endSec: number,
  yoloFps: number,
  classes: string[],
  onLog: (msg: string) => void
): Promise<YoloDetection[]> {
  // Always include universal vehicle/person defaults, then merge interpretation hints (cap to keep YOLO-World responsive).
  const defaults = ['car', 'truck', 'motorcycle', 'person', 'bicycle', 'bus'];
  const merged = Array.from(new Set([...defaults, ...classes.map(c => c.trim().toLowerCase()).filter(Boolean)])).slice(0, 24);
  onLog(`🔧 YOLO scanning ${startSec}s-${endSec}s @ ${yoloFps} FPS · classes: ${merged.join(', ')}`);

  const formData = new FormData();
  formData.append('file', videoFile);
  formData.append('start_sec', startSec.toString());
  formData.append('end_sec', endSec.toString());
  formData.append('yolo_fps', yoloFps.toString());
  formData.append('classes', merged.join(','));

  const res = await fetch('http://localhost:8000/yolo_detect', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`YOLO detect failed: ${await res.text()}`);
  }

  const data = await res.json();
  const detections: YoloDetection[] = data.detections || [];
  const totalObjects = detections.reduce((sum: number, d: YoloDetection) => sum + d.objects.length, 0);
  onLog(`   ✅ YOLO found ${totalObjects} objects across ${detections.length} frames.`);

  return detections;
}

// Sample N items evenly from a list (preserves first + last so the impact moment isn't dropped).
function sampleEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

const REASONING_FRAME_BUDGET = 14;

// Step 3: Gemini Final Reasoning — Phase 1 has already CONFIRMED the incident. Phase 3's job is to
// LOCATE the peak frame and identify involved parties — NOT to re-litigate whether it happened.
async function geminiFinalReasoning(
  apiKey: string,
  query: string,
  interpretation: QueryInterpretation,
  windowStart: number,
  windowEnd: number,
  flaggedMoments: FlaggedMoment[],
  detections: YoloDetection[],
  onLog: (msg: string) => void
): Promise<Incident[]> {
  // Highest-confidence flagged moment in this window — the authoritative Phase 1 finding.
  const topMoment = flaggedMoments.length > 0
    ? flaggedMoments.reduce((a, b) => a.confidence > b.confidence ? a : b)
    : null;

  if (detections.length === 0) {
    onLog(`   ⚠️ No frames returned from YOLO — using Phase 1 finding directly.`);
    if (topMoment) return [phase1Fallback(query, windowStart, windowEnd, flaggedMoments, [], topMoment)];
    return [];
  }

  // Send a small even sample of images, but ALL detection metadata so the verifier can reason about trajectories.
  const sentFrames = sampleEvenly(detections, REASONING_FRAME_BUDGET);
  onLog(`🧠 Phase 3: Localizing peak frame · sending ${sentFrames.length}/${detections.length} frames + full detection timeline...`);

  const context = detections.map((d, i) => ({
    frame_idx: i,
    timestamp_sec: d.frame_sec,
    sent_image: sentFrames.includes(d),
    detected_objects: d.objects.map((o, j) => ({
      object_id: `f${i}_o${j}`,
      label: o.label,
      confidence: o.confidence,
      bbox_1000: o.bbox,
    }))
  }));

  const flaggedSummary = flaggedMoments
    .map(m => `${m.flagged_sec.toFixed(1)}s @ ${(m.confidence * 100).toFixed(0)}% ("${m.description}")`)
    .join('; ');

  const prompt = `You are a forensic video analyst LOCATING an already-confirmed incident.

PHASE 1 (a separate Gemini agent) has ALREADY screened this video and CONFIRMED matching moment(s) in this window:
${flaggedSummary || '(none — locate from frames alone)'}

USER QUERY: "${query}" — meaning: "${interpretation.expanded_meaning}"
Visual categories that match this query: ${interpretation.visual_categories.join('; ')}

YOUR JOB IS NOT TO RE-LITIGATE WHETHER THE INCIDENT HAPPENED.
Phase 1 saw the entire video; trust its description. Your job is:
1. LOCATE the single most representative "peak" frame for each distinct incident (moment of impact / clearest visible state).
2. IDENTIFY which detected objects are involved (by object_id) and assign a role to each (e.g. "striking vehicle", "victim", "obstacle hit", "second vehicle", "bystander").
3. Refine the textual description to match the YOLO-annotated visual evidence.

If YOLO missed the obstacle/target (e.g. traffic barriers, debris, road furniture not in the class list), DO NOT downgrade — Phase 1 already saw it. Describe it textually under "description" and only list the visible parties under involved_objects.

I am sending ${sentFrames.length} frames evenly sampled from ${windowStart.toFixed(1)}s..${windowEnd.toFixed(1)}s, with green YOLO boxes drawn. The DETECTIONS array below covers EVERY frame's metadata (not just sent images), so you can reason about object positions/trajectories across the whole window. Coordinates are normalized 0–1000 as [ymin, xmin, ymax, xmax].

DETECTIONS:
${JSON.stringify(context)}

Return ONLY a JSON object with this EXACT shape:
{
  "incidents": [
    {
      "incident_frame_idx": number,
      "incident_timestamp_sec": number,
      "event_type": string,
      "description": string,
      "severity": "low" | "medium" | "high",
      "confidence": number,
      "involved_objects": [
        { "object_id": string, "role": string }
      ]
    }
  ]
}

CRITICAL: only return { "incidents": [] } if you can clearly prove Phase 1's findings are contradicted by the YOLO evidence (e.g. the window shows an empty road with zero relevant objects). When in doubt, return at least one incident built from Phase 1's description and the most plausible peak frame.`;

  const parts: any[] = [{ text: prompt }];
  for (const d of sentFrames) {
    parts.push({
      inlineData: { mimeType: "image/jpeg", data: d.annotated_frame_b64 }
    });
  }

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey.trim()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
    })
  });

  if (!res.ok) {
    throw new Error(`Gemini reasoning failed: ${await res.text()}`);
  }

  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  let parsed: any = {};
  try { parsed = JSON.parse(rawText); } catch {
    onLog(`   ⚠️ Reasoning returned invalid JSON — falling back to Phase 1 finding.`);
    if (topMoment) return [phase1Fallback(query, windowStart, windowEnd, flaggedMoments, detections, topMoment)];
    return [];
  }

  const rawIncidents: any[] = Array.isArray(parsed.incidents) ? parsed.incidents : [];
  if (rawIncidents.length === 0) {
    if (topMoment && topMoment.confidence >= 0.7) {
      onLog(`   ⚠️ Localizer returned empty but Phase 1 was ${(topMoment.confidence * 100).toFixed(0)}% — keeping Phase 1 finding.`);
      return [phase1Fallback(query, windowStart, windowEnd, flaggedMoments, detections, topMoment)];
    }
    onLog(`   ℹ️ No incident confirmed in window ${windowStart.toFixed(1)}-${windowEnd.toFixed(1)}s.`);
    return [];
  }

  // Build the trace once per window — shared across the incidents that come out of it
  const trace: IncidentTrace = {
    query,
    windowStart,
    windowEnd,
    flaggedMoments: flaggedMoments.map(m => ({
      flagged_sec: m.flagged_sec,
      confidence: m.confidence,
      description: m.description,
    })),
    yoloFrames: detections.map(d => ({
      frameSec: d.frame_sec,
      annotatedB64: d.annotated_frame_b64,
      objects: d.objects.map(o => ({ label: o.label, confidence: o.confidence, bbox: o.bbox })),
    })),
    rawGeminiResponse: rawText,
  };

  const incidents: Incident[] = rawIncidents.map((raw): Incident => {
    const idx = Math.max(0, Math.min(detections.length - 1, Number(raw.incident_frame_idx ?? 0)));
    const incidentFrame = detections[idx];
    const incidentSec = Number(raw.incident_timestamp_sec ?? incidentFrame?.frame_sec ?? windowStart);
    const eventType = String(raw.event_type || 'event');
    const description = String(raw.description || query);
    const severity: 'low' | 'medium' | 'high' = (['low', 'medium', 'high'] as const).includes(raw.severity) ? raw.severity : 'medium';
    const localizerConf = Math.max(0, Math.min(1, Number(raw.confidence) || 0.8));
    // Confidence floor: never drop below Phase 1's confidence × 0.9 — the localizer can only refine, not invalidate
    const phase1Floor = topMoment ? topMoment.confidence * 0.9 : 0;
    const confidence = Math.max(phase1Floor, localizerConf);
    const involvedRaw: Array<{ object_id: string; role: string }> = Array.isArray(raw.involved_objects) ? raw.involved_objects : [];

    const involved: InvolvedObject[] = involvedRaw.flatMap(inv => {
      const m = /^f(\d+)_o(\d+)$/.exec(inv.object_id || '');
      if (!m) return [];
      const fIdx = Number(m[1]);
      const oIdx = Number(m[2]);
      const det = detections[fIdx];
      const obj = det?.objects[oIdx];
      if (!obj || !Array.isArray(obj.bbox) || obj.bbox.length !== 4) return [];
      return [{
        role: inv.role || 'object',
        label: obj.label,
        yoloConfidence: obj.confidence,
        bbox: [obj.bbox[0], obj.bbox[1], obj.bbox[2], obj.bbox[3]] as [number, number, number, number],
        fromFrameIdx: fIdx,
      }];
    });

    const id = ++keyframeIdCounter;
    return {
      id,
      timeSeconds: incidentSec,
      duration: [Math.max(0, incidentSec - 1.5), incidentSec + 1.5] as [number, number],
      eventType,
      description,
      severity,
      confidence,
      color: KEYFRAME_COLORS[id % KEYFRAME_COLORS.length],
      involved,
      trace,
    };
  });

  incidents.forEach(inc => {
    onLog(`   ✅ Incident @ ${inc.timeSeconds.toFixed(1)}s [${inc.severity}]: ${inc.eventType} (${(inc.confidence * 100).toFixed(0)}%) — ${inc.description}`);
    if (inc.involved.length > 0) {
      onLog(`      Involved: ${inc.involved.map(o => `${o.role} (${o.label})`).join(', ')}`);
    }
  });

  return incidents;
}

// Build an Incident directly from Phase 1's finding when Phase 3 fails or invalidates without justification.
function phase1Fallback(
  query: string,
  windowStart: number,
  windowEnd: number,
  flaggedMoments: FlaggedMoment[],
  detections: YoloDetection[],
  topMoment: FlaggedMoment
): Incident {
  // Pick the YOLO frame closest to topMoment.flagged_sec (so the inspector still has a peak frame)
  let closestIdx = 0;
  let closestDelta = Infinity;
  detections.forEach((d, i) => {
    const delta = Math.abs(d.frame_sec - topMoment.flagged_sec);
    if (delta < closestDelta) { closestDelta = delta; closestIdx = i; }
  });

  const trace: IncidentTrace = {
    query,
    windowStart,
    windowEnd,
    flaggedMoments: flaggedMoments.map(m => ({ flagged_sec: m.flagged_sec, confidence: m.confidence, description: m.description })),
    yoloFrames: detections.map(d => ({
      frameSec: d.frame_sec,
      annotatedB64: d.annotated_frame_b64,
      objects: d.objects.map(o => ({ label: o.label, confidence: o.confidence, bbox: o.bbox })),
    })),
    rawGeminiResponse: '(Phase 3 returned empty — keyframe built from Phase 1 finding)',
  };

  // Promote the top-2 YOLO objects in the closest frame as "involved" so the UI still has bboxes.
  const involved: InvolvedObject[] = (detections[closestIdx]?.objects || [])
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map(o => ({
      role: 'visible party',
      label: o.label,
      yoloConfidence: o.confidence,
      bbox: [o.bbox[0], o.bbox[1], o.bbox[2], o.bbox[3]] as [number, number, number, number],
      fromFrameIdx: closestIdx,
    }));

  const id = ++keyframeIdCounter;
  return {
    id,
    timeSeconds: topMoment.flagged_sec,
    duration: [Math.max(0, topMoment.flagged_sec - 1.5), topMoment.flagged_sec + 1.5] as [number, number],
    eventType: 'screened event',
    description: topMoment.description,
    severity: 'medium',
    confidence: topMoment.confidence,
    color: KEYFRAME_COLORS[id % KEYFRAME_COLORS.length],
    involved,
    trace,
  };
}

// ===== PIPELINE MEMOIZATION LOGIC IS NOW IN APP COMPONENT =====



// ===== SVG ICONS =====
const IconTerminal = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const IconSearch = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const IconUpload = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 16 12 12 8 16" />
    <line x1="12" y1="12" x2="12" y2="21" />
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
  </svg>
);

const IconPlay = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const IconPause = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
  </svg>
);

const IconCamera = () => (
  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="20" rx="2" ry="2" />
    <polygon points="10 8 16 12 10 16 10 8" />
  </svg>
);

const IconGemini = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const IconX = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const IconChevronUp = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="18 15 12 9 6 15" />
  </svg>
);

const IconChevronDown = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

// ===== APP =====
export default function App() {
  const [query, setQuery] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>(() => [
    createLog('info', 'Scamtir Video Intelligence Engine initialized.'),
    createLog('info', 'Powered by Gemini Multimodal API.'),
    createLog('info', 'Upload a video or connect a stream to begin.'),
  ]);
  const [analyzing, setAnalyzing] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [activeIncidentId, setActiveIncidentId] = useState<number | null>(null);
  const [inspectIncidentId, setInspectIncidentId] = useState<number | null>(null); // modal target
  const [confidenceFilter, setConfidenceFilter] = useState<number>(0); // 0..1; hide below threshold
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoDim, setVideoDim] = useState({ w: 0, h: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [queryHistory, setQueryHistory] = useState<string[]>([]);
  const [scanStart, setScanStart] = useState<number>(0);
  const [scanEnd, setScanEnd] = useState<number>(0);

  // Rendered video rect within the wrapper — letterbox/pillarbox aware so bboxes line up exactly
  const [videoFitRect, setVideoFitRect] = useState({ left: 0, top: 0, width: 0, height: 0 });

  // Live pipeline progress (drives the progress panel + analyzing overlay)
  const [progress, setProgress] = useState<PipelineProgress>({
    phase: 'idle',
    message: 'Idle.',
    batchesTotal: 0, batchesDone: 0,
    windowsTotal: 0, windowsDone: 0,
    incidentsFound: 0,
  });

  // Gemini API key management
  const [geminiApiKey, setGeminiApiKey] = useState<string>(ENV_API_KEY || '');
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isLogExpanded, setIsLogExpanded] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'online' | 'offline'>('checking');

  // Pipeline Memoization State
  const [pipelineOptimizedFile, setPipelineOptimizedFile] = useState<File | null>(null);
  const [pipelineGeminiUri, setPipelineGeminiUri] = useState<{ fileUri: string, mimeType: string } | null>(null);
  const [pipelineScreenedSegments, setPipelineScreenedSegments] = useState<FlaggedMoment[] | null>(null);
  const [pipelineInterpretation, setPipelineInterpretation] = useState<QueryInterpretation | null>(null);
  const lastQueryRef = useRef<string>('');

  // Check backend health
  useEffect(() => {
    const checkBackend = async () => {
      try {
        const res = await fetch('http://localhost:8000/health');
        if (res.ok) {
          setBackendStatus('online');
        } else {
          setBackendStatus('offline');
        }
      } catch (e) {
        setBackendStatus('offline');
      }
    };
    checkBackend();
    const interval = setInterval(checkBackend, 5000);
    return () => clearInterval(interval);
  }, []);

  // Check for API key on mount
  useEffect(() => {
    // Check if key is in .env (and isn't the placeholder string)
    if (ENV_API_KEY && ENV_API_KEY.length > 10 && !ENV_API_KEY.includes('your_')) {
      setGeminiApiKey(ENV_API_KEY);
      setLogs(prev => [...prev, createLog('success', 'Gemini API key loaded from .env')]);
    } else {
      const saved = localStorage.getItem('scamtir_gemini_key');
      if (saved && saved.length > 10) {
        setGeminiApiKey(saved);
        setLogs(prev => [...prev, createLog('success', 'Gemini API key loaded from local storage.')]);
      } else {
        setShowApiKeyModal(true);
        setLogs(prev => [...prev, createLog('warn', 'Gemini API key not initialized. Please enter your key to enable video analysis.')]);
      }
    }
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoWrapperRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logFeedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Recompute the rendered video rect whenever the wrapper resizes or the video metadata changes.
  // This is the key fix for "weird detection box positions" — bboxes are positioned within this rect
  // (which exactly matches the displayed video pixels, accounting for letterbox/pillarbox).
  useEffect(() => {
    const compute = () => {
      const v = videoRef.current;
      const w = videoWrapperRef.current;
      if (!v || !w) return;
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const wrapper = w.getBoundingClientRect();
      if (!vw || !vh || !wrapper.width || !wrapper.height) return;
      const videoAspect = vw / vh;
      const wrapperAspect = wrapper.width / wrapper.height;
      let renderW: number, renderH: number, left: number, top: number;
      if (wrapperAspect > videoAspect) {
        // wrapper is wider than the video → pillarbox (vertical bars left/right)
        renderH = wrapper.height;
        renderW = renderH * videoAspect;
        left = (wrapper.width - renderW) / 2;
        top = 0;
      } else {
        // wrapper is taller than the video → letterbox (bars top/bottom)
        renderW = wrapper.width;
        renderH = renderW / videoAspect;
        left = 0;
        top = (wrapper.height - renderH) / 2;
      }
      setVideoFitRect({ left, top, width: renderW, height: renderH });
    };
    compute();
    const v = videoRef.current;
    const w = videoWrapperRef.current;
    if (!v || !w) return;
    const ro = new ResizeObserver(compute);
    ro.observe(w);
    v.addEventListener('loadedmetadata', compute);
    window.addEventListener('resize', compute);
    return () => {
      ro.disconnect();
      v.removeEventListener('loadedmetadata', compute);
      window.removeEventListener('resize', compute);
    };
  }, [videoUrl, videoDim.w, videoDim.h]);

  // Auto-scroll log feed
  useEffect(() => {
    if (logFeedRef.current) {
      logFeedRef.current.scrollTop = logFeedRef.current.scrollHeight;
    }
  }, [logs]);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs(prev => [...prev.slice(-150), createLog(type, message)]);
  }, []);

  const handleVideoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setIncidents([]);
    setActiveIncidentId(null);
    setInspectIncidentId(null);
    setPipelineOptimizedFile(null);
    setPipelineGeminiUri(null);
    setPipelineScreenedSegments(null);
    setPipelineInterpretation(null);
    lastQueryRef.current = '';
    setProgress({
      phase: 'idle', message: 'Idle.',
      batchesTotal: 0, batchesDone: 0, windowsTotal: 0, windowsDone: 0, incidentsFound: 0,
    });
    addLog('success', `Video loaded: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`);
  }, [addLog]);

  const handleDropZoneClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleVideoMetadata = useCallback(() => {
    if (videoRef.current) {
      const dur = videoRef.current.duration;
      setVideoDuration(dur);
      setScanEnd(Math.floor(dur));
      setVideoDim({ w: videoRef.current.videoWidth, h: videoRef.current.videoHeight });
      addLog('info', `Video duration: ${formatVideoTime(dur)}, resolution: ${videoRef.current.videoWidth}x${videoRef.current.videoHeight}`);
    }
  }, [addLog]);

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  }, []);

  const togglePlayPause = useCallback(() => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  }, []);

  const seekTo = useCallback((seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      setCurrentTime(seconds);
    }
  }, []);

  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current || videoDuration === 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = x / rect.width;
    seekTo(pct * videoDuration);
  }, [videoDuration, seekTo]);

  const jumpToIncident = useCallback((inc: Incident) => {
    setActiveIncidentId(inc.id);
    seekTo(inc.timeSeconds);
    addLog('detect', `Jumped to ${formatVideoTime(inc.timeSeconds)} — ${inc.eventType}: ${inc.description} (${(inc.confidence * 100).toFixed(0)}%)`);
  }, [seekTo, addLog]);

  const openInspector = useCallback((inc: Incident) => {
    setInspectIncidentId(inc.id);
  }, []);

  const closeInspector = useCallback(() => {
    setInspectIncidentId(null);
  }, []);

  const saveApiKey = useCallback((key: string) => {
    setGeminiApiKey(key);
    localStorage.setItem('scamtir_gemini_key', key);
    setShowApiKeyModal(false);
    addLog('success', 'Gemini API key saved.');
  }, [addLog]);

  // Real Gemini analysis
  const runAnalysis = useCallback(async () => {
    if (!query.trim()) {
      addLog('error', 'No query entered. Describe what you want to find.');
      return;
    }
    if (!videoUrl || !videoFile) {
      addLog('error', 'No video loaded. Upload a video first.');
      return;
    }
    if (!geminiApiKey) {
      setShowApiKeyModal(true);
      addLog('error', 'API Key not initialized. Please enter your Gemini API key in the popup.');
      return;
    }
    if (analyzing) return;

    setAnalyzing(true);
    setIncidents([]);
    setActiveIncidentId(null);
    setInspectIncidentId(null);

    const queryText = query.trim();
    if (!queryHistory.includes(queryText)) {
      setQueryHistory(prev => [queryText, ...prev].slice(0, 10));
    }

    const setProg = (patch: Partial<PipelineProgress>) => setProgress(prev => ({ ...prev, ...patch }));

    addLog('info', `🧠 Query: "${queryText}"`);

    try {
      setProg({ phase: 'compress', message: 'Preparing video...', batchesTotal: 0, batchesDone: 0, windowsTotal: 0, windowsDone: 0, incidentsFound: 0 });
      addLog('info', `🚀 Multi-phase pipeline starting (chunk size ${BATCH_SIZE_SEC}s · YOLO ${YOLO_WINDOW_FPS} FPS · ±${PADDING_SEC}s windows)`);

      // Step 0: Compress (one-shot, memoized for the session)
      let currentOptFile = pipelineOptimizedFile;
      if (!currentOptFile) {
        currentOptFile = await compressVideoClientSide(videoFile, msg => addLog('info', msg));
        setPipelineOptimizedFile(currentOptFile);
      } else {
        addLog('info', `⏭️ Skip: Already compressed video.`);
      }

      // Step 1a: Upload to Gemini File API (one-shot, memoized)
      setProg({ phase: 'upload', message: 'Uploading video to Gemini File API...' });
      let currentGeminiUri = pipelineGeminiUri;
      if (!currentGeminiUri) {
        const fileInfo = await uploadVideoToGemini(geminiApiKey, currentOptFile, msg => addLog('info', msg));
        currentGeminiUri = { fileUri: fileInfo.fileUri, mimeType: fileInfo.mimeType };
        setPipelineGeminiUri(currentGeminiUri);
      } else {
        addLog('info', `⏭️ Skip: Video already ACTIVE on Gemini servers.`);
      }

      // Phase 0 — Interpret the query (broad → specific visual cues + class hints)
      let currentInterpretation = pipelineInterpretation;
      if (!currentInterpretation || lastQueryRef.current !== queryText) {
        currentInterpretation = await geminiInterpretQuery(geminiApiKey, queryText, msg => addLog('info', msg));
        setPipelineInterpretation(currentInterpretation);
      } else {
        addLog('info', `⏭️ Skip: Query already interpreted.`);
      }

      // Phase 1 — Batch screen via videoMetadata (now using the expanded interpretation)
      setProg({ phase: 'screen', message: 'Phase 1: chunked batch screening...' });
      let currentMoments: FlaggedMoment[] | null = pipelineScreenedSegments;
      if (!currentMoments || lastQueryRef.current !== queryText) {
        const totalBatches = Math.max(1, Math.ceil(((scanEnd > 0 ? scanEnd : videoDuration) - scanStart) / BATCH_SIZE_SEC));
        setProg({ batchesTotal: totalBatches, batchesDone: 0 });
        currentMoments = await geminiBatchScreen(
          geminiApiKey,
          currentGeminiUri.fileUri,
          currentGeminiUri.mimeType,
          queryText,
          currentInterpretation,
          videoDuration,
          scanStart,
          scanEnd,
          msg => {
            addLog('info', msg);
            // Crude per-batch progress nudge based on log lines
            if (msg.includes('Batch ') && (msg.includes('flagged') || msg.includes('failed'))) {
              setProgress(prev => ({ ...prev, batchesDone: Math.min(prev.batchesTotal, prev.batchesDone + 1) }));
            }
          }
        );
        setPipelineScreenedSegments(currentMoments);
        lastQueryRef.current = queryText;
      } else {
        addLog('info', `⏭️ Skip: Already screened for this query.`);
      }

      const filteredMoments = (currentMoments || []).filter(m =>
        m.flagged_sec >= scanStart && m.flagged_sec <= (scanEnd > 0 ? scanEnd : videoDuration)
      );

      if (filteredMoments.length === 0) {
        addLog('warn', `No moments flagged for "${queryText}" within the scan range.`);
        setProg({ phase: 'done', message: 'No matches.' });
        setAnalyzing(false);
        return;
      }

      // Phase 2: Build merged ±5s windows, hard-capped at MAX_WINDOW_SEC so each YOLO call is bounded.
      const windows = buildMergedWindows(filteredMoments, PADDING_SEC, videoDuration, MAX_WINDOW_SEC);
      setProg({ phase: 'yolo', message: `Phase 2: YOLO over ${windows.length} window(s) (≤${MAX_WINDOW_SEC}s each)...`, windowsTotal: windows.length, windowsDone: 0 });
      addLog('info', `📌 Phase 2: ${windows.length} window(s) (${PADDING_SEC}s padding, capped at ${MAX_WINDOW_SEC}s each) for YOLO annotation.`);

      const allIncidents: Incident[] = [];
      let firstAutoJumped = false;
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        addLog('info', `━━━ Window ${i + 1}/${windows.length}: ${w.start.toFixed(1)}s-${w.end.toFixed(1)}s (${(w.end - w.start).toFixed(1)}s, ${w.moments.length} flagged) ━━━`);
        setProg({ phase: 'yolo', message: `Phase 2: window ${i + 1}/${windows.length} (YOLO @ ${YOLO_WINDOW_FPS} FPS)...` });

        const detections = await yoloDetectSegment(videoFile, w.start, w.end, YOLO_WINDOW_FPS, currentInterpretation.target_objects, msg => addLog('info', msg));

        setProg({ phase: 'reason', message: `Phase 3: window ${i + 1}/${windows.length} reasoning over ${detections.length} frames...` });
        const incs = await geminiFinalReasoning(
          geminiApiKey,
          queryText,
          currentInterpretation,
          w.start,
          w.end,
          w.moments,
          detections,
          msg => addLog('info', msg)
        );

        // FIFO streaming: render each window's incidents immediately so the user sees progress
        // and can start inspecting / jumping while later windows are still processing.
        if (incs.length > 0) {
          allIncidents.push(...incs);
          const sortedSoFar = [...allIncidents].sort((a, b) => a.timeSeconds - b.timeSeconds);
          setIncidents(sortedSoFar);
          addLog('success', `   🚨 ${incs.length} incident(s) confirmed in window ${i + 1} — rendered to timeline.`);

          // Auto-jump to the very first incident the moment it lands (don't wait for all windows).
          if (!firstAutoJumped) {
            const first = sortedSoFar[0];
            setActiveIncidentId(first.id);
            seekTo(first.timeSeconds);
            addLog('info', `Auto-jumped to first incident at ${formatVideoTime(first.timeSeconds)}.`);
            firstAutoJumped = true;
          }
        }
        setProgress(prev => ({ ...prev, windowsDone: i + 1, incidentsFound: allIncidents.length }));
      }

      setProg({ phase: 'done', message: `Done. ${allIncidents.length} incident(s) found.`, incidentsFound: allIncidents.length });

      if (allIncidents.length === 0) {
        addLog('warn', `No incidents confirmed for "${queryText}" after deep analysis.`);
      } else {
        addLog('success', `⚡ Analysis complete. ${allIncidents.length} incident(s) found.`);
      }
    } catch (err: any) {
      console.error('[Scamtir] Gemini API error:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      addLog('error', `API error: ${errMsg}`);
      setProg({ phase: 'error', message: errMsg });
      if (errMsg.includes('401') || errMsg.includes('403')) {
        addLog('error', 'Invalid API key. Please re-enter your Gemini API key.');
        setShowApiKeyModal(true);
      }
    } finally {
      setAnalyzing(false);
    }
  }, [query, videoUrl, analyzing, videoDuration, addLog, queryHistory, geminiApiKey, pipelineOptimizedFile, pipelineGeminiUri, pipelineScreenedSegments, pipelineInterpretation, videoFile, scanStart, scanEnd, seekTo]);

  const loadPreset = useCallback((preset: PresetQuery) => {
    setQuery(preset.query);
    addLog('info', `Preset loaded: ${preset.title}`);
    inputRef.current?.focus();
  }, [addLog]);

  const clearLogs = useCallback(() => {
    setLogs([createLog('info', 'Log cleared.')]);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runAnalysis();
    }
  }, [runAnalysis]);

  const progressPct = videoDuration > 0 ? (currentTime / videoDuration) * 100 : 0;

  const visibleIncidents = incidents.filter(inc => inc.confidence >= confidenceFilter);
  const activeIncidents = visibleIncidents.filter(inc => currentTime >= inc.duration[0] && currentTime <= inc.duration[1]);
  const activeIncident = activeIncidents.find(i => i.id === activeIncidentId) || activeIncidents[0] || null;
  const inspectIncident = inspectIncidentId != null ? incidents.find(i => i.id === inspectIncidentId) || null : null;

  return (
    <div className="app-layout">
      {/* ===== LEFT: VIDEO VIEWPORT ===== */}
      <div className="viewport-panel">
        {/* Header */}
        <div className="viewport-header">
          <div className="viewport-brand">
            <div className="viewport-brand-logo">SCAMTIR<span>.</span></div>
            <div className="viewport-brand-badge">Gemini AI</div>
          </div>
          <div className="viewport-status">
            <div className="status-indicator">
              <div className={`status-dot ${backendStatus === 'online' ? '' : 'inactive'}`} style={backendStatus === 'offline' ? { background: '#f87171' } : {}} />
              <span>YOLO: {backendStatus === 'online' ? 'Online' : backendStatus === 'offline' ? 'Offline' : 'Checking...'}</span>
            </div>
            <div className="status-indicator" style={{ marginLeft: 12 }}>
              <div className={`status-dot ${videoUrl ? '' : 'inactive'}`} />
              <span>{videoUrl ? (isPlaying ? 'Playing' : 'Loaded') : 'No Video'}</span>
            </div>
            <div className="status-indicator" style={{ marginLeft: 12 }}>
              <div className={`status-dot ${visibleIncidents.length > 0 ? '' : 'inactive'}`} />
              <span>{visibleIncidents.length} Incident{visibleIncidents.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>

        {/* Video View */}
        <div className="viewport-body">
          {videoUrl ? (
            <div ref={videoWrapperRef} className="video-wrapper" style={{ '--video-aspect': videoDim.w && videoDim.h ? `${videoDim.w} / ${videoDim.h}` : '16/9' } as React.CSSProperties}>
              <video
                ref={videoRef}
                src={videoUrl}
                className="camera-feed-image"
                onLoadedMetadata={handleVideoMetadata}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onClick={togglePlayPause}
              />
              <div className="grid-overlay" />
              {analyzing && (
                <div className="scan-overlay">
                  <div className="scan-line" />
                  <div className="analyzing-text">
                    <IconGemini />
                    <span>{progress.message}</span>
                  </div>
                </div>
              )}
              {/* Bounding box layer — exactly the rendered video pixels (letterbox/pillarbox aware) */}
              {videoFitRect.width > 0 && (
                <div
                  className="bbox-layer"
                  style={{
                    position: 'absolute',
                    left: `${videoFitRect.left}px`,
                    top: `${videoFitRect.top}px`,
                    width: `${videoFitRect.width}px`,
                    height: `${videoFitRect.height}px`,
                    pointerEvents: 'none',
                    zIndex: 5,
                  }}
                >
                  {activeIncidents.flatMap(inc =>
                    inc.involved.map((obj, i) => {
                      const [ymin, xmin, ymax, xmax] = obj.bbox;
                      const top = `${(ymin / 1000) * 100}%`;
                      const left = `${(xmin / 1000) * 100}%`;
                      const width = `${((xmax - xmin) / 1000) * 100}%`;
                      const height = `${((ymax - ymin) / 1000) * 100}%`;
                      const isActive = inc.id === (activeIncident?.id ?? -1);
                      return (
                        <div
                          key={`bbox-${inc.id}-${i}`}
                          className={`bounding-box-overlay ${isActive ? 'is-active' : ''}`}
                          style={{ top, left, width, height, '--bbox-color': inc.color } as React.CSSProperties}
                          title={`${obj.role} (${obj.label} ${(obj.yoloConfidence * 100).toFixed(0)}%) — ${inc.eventType}`}
                        >
                          <div className="bbox-label" style={{ background: inc.color }}>
                            <span className="bbl-role">{obj.role}</span>
                            <span className="bbl-class">{obj.label}</span>
                          </div>
                          <div className="bbox-corner top-left" />
                          <div className="bbox-corner top-right" />
                          <div className="bbox-corner bottom-left" />
                          <div className="bbox-corner bottom-right" />
                        </div>
                      );
                    })
                  )}
                </div>
              )}
              {/* Active incident badge */}
              {activeIncident && (
                <div className="active-keyframe-badge" onClick={() => openInspector(activeIncident)} style={{ cursor: 'pointer' }} title="Click for processing details">
                  <span className="akf-dot" style={{ background: activeIncident.color }} />
                  <span className="akf-label">
                    <strong style={{ marginRight: 6 }}>{activeIncident.eventType}</strong>
                    {activeIncident.description}
                  </span>
                  <span className="akf-conf">{(activeIncident.confidence * 100).toFixed(0)}%</span>
                  <span className="akf-time">{formatVideoTime(activeIncident.timeSeconds)}</span>
                </div>
              )}
              {/* Play/Pause overlay */}
              <button className="play-overlay-btn" onClick={togglePlayPause} title={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <IconPause /> : <IconPlay />}
              </button>
            </div>
          ) : (
            <div className="camera-feed">
              <div className="camera-feed-placeholder" onClick={handleDropZoneClick} style={{ cursor: 'pointer' }}>
                <IconCamera />
                <p>Upload a video to begin analysis</p>
                <small>MP4, WebM, MOV — or drag & drop</small>
              </div>
              <div className="grid-overlay" />
            </div>
          )}
        </div>

        {/* ===== TIMELINE BAR ===== */}
        <div className="timeline-container">
          <div className="timeline-time">{formatVideoTime(currentTime)}</div>
          <div className="timeline-track-wrapper" ref={timelineRef} onClick={handleTimelineClick}>
            <div className="timeline-track">
              <div className="timeline-progress" style={{ width: `${progressPct}%` }} />
              {/* One range + one marker per incident (no more N stacked duplicates) */}
              {visibleIncidents.map(inc => {
                const startPct = videoDuration > 0 ? (inc.duration[0] / videoDuration) * 100 : 0;
                const widthPct = videoDuration > 0 ? ((inc.duration[1] - inc.duration[0]) / videoDuration) * 100 : 0;
                return (
                  <div
                    key={`range-${inc.id}`}
                    className={`keyframe-range ${activeIncidents.some(a => a.id === inc.id) ? 'active' : ''}`}
                    style={{ left: `${startPct}%`, width: `${widthPct}%`, '--kf-color': inc.color } as React.CSSProperties}
                  />
                );
              })}
              {visibleIncidents.map(inc => {
                const pct = videoDuration > 0 ? (inc.timeSeconds / videoDuration) * 100 : 0;
                const isActive = activeIncidents.some(a => a.id === inc.id);
                return (
                  <button
                    key={`marker-${inc.id}`}
                    className={`keyframe-marker ${isActive ? 'active' : ''}`}
                    style={{ left: `${pct}%`, '--kf-color': inc.color } as React.CSSProperties}
                    onClick={e => { e.stopPropagation(); jumpToIncident(inc); }}
                    title={`${formatVideoTime(inc.timeSeconds)} \u2014 ${inc.eventType}: ${inc.description} (${(inc.confidence * 100).toFixed(0)}%, ${inc.involved.length} involved)`}
                  >
                    <span className="keyframe-pulse" />
                  </button>
                );
              })}
              {/* Playhead */}
              <div className="timeline-playhead" style={{ left: `${progressPct}%` }} />
            </div>
          </div>
          <div className="timeline-time">{formatVideoTime(videoDuration)}</div>
        </div>

        {/* Incident chips row — one per real event, with type + parties + click-to-inspect */}
        {visibleIncidents.length > 0 && (
          <div className="keyframe-chips">
            {visibleIncidents.map(inc => (
              <div
                key={inc.id}
                className={`keyframe-chip ${activeIncidentId === inc.id ? 'active' : ''}`}
                style={{ '--kf-color': inc.color } as React.CSSProperties}
              >
                <button className="kc-main" onClick={() => jumpToIncident(inc)} title="Jump to incident">
                  <span className="kc-dot" style={{ background: inc.color }} />
                  <span className="kc-time">{formatVideoTime(inc.timeSeconds)}</span>
                  <span className="kc-event">{inc.eventType}</span>
                  <span className="kc-parties">{inc.involved.length}p</span>
                  <span className="kc-conf">{(inc.confidence * 100).toFixed(0)}%</span>
                </button>
                <button className="kc-inspect" onClick={() => openInspector(inc)} title="Show pipeline trace">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Footer Stats */}
        <div className="viewport-footer">
          <div className="viewport-stats">
            <div className="stat-item">
              <span className="stat-label">SRC</span>
              <span className="stat-value">{videoFile ? videoFile.name.slice(0, 24) : '—'}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">DURATION</span>
              <span className="stat-value">{videoDuration > 0 ? formatVideoTime(videoDuration) : '—'}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">INCIDENTS</span>
              <span className="stat-value">{visibleIncidents.length}</span>
            </div>
          </div>
          <div className="viewport-fps">
            {analyzing ? `⏳ ${progress.message}` : visibleIncidents.length > 0 ? '✅ Ready' : '— Idle'}
          </div>
        </div>
      </div>

      {/* ===== RIGHT: QUERY CONSOLE (30%) ===== */}
      <div className="console-panel">
        {/* Console Header */}
        <div className="console-header">
          <div className="console-header-icon gemini-icon">
            <IconGemini />
          </div>
          <div className="console-header-text">
            <h2>AI Query Console</h2>
            <p>Natural Language Video Intelligence</p>
          </div>
        </div>

        <div className="console-body">
          {/* Video Upload */}
          <div className="console-section">
            <div className="console-section-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="20" height="20" rx="2" ry="2" /><polygon points="10 8 16 12 10 16 10 8" />
              </svg>
              Video Source
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              style={{ display: 'none' }}
              onChange={handleVideoUpload}
              id="video-upload"
            />
            <div
              className={`image-upload-zone ${videoFile ? 'has-image' : ''}`}
              onClick={handleDropZoneClick}
              role="button"
              tabIndex={0}
              id="upload-zone"
            >
              {videoFile ? (
                <div className="uploaded-filename">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {videoFile.name}
                </div>
              ) : (
                <>
                  <IconUpload />
                  <p>Click to upload video</p>
                  <small>MP4, WebM, MOV</small>
                </>
              )}
            </div>
          </div>

          {/* Natural Language Query */}
          <div className="console-section">
            <div className="console-section-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              Natural Language Query
            </div>
            <div className="query-input-wrapper">
              <input
                ref={inputRef}
                className="query-input"
                type="text"
                placeholder='e.g. "person wearing white shirt raising a hand"'
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                id="query-input"
              />
              <button
                className="query-search-btn"
                onClick={runAnalysis}
                disabled={analyzing}
                title="Analyze with Gemini"
                id="query-search-btn"
              >
                {analyzing ? <div className="spinner" /> : <IconSearch />}
              </button>
            </div>

            {/* Pipeline Configuration */}
            <div style={{ marginTop: '16px', marginBottom: '20px', background: 'rgba(255,255,255,0.03)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>

              <div style={{ fontSize: '11px', color: '#666', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>
                Pipeline Configuration
              </div>

              {/* Row 1: Target Range */}
              <div style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', color: '#888', marginBottom: '4px', display: 'block' }}>
                    Scan Start (sec)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max={Math.max(0, scanEnd - 1)}
                    value={scanStart}
                    onChange={e => setScanStart(parseInt(e.target.value) || 0)}
                    className="query-input"
                    style={{ width: '100%', padding: '8px', marginBottom: '4px' }}
                  />
                  <div style={{ fontSize: '10px', color: '#555' }}>Start time limit</div>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '12px', color: '#888', marginBottom: '4px', display: 'block' }}>
                    Scan End (sec)
                  </label>
                  <input
                    type="number"
                    min={scanStart + 1}
                    max={Math.floor(videoDuration) || 9999}
                    value={scanEnd}
                    onChange={e => setScanEnd(parseInt(e.target.value) || 0)}
                    className="query-input"
                    style={{ width: '100%', padding: '8px', marginBottom: '4px' }}
                  />
                  <div style={{ fontSize: '10px', color: '#555' }}>End time limit</div>
                </div>
              </div>

              {/* Row 2: Confidence Threshold (filters incidents post-analysis) */}
              <div>
                <label style={{ fontSize: '12px', color: '#888', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Confidence Filter</span>
                  <span style={{ color: '#fff', fontWeight: 'bold' }}>{(confidenceFilter * 100).toFixed(0)}%</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(confidenceFilter * 100)}
                  onChange={e => setConfidenceFilter((parseInt(e.target.value) || 0) / 100)}
                  style={{ width: '100%', cursor: 'pointer', marginBottom: '4px' }}
                />
                <div style={{ fontSize: '10px', color: '#555' }}>
                  Hide incidents below this confidence ({incidents.length - visibleIncidents.length} hidden / {incidents.length} total).
                </div>
              </div>
            </div>
          </div>

          {/* Run button */}
          <button
            className={`run-detection-btn gemini-btn ${analyzing ? 'detecting' : ''}`}
            onClick={runAnalysis}
            disabled={analyzing}
          >
            {analyzing ? (
              <>
                <div className="spinner" />
                {progress.message}
              </>
            ) : (
              <>
                <IconGemini />
                Run Multi-Phase Analysis
              </>
            )}
          </button>

          {/* Pipeline Progress Panel — visible while analyzing or when last run produced results */}
          {(analyzing || progress.phase === 'done' || progress.phase === 'error') && (
            <div className="pipeline-panel">
              <div className="pp-header">
                <span className="pp-title">Pipeline Status</span>
                <span className={`pp-phase pp-phase-${progress.phase}`}>{progress.phase.toUpperCase()}</span>
              </div>
              <div className="pp-message">{progress.message}</div>
              <div className="pp-steps">
                <div className={`pp-step ${['screen','yolo','reason','done'].includes(progress.phase) ? 'done' : progress.phase === 'compress' || progress.phase === 'upload' ? 'active' : ''}`}>
                  <span className="pp-step-num">1</span>
                  <span className="pp-step-name">Upload</span>
                  <span className="pp-step-detail">{progress.phase === 'compress' ? 'compressing' : progress.phase === 'upload' ? 'uploading' : ''}</span>
                </div>
                <div className={`pp-step ${['yolo','reason','done'].includes(progress.phase) ? 'done' : progress.phase === 'screen' ? 'active' : ''}`}>
                  <span className="pp-step-num">2</span>
                  <span className="pp-step-name">Screen</span>
                  <span className="pp-step-detail">{progress.batchesTotal > 0 ? `${progress.batchesDone}/${progress.batchesTotal} batches` : ''}</span>
                </div>
                <div className={`pp-step ${['done'].includes(progress.phase) ? 'done' : (progress.phase === 'yolo' || progress.phase === 'reason') ? 'active' : ''}`}>
                  <span className="pp-step-num">3</span>
                  <span className="pp-step-name">YOLO + Reason</span>
                  <span className="pp-step-detail">{progress.windowsTotal > 0 ? `${progress.windowsDone}/${progress.windowsTotal} windows` : ''}</span>
                </div>
              </div>
              {progress.windowsTotal > 0 && (
                <div className="pp-bar">
                  <div className="pp-bar-fill" style={{ width: `${(progress.windowsDone / progress.windowsTotal) * 100}%` }} />
                </div>
              )}
              <div className="pp-tail">
                <span>Incidents found: <strong>{progress.incidentsFound}</strong></span>
                {progress.phase === 'error' && <span style={{ color: 'var(--accent-red)' }}>· error</span>}
              </div>
            </div>
          )}

          {/* Query History */}
          {queryHistory.length > 0 && (
            <div className="console-section">
              <div className="console-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                Recent Queries
              </div>
              <div className="query-history">
                {queryHistory.map((q, i) => (
                  <button key={i} className="query-history-item" onClick={() => { setQuery(q); inputRef.current?.focus(); }}>
                    <span className="qh-text">{q}</span>
                    <IconX />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Preset Queries */}
          <div className="console-section">
            <div className="console-section-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Quick Query Presets
            </div>
            <div className="preset-prompts">
              {PRESET_QUERIES.map((p, i) => (
                <button key={i} className="preset-prompt-btn" onClick={() => loadPreset(p)} id={`preset-${i}`}>
                  <span className="preset-emoji">{p.emoji}</span>
                  <span className="preset-text">
                    <strong>{p.title}</strong>
                    <span>{p.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Log Feed */}
          <div className={`log-section-container ${isLogExpanded ? 'expanded' : ''}`}>
            <div className="console-section-title log-header-sticky" onClick={() => setIsLogExpanded(!isLogExpanded)} style={{ cursor: 'pointer', userSelect: 'none' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconTerminal />
                System Log
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button className="clear-log-btn" onClick={(e) => { e.stopPropagation(); clearLogs(); }}>Clear</button>
                <div className="expand-icon-wrapper">
                  {isLogExpanded ? <IconChevronDown /> : <IconChevronUp />}
                </div>
              </div>
            </div>
            <div className="log-feed" ref={logFeedRef}>
              {logs.map(log => (
                <div key={log.id} className="log-entry">
                  <span className="log-timestamp">{log.timestamp}</span>
                  <span className={`log-type ${log.type}`}>
                    {log.type === 'info' && 'INFO'}
                    {log.type === 'success' && ' OK '}
                    {log.type === 'warn' && 'WARN'}
                    {log.type === 'error' && ' ERR'}
                    {log.type === 'detect' && 'DTCT'}
                  </span>
                  <span className="log-message" dangerouslySetInnerHTML={{ __html: log.message.replace(/\"([^\"]+)\"/g, '<strong>"$1"</strong>') }} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Console Footer */}
        <div className="console-footer">
          <div className="console-footer-info">
            <div className={`status-dot ${analyzing ? '' : geminiApiKey ? 'inactive' : ''}`} style={{ width: 6, height: 6 }} />
            {analyzing ? 'Gemini Processing...' : geminiApiKey ? 'Ready' : 'No API Key'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              className="clear-log-btn"
              onClick={() => { setApiKeyInput(geminiApiKey); setShowApiKeyModal(true); }}
              title="Configure Gemini API Key"
            >
              ⚙ API Key
            </button>
            <div className="console-footer-version">v3.0.0-gemini</div>
          </div>
        </div>
      </div>

      {/* ===== API KEY MODAL ===== */}
      {showApiKeyModal && (
        <div className="modal-overlay" onClick={() => geminiApiKey && setShowApiKeyModal(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-icon">
                <IconGemini />
              </div>
              <div>
                <h3 className="modal-title">Gemini API Key</h3>
                <p className="modal-subtitle">Required to analyze video with AI</p>
              </div>
            </div>
            <div className="modal-body">
              <p className="modal-hint">
                Get a free key at{' '}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
                  aistudio.google.com/apikey
                </a>
              </p>
              <input
                className="modal-input"
                type="password"
                placeholder="AIzaSy..."
                value={apiKeyInput}
                onChange={e => setApiKeyInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && apiKeyInput.trim()) saveApiKey(apiKeyInput.trim()); }}
                autoFocus
              />
              <p className="modal-note">
                Stored in browser localStorage. Add <code>VITE_GEMINI_API_KEY</code> to <code>.env</code> to skip this prompt.
              </p>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn-secondary"
                onClick={() => { setApiKeyInput(''); localStorage.removeItem('scamtir_gemini_key'); setGeminiApiKey(''); }}
                style={{ marginRight: 'auto', color: 'var(--accent-red)' }}
              >
                Clear
              </button>
              {geminiApiKey && (
                <button className="modal-btn-secondary" onClick={() => setShowApiKeyModal(false)}>
                  Cancel
                </button>
              )}
              <button
                className="modal-btn-primary"
                onClick={() => {
                  const val = apiKeyInput.trim();
                  if (val) saveApiKey(val);
                }}
                disabled={!apiKeyInput.trim()}
              >
                Save Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== INCIDENT INSPECTOR MODAL =====
          Click an incident chip (or the active badge) to see exactly what the pipeline saw and decided. */}
      {inspectIncident && (
        <div className="modal-overlay" onClick={closeInspector}>
          <div className="modal-card inspector-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-icon" style={{ background: inspectIncident.color }}>
                <IconGemini />
              </div>
              <div style={{ flex: 1 }}>
                <h3 className="modal-title">
                  {inspectIncident.eventType}
                  <span style={{ marginLeft: 10, fontSize: '12px', color: 'var(--text-secondary)' }}>
                    @ {formatVideoTime(inspectIncident.timeSeconds)} · severity {inspectIncident.severity} · {(inspectIncident.confidence * 100).toFixed(0)}%
                  </span>
                </h3>
                <p className="modal-subtitle">{inspectIncident.description}</p>
              </div>
              <button className="modal-btn-secondary" onClick={closeInspector}>Close</button>
            </div>

            <div className="modal-body inspector-body">
              {/* Section: Query */}
              <div className="insp-section">
                <div className="insp-section-title">Query Sent</div>
                <code className="insp-query">"{inspectIncident.trace.query}"</code>
              </div>

              {/* Section: Phase 1 — flagged moments */}
              <div className="insp-section">
                <div className="insp-section-title">
                  Phase 1 · Coarse Screen — flagged moments inside window {inspectIncident.trace.windowStart.toFixed(1)}s..{inspectIncident.trace.windowEnd.toFixed(1)}s
                </div>
                {inspectIncident.trace.flaggedMoments.length === 0 ? (
                  <div className="insp-empty">No flagged moments recorded for this window.</div>
                ) : (
                  <ul className="insp-list">
                    {inspectIncident.trace.flaggedMoments.map((m, i) => (
                      <li key={i}>
                        <strong>{m.flagged_sec.toFixed(1)}s</strong>
                        <span className="insp-conf">{(m.confidence * 100).toFixed(0)}%</span>
                        <span className="insp-text">{m.description}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Section: Phase 2 — YOLO frames */}
              <div className="insp-section">
                <div className="insp-section-title">
                  Phase 2 · YOLO @ {YOLO_WINDOW_FPS} FPS — {inspectIncident.trace.yoloFrames.length} frame(s) sent to Gemini
                </div>
                <div className="insp-thumb-strip">
                  {inspectIncident.trace.yoloFrames.map((f, i) => (
                    <div key={i} className="insp-thumb" title={`${f.frameSec.toFixed(2)}s · ${f.objects.length} object(s)`}>
                      <img src={`data:image/jpeg;base64,${f.annotatedB64}`} alt={`frame ${i}`} />
                      <div className="insp-thumb-meta">
                        <span>{f.frameSec.toFixed(1)}s</span>
                        <span>{f.objects.length}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Section: Phase 3 — involved objects */}
              <div className="insp-section">
                <div className="insp-section-title">Phase 3 · Final Reasoning — Gemini's verdict</div>
                {inspectIncident.involved.length === 0 ? (
                  <div className="insp-empty">No specific objects were attributed to this incident.</div>
                ) : (
                  <ul className="insp-list insp-involved">
                    {inspectIncident.involved.map((obj, i) => (
                      <li key={i}>
                        <span className="insp-role" style={{ background: inspectIncident.color }}>{obj.role}</span>
                        <span className="insp-class">{obj.label}</span>
                        <span className="insp-conf">YOLO {(obj.yoloConfidence * 100).toFixed(0)}%</span>
                        <span className="insp-bbox">bbox [{obj.bbox.map(n => Math.round(n)).join(', ')}]</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Section: Raw response */}
              <details className="insp-section">
                <summary className="insp-section-title" style={{ cursor: 'pointer' }}>Raw Gemini response (JSON)</summary>
                <pre className="insp-raw">{(() => {
                  try { return JSON.stringify(JSON.parse(inspectIncident.trace.rawGeminiResponse), null, 2); }
                  catch { return inspectIncident.trace.rawGeminiResponse; }
                })()}</pre>
              </details>
            </div>

            <div className="modal-actions">
              <button className="modal-btn-primary" onClick={() => { jumpToIncident(inspectIncident); closeInspector(); }}>
                Jump to Moment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
