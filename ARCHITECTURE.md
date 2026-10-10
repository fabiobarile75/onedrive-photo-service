# Architecture

## System Overview

```
Browser (Vite SPA)
    │ HTTPS — JWT in Authorization header
    ▼
Reverse Proxy (Node.js)
  /photos → onedrive-photos:8000
    │
    ▼
Express.js Backend (Node.js)
  ├── authMiddleware (JWT verify, shared secret with auth-service)
  ├── api/indexing.js   → start/state/metrics for indexing + face detection
  ├── api/photos.js     → list, GPS search, view, thumbnail
  ├── api/faces.js      → clusters, identify, merge, stats
  └── api/auth.js       → OneDrive OAuth flow
    │
    ├── services/indexer.js
    │     ├── fetchAndSavePhotosMetadata()  — OneDrive delta API pagination
    │     └── startFaceDetection()          — producer/consumer pipeline
    │           ├── Producer (N workers)    — download from Graph API, push to AsyncQueue
    │           └── Consumer (1 worker)     — pop from queue, send to Python daemon
    │
    ├── services/faceDetector.js
    │     ├── detectFacesInImage()   — sends image bytes to daemon via stdin/stdout
    │     ├── extractFaceThumbnail() — crops face region
    │     ├── saveFaceToDb()         — writes to photo_faces
    │     └── clusterFacesByPerson() — agglomerative clustering by descriptor distance
    │
    └── services/detect_faces_daemon.py  (long-running Python process)
          ├── MTCNN  (facenet-pytorch) — detect + encode faces
          ├── HOG    (face_recognition dlib)
          ├── CNN    (face_recognition dlib)
          └── MediaPipe (tflite)
    │
    ▼
PostgreSQL
  ├── photos                  — OneDrive metadata per user
  ├── photo_faces             — face bounding boxes + 512D descriptors + thumbnails
  ├── person_clusters         — cluster names per user
  ├── indexing_state          — photo indexing progress
  ├── face_detection_state    — face detection progress (separate from indexing)
  └── user_onedrive_tokens    — OAuth tokens per user
```

## Face Detection Pipeline

```
photos[] (from DB, limit N, videos excluded)
    │
    ▼
AsyncQueue(concurrency * 2)
    ▲                    │
    │ push({photo,       │ pop()
    │  buf, downloadMs}) │
    │                    ▼
Producer (N parallel)   Consumer (1 serial)
─────────────────────   ──────────────────────────────
GET /drive/items/{id}/  convertPhotoBuffer()
  content               detectFacesInImage() ──► Python daemon
measure downloadMs      measure detectMs
                        pushMetric(userId, dl, det)
                        extractFaceThumbnail()
                        saveFaceToDb()
                        UPDATE face_detection_state
```

The queue bounds memory usage to `concurrency * 2` photos. The producer downloads ahead so the daemon never waits for a download.

## Python Daemon

The daemon is a long-running process spawned once per face detection job:
- Communicates via `stdin` (JSON requests) / `stdout` (JSON responses)
- Signals `{"status": "ready"}` on stdout when models are loaded
- Loads MTCNN + InceptionResnetV1(vggface2) at startup (weights baked into Docker image)
- HOG/CNN/MediaPipe loaded lazily on first use

The vggface2 weights (~90MB) are pre-downloaded during `docker build` in the `python-deps` stage and copied to the final image via `COPY --from=python-deps /root/.cache/torch /root/.cache/torch`. Without this, the daemon fails with DNS error at runtime (no internet in container).

## Metrics

Each processed photo records `{ ts, downloadMs, detectMs }` in an in-memory circular buffer (600 entries per user ≈ 10 min at 1 photo/s). The frontend polls `GET /api/indexing/faces/metrics` every 2s and displays:
- Last download time (ms)
- Last detection time (ms)
- Photos/s chart (Chart.js, 10-minute window, 10s buckets)

Metrics are lost on server restart (in-memory only by design).

## State Tables

Two separate state tables avoid interference:

| Table | Tracks | Reset on restart |
|-------|--------|-----------------|
| `indexing_state` | Photo metadata indexing | No |
| `face_detection_state` | Face detection + clustering | Yes (stuck jobs → error) |

## Multi-user Isolation

All tables have `user_id TEXT NOT NULL`. Every query filters by `req.userId` extracted from the JWT. Users cannot see each other's photos, faces, or tokens.

## Docker Network

In production (`assistant-operation`), all services share `compose_app-net`. The proxy routes `/photos` → `onedrive-photos:8000` using the container's network alias.

After `--force-recreate`, the container loses its alias on `compose_app-net` and must be reconnected:
```bash
docker network connect compose_app-net compose-onedrive-photos-1 --alias onedrive-photos
```
