# OneDrive Photo Service

A monorepo service for indexing OneDrive photos with metadata storage, face detection, and person clustering.

## Features

- ✅ OAuth2 authentication with automatic token refresh
- ✅ OneDrive delta API for complete photo retrieval (handles HEIC/JPEG)
- ✅ Face detection with `@vladmandic/face-api` (fast on ARM CPU)
- ✅ Automatic face clustering by person
- ✅ PostgreSQL storage with JSONB metadata + bounding boxes
- ✅ GPS location indexing
- ✅ Web UI with real-time progress tracking
- ✅ REST API for photos and face clusters
- ✅ Docker support (standard + ARM)

## Architecture

```
onedrive-photo-service/
├── packages/
│   ├── backend/                    # Express.js API
│   │   ├── src/
│   │   │   ├── server.js
│   │   │   ├── auth/oauth.js       # OAuth + token management
│   │   │   ├── db/init.js          # PostgreSQL schema
│   │   │   ├── services/
│   │   │   │   ├── indexer.js      # Main indexing orchestrator
│   │   │   │   ├── faceDetector.js # Face detection + clustering
│   │   │   │   └── imageConverter.js # HEIC → JPEG conversion
│   │   │   └── api/
│   │   │       ├── indexing.js     # Indexing control endpoints
│   │   │       ├── photos.js       # Photo retrieval + GPS search
│   │   │       └── faces.js        # Face clusters + management
│   │   └── package.json
│   └── web/                         # Vite + vanilla JS UI
│       ├── index.html
│       ├── style.css
│       ├── src/main.js
│       └── package.json
├── docker-compose.yml
├── Dockerfile (for x86_64)
├── Dockerfile.arm (for ARM Oracle Cloud)
└── README.md
```

## Setup

### 1. Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Docker & Docker Compose (optional)
- OneDrive personal account with OAuth credentials

### 2. OAuth Configuration

You need OAuth tokens to access OneDrive. Get them from the test project:

```bash
# Copy tokens from the test project
cp ../test/tokens.json ./tokens.json
```

Or generate new ones by running the login flow (see `/scripts/login.js` if needed).

### 3. Installation

```bash
npm install
```

### 4. Start Services

**With Docker (recommended)**:
```bash
docker-compose up -d
```

**Without Docker**:
```bash
# Terminal 1: Start PostgreSQL
# (Configure connection in packages/backend/src/db/init.js)

# Terminal 2: Backend
cd packages/backend
npm run dev

# Terminal 3: Web UI
cd packages/web
npm run dev
```

### 5. Access

- **Web UI**: http://localhost:5173
- **API**: http://localhost:3000/api
- **PostgreSQL**: localhost:5432

## Usage

### 1. Start Indexing

1. Open http://localhost:5173
2. Click "Start Indexing"
3. Monitor progress in real-time:
   - **Phase 1**: Fetch photo metadata from OneDrive
   - **Phase 2**: Download & process each photo:
     - Convert HEIC to JPEG if needed
     - Detect faces with face-api
     - Extract thumbnails
   - **Phase 3**: Cluster faces by person

### 2. View Results

- **Face Clusters**: See detected people grouped by similarity
- **Gallery**: Browse all indexed photos
- **Stats**: Total photos, faces, clusters, average age

### 3. API Endpoints

**Indexing**:
- `POST /api/indexing/start` - Start indexing
- `GET /api/indexing/state` - Get progress state

**Photos**:
- `GET /api/photos?limit=50&offset=0` - List photos
- `GET /api/photos/location?lat=X&lon=Y&radius=1` - Find by GPS

**Faces**:
- `GET /api/faces/clusters` - Get all person clusters
- `GET /api/faces/clusters/:clusterId` - Get cluster details
- `GET /api/faces/photo/:photoId` - Get faces in photo
- `GET /api/faces/thumbnail/:faceId` - Get face thumbnail
- `POST /api/faces/clusters/merge` - Merge two clusters
- `POST /api/faces/clusters/:clusterId/split` - Split cluster
- `GET /api/faces/stats/summary` - Get statistics

## Database Schema

### photos
```sql
id TEXT PRIMARY KEY,
name TEXT,
taken_at TIMESTAMP,
metadata JSONB,  -- Full OneDrive metadata
created_at TIMESTAMP
```

### photo_faces
```sql
id SERIAL PRIMARY KEY,
photo_id TEXT FK,
face_index INT,
bounding_box JSONB,      -- {"x": 150, "y": 100, "width": 120, "height": 150}
descriptor BYTEA,         -- 128D embedding (Float32Array)
age INT,
gender TEXT,
expressions JSONB,        -- {"happy": 0.8, "sad": 0.1, ...}
thumbnail BYTEA,          -- 256x256 JPEG
person_cluster_id TEXT,   -- Cluster ID (null if unclassified)
```

### indexing_state
```sql
status TEXT,              -- 'idle', 'indexing', 'clustering', 'completed', 'error'
total_items INT,
processed_items INT,
current_page INT,
error TEXT,
started_at TIMESTAMP,
completed_at TIMESTAMP
```

## Performance on ARM (Oracle Cloud)

| Step | Time (1000 photos) | Notes |
|------|-------------------|-------|
| Fetch metadata | ~2 min | OneDrive API pagination |
| Download + convert | ~5 min | HEIC → JPEG conversion |
| Face detection | ~8 min | face-api.js, 500ms/photo |
| Clustering | ~5 min | Agglomerative clustering |
| **Total** | ~20 min | Highly parallelizable |

**Optimization tips**:
- Reduce image resolution before detection (see `imageConverter.js`)
- Tune clustering threshold (default 0.5)
- Use lower face detection model if needed

## Environment Variables

```
DB_USER=postgres
DB_PASSWORD=postgres
DB_HOST=localhost
DB_PORT=5432
DB_NAME=onedrive_photos

OAUTH_CLIENT_ID=your_client_id
OAUTH_CLIENT_SECRET=your_client_secret
REDIRECT_URI=http://localhost:3000/api/auth/callback

NODE_ENV=production
FACE_DETECTION_WORKERS=2
FACE_DETECTION_TIMEOUT=30000
```

## Docker for ARM (Oracle Cloud)

Build for ARM32v7:
```bash
docker build -f packages/backend/Dockerfile.arm -t onedrive-backend:arm32v7 .
```

Or use docker-compose with build context:
```bash
docker-compose -f docker-compose.arm.yml up
```

## Known Limitations

- **HEIC conversion**: Requires `sharp` with libheif support (pre-compiled for ARM)
- **Face clustering**: Simple agglomerative algorithm; consider ML-based clustering for >10k photos
- **GPS search**: Requires PostGIS for true geographic queries (future improvement)
- **Unclassified faces**: Manual assignment via API or UI (future: bulk operations)

## Next Steps

- [ ] Implement PostgreSQL full-text search for metadata
- [ ] Add face re-clustering with different thresholds
- [ ] Build manual face assignment UI
- [ ] Add photo download with face anonymization
- [ ] Implement caching strategy for processed images
- [ ] Add batch operations (export, delete, etc.)

## Troubleshooting

**PostgreSQL connection fails**:
- Ensure PostgreSQL is running: `docker-compose up postgres`
- Check credentials in `src/db/init.js`

**Face detection is slow**:
- Reduce image resolution in `imageConverter.js`
- Increase workers with `FACE_DETECTION_WORKERS` env var

**HEIC conversion fails**:
- Verify `sharp` has libheif: `npm ls sharp`
- On ARM, may need to rebuild: `npm rebuild sharp`

**OAuth token expired**:
- Service auto-refreshes; check `tokens.json` exists and is readable

## License

ISC

