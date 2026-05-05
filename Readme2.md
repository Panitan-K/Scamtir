# Scamtir: Gemini Video Intelligence Pipeline

This document explains exactly how the current video processing pipeline operates under the hood, and provides insights into why you might be experiencing false positives or missing fast-moving events like accidents.

## Architecture: How It Works

The current system is a **pure frontend application** (React/Vite) that interacts directly with Google's Gemini REST API. There is no intermediate Node.js server. 

Here is the exact step-by-step flow when you click "Analyze":

1. **Direct File Upload**:
   The video file (`File` object) is uploaded directly from your browser to Google's servers using the **Gemini File API** (`https://generativelanguage.googleapis.com/upload/v1beta/files`). We use a direct multipart upload to bypass payload limits.

2. **Native Video Processing (Polling)**:
   Once uploaded, Google's servers begin processing the video. Our app enters a polling loop (checking every 2 seconds). 
   *Crucial Detail*: During this phase, Gemini breaks the video down into images natively at **1 Frame Per Second (1 FPS)**. 

3. **Multimodal Inference**:
   Once the video state is `ACTIVE`, the app sends a `generateContent` request to the target model (`gemini-3.1-flash-lite-preview`). We attach the `fileUri` of the uploaded video and our system prompt.

4. **Strict JSON Enforcement**:
   To prevent parsing crashes, we pass `responseMimeType: "application/json"` in the `generationConfig`. The model is instructed to return an array of events with:
   - `start_time_seconds` and `end_time_seconds`
   - `bounding_box_2d` (Coordinates scaled 0 to 1000)
   - `description`
   - `confidence`

5. **UI Rendering**:
   The UI parses this JSON. Because the video player (`<video>`) often letterboxes footage, we wrap it in a dynamic container that strictly enforces the intrinsic `videoWidth / videoHeight`. The bounding boxes are rendered as absolute percentages on this wrapper, ensuring perfect alignment with the tracked objects.

---

## Why are you getting False Positives and Missing Accidents?

If the AI is hallucinating events (false positives) or entirely missing critical moments (false negatives), it is due to three major limitations in the current architecture:

### 1. The 1 Frame Per Second (1 FPS) Blindspot
When you upload a video to the Gemini File API, **Google natively samples the video at exactly 1 frame per second.** 
If an accident (like a quick car collision) occurs and resolves within a 0.5-second window between frames, **the AI literally never sees it**. It is impossible for the model to detect something that was skipped during the frame extraction process.

### 2. The Model is "Lite"
You are currently using `gemini-3.1-flash-lite-preview`. While extremely fast and cheap, the "Lite" models have significantly lower reasoning capabilities and visual acuity compared to standard or "Pro" models. 
* **Fix**: Switching the model to `gemini-1.5-pro` or the experimental `gemini-2.0-flash-exp` will drastically reduce false positives.

### 3. Lack of "Chain of Thought" Reasoning
Currently, the prompt forces the AI to output *only* the final JSON array. Because it is forced to jump straight to the answer, it cannot "think" through what it is seeing.
* **Fix**: We can update the JSON schema to require a `"reasoning"` field *before* the detection fields. Forcing the AI to explain its visual thought process before committing to a bounding box reduces hallucinations by up to 40%.

### 4. Confidence Thresholding
The UI currently displays whatever the model returns, regardless of the `confidence` score. If the model is only 20% sure it saw an accident, it still draws a box. 
* **Fix**: We should implement a slider in the UI to filter out detections with a confidence below 70%.
