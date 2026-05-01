import cv2
from ultralytics import YOLOWorld

def main():
    print("Loading YOLO-World Zero-Shot model...")
    # Initialize YOLO-World model (downloads yolov8s-worldv2.pt automatically ~20MB)
    model = YOLOWorld("yolov8s-worldv2.pt")

    # Set custom vocabulary for Zero-Shot detection
    # Feel free to change these words to whatever you want to detect!
    custom_classes = ["person", "cell phone", "keyboard", "bottle", "cup"]
    print(f"Setting custom detection classes: {custom_classes}")
    model.set_classes(custom_classes)

    print("Opening webcam...")
    # 0 is usually the built-in webcam
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("Error: Could not open webcam.")
        return

    print("Webcam started! Press 'q' to quit.")

    while True:
        success, frame = cap.read()
        if not success:
            print("Failed to read frame from webcam.")
            break

        # Run inference (conf=0.1 is the confidence threshold)
        results = model.predict(frame, conf=0.1, verbose=False)

        # Plot bounding boxes and labels on the frame
        annotated_frame = results[0].plot()

        # Display the output
        cv2.imshow("Scamtir - YOLO-World Zero-Shot", annotated_frame)

        # Break the loop if 'q' is pressed
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    # Clean up
    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
