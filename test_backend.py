import cv2
import numpy as np
import requests
import os

def create_test_video(filename="test_video.mp4", duration_sec=5, fps=30):
    print(f"[TEST] Creating dummy video: {filename}")
    width, height = 640, 480
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(filename, fourcc, fps, (width, height))

    for i in range(duration_sec * fps):
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        # Draw a white circle that moves
        center_x = int(50 + (i * 2)) % width
        center_y = height // 2
        cv2.circle(frame, (center_x, center_y), 50, (255, 255, 255), -1)
        out.write(frame)

    out.release()
    print(f"[TEST] Video created: {filename}")

def test_hybrid_backend():
    url = "http://localhost:8000/hybrid_trigger"
    video_file = "test_video.mp4"
    
    if not os.path.exists(video_file):
        create_test_video(video_file)

    print(f"[TEST] Sending {video_file} to {url}...")
    
    with open(video_file, "rb") as f:
        files = {"file": (video_file, f, "video/mp4")}
        data = {
            "query": "white circle",
            "yolo_fps": 5,
            "clip_duration_sec": 4,
            "confidence_threshold": 0.1
        }
        
        try:
            response = requests.post(url, files=files, data=data)
            print(f"[TEST] Status Code: {response.status_code}")
            
            if response.status_code == 200:
                print("[TEST] ✅ Success! Received micro-chunk.")
                print(f"[TEST] Headers: {dict(response.headers)}")
                # Save the result
                with open("test_result_chunk.mp4", "wb") as out:
                    out.write(response.content)
                print("[TEST] Micro-chunk saved as 'test_result_chunk.mp4'")
            else:
                print(f"[TEST] ❌ Error: {response.text}")
                
        except Exception as e:
            print(f"[TEST] ❌ Connection failed: {e}")

if __name__ == "__main__":
    test_hybrid_backend()
