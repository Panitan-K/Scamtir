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

interface Keyframe {
  id: number;
  timeSeconds: number;
  duration: [number, number]; // [start, end]
  boundingBox: [number, number, number, number] | null; // [ymin, xmin, ymax, xmax] scaled to 1000
  label: string;
  confidence: number;
  color: string;
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
const SCREEN_CONCURRENCY = 4;      // Max parallel Gemini screening calls
const YOLO_WINDOW_FPS = 3;         // Phase 2: 3 FPS × 10s = 30 annotated frames

interface FlaggedMoment {
  flagged_sec: number;
  confidence: number;
  description: string;
}

// Step 1: Gemini Batch Screening — chop video into <10s windows, ask each for the EXACT second of the event
async function geminiBatchScreen(
  apiKey: string,
  fileUri: string,
  mimeType: string,
  query: string,
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
Watch this short clip carefully and identify the EXACT second(s) when this occurs: "${query}"

Return ONLY a JSON array. Each item must have:
- "flagged_sec": number (the precise second in the ORIGINAL full video where the event occurs — use the timestamps you observe in this clip)
- "confidence": number between 0 and 1
- "description": string (one short sentence describing what you saw at that moment)

Be precise. Pick the single most representative second per event. If multiple distinct events happen, list each.
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

// Helper: merge nearby flagged seconds into ±padSec windows so YOLO doesn't redo overlapping work
function buildMergedWindows(
  moments: FlaggedMoment[],
  padSec: number,
  videoDurationSec: number
): Array<{ start: number; end: number; moments: FlaggedMoment[] }> {
  if (moments.length === 0) return [];
  const sorted = [...moments].sort((a, b) => a.flagged_sec - b.flagged_sec);
  const windows: Array<{ start: number; end: number; moments: FlaggedMoment[] }> = [];
  for (const m of sorted) {
    const s = Math.max(0, m.flagged_sec - padSec);
    const e = Math.min(videoDurationSec, m.flagged_sec + padSec);
    const last = windows[windows.length - 1];
    if (last && s <= last.end) {
      last.end = Math.max(last.end, e);
      last.moments.push(m);
    } else {
      windows.push({ start: s, end: e, moments: [m] });
    }
  }
  return windows;
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
  onLog: (msg: string) => void
): Promise<YoloDetection[]> {
  onLog(`🔧 YOLO scanning segment ${startSec}s - ${endSec}s at ${yoloFps} FPS...`);

  const formData = new FormData();
  formData.append('file', videoFile);
  formData.append('start_sec', startSec.toString());
  formData.append('end_sec', endSec.toString());
  formData.append('yolo_fps', yoloFps.toString());
  formData.append('classes', 'car,truck,motorcycle,person,bicycle,bus');

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

// Step 3: Gemini Final Reasoning — send ALL annotated frames + bbox metadata for the whole window
async function geminiFinalReasoning(
  apiKey: string,
  query: string,
  windowStart: number,
  windowEnd: number,
  flaggedMoments: FlaggedMoment[],
  detections: YoloDetection[],
  onLog: (msg: string) => void
): Promise<Keyframe[]> {
  if (detections.length === 0) {
    onLog(`   ⚠️ No frames returned from YOLO — skipping reasoning.`);
    return [];
  }

  onLog(`🧠 Phase 3: Sending ${detections.length} annotated frames @ ${YOLO_WINDOW_FPS} FPS to Gemini...`);

  const context = detections.map((d, i) => ({
    frame_idx: i,
    timestamp_sec: d.frame_sec,
    detected_objects: d.objects.map((o, j) => ({
      object_id: `f${i}_o${j}`,
      label: o.label,
      confidence: o.confidence,
      bbox_1000: o.bbox,
    }))
  }));

  const flaggedSummary = flaggedMoments
    .map(m => `${m.flagged_sec.toFixed(1)}s ("${m.description}")`)
    .join('; ');

  const prompt = `You are a forensic video analyst.
USER QUERY: "${query}"
COARSE SCREEN flagged these moments inside this window: ${flaggedSummary}

I am showing you ${detections.length} sequential frames sampled at ${YOLO_WINDOW_FPS} FPS spanning ${windowStart.toFixed(1)}s..${windowEnd.toFixed(1)}s of the original video.
Each frame has YOLO detection boxes drawn (green rectangles with labels). Use the metadata below to refer to specific objects by object_id. Coordinates are normalized 0–1000 as [ymin, xmin, ymax, xmax].

DETECTIONS:
${JSON.stringify(context)}

Reason about object motion, trajectories, and spatial relationships across the frames. Determine:
1. Whether a real incident matching the query actually occurred.
2. The single most representative INCIDENT frame (peak of the event).
3. What kind of event happened (collision, near-miss, fall, debris, intrusion, etc.).
4. Which detected objects are involved and the role of each.

Return ONLY a JSON object with this EXACT shape:
{
  "incident_detected": boolean,
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

If no real incident is confirmed, set "incident_detected": false and return defaults for the other fields.`;

  const parts: any[] = [{ text: prompt }];
  for (const d of detections) {
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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch {
    onLog(`   ⚠️ Reasoning returned invalid JSON.`);
    return [];
  }

  if (!parsed.incident_detected) {
    onLog(`   ℹ️ No incident confirmed in window ${windowStart.toFixed(1)}-${windowEnd.toFixed(1)}s.`);
    return [];
  }

  const idx = Math.max(0, Math.min(detections.length - 1, Number(parsed.incident_frame_idx ?? 0)));
  const incidentFrame = detections[idx];
  const incidentSec = Number(parsed.incident_timestamp_sec ?? incidentFrame?.frame_sec ?? windowStart);
  const eventType = String(parsed.event_type || 'event');
  const description = String(parsed.description || query);
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0.8));
  const involved: Array<{ object_id: string; role: string }> = Array.isArray(parsed.involved_objects) ? parsed.involved_objects : [];

  const dur: [number, number] = [
    Math.max(0, incidentSec - 1.5),
    incidentSec + 1.5
  ];

  // Render one keyframe per involved object so each gets its own bbox overlay; if none, render a single label-only keyframe
  if (involved.length === 0) {
    onLog(`   ✅ Incident @ ${incidentSec.toFixed(1)}s: ${eventType} (${(confidence * 100).toFixed(0)}%) — ${description}`);
    return [{
      id: ++keyframeIdCounter,
      timeSeconds: incidentSec,
      duration: dur,
      boundingBox: null,
      label: `${eventType} — ${description}`,
      confidence,
      color: KEYFRAME_COLORS[keyframeIdCounter % KEYFRAME_COLORS.length],
    }];
  }

  const keyframes: Keyframe[] = involved.map((inv, i) => {
    const m = /^f(\d+)_o(\d+)$/.exec(inv.object_id || '');
    let bbox: [number, number, number, number] | null = null;
    if (m) {
      const fIdx = Number(m[1]);
      const oIdx = Number(m[2]);
      const det = detections[fIdx];
      const obj = det?.objects[oIdx];
      if (obj && Array.isArray(obj.bbox) && obj.bbox.length === 4) {
        bbox = [obj.bbox[0], obj.bbox[1], obj.bbox[2], obj.bbox[3]];
      }
    }
    return {
      id: ++keyframeIdCounter,
      timeSeconds: incidentSec,
      duration: dur,
      boundingBox: bbox,
      label: `${inv.role || 'object'} — ${eventType}`,
      confidence,
      color: KEYFRAME_COLORS[i % KEYFRAME_COLORS.length],
    };
  });

  onLog(`   ✅ Incident @ ${incidentSec.toFixed(1)}s: ${eventType} (${(confidence * 100).toFixed(0)}%) — ${description}`);
  onLog(`      Involved: ${involved.map(o => `${o.role}`).join(', ')}`);
  return keyframes;
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
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [activeKeyframe, setActiveKeyframe] = useState<Keyframe | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoDim, setVideoDim] = useState({ w: 0, h: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [queryHistory, setQueryHistory] = useState<string[]>([]);
  const [yoloFps, setYoloFps] = useState<number>(5);
  const [scanStart, setScanStart] = useState<number>(0);
  const [scanEnd, setScanEnd] = useState<number>(0);

  // Gemini API key management
  const [geminiApiKey, setGeminiApiKey] = useState<string>(ENV_API_KEY || '');
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isLogExpanded, setIsLogExpanded] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'online' | 'offline'>('checking');

  // Pipeline Memoization State
  const [pipelineOptimizedFile, setPipelineOptimizedFile] = useState<File | null>(null);
  const [pipelineGeminiUri, setPipelineGeminiUri] = useState<{ fileUri: string, mimeType: string } | null>(null);
  const [pipelineScreenedSegments, setPipelineScreenedSegments] = useState<any[] | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logFeedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

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
    setKeyframes([]);
    setActiveKeyframe(null);
    setPipelineOptimizedFile(null);
    setPipelineGeminiUri(null);
    setPipelineScreenedSegments(null);
    lastQueryRef.current = '';
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

  const jumpToKeyframe = useCallback((kf: Keyframe) => {
    setActiveKeyframe(kf);
    seekTo(kf.timeSeconds);
    addLog('detect', `Jumped to keyframe at ${formatVideoTime(kf.timeSeconds)}: "${kf.label}" (${(kf.confidence * 100).toFixed(0)}%)`);
  }, [seekTo, addLog]);

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
    setKeyframes([]);
    setActiveKeyframe(null);

    const queryText = query.trim();
    if (!queryHistory.includes(queryText)) {
      setQueryHistory(prev => [queryText, ...prev].slice(0, 10));
    }

    addLog('info', `🧠 Sending query to Gemini: "${queryText}"`);

    try {
      addLog('info', `🚀 Initializing Chunked Multi-Phase Pipeline...`);
      addLog('info', `📊 Phase 1: Gemini batch screen (${BATCH_SIZE_SEC}s chunks) → Phase 2: YOLO @ ${YOLO_WINDOW_FPS} FPS over ±${PADDING_SEC}s windows → Phase 3: Gemini reasoning over annotated frames`);

      // Step 0: Compress (one-shot, memoized for the session)
      let currentOptFile = pipelineOptimizedFile;
      if (!currentOptFile) {
        currentOptFile = await compressVideoClientSide(videoFile, msg => addLog('info', msg));
        setPipelineOptimizedFile(currentOptFile);
      } else {
        addLog('info', `⏭️ Skip: Already compressed video.`);
      }

      // Step 1a: Upload to Gemini File API (one-shot, memoized)
      let currentGeminiUri = pipelineGeminiUri;
      if (!currentGeminiUri) {
        const fileInfo = await uploadVideoToGemini(geminiApiKey, currentOptFile, msg => addLog('info', msg));
        currentGeminiUri = { fileUri: fileInfo.fileUri, mimeType: fileInfo.mimeType };
        setPipelineGeminiUri(currentGeminiUri);
      } else {
        addLog('info', `⏭️ Skip: Video already ACTIVE on Gemini servers.`);
      }

      // Step 1b: Phase 1 — Batch screen via videoMetadata (no re-upload, isolated context per chunk)
      let currentMoments: FlaggedMoment[] | null = pipelineScreenedSegments as FlaggedMoment[] | null;
      if (!currentMoments || lastQueryRef.current !== queryText) {
        currentMoments = await geminiBatchScreen(
          geminiApiKey,
          currentGeminiUri.fileUri,
          currentGeminiUri.mimeType,
          queryText,
          videoDuration,
          scanStart,
          scanEnd,
          msg => addLog('info', msg)
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
        setAnalyzing(false);
        return;
      }

      // Step 2: Build merged ±5s windows (overlap-safe so YOLO doesn't re-run on the same frames)
      const windows = buildMergedWindows(filteredMoments, PADDING_SEC, videoDuration);
      addLog('info', `\n📌 Phase 2: ${windows.length} merged window(s) (${PADDING_SEC}s padding, deduped) for YOLO annotation.`);

      const allKeyframes: Keyframe[] = [];
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        addLog('info', `\n━━━ Window ${i + 1}/${windows.length}: ${w.start.toFixed(1)}s - ${w.end.toFixed(1)}s (${w.moments.length} flagged moment(s)) ━━━`);

        // Phase 2: YOLO @ 3 FPS over the window — gives ~30 annotated frames for a 10s window
        const detections = await yoloDetectSegment(videoFile, w.start, w.end, YOLO_WINDOW_FPS, msg => addLog('info', msg));

        // Phase 3: Gemini reasoning over all annotated frames + bbox metadata
        const kfs = await geminiFinalReasoning(
          geminiApiKey,
          queryText,
          w.start,
          w.end,
          w.moments,
          detections,
          msg => addLog('info', msg)
        );

        allKeyframes.push(...kfs);

        if (kfs.length > 0) {
          addLog('success', `   🚨 Incident confirmed in window ${i + 1}.`);
        }
      }

      addLog('info', `\n✅ Pipeline complete. ${allKeyframes.length} keyframe(s) rendered.`);
      const results = allKeyframes;

      // Step 3: Process results
      if (results.length === 0) {
        addLog('warn', `No matches confirmed for "${queryText}" after verification.`);
      } else {
        setKeyframes(results.sort((a, b) => a.timeSeconds - b.timeSeconds));
        results.forEach(kf => {
          addLog('detect', `Match at ${formatVideoTime(kf.timeSeconds)}: "${kf.label}" — conf: ${(kf.confidence * 100).toFixed(1)}%`);
        });
        addLog('success', `⚡ Analysis complete. ${results.length} keyframe(s) found.`);

        // Auto-jump to highest confidence
        const best = results.reduce((a, b) => a.confidence > b.confidence ? a : b);
        jumpToKeyframe(best);
        addLog('info', `Auto-jumped to best match at ${formatVideoTime(best.timeSeconds)}.`);
      }
    } catch (err: any) {
      console.error('[Scamtir] Gemini API error:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      addLog('error', `API error: ${errMsg}`);
      if (errMsg.includes('401') || errMsg.includes('403')) {
        addLog('error', 'Invalid API key. Please re-enter your Gemini API key.');
        setShowApiKeyModal(true);
      }
    } finally {
      setAnalyzing(false);
    }
  }, [query, videoUrl, analyzing, videoDuration, addLog, queryHistory, jumpToKeyframe, geminiApiKey, pipelineOptimizedFile, pipelineGeminiUri, pipelineScreenedSegments, videoFile, scanStart, scanEnd]);

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

  const activeFrames = keyframes.filter(kf => currentTime >= kf.duration[0] && currentTime <= kf.duration[1]);

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
              <div className={`status-dot ${keyframes.length > 0 ? '' : 'inactive'}`} />
              <span>{keyframes.length} Keyframe{keyframes.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>

        {/* Video View */}
        <div className="viewport-body">
          {videoUrl ? (
            <div className="video-wrapper" style={{ '--video-aspect': videoDim.w && videoDim.h ? `${videoDim.w} / ${videoDim.h}` : '16/9' } as React.CSSProperties}>
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
                    <span>Gemini is analyzing video segments...</span>
                  </div>
                </div>
              )}
              {/* Bounding Box Overlays */}
              {videoDim.w > 0 && activeFrames.map(kf => {
                if (!kf.boundingBox) return null;
                const [ymin, xmin, ymax, xmax] = kf.boundingBox;
                const top = `${(ymin / 1000) * 100}%`;
                const left = `${(xmin / 1000) * 100}%`;
                const width = `${((xmax - xmin) / 1000) * 100}%`;
                const height = `${((ymax - ymin) / 1000) * 100}%`;
                return (
                  <div
                    key={`bbox-${kf.id}`}
                    className="bounding-box-overlay"
                    style={{ top, left, width, height, '--bbox-color': kf.color } as React.CSSProperties}
                  >
                    <div className="bbox-label" style={{ background: kf.color }}>{kf.label}</div>
                    <div className="bbox-corner top-left" />
                    <div className="bbox-corner top-right" />
                    <div className="bbox-corner bottom-left" />
                    <div className="bbox-corner bottom-right" />
                  </div>
                );
              })}
              {/* Active keyframe indicator */}
              {activeKeyframe && (
                <div className="active-keyframe-badge">
                  <span className="akf-dot" style={{ background: activeKeyframe.color }} />
                  <span className="akf-label">{activeKeyframe.label}</span>
                  <span className="akf-conf">{(activeKeyframe.confidence * 100).toFixed(0)}%</span>
                  <span className="akf-time">{formatVideoTime(activeKeyframe.timeSeconds)}</span>
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
              {/* Keyframe ranges */}
              {keyframes.map(kf => {
                const startPct = videoDuration > 0 ? (kf.duration[0] / videoDuration) * 100 : 0;
                const widthPct = videoDuration > 0 ? ((kf.duration[1] - kf.duration[0]) / videoDuration) * 100 : 0;
                return (
                  <div
                    key={`range-${kf.id}`}
                    className={`keyframe-range ${activeFrames.some(a => a.id === kf.id) ? 'active' : ''}`}
                    style={{ left: `${startPct}%`, width: `${widthPct}%`, '--kf-color': kf.color } as React.CSSProperties}
                  />
                );
              })}
              {/* Keyframe markers */}
              {keyframes.map(kf => {
                const pct = videoDuration > 0 ? (kf.timeSeconds / videoDuration) * 100 : 0;
                const isActive = activeFrames.some(a => a.id === kf.id);
                return (
                  <button
                    key={`marker-${kf.id}`}
                    className={`keyframe-marker ${isActive ? 'active' : ''}`}
                    style={{ left: `${pct}%`, '--kf-color': kf.color } as React.CSSProperties}
                    onClick={e => { e.stopPropagation(); jumpToKeyframe(kf); }}
                    title={`${formatVideoTime(kf.duration[0])} - ${formatVideoTime(kf.duration[1])} \u2014 ${kf.label} (${(kf.confidence * 100).toFixed(0)}%)`}
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

        {/* Keyframe chips row */}
        {keyframes.length > 0 && (
          <div className="keyframe-chips">
            {keyframes.map(kf => (
              <button
                key={kf.id}
                className={`keyframe-chip ${activeKeyframe?.id === kf.id ? 'active' : ''}`}
                style={{ '--kf-color': kf.color } as React.CSSProperties}
                onClick={() => jumpToKeyframe(kf)}
              >
                <span className="kc-dot" style={{ background: kf.color }} />
                <span className="kc-time">{formatVideoTime(kf.timeSeconds)}</span>
                <span className="kc-conf">{(kf.confidence * 100).toFixed(0)}%</span>
              </button>
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
              <span className="stat-label">KEYFRAMES</span>
              <span className="stat-value">{keyframes.length}</span>
            </div>
          </div>
          <div className="viewport-fps">
            {analyzing ? '⏳ Analyzing...' : keyframes.length > 0 ? '✅ Ready' : '— Idle'}
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

              {/* Row 2: Advanced Settings */}
              <div>
                <label style={{ fontSize: '12px', color: '#888', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>YOLO Annotator Precision</span>
                  <span style={{ color: '#fff', fontWeight: 'bold' }}>{yoloFps} FPS</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="30"
                  value={yoloFps}
                  onChange={e => setYoloFps(parseInt(e.target.value) || 5)}
                  style={{ width: '100%', cursor: 'pointer', marginBottom: '4px' }}
                />
                <div style={{ fontSize: '10px', color: '#555' }}>Higher FPS = Better spatial reasoning, but slower processing.</div>
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
                Running Pipeline...
              </>
            ) : (
              <>
                <IconGemini />
                Start Gemini-Optimized Pipeline

              </>
            )}
          </button>

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
    </div>
  );
}
