#!/usr/bin/env python3
import sys
import os
import json

os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['GLOG_minloglevel'] = '3'
import warnings
warnings.filterwarnings('ignore')

import face_recognition
from PIL import Image
import numpy as np

try:
    from pillow_heif import register_heif_opener, open_heif
    register_heif_opener()
    HAS_HEIF = True
except ImportError:
    HAS_HEIF = False

MEDIAPIPE_MODEL = os.path.join(os.path.dirname(__file__), 'blaze_face_full_range.tflite')

def open_image(image_path):
    ext = os.path.splitext(image_path)[1].lower()
    if ext in ('.heic', '.heif') and HAS_HEIF:
        heif = open_heif(image_path, convert_hdr_to_8bit=True)
        return Image.frombytes(heif.mode, heif.size, heif.data).convert('RGB')
    return Image.open(image_path).convert('RGB')

def resize(pil_img, max_size):
    w, h = pil_img.size
    if max(w, h) <= max_size:
        return pil_img
    r = max_size / max(w, h)
    return pil_img.resize((int(w * r), int(h * r)), Image.LANCZOS)

def make_faces(boxes_locs, encodings, scale_x, scale_y):
    faces = []
    for i, (location, encoding) in enumerate(zip(boxes_locs, encodings)):
        top, right, bottom, left = location
        faces.append({
            "index": i,
            "box": {
                "x": int(left * scale_x),
                "y": int(top * scale_y),
                "width": int((right - left) * scale_x),
                "height": int((bottom - top) * scale_y)
            },
            "descriptor": encoding.tolist(),
            "age": None,
            "emotion": None,
            "emotions": {}
        })
    return faces

def detect_faces_mtcnn(pil_img, orig_w, orig_h):
    from facenet_pytorch import MTCNN
    resized_w, resized_h = pil_img.size
    scale_x = orig_w / resized_w if resized_w else 1
    scale_y = orig_h / resized_h if resized_h else 1

    mtcnn = MTCNN(keep_all=True, min_face_size=20, thresholds=[0.5, 0.6, 0.6])
    boxes, probs = mtcnn.detect(pil_img)

    if boxes is None:
        return []

    arr = np.array(pil_img)
    locs = []
    for b in boxes:
        x1, y1, x2, y2 = b
        top = max(0, int(y1))
        left = max(0, int(x1))
        bottom = min(resized_h, int(y2))
        right = min(resized_w, int(x2))
        locs.append((top, right, bottom, left))

    encodings = face_recognition.face_encodings(arr, locs)
    return make_faces(locs, encodings, scale_x, scale_y)

def detect_faces_mediapipe(pil_img, orig_w, orig_h):
    import mediapipe as mp
    import urllib.request

    if not os.path.exists(MEDIAPIPE_MODEL):
        urllib.request.urlretrieve(
            'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite',
            MEDIAPIPE_MODEL
        )

    arr = np.array(pil_img)
    resized_w, resized_h = pil_img.size
    scale_x = orig_w / resized_w if resized_w else 1
    scale_y = orig_h / resized_h if resized_h else 1

    BaseOptions = mp.tasks.BaseOptions
    FaceDetector = mp.tasks.vision.FaceDetector
    FaceDetectorOptions = mp.tasks.vision.FaceDetectorOptions
    VisionRunningMode = mp.tasks.vision.RunningMode

    options = FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=MEDIAPIPE_MODEL),
        running_mode=VisionRunningMode.IMAGE,
        min_detection_confidence=0.3
    )

    with FaceDetector.create_from_options(options) as detector:
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=arr)
        result = detector.detect(mp_img)

        locs = []
        for detection in (result.detections or []):
            bbox = detection.bounding_box
            top = max(0, bbox.origin_y)
            left = max(0, bbox.origin_x)
            bottom = min(resized_h, bbox.origin_y + bbox.height)
            right = min(resized_w, bbox.origin_x + bbox.width)
            locs.append((top, right, bottom, left))

        encodings = face_recognition.face_encodings(arr, locs)
        return make_faces(locs, encodings, scale_x, scale_y)

def detect_faces(image_path, model="hog"):
    try:
        pil_img = Image.open(image_path).convert('RGB')
        orig_w, orig_h = pil_img.size

        if model == "mtcnn":
            pil_img = resize(pil_img, 1200)
            faces = detect_faces_mtcnn(pil_img, orig_w, orig_h)
        elif model == "mediapipe":
            pil_img = resize(pil_img, 1200)
            faces = detect_faces_mediapipe(pil_img, orig_w, orig_h)
        else:
            max_size = 1200 if model == "cnn" else 2000
            pil_img = resize(pil_img, max_size)
            resized_w, resized_h = pil_img.size
            image = np.array(pil_img)
            locations = face_recognition.face_locations(image, model=model)
            encodings = face_recognition.face_encodings(image, locations)
            scale_x = orig_w / resized_w if resized_w else 1
            scale_y = orig_h / resized_h if resized_h else 1
            faces = make_faces(locations, encodings, scale_x, scale_y)

        sys.stdout.write(json.dumps({"faces": faces}) + "\n")
        sys.stdout.flush()
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    sys.stderr = open(os.devnull, 'w')
    if len(sys.argv) < 2:
        sys.stdout.write(json.dumps({"error": "No image path provided"}) + "\n")
        sys.exit(1)
    model_arg = sys.argv[2] if len(sys.argv) > 2 else "hog"
    detect_faces(sys.argv[1], model_arg)
