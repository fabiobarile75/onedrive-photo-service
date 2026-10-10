# Project Summary

## What Was Built

A multi-user **OneDrive Photo Service** — indexes photos from Microsoft OneDrive, detects and clusters faces, and exposes a web UI with real-time metrics.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite + Vanilla JS, Chart.js, Leaflet |
| Backend | Node.js + Express.js |
| Face Detection | Python 3.11 daemon (MTCNN/HOG/CNN/MediaPipe) |
| Face Encoding | facenet-pytorch (InceptionResnetV1 vggface2) |
| Image Processing | Sharp, pillow-heif |
| Database | PostgreSQL 16 |
| Container | Docker (x86_64 + ARM64) |
| Auth | JWT (shared secret with auth-service) |

## Key Features

| Feature | Notes |
|---------|-------|
| Multi-user isolation | All data scoped by `user_id` from JWT |
| OneDrive OAuth | Tokens stored in DB, auto-refresh |
| Delta API sync | Incremental, handles 27k+ photos |
| Multi-model face detection | MTCNN, HOG, CNN, MediaPipe |
| Producer/consumer pipeline | N parallel downloads, 1 daemon consumer |
| HEIC/JPEG/PNG support | Automatic conversion |
| Face clustering | Agglomerative, configurable distance |
| GPS photo map | Leaflet + marker clustering |
| Real-time metrics | photos/s chart, download/detect ms |
| Video filtering | `.mov .mp4 .3gp .avi .mkv .wmv` excluded |

## Database Schema

```
photos                  — OneDrive metadata (27k+ rows)
photo_faces             — face data: bounding box, 512D descriptor, thumbnail
person_clusters         — cluster names
indexing_state          — photo indexing progress
face_detection_state    — face detection progress (separate table)
user_onedrive_tokens    — OAuth tokens per user
```

## Face Detection Architecture

```
Producer (N parallel downloads)
    ↓  AsyncQueue(N*2)
Consumer → Python daemon (stdin/stdout JSON)
    ↓
pushMetric(downloadMs, detectMs)
    ↓
/api/indexing/faces/metrics → Chart.js in UI
```

The Python daemon loads MTCNN + vggface2 weights at startup. Weights are baked into the Docker image at build time (`COPY --from=python-deps /root/.cache/torch`).

## Deployment

Runs as part of `assistant-operation` stack on Oracle Cloud ARM64. The container must be on `compose_app-net` with alias `onedrive-photos` for the reverse proxy to reach it.

After any `--force-recreate`:
```bash
docker network connect compose_app-net compose-onedrive-photos-1 --alias onedrive-photos
```

## Known Gotchas

- `@microsoft.graph.downloadUrl` unreliable for personal MSA → use `/drive/items/{id}/content` + Bearer token
- vggface2 weights must be in Docker image (no internet at runtime)
- `face_detection_state` reset to `error` on server restart (prevents stuck "indexing" button)
- Local dev: launch from `assistant-operation/compose/`, not `onedrive-photo-service/` directly
