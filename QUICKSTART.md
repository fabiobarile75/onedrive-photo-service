# Quick Start Guide

## 1. Initial Setup (5 minutes)

### Copy OAuth tokens
```bash
cp ../test/tokens.json ./tokens.json
```

If you don't have tokens from the test project, generate them:
```bash
cd packages/backend
npm run login
# Follow the browser authentication flow
```

### Install dependencies
```bash
npm install
```

## 2. Run with Docker (Recommended)

### Start all services
```bash
docker-compose up -d
```

Check logs:
```bash
docker-compose logs -f backend
```

### Access the app
- **Web UI**: http://localhost:5173
- **API Docs**: See README.md for endpoint reference

## 3. Run without Docker

### Prerequisites
- PostgreSQL 16+ running locally
- Python 3.11+ (for face_recognition)

### Setup PostgreSQL
```bash
# On macOS with Homebrew
brew services start postgresql@16

# On Linux
sudo systemctl start postgresql

# Create database
createdb onedrive_photos
```

### Start backend
```bash
cd packages/backend
npm install
npm run dev
```

Backend runs on: http://localhost:3000

### Start web UI (new terminal)
```bash
cd packages/web
npm install
npm run dev
```

Web UI runs on: http://localhost:5173

## 4. Start Your First Indexing

1. **Open** http://localhost:5173
2. **Click** "Start Indexing" button
3. **Monitor** progress in real-time:
   - Phase 1: Fetch photos from OneDrive (~2 min for 1000 photos)
   - Phase 2: Process each photo & detect faces (~8-10 min)
   - Phase 3: Cluster faces by person (~5 min)

## 5. View Results

- **Face Clusters tab**: See people detected in your photos
- **Gallery tab**: Browse all indexed photos
- **Stats tab**: See total photos, faces, clusters

## Troubleshooting

### PostgreSQL won't start
```bash
# Check if running
ps aux | grep postgres

# Clear stuck connections (if needed)
rm -rf /var/lib/postgresql/16/main/postmaster.pid
```

### "No tokens found" error
Re-run the login script:
```bash
cd packages/backend
npm run login
```

### Face detection is very slow
- Reduce photo resolution in `packages/backend/src/services/imageConverter.js`
- Increase workers: `FACE_DETECTION_WORKERS=4 npm run dev`

### Port already in use
```bash
# Find process using port 3000
lsof -i :3000

# Find process using port 5173
lsof -i :5173

# Kill it if needed
kill -9 <PID>
```

## Next Steps

- Review API endpoints in README.md
- Explore clustering results in web UI
- Manually merge/split person clusters as needed
- Export clustered photos

## Development Tips

### Watch logs
```bash
docker-compose logs -f backend
docker-compose logs -f postgres
```

### Access database
```bash
psql -U postgres -d onedrive_photos
```

Useful queries:
```sql
-- Count photos and faces
SELECT COUNT(*) as photos FROM photos;
SELECT COUNT(*) as faces FROM photo_faces;
SELECT COUNT(DISTINCT person_cluster_id) as clusters FROM photo_faces WHERE person_cluster_id IS NOT NULL;

-- See photos without faces
SELECT id, name FROM photos WHERE id NOT IN (SELECT DISTINCT photo_id FROM photo_faces);
```

### Reset everything
```bash
docker-compose down -v
docker-compose up -d
```

This will wipe the database and start fresh.
