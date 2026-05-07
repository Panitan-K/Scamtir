import { useState, useRef, useCallback, useEffect } from 'react';
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

// Upload video and poll until active via Gemini File API
async function uploadAndAnalyzeVideo(apiKey: string, videoFile: File, query: string, onLog: (msg: string) => void): Promise<Keyframe[]> {
  // 1. Upload
  onLog(`Uploading ${videoFile.name} (${(videoFile.size / 1024 / 1024).toFixed(1)}MB) via Gemini File API...`);
  const uploadRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey.trim()}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Header-Content-Length': videoFile.size.toString(),
      'X-Goog-Upload-Header-Content-Type': videoFile.type || 'video/mp4',
      'Content-Type': videoFile.type || 'video/mp4'
    },
    body: videoFile
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${await uploadRes.text()}`);
  }

  const fileInfo = await uploadRes.json();
  const fileName = fileInfo.file.name;
  const fileUri = fileInfo.file.uri;
  onLog(`Upload complete. File URI: ${fileUri}`);

  // 2. Poll for processing
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

  onLog('Video is ACTIVE. Running analysis query...');

  // 3. Generate Content
  const systemPrompt = `You are an AI Video Verification Engine.
You are analyzing a video clip to find segments matching the query: "${query}".
Your task is to verify this claim and provide reasoning. Look closely at the motion and interaction between entities.
Return ONLY a JSON array of events. Each event must be an object with the following schema:
- "start_time_seconds": number (the exact start timestamp in seconds)
- "end_time_seconds": number (the exact end timestamp in seconds)
- "is_verified": boolean (True if the "${query}" actually occurred)
- "reasoning": string (Provide a 1-sentence step-by-step reasoning of what physically happened to justify your verification)
- "feedback": string (If not verified, explain what the objects were actually doing)
- "bounding_box_2d": array of 4 numbers [ymin, xmin, ymax, xmax] normalized between 0 and 1000. If a box cannot be drawn, return null.
If nothing matches, return [].`;

  const genRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey.trim()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: systemPrompt },
          { fileData: { fileUri: fileUri, mimeType: fileInfo.file.mimeType } }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2
      }
    })
  });

  if (!genRes.ok) {
    throw new Error(`Analysis failed: ${await genRes.text()}`);
  }

  const genData = await genRes.json();
  const text = genData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  const detections = JSON.parse(text) as Array<{ start_time_seconds: number; end_time_seconds: number; is_verified: boolean; reasoning: string; feedback?: string; bounding_box_2d: [number, number, number, number] | null; confidence?: number }>;

  // Log feedback for unverified events to help the user understand why it failed
  const unverified = detections.find(d => d.is_verified === false);
  if (unverified) {
    onLog(`💡 Model Feedback: ${unverified.feedback || unverified.reasoning}`);
  }

  const verifiedDetections = detections.filter(d => d.is_verified !== false);

  return verifiedDetections.map((d, i) => {
    const start = d.start_time_seconds || 0;
    const end = d.end_time_seconds || start + 1;
    return {
      id: ++keyframeIdCounter,
      timeSeconds: start,
      duration: [start, Math.max(start, end)],
      boundingBox: d.bounding_box_2d || null,
      label: d.reasoning || query,
      confidence: d.confidence || 0.95, // Fallback if confidence isn't strictly requested
      color: KEYFRAME_COLORS[i % KEYFRAME_COLORS.length],
    };
  });
}

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

  // Gemini API key management
  const [geminiApiKey, setGeminiApiKey] = useState<string>(ENV_API_KEY || '');
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isLogExpanded, setIsLogExpanded] = useState(false);

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
    addLog('success', `Video loaded: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`);
  }, [addLog]);

  const handleDropZoneClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleVideoMetadata = useCallback(() => {
    if (videoRef.current) {
      setVideoDuration(videoRef.current.duration);
      setVideoDim({ w: videoRef.current.videoWidth, h: videoRef.current.videoHeight });
      addLog('info', `Video duration: ${formatVideoTime(videoRef.current.duration)}, resolution: ${videoRef.current.videoWidth}x${videoRef.current.videoHeight}`);
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
      addLog('info', `Starting analysis using Gemini File API...`);
      const results = await uploadAndAnalyzeVideo(geminiApiKey, videoFile, queryText, (msg) => {
        addLog('info', msg);
      });

      // Step 3: Process results
      if (results.length === 0) {
        addLog('warn', `No matches found for "${queryText}".`);
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
      addLog('error', `Gemini API error: ${err.message}`);
      if (err.message.includes('401') || err.message.includes('403')) {
        addLog('error', 'Invalid API key. Please re-enter your Gemini API key.');
        setShowApiKeyModal(true);
      }
    } finally {
      setAnalyzing(false);
    }
  }, [query, videoUrl, analyzing, videoDuration, addLog, queryHistory, jumpToKeyframe, geminiApiKey]);

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

            {/* Run button */}
            <button
              className={`run-detection-btn gemini-btn ${analyzing ? 'detecting' : ''}`}
              onClick={runAnalysis}
              disabled={analyzing}
            >
              {analyzing ? (
                <>
                  <div className="spinner" />
                  Analyzing with Gemini...
                </>
              ) : (
                <>
                  <IconGemini />
                  Analyze Video
                </>
              )}
            </button>
          </div>

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
