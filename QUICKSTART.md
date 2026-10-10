# Quick Start

## Prerequisites

- Docker & Docker Compose
- Access to an `auth-service` instance (JWT_SECRET shared)
- OneDrive personal Microsoft account
- Azure app registration (OAuth client_id + client_secret)

## Deploy with assistant-operation (recommended)

```bash
# 1. Build the image
docker build -t local/onedrive-photo-service:dev /path/to/onedrive-photo-service

# 2. Set environment variables in assistant-operation/compose/onedrive-photos.env.docker
JWT_SECRET=...
OAUTH_CLIENT_ID=...
OAUTH_CLIENT_SECRET=...
REDIRECT_URI=https://your-domain/photos/api/auth/callback

# 3. Start
docker compose -f assistant-operation/compose/docker-compose.local.yml up -d --force-recreate onedrive-photos

# 4. Reconnect to proxy network (required after each recreate)
docker network connect compose_app-net compose-onedrive-photos-1 --alias onedrive-photos
```

## First Use

1. Open `https://your-domain/photos`
2. If not logged in → redirected to auth-service login
3. Click "Connect OneDrive" → OAuth flow with Microsoft
4. Go to **Indexing** tab → click "Index Photos" (fetches all metadata from OneDrive delta API)
5. Go to **Face Detection** tab → configure options → click "Detect Faces"
6. Monitor progress and real-time metrics (download ms, detect ms, photos/s chart)
7. Go to **Face Clusters** tab → browse, rename, merge clusters

## Face Detection Options

| Option | Description |
|--------|-------------|
| Model | `mtcnn` (recommended), `hog` (fastest), `cnn`, `mediapipe` |
| Max photos | Number of photos to process (up to 100000) |
| Parallelism | Concurrent downloads (1–20); daemon processes sequentially |
| Clustering distance | 0.3 (strict) → 1.5 (loose); default 1.0 |

## Troubleshooting

**502 Bad Gateway after recreate**:
The container lost its connection to the proxy network. Run:
```bash
docker network connect compose_app-net compose-onedrive-photos-1 --alias onedrive-photos
```

**Button disabled after server restart**:
The startup reset clears stuck `face_detection_state` rows automatically. If still stuck, check DB:
```bash
docker exec compose-postgres-1 psql -U assistant -d onedrive_photos \
  -c "UPDATE face_detection_state SET status='idle' WHERE status IN ('indexing','clustering');"
```

**Daemon DNS failure at startup**:
The vggface2 weights must be baked into the image at build time. If you see `URLError: Temporary failure in name resolution` in logs, rebuild with `docker build` (not from cache if python-deps layer is stale).

**"No download URL" errors**:
Normal — the service uses `/drive/items/{id}/content` with Bearer token. The `@microsoft.graph.downloadUrl` field is unreliable for personal MSA accounts.

## Useful DB Queries

```sql
-- Photos and faces count
SELECT COUNT(*) FROM photos WHERE user_id = 'your-user-id';
SELECT COUNT(*) FROM photo_faces WHERE user_id = 'your-user-id';

-- Face detection progress
SELECT status, processed_items, total_items FROM face_detection_state
ORDER BY id DESC LIMIT 1;

-- Reset stuck state
UPDATE face_detection_state SET status = 'idle'
WHERE status IN ('indexing', 'clustering');
```
