# OneDrive Photo Service

A monorepo service for indexing OneDrive photos with face detection, person clustering, and a web UI. Designed for multi-user deployment on ARM Oracle Cloud, behind a shared reverse proxy.

## Features

- OAuth2 authentication with Microsoft Graph API (personal MSA accounts)
- OneDrive delta API for incremental photo sync
- Multi-model face detection: HOG, CNN, MTCNN, MediaPipe
- Producer/consumer pipeline for parallel download + sequential detection
- Automatic face clustering by person (agglomerative, configurable distance)
- HEIC/JPEG/PNG support via pillow-heif + sharp
- GPS photo map with Leaflet + marker clustering
- Real-time progress + performance metrics chart (photos/s, download ms, detect ms)
- Multi-user: each user has isolated photos, faces, clusters
- JWT authentication (shared secret with auth-service)
- Docker support (x86_64 + ARM64 Oracle Cloud)

## Architecture

```
onedrive-photo-service/
├── packages/
│   ├── backend/
│   │   └── src/
│   │       ├── server.js
│   │       ├── middleware/auth.js       # JWT verification
│   │       ├── auth/oauth.js            # OneDrive OAuth + token refresh (DB-backed)
│   │       ├── db/init.js               # PostgreSQL schema + migrations
│   │       ├── services/
│   │       │   ├── indexer.js           # Indexing + face detection orchestrator
│   │       │   ├── faceDetector.js      # Clustering, thumbnails, face DB ops
│   │       │   ├── detect_faces_daemon.py  # Long-running Python daemon (MTCNN/HOG/CNN/MediaPipe)
│   │       │   └── imageConverter.js    # HEIC→JPEG conversion
│   │       └── api/
│   │           ├── indexing.js          # Indexing + face detection endpoints
│   │           ├── photos.js            # Photo retrieval + GPS search
│   │           ├── faces.js             # Face clusters + management
│   │           └── auth.js              # OneDrive OAuth flow endpoints
│   └── web/
│       ├── index.html
│       ├── style.css
│       └── src/main.js
├── Dockerfile
└── docker-compose.yml
```

## Face Detection Pipeline

Photos are processed via a producer/consumer pipeline:

```
Producer (concurrency N)         Consumer (single)
─────────────────────────        ──────────────────────────
Download photo from OneDrive ──► Python daemon (MTCNN/HOG)
  measure downloadMs             measure detectMs
  push to AsyncQueue(N*2)        pushMetric(userId, dl, det)
                                 save faces to DB
```

The queue size is `concurrency * 2` — the producer downloads ahead while the daemon processes, keeping it busy continuously.

## API Endpoints

**Indexing** (requires JWT):
- `POST /api/indexing/start` — start photo metadata indexing
- `GET /api/indexing/state` — indexing progress
- `POST /api/indexing/faces/start` — start face detection `{ model, limit, concurrency, distance }`
- `GET /api/indexing/faces/state` — face detection progress
- `GET /api/indexing/faces/metrics` — real-time metrics buffer (downloadMs, detectMs per photo)

**Photos**:
- `GET /api/photos?limit=N&offset=N` — list photos
- `GET /api/photos/map?lat=X&lng=Y&radius=R` — GPS search
- `GET /api/photos/:id/view` — download photo
- `GET /api/photos/:id/thumbnail` — photo thumbnail

**Faces**:
- `GET /api/faces/clusters` — all person clusters
- `GET /api/faces/clusters/:id` — cluster faces
- `PUT /api/faces/clusters/:id/name` — rename cluster
- `POST /api/faces/clusters/:id/merge/:target` — merge clusters
- `POST /api/faces/identify` — identify faces in uploaded image
- `GET /api/faces/stats/summary` — statistics

**Auth**:
- `GET /api/auth/onedrive/connect` — start OneDrive OAuth flow
- `GET /api/auth/callback` — OAuth callback
- `GET /api/auth/onedrive/status` — check if OneDrive is connected

## Database Schema

```sql
photos (id, user_id, name, taken_at, metadata JSONB)
photo_faces (id, user_id, photo_id, bounding_box, descriptor, thumbnail, person_cluster_id)
person_clusters (id, user_id, name)
indexing_state (user_id, status, total_items, processed_items, current_page, error)
face_detection_state (user_id, status, total_items, processed_items, error)
user_onedrive_tokens (user_id, access_token, refresh_token, expires_at)
```

`indexing_state` tracks photo metadata indexing; `face_detection_state` tracks face detection separately (different lifecycles).

## Environment Variables

```
# Database
DB_USER=assistant
DB_PASSWORD=...
DB_HOST=postgres
DB_NAME=onedrive_photos

# Auth
JWT_SECRET=...           # shared with auth-service

# OneDrive OAuth
OAUTH_CLIENT_ID=...
OAUTH_CLIENT_SECRET=...
REDIRECT_URI=https://your-domain/photos/api/auth/callback
AUTH_FRONTEND_URL=https://your-domain/auth/login
PHOTOS_FRONTEND_URL=https://your-domain/photos
```

## Docker Deployment

Build and run (x86_64):
```bash
docker compose build
docker compose up -d --force-recreate
```

The `Dockerfile` pre-downloads facenet-pytorch `vggface2` model weights at build time (the container has no internet access at runtime).

After `--force-recreate`, reconnect the container to the proxy network:
```bash
docker network connect compose_app-net compose-onedrive-photos-1 --alias onedrive-photos
```

## Known Limitations

- `@microsoft.graph.downloadUrl` is unreliable for personal MSA accounts — the service uses `/drive/items/{id}/content` with Bearer token instead
- MTCNN thresholds `[0.9, 0.9, 0.9]` may miss faces on CPU; lower to `[0.6, 0.7, 0.7]` for more detections
- Videos (`.mov`, `.mp4`, `.3gp`, `.avi`, `.mkv`, `.wmv`) are excluded from face detection
