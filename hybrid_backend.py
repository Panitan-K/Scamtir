import os
import cv2
import json
import time
import uuid
import tempfile
import numpy as np
from fastapi import FastAPI, Form, File, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.background import BackgroundTasks
import uvicorn
import threading
from ultralytics import YOLOWorld
from tqdm import tqdm

app = FastAPI(title="Scamtir Hybrid Video Backend (YOLO + Gemini)")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    return {"status": "ok", "message": "YOLO Backend is running"}

# Thread lock for YOLO model
model_lock = threading.Lock()

print("[BACKEND] Loading YOLO-World model...")
model = YOLOWorld("yolov8s-worldv2.pt")
print("[BACKEND] ✅ YOLO-World loaded.")

def cleanup_file(path: str):
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception as e:
        print(f"[CLEANUP] Failed to remove {path}: {e}")

@app.post("/hybrid_trigger")
async def hybrid_trigger(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    query: str = Form(...),
    yolo_fps: int = Form(5),
    clip_duration_sec: int = Form(4),
    confidence_threshold: float = Form(0.1),
    start_sec: float = Form(0.0),
    end_sec: float = Form(-1.0)
):
    """
    1. Receives video.
    2. Runs YOLO-World at `yolo_fps` to search for `query`.
    3. If found, slices a micro-chunk of `clip_duration_sec` around the detection.
    4. Returns the chunk so the frontend can send it to Gemini.
    """
    print(f"\n[HYBRID] Received video: {file.filename} | Query: '{query}'")
    
    temp_dir = tempfile.gettempdir()
    video_id = str(uuid.uuid4())
    input_path = os.path.join(temp_dir, f"{video_id}_in.mp4")
    output_path = os.path.join(temp_dir, f"{video_id}_out.mp4")
    
    # Save uploaded file
    with open(input_path, "wb") as f:
        f.write(await file.read())
        
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        return JSONResponse({"status": "error", "message": "Could not open video file."}, status_code=400)
        
    orig_fps = cap.get(cv2.CAP_PROP_FPS)
    if orig_fps <= 0: orig_fps = 30.0
    
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    frame_skip = max(1, int(orig_fps / yolo_fps))
    
    print(f"[HYBRID] Video info: {orig_fps} FPS, {total_frames} frames, {width}x{height}")
    print(f"[HYBRID] YOLO scanning at {yolo_fps} FPS (checking every {frame_skip} frames)")

    detection_timestamp = -1
    detection_bbox = None
    
    with model_lock:
        model.set_classes([query])
        
        start_frame = int(start_sec * orig_fps)
        end_frame = int(end_sec * orig_fps) if end_sec > 0 else total_frames
        
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
        current_frame = start_frame
        scan_frames = min(total_frames, end_frame) - start_frame

        with tqdm(total=scan_frames, desc=f"Scanning '{query}'", unit="frame") as pbar:
            while True:
                if current_frame > end_frame:
                    break
                    
                ret, frame = cap.read()
                if not ret:
                    break
                    
                # Only process at the target YOLO FPS
                if current_frame % frame_skip == 0:
                    results = model.predict(frame, conf=confidence_threshold, verbose=False)
                    
                    if len(results) > 0 and len(results[0].boxes) > 0:
                        # Anomaly found!
                        box = results[0].boxes[0] # Take highest confidence
                        x1, y1, x2, y2 = box.xyxy[0].cpu().tolist()
                        conf = box.conf[0].item()
                        
                        detection_timestamp = current_frame / orig_fps
                        detection_bbox = [y1/height*1000, x1/width*1000, y2/height*1000, x2/width*1000]
                        print(f"\n[HYBRID] 🚨 Anomaly detected at {detection_timestamp:.2f}s (Conf: {conf:.2f})")
                        break # Stop scanning, we found the trigger point
                
                current_frame += 1
                pbar.update(1)

    # If nothing detected
    if detection_timestamp == -1:
        cap.release()
        cleanup_file(input_path)
        return JSONResponse({
            "status": "not_found", 
            "message": f"YOLO did not detect '{query}' in the video."
        })

    # Slice the video around the detection timestamp
    half_clip = clip_duration_sec / 2.0
    start_time = max(0, detection_timestamp - half_clip)
    end_time = min(total_frames / orig_fps, detection_timestamp + half_clip)
    
    start_frame = int(start_time * orig_fps)
    end_frame = int(end_time * orig_fps)
    
    print(f"[HYBRID] ✂️ Slicing video from {start_time:.2f}s to {end_time:.2f}s...")
    
    # Reset video to start_frame
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, orig_fps, (width, height))
    
    frames_written = 0
    max_frames_to_write = end_frame - start_frame
    
    while frames_written < max_frames_to_write:
        ret, frame = cap.read()
        if not ret:
            break
        out.write(frame)
        frames_written += 1
        
    cap.release()
    out.release()
    
    # Clean up input, schedule output cleanup
    cleanup_file(input_path)
    background_tasks.add_task(cleanup_file, output_path)
    
    print(f"[HYBRID] ✅ Micro-chunk created successfully.")
    
    return FileResponse(
        path=output_path,
        media_type="video/mp4",
        filename=f"hybrid_clip_{detection_timestamp:.1f}s.mp4",
        headers={
            "X-Detection-Time": str(detection_timestamp),
            "X-Bounding-Box": json.dumps(detection_bbox)
        }
    )

if __name__ == "__main__":
    import multiprocessing
    workers = max(1, multiprocessing.cpu_count() - 3) # Use most of available CPU cores
    print(f"[HYBRID] 🚀 Starting Hybrid YOLO Backend on http://0.0.0.0:8000 with {workers} workers")
    uvicorn.run("hybrid_backend:app", host="0.0.0.0", port=8000, workers=workers)
