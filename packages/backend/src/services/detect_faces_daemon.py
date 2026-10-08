#!/usr/bin/env python3
"""Long-running face detection daemon — reads JSON requests from stdin, writes JSON responses to stdout."""
import sys
import os
import json

os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['GLOG_minloglevel'] = '3'
import warnings
warnings.filterwarnings('ignore')

from PIL import Image, ImageOps
import numpy as np
import torch

try:
    from pillow_heif import register_heif_opener, open_heif
    register_heif_opener()
    HAS_HEIF = True
except ImportError:
    HAS_HEIF = False

MEDIAPIPE_MODEL = os.path.join(os.path.dirname(__file__), 'blaze_face_full_range.tflite')
_mtcnn = None
_resnet = None

def get_mtcnn():
    global _mtcnn
    if _mtcnn is None:
        from facenet_pytorch import MTCNN
        _mtcnn = MTCNN(keep_all=True, min_face_size=40, thresholds=[0.9, 0.9, 0.9], post_process=True)
    return _mtcnn

def get_resnet():
    global _resnet
    if _resnet is None:
        from facenet_pytorch import InceptionResnetV1
        _resnet = InceptionResnetV1(pretrained='vggface2').eval()
    return _resnet

def open_image(image_path):
    ext = os.path.splitext(image_path)[1].lower()
    if ext in ('.heic', '.heif') and HAS_HEIF:
        heif = open_heif(image_path, convert_hdr_to_8bit=True)
        return Image.frombytes(heif.mode, heif.size, heif.data).convert('RGB')
    return ImageOps.exif_transpose(Image.open(image_path)).convert('RGB')

def resize(pil_img, max_size):
    w, h = pil_img.size
    if max(w, h) <= max_size:
        return pil_img
    r = max_size / max(w, h)
    return pil_img.resize((int(w * r), int(h * r)), Image.LANCZOS)

def make_faces(locs, embeddings, img_w, img_h):
    faces = []
    for i, (location, embedding) in enumerate(zip(locs, embeddings)):
        top, right, bottom, left = location
        faces.append({
            "index": i,
            "box": {
                "x": left / img_w,
                "y": top / img_h,
                "width": (right - left) / img_w,
                "height": (bottom - top) / img_h
            },
            "descriptor": embedding.tolist(),
            "age": None,
            "emotion": None,
            "emotions": {}
        })
    return faces

def detect(image_path, model):
    pil_img = open_image(image_path)

    if model == "mtcnn":
        pil_img = resize(pil_img, 1200)
        w, h = pil_img.size
        mtcnn = get_mtcnn()
        resnet = get_resnet()

        boxes, probs = mtcnn.detect(pil_img)
        if boxes is None:
            return []

        face_tensors = mtcnn(pil_img)
        if face_tensors is None:
            return []

        if face_tensors.dim() == 3:
            face_tensors = face_tensors.unsqueeze(0)

        with torch.no_grad():
            embeddings = resnet(face_tensors).numpy()

        locs = []
        for b in boxes:
            x1, y1, x2, y2 = b
            locs.append((max(0, int(y1)), min(w, int(x2)), min(h, int(y2)), max(0, int(x1))))

        return make_faces(locs, embeddings, w, h)

    elif model == "mediapipe":
        import mediapipe as mp, urllib.request
        if not os.path.exists(MEDIAPIPE_MODEL):
            urllib.request.urlretrieve(
                'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite',
                MEDIAPIPE_MODEL
            )
        pil_img = resize(pil_img, 1200)
        w, h = pil_img.size
        arr = np.array(pil_img)
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
            for d in (result.detections or []):
                bbox = d.bounding_box
                locs.append((max(0, bbox.origin_y), min(w, bbox.origin_x + bbox.width),
                              min(h, bbox.origin_y + bbox.height), max(0, bbox.origin_x)))
            import face_recognition
            encodings = face_recognition.face_encodings(arr, locs)
            return make_faces(locs, encodings, w, h)

    else:
        import face_recognition
        max_size = 1200 if model == "cnn" else 2000
        pil_img = resize(pil_img, max_size)
        w, h = pil_img.size
        image = np.array(pil_img)
        locations = face_recognition.face_locations(image, model=model)
        encodings = face_recognition.face_encodings(image, locations)
        return make_faces(locations, encodings, w, h)

# Pre-load MTCNN and InceptionResnet at startup
get_mtcnn()
get_resnet()

# Signal ready
sys.stderr = open(os.devnull, 'w')
sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
sys.stdout.flush()

# Main loop
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        faces = detect(req["image_path"], req.get("model", "hog"))
        sys.stdout.write(json.dumps({"faces": faces}) + "\n")
    except Exception as e:
        sys.stdout.write(json.dumps({"error": str(e)}) + "\n")
    sys.stdout.flush()
