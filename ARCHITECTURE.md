# OneDrive Photo Service - Architecture Overview

## System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                         Web UI (Vite)                            │
│  - Tab navigation (Indexing, Clusters, Gallery, Stats)          │
│  - Real-time progress polling                                   │
│  - Cluster visualization & management                           │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP/REST
┌────────────────────────▼────────────────────────────────────────┐
│                    Express.js Backend                            │
├─────────────────────────────────────────────────────────────────┤
│ API Routes:                                                      │
│  ├─ /api/indexing  → Control indexing process                  │
│  ├─ /api/photos    → Query photos & GPS search                 │
│  └─ /api/faces     → Face clusters & management                │
├─────────────────────────────────────────────────────────────────┤
│ Services:                                                        │
│  ├─ indexer.js        → Orchestrate 3-phase indexing           │
│  ├─ faceDetector.js   → face-api + clustering                  │
│  ├─ imageConverter.js → HEIC→JPEG + optimization               │
│  └─ oauth.js          → Token management                        │
├─────────────────────────────────────────────────────────────────┤
│ Database Handlers:                                               │
│  └─ db/init.js        → Schema + connection pool               │
└────────────────────────┬────────────────────────────────────────┘
                         │ SQL
┌────────────────────────▼────────────────────────────────────────┐
│                    PostgreSQL 16                                 │
├─────────────────────────────────────────────────────────────────┤
│ Tables:                                                          │
│  ├─ photos(id, name, taken_at, metadata JSONB)                 │
│  ├─ photo_faces(photo_id, descriptor, bounding_box, ...)       │
│  └─ indexing_state(status, progress, error)                    │
├─────────────────────────────────────────────────────────────────┤
│ Indexes:                                                         │
│  ├─ idx_photos_taken_at                                         │
│  ├─ idx_photo_faces_cluster_id                                  │
│  └─ idx_photo_faces_photo_id                                    │
└─────────────────────────────────────────────────────────────────┘
         ▲
         │ OneDrive API
         │
    ┌────┴────────────────────────┐
    │  Microsoft Graph API        │
    │  - OAuth2 (MSA account)     │
    │  - Delta API (pagination)   │
    │  - Download URLs (302 redir)│
    └─────────────────────────────┘
```

## Indexing Flow (3 Phases)

### Phase 1: Fetch Metadata
```
OneDrive API (delta)
    ↓
Paginate through all photos
    ↓
Extract: id, name, taken_at, location, size
    ↓
Save to DB (photos table)
```

### Phase 2: Process Photos & Detect Faces
```
For each photo:
  1. Download from OneDrive (URL redirect)
  2. Check format (HEIC/JPEG/PNG)
  3. Convert HEIC → JPEG if needed
  4. Optimize resolution (1920x1080 max)
  5. Detect faces with face-api.js
  6. Extract thumbnails (256x256 per face)
  7. Save face data to DB (photo_faces table)
  8. Update progress (processed_items++)
```

### Phase 3: Cluster Faces by Person
```
1. Fetch all faces from DB
2. For each face:
   a. Calculate distance to existing clusters
   b. If distance < threshold (0.5):
      - Add to cluster
   c. Else:
      - Create new cluster
3. Save cluster_id to DB
```

## Data Models

### photos
- `id` (PK): OneDrive file ID
- `name`: Filename
- `taken_at`: EXIF date or created_at
- `metadata` (JSONB): Full OneDrive response
- Index on `taken_at` for sorting

### photo_faces
- `id` (PK): Auto-increment
- `photo_id` (FK): Reference to photos
- `face_index`: 0, 1, 2... per photo
- `bounding_box` (JSONB): `{x, y, width, height}`
- `descriptor` (BYTEA): 128-float embedding
- `age`, `gender`: Detected attributes
- `expressions` (JSONB): Emotion probabilities
- `thumbnail` (BYTEA): 256x256 JPEG
- `person_cluster_id`: Cluster assignment
- Index on `photo_id` and `person_cluster_id`

### indexing_state
- Tracks current progress
- One row per indexing session (latest = current)
- Status: idle → indexing → clustering → completed/error

## API Response Examples

### Start Indexing
```bash
POST /api/indexing/start
→ { "status": "started" }
```

### Get Progress
```bash
GET /api/indexing/state
→ {
    "status": "indexing",
    "total_items": 1500,
    "processed_items": 350,
    "current_page": 7
  }
```

### List Clusters
```bash
GET /api/faces/clusters
→ [
    {
      "person_cluster_id": "abc123",
      "photo_count": 127,
      "face_count": 245,
      "avg_age": 28,
      "gender": "male"
    },
    ...
  ]
```

### Get Cluster Details
```bash
GET /api/faces/clusters/abc123
→ [
    {
      "id": 5123,
      "photo_id": "xyz",
      "age": 28,
      "gender": "male",
      "bounding_box": {"x": 150, "y": 100, "width": 120, "height": 150},
      "thumbnail": "base64..."
    },
    ...
  ]
```

## Performance Characteristics

### On ARM (Oracle Cloud)
- **Single-threaded**: ~500ms/photo for face detection
- **Network**: ~100ms/photo for download
- **Database writes**: Batched, negligible

| Step | 100 photos | 1000 photos | 10k photos |
|------|-----------|-----------|-----------|
| Fetch metadata | 30s | 2m | 20m |
| Download+convert | 1m | 10m | 100m |
| Detect faces | 1m | 8m | 80m |
| Cluster | 10s | 1m | 10m |
| **Total** | ~3m | ~21m | ~200m |

### Database
- Photos table: ~1KB per row
- photo_faces table: ~20KB per row (descriptor + thumbnail)
- Indexes: ~10% of data size

1000 photos with ~5000 faces = ~100MB total

## Scaling Considerations

### To process millions of photos:
1. **Parallelize downloads** (async fetch pool)
2. **Batch face detection** (multi-worker processing)
3. **Use hierarchical clustering** instead of agglomerative
4. **Cache converted images** to avoid re-processing
5. **Stream results** instead of loading all faces into memory

### Future improvements:
- WebSocket for real-time UI updates (instead of polling)
- Background job queue (Bull, RabbitMQ)
- Face re-identification across sessions
- PostgreSQL full-text search on metadata
- S3/cloud storage for image caching

## Security Notes

- OAuth tokens stored in `tokens.json` (local, not committed)
- Auto-refresh before expiration
- No credentials logged
- All OneDrive access via Graph API (authorized only)
- Face data stored locally (not sent to cloud)
- HTTPS recommended for production deployment
