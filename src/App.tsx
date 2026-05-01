import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

const BACKEND_URL = 'http://localhost:8000';

// ===== TYPES =====
interface LogEntry {
  id: number;
  timestamp: string;
  type: 'info' | 'success' | 'warn' | 'error' | 'detect';
  message: string;
}

interface DetectionBox {
  id: number;
  label: string;
  confidence: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PresetPrompt {
  emoji: string;
  title: string;
  description: string;
  vocabs: string[];
}

// ===== PRESETS =====
const PRESET_PROMPTS: PresetPrompt[] = [
  {
    emoji: '🔌',
    title: 'Cable Theft Detection',
    description: 'คนกำลังถือสายไฟ / ตัดสายเคเบิล',
    vocabs: ['person holding wire', 'cable cutting', 'unauthorized person near cable box'],
  },
  {
    emoji: '🚧',
    title: 'Road Hazard Detection',
    description: 'สิ่งกีดขวาง / ต้นไม้ล้ม / เศษซาก',
    vocabs: ['fallen tree on road', 'debris on highway', 'damaged guardrail'],
  },
  {
    emoji: '🚗',
    title: 'Traffic Anomaly',
    description: 'รถจอดผิดที่ / อุบัติเหตุ / รถย้อนศร',
    vocabs: ['car stopped on shoulder', 'vehicle accident', 'wrong-way driver'],
  },
  {
    emoji: '🏭',
    title: 'Safety Compliance',
    description: 'ไม่สวม PPE / มือใกล้ใบมีด',
    vocabs: ['worker without helmet', 'hand near moving blade', 'person in restricted zone'],
  },
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

function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

// ===== SVG ICONS =====
const IconPlus = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const IconCamera = () => (
  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const IconUpload = () => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 16 12 12 8 16" />
    <line x1="12" y1="12" x2="12" y2="21" />
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
  </svg>
);

const IconTerminal = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const IconZap = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const IconX = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// ===== APP =====
export default function App() {
  const [vocabs, setVocabs] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [confidence, setConfidence] = useState(0.45);
  const [logs, setLogs] = useState<LogEntry[]>(() => [
    createLog('info', 'Scamtify Zero-Shot Engine initialized.'),
    createLog('info', 'Checking backend connection...'),
  ]);
  const [detecting, setDetecting] = useState(false);
  const [detections, setDetections] = useState<DetectionBox[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [backendConnected, setBackendConnected] = useState(false);

  // Source Type
  const [sourceType, setSourceType] = useState<'image' | 'webcam'>('image');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const logFeedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const detectingRef = useRef(false);

  // Auto-scroll log feed
  useEffect(() => {
    if (logFeedRef.current) {
      logFeedRef.current.scrollTop = logFeedRef.current.scrollHeight;
    }
  }, [logs]);

  // ===== HEALTH CHECK on mount + periodic heartbeat =====
  useEffect(() => {
    const checkHealth = async () => {
      try {
        console.log('[FRONTEND] Pinging backend health at', `${BACKEND_URL}/health`);
        const res = await fetch(`${BACKEND_URL}/health`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        console.log('[FRONTEND] ✅ Backend health OK:', data);
        setBackendConnected(true);
        setLogs(prev => [...prev, createLog('success', `Backend connected. Model: ${data.model}, Webcam: ${data.webcam ? 'OK' : 'FAIL'}, Classes: ${data.current_classes.length}`)]);
      } catch (err: any) {
        console.error('[FRONTEND] ❌ Backend health check FAILED:', err.message);
        setBackendConnected(false);
        setLogs(prev => [...prev, createLog('error', `Backend NOT reachable at ${BACKEND_URL}. Start backend_server.ipynb first!`)]);
      }
    };
    checkHealth();

    // Heartbeat every 10 seconds
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/health`);
        const wasConnected = backendConnected;
        if (res.ok) {
          if (!wasConnected) {
            console.log('[FRONTEND] ✅ Backend reconnected!');
            setLogs(prev => [...prev, createLog('success', 'Backend reconnected!')]);
          }
          setBackendConnected(true);
        } else {
          throw new Error('not ok');
        }
      } catch {
        if (backendConnected) {
          console.warn('[FRONTEND] ⚠️ Backend heartbeat lost.');
          setLogs(prev => [...prev, createLog('error', 'Backend connection lost!')]);
        }
        setBackendConnected(false);
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [backendConnected]);

  // Simulated FPS counter (approximate)
  useEffect(() => {
    if (!imageUrl) { setFps(0); return; }
    const interval = setInterval(() => {
      setFps(sourceType === 'webcam' ? 10 : 0); // Native stream is capped at 10 FPS
    }, 1000);
    return () => clearInterval(interval);
  }, [imageUrl, sourceType]);

  // Synchronize vocabs to backend whenever they change (any mode)
  useEffect(() => {
    if (!backendConnected) return; // Don't attempt if backend is offline

    const syncClasses = async () => {
      try {
        console.log('[FRONTEND] Syncing vocabs to backend:', vocabs);
        const formData = new FormData();
        formData.append('vocabs', JSON.stringify(vocabs));
        const res = await fetch(`${BACKEND_URL}/update_classes`, { method: 'POST', body: formData });
        const data = await res.json();
        console.log('[FRONTEND] ✅ Backend classes synced:', data);
        setLogs(prev => [...prev.slice(-100), createLog('success', `Backend classes updated: [${data.classes.join(', ')}]`)]);
      } catch (e: any) {
        console.error('[FRONTEND] ❌ Failed to sync classes to backend:', e.message);
        setLogs(prev => [...prev.slice(-100), createLog('error', `Failed to sync classes to backend: ${e.message}`)]);
      }
    };
    syncClasses();
  }, [vocabs, backendConnected]);

  const addLog = useCallback((type: LogEntry['type'], message: string) => {
    setLogs(prev => [...prev.slice(-100), createLog(type, message)]);
  }, []);

  const addVocab = useCallback(() => {
    const val = inputValue.trim();
    if (!val) return;
    if (vocabs.includes(val)) {
      addLog('warn', `Duplicate vocab skipped: "${val}"`);
      return;
    }
    setVocabs(prev => [...prev, val]);
    addLog('success', `Vocab added: "${val}"`);
    setInputValue('');
    inputRef.current?.focus();
  }, [inputValue, vocabs, addLog]);

  const removeVocab = useCallback((v: string) => {
    setVocabs(prev => prev.filter(x => x !== v));
    addLog('info', `Vocab removed: "${v}"`);
    setDetections(prev => prev.filter(d => d.label !== v));
  }, [addLog]);

  const loadPreset = useCallback((preset: PresetPrompt) => {
    const newVocabs = preset.vocabs.filter(v => !vocabs.includes(v));
    if (newVocabs.length === 0) {
      addLog('warn', `All vocabs from "${preset.title}" already loaded.`);
      return;
    }
    setVocabs(prev => [...prev, ...newVocabs]);
    addLog('info', `Preset loaded: ${preset.title} (+${newVocabs.length} vocabs)`);
  }, [vocabs, addLog]);

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setDetections([]);
    setSourceType('image');
    addLog('success', `Image loaded: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
  }, [addLog]);

  const handleDropZoneClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const toggleWebcam = useCallback(async () => {
    if (sourceType === 'webcam') {
      console.log('[FRONTEND] Disconnecting from backend webcam stream.');
      setSourceType('image');
      setImageUrl(imageFile ? URL.createObjectURL(imageFile) : null);
      setDetections([]);
      addLog('info', 'Disconnected from Native Backend Webcam.');
    } else {
      // Pre-flight: check if backend is alive before connecting
      console.log('[FRONTEND] Attempting to connect to backend webcam stream...');
      try {
        const healthRes = await fetch(`${BACKEND_URL}/health`);
        if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
        const healthData = await healthRes.json();
        console.log('[FRONTEND] ✅ Backend alive. Webcam status:', healthData.webcam);
        
        if (!healthData.webcam) {
          addLog('error', 'Backend is running but webcam failed to open. Check if another app is using it.');
          return;
        }
      } catch (e: any) {
        console.error('[FRONTEND] ❌ Cannot reach backend:', e.message);
        addLog('error', `Cannot reach backend at ${BACKEND_URL}. Is backend_server.ipynb running?`);
        return;
      }

      setSourceType('webcam');
      const streamUrl = `${BACKEND_URL}/video_feed?t=${Date.now()}`;
      console.log('[FRONTEND] Setting MJPEG stream src:', streamUrl);
      setImageUrl(streamUrl);
      addLog('success', 'Connected to Backend Native Webcam Stream.');
      
      // Force an immediate sync of classes
      try {
        const formData = new FormData();
        formData.append('vocabs', JSON.stringify(vocabs));
        const res = await fetch(`${BACKEND_URL}/update_classes`, { method: 'POST', body: formData });
        const data = await res.json();
        console.log('[FRONTEND] ✅ Classes synced on stream connect:', data);
        addLog('info', `Classes synced: ${data.classes.join(', ')}`);
      } catch (e: any) {
        console.error('[FRONTEND] ❌ Failed to sync classes:', e.message);
        addLog('warn', 'Stream connected but class sync failed.');
      }
    }
  }, [sourceType, imageFile, addLog, vocabs]);

  const runDetection = useCallback(async () => {
    if (sourceType === 'webcam') {
      addLog('info', 'Webcam stream is running natively on the backend. Just look at the feed!');
      return;
    }

    if (vocabs.length === 0) {
      addLog('error', 'No vocabulary defined. Add detection prompts first.');
      return;
    }
    if (!imageFile) {
      addLog('error', 'No image loaded.');
      return;
    }
    if (detectingRef.current) return;

    setDetecting(true);
    detectingRef.current = true;
    setDetections([]);
    
    addLog('info', `Running YOLO-World detection on image with ${vocabs.length} prompt(s)...`);

    const startTime = performance.now();
    try {
      console.log('[FRONTEND] Sending /detect request:', { vocabs, confidence, fileName: imageFile.name });
      const formData = new FormData();
      formData.append('vocabs', JSON.stringify(vocabs));
      formData.append('threshold', confidence.toString());
      formData.append('file', imageFile);

      const response = await fetch(`${BACKEND_URL}/detect`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log('[FRONTEND] ✅ /detect response:', result);
      
      if (result.status === 'success') {
        setDetections(result.detections);
        
        if (result.detections.length > 0) {
          addLog('success', `⚡ ${result.detections.length} detection(s) found above threshold.`);
          result.detections.forEach((d: DetectionBox) => {
            addLog('detect', `Match: "${d.label}" — conf: ${(d.confidence * 100).toFixed(1)}%`);
          });
        } else {
          addLog('info', 'No detections above confidence threshold.');
        }
      } else {
        console.error('[FRONTEND] ❌ Backend returned error status:', result);
        addLog('error', 'Backend returned an error status.');
      }
    } catch (err: any) {
      console.error('[FRONTEND] ❌ /detect request failed:', err.message);
      addLog('error', `Connection failed: ${err.message}. Is the backend running?`);
    } finally {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
      addLog('info', `Inference complete in ${elapsed}s`);
      setDetecting(false);
      detectingRef.current = false;
    }
  }, [vocabs, imageFile, confidence, addLog, sourceType]);

  const clearLogs = useCallback(() => {
    setLogs([createLog('info', 'Log cleared.')]);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') addVocab();
  }, [addVocab]);

  return (
    <div className="app-layout">
      {/* ===== LEFT: VIEWPORT (70%) ===== */}
      <div className="viewport-panel">
        {/* Header */}
        <div className="viewport-header">
          <div className="viewport-brand">
            <div className="viewport-brand-logo">SCAMTIFY<span>.</span></div>
            <div className="viewport-brand-badge">Zero-Shot</div>
          </div>
          <div className="viewport-status">
            <div className="status-indicator">
              <div className={`status-dot ${backendConnected ? '' : 'inactive'}`} />
              <span>{backendConnected ? 'Backend Online' : 'Backend Offline'}</span>
            </div>
            <div className="status-indicator" style={{ marginLeft: 12 }}>
              <div className={`status-dot ${imageUrl ? '' : 'inactive'}`} />
              <span>{imageUrl ? (sourceType === 'webcam' ? 'Streaming' : 'Image') : 'No Feed'}</span>
            </div>
          </div>
        </div>

        {/* Camera / Image View */}
        <div className="viewport-body">
          {imageUrl ? (
            <>
              {/* For both image and backend stream, we render an <img> */}
              <img src={imageUrl} alt="Camera feed" className="camera-feed-image" crossOrigin="anonymous" />
              
              <div className="grid-overlay" />
              {detecting && (
                <div className="scan-overlay">
                  <div className="scan-line" />
                </div>
              )}
              {/* Only render frontend boxes if it's an uploaded image. Backend stream handles its own box drawing natively! */}
              {sourceType === 'image' && (
                <div className="detection-overlay">
                  {detections.map(d => (
                    <div
                      key={d.id}
                      className="detection-box"
                      style={{
                        left: `${d.x}%`,
                        top: `${d.y}%`,
                        width: `${d.w}%`,
                        height: `${d.h}%`,
                      }}
                    >
                      <div className="detection-label">
                        {d.label} <span className="confidence">{(d.confidence * 100).toFixed(0)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="camera-feed">
              <div className="camera-feed-placeholder">
                <IconCamera />
                <p>No feed — Connect to Backend Stream or upload image</p>
              </div>
              <div className="grid-overlay" />
            </div>
          )}
        </div>

        {/* Footer Stats */}
        <div className="viewport-footer">
          <div className="viewport-stats">
            <div className="stat-item">
              <span className="stat-label">SRC</span>
              <span className="stat-value">{sourceType === 'webcam' ? 'Backend /video_feed' : (imageFile ? imageFile.name.slice(0, 20) : '—')}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">MODE</span>
              <span className="stat-value">{sourceType.toUpperCase()}</span>
            </div>
            {sourceType === 'image' && (
              <div className="stat-item">
                <span className="stat-label">DETECTIONS</span>
                <span className="stat-value">{detections.length}</span>
              </div>
            )}
          </div>
          <div className="viewport-fps">
            {fps > 0 ? `${fps} FPS` : '— FPS'}
          </div>
        </div>
      </div>

      {/* ===== RIGHT: CONSOLE (30%) ===== */}
      <div className="console-panel">
        {/* Console Header */}
        <div className="console-header">
          <div className="console-header-icon">
            <IconTerminal />
          </div>
          <div className="console-header-text">
            <h2>Detection Console</h2>
            <p>Text-to-Image Zero-Shot Prompt</p>
          </div>
        </div>

        <div className="console-body">
          {/* Media Source Selector */}
          <div className="console-section">
            <div className="console-section-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              Media Source
            </div>
            
            <div style={{ display: 'flex', gap: '8px', marginBottom: sourceType === 'image' ? '10px' : '0' }}>
               <button 
                  className={`run-detection-btn ${sourceType === 'image' ? 'active' : ''}`} 
                  onClick={() => { if(sourceType === 'webcam') toggleWebcam(); }}
                  style={{ flex: 1, padding: '8px', background: sourceType==='image'?'#3b82f6':'#1e293b' }}
               >
                 Image Upload
               </button>
               <button 
                  className={`run-detection-btn ${sourceType === 'webcam' ? 'active' : ''}`} 
                  onClick={toggleWebcam}
                  style={{ flex: 1, padding: '8px', background: sourceType==='webcam'?'#ef4444':'#1e293b' }}
               >
                 {sourceType === 'webcam' ? 'Stop Stream' : 'Backend Stream'}
               </button>
            </div>

            {sourceType === 'image' && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleImageUpload}
                  id="image-upload"
                />
                <div
                  className={`image-upload-zone ${imageFile ? 'has-image' : ''}`}
                  onClick={handleDropZoneClick}
                  role="button"
                  tabIndex={0}
                  id="upload-zone"
                >
                  {imageFile ? (
                    <div className="uploaded-filename">
                      <IconCheck /> {imageFile.name}
                    </div>
                  ) : (
                    <>
                      <IconUpload />
                      <p>Click to upload image</p>
                      <small>PNG, JPG, WebP — or drag & drop</small>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Vocab Input */}
          <div className="console-section">
            <div className="console-section-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </svg>
              Detection Vocabulary
            </div>
            <div className="vocab-input-wrapper">
              <input
                ref={inputRef}
                className="vocab-input"
                type="text"
                placeholder='e.g. "person holding wire"'
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                id="vocab-input"
              />
              <button
                className="vocab-add-btn"
                onClick={addVocab}
                title="Add vocabulary"
                id="vocab-add-btn"
              >
                <IconPlus />
              </button>
            </div>

            {vocabs.length > 0 ? (
              <div className="vocab-tags">
                {vocabs.map(v => (
                  <div key={v} className="vocab-tag">
                     {v}
                    <button className="vocab-tag-remove" onClick={() => removeVocab(v)} title="Remove">
                      <IconX />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="vocab-empty">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <p>Type what you want to detect</p>
              </div>
            )}
          </div>

          {/* Confidence Threshold */}
          <div className="console-section">
            <div className="console-section-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
              Settings
            </div>
            
            {sourceType === 'image' && (
              <div className="confidence-slider-wrapper">
                <div className="confidence-slider-header">
                  <label>Confidence Threshold</label>
                  <span>{(confidence * 100).toFixed(0)}%</span>
                </div>
                <input
                  className="confidence-slider"
                  type="range"
                  min="0.1"
                  max="0.95"
                  step="0.05"
                  value={confidence}
                  onChange={e => setConfidence(parseFloat(e.target.value))}
                  id="confidence-slider"
                />
              </div>
            )}

            {sourceType === 'image' ? (
              <button
                className={`run-detection-btn ${detecting ? 'detecting' : ''}`}
                onClick={() => runDetection()}
                disabled={detecting}
              >
                {detecting ? 'Analyzing...' : 'Run Single Image'}
              </button>
            ) : (
              <button className="run-detection-btn" disabled style={{ background: '#059669', opacity: 1, cursor: 'default' }}>
                <IconZap /> Streaming Live Natively
              </button>
            )}
          </div>

          {/* Preset Prompts */}
          <div className="console-section">
            <div className="console-section-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Quick Presets
            </div>
            <div className="preset-prompts">
              {PRESET_PROMPTS.map((p, i) => (
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
          <div className="console-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingBottom: 0 }}>
            <div className="console-section-title" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                System Log
              </span>
              <button className="clear-log-btn" onClick={clearLogs} id="clear-log-btn">Clear</button>
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

        {/* Console Footer */}
        <div className="console-footer">
          <div className="console-footer-info">
            <div className={`status-dot ${detecting || sourceType === 'webcam' ? '' : 'inactive'}`} style={{ width: 6, height: 6 }} />
            {sourceType === 'webcam' ? 'Live Streaming...' : (detecting ? 'Processing...' : 'Idle')}
          </div>
          <div className="console-footer-version">v2.0.0-sentinel</div>
        </div>
      </div>
    </div>
  );
}
