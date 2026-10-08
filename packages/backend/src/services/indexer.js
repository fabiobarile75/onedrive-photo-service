const fetch = require('node-fetch').default;
const { getValidAccessToken } = require('../auth/oauth');
const { getPool } = require('../db/init');
const { convertPhotoBuffer } = require('./imageConverter');
const { detectFacesInImage, extractFaceThumbnail, saveFaceToDb, clusterFacesByPerson } = require('./faceDetector');

async function downloadPhotoBuffer(photoId, downloadUrl, token) {
  // OneDrive pre-signed URLs don't need Authorization header
  const res = await fetch(downloadUrl);

  if (!res.ok) {
    // Fallback with auth header
    const res2 = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res2.ok) {
      throw new Error(`Failed to download photo ${photoId}: ${res2.status}`);
    }
    return Buffer.from(await res2.arrayBuffer());
  }

  return Buffer.from(await res.arrayBuffer());
}

async function fetchAllPhotosMetadata() {
  console.log('fetchAllPhotosMetadata: Getting OAuth token...');
  const token = await getValidAccessToken();
  console.log('fetchAllPhotosMetadata: Token obtained');
  const pool = getPool();

  let allItems = [];
  let url = "https://graph.microsoft.com/v1.0/me/drive/special/cameraroll/delta" +
    "?$select=id,name,size,createdDateTime,lastModifiedDateTime,photo,location,file,deleted,@microsoft.graph.downloadUrl" +
    "&$top=1000";

  let page = 0;
  let totalItems = 0;

  while (url) {
    page++;
    console.log(`fetchAllPhotosMetadata: Fetching page ${page}...`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`fetchAllPhotosMetadata: Page ${page} response status: ${res.status}`);
    const data = await res.json();
    console.log(`fetchAllPhotosMetadata: Page ${page} parsed, ${data.value?.length || 0} items`);

    if (data.error) {
      throw new Error(`Graph API error: ${JSON.stringify(data.error)}`);
    }

    const items = (data.value || []).filter(i => i.file && !i.deleted);
    console.log(`fetchAllPhotosMetadata: Page ${page} filtered to ${items.length} valid photos`);
    allItems = allItems.concat(items);
    totalItems += items.length;

    url = data['@odata.nextLink'] || null;
    console.log(`fetchAllPhotosMetadata: Next URL: ${url ? 'yes' : 'no more pages'}`);
  }

  console.log(`fetchAllPhotosMetadata: Complete! Total items: ${totalItems}`);
  return allItems;
}

async function savePhotosToDb(photos) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    for (const photo of photos) {
      const takenAt = photo.photo?.takenDateTime || photo.createdDateTime;

      await client.query(
        `INSERT INTO photos (id, name, taken_at, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
         metadata = $4, updated_at = CURRENT_TIMESTAMP`,
        [
          photo.id,
          photo.name,
          takenAt,
          JSON.stringify(photo)
        ]
      );
    }
  } finally {
    client.release();
  }
}

async function indexPhotoWithFaces(photo, token, model = 'hog') {
  try {
    const downloadUrl = photo['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      console.warn(`No download URL for ${photo.name}`);
      return;
    }

    // 1. Télécharger et convertir image
    console.log(`Processing ${photo.name}...`);
    const imageBuffer = await downloadPhotoBuffer(photo.id, downloadUrl, token);
    const ext = require('path').extname(photo.name).toLowerCase() || '.jpg';
    const processedBuffer = await convertPhotoBuffer(imageBuffer, photo.name);

    // For HEIC: convert to JPEG for thumbnail extraction (sharp can't handle HEIC)
    let thumbnailBuffer = processedBuffer;
    if (ext === '.heic' || ext === '.heif') {
      try {
        const os = require('os'), fs = require('fs'), { spawn } = require('child_process');
        const tmpHeic = require('path').join(os.tmpdir(), `heic_thumb_${Date.now()}.heic`);
        const tmpJpeg = require('path').join(os.tmpdir(), `heic_thumb_${Date.now()}.jpg`);
        fs.writeFileSync(tmpHeic, imageBuffer);
        await new Promise((resolve, reject) => {
          const proc = spawn('python3', ['-c', `
from pillow_heif import open_heif
from PIL import Image, ImageOps
heif = open_heif('${tmpHeic}', convert_hdr_to_8bit=True)
img = ImageOps.exif_transpose(Image.frombytes(heif.mode, heif.size, heif.data))
img.save('${tmpJpeg}', 'JPEG', quality=90)
`]);
          proc.on('close', code => code === 0 ? resolve() : reject(new Error('HEIC→JPEG failed')));
          proc.on('error', reject);
        });
        thumbnailBuffer = fs.readFileSync(tmpJpeg);
        try { fs.unlinkSync(tmpHeic); fs.unlinkSync(tmpJpeg); } catch {}
      } catch (e) {
        console.error('HEIC thumbnail conversion error:', e.message);
      }
    }
    const detections = await detectFacesInImage(processedBuffer, ext, model);

    if (detections.length === 0) {
      console.log(`  No faces detected in ${photo.name}`);
      return;
    }

    console.log(`  Detected ${detections.length} faces`);

    // 3. Sauvegarder faces
    for (let i = 0; i < detections.length; i++) {
      const detection = detections[i];
      const thumbnail = await extractFaceThumbnail(thumbnailBuffer, detection.box);
      await saveFaceToDb(photo.id, i, detection, thumbnail);
    }
  } catch (err) {
    console.error(`Error processing ${photo.name}:`, err.message);
  }
}

async function updateIndexingStatus(status, message = null) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const query = message
      ? `UPDATE indexing_state SET status = $1, current_page = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT MAX(id) FROM indexing_state)`
      : `UPDATE indexing_state SET status = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT MAX(id) FROM indexing_state)`;

    await client.query(query, message ? [status, message] : [status]);
  } finally {
    client.release();
  }
}

async function startIndexing() {
  const pool = getPool();
  let client = await pool.connect();

  try {
    console.log('startIndexing: Inserting initial state...');
    // Initialize indexing state
    await client.query(
      `INSERT INTO indexing_state (status, started_at, created_at, updated_at)
       VALUES ('indexing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    console.log('startIndexing: Initial state inserted');
    client.release();

    console.log('startIndexing: Getting OAuth token...');
    const token = await getValidAccessToken();
    console.log('startIndexing: Token obtained');

    // Phase 1 : Fetch metadata
    console.log('Phase 1: Fetching photo metadata from OneDrive...');
    const photos = await fetchAllPhotosMetadata();
    console.log(`Found ${photos.length} photos`);

    // Phase 2 : Save photos
    console.log('Phase 2: Saving photos to DB...');
    await savePhotosToDb(photos);

    // Mark as completed
    console.log('startIndexing: Marking as completed...');
    client = await pool.connect();
    try {
      await client.query(
        `UPDATE indexing_state SET status = 'completed', total_items = $1, processed_items = $1, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT MAX(id) FROM indexing_state)`,
        [photos.length]
      );
    } finally {
      client.release();
    }

    console.log('Indexing completed successfully');
    return { success: true, total: photos.length };
  } catch (err) {
    console.error('Indexing error:', err);
    const errorClient = await pool.connect();
    try {
      await errorClient.query(
        `UPDATE indexing_state SET status = 'error', error = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT MAX(id) FROM indexing_state)`,
        [err.message]
      );
    } finally {
      errorClient.release();
    }
    throw err;
  }
}

async function startFaceDetection(distance = 0.6, model = 'hog', limit = 100, concurrency = 5) {
  const pool = getPool();
  let client = await pool.connect();

  try {
    await client.query(
      `INSERT INTO indexing_state (status, started_at, created_at, updated_at)
       VALUES ('indexing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    client.release();

    // Clear previous face detections and clusters
    await pool.query(`DELETE FROM photo_faces`);

    const token = await getValidAccessToken();

    const result = await pool.query(`SELECT id, name FROM photos LIMIT $1`, [limit]);
    const photoRows = result.rows;
    console.log(`Face detection: processing ${photoRows.length} photos (limit=${limit}, concurrency=${concurrency})...`);

    // Build photo objects with fresh download URLs
    const photos = photoRows.map(r => ({
      id: r.id,
      name: r.name,
    }));

    // Store total upfront so the UI can show progress immediately
    await pool.query(
      `UPDATE indexing_state SET total_items = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = (SELECT MAX(id) FROM indexing_state)`,
      [photos.length]
    );

    const CONCURRENCY = concurrency;
    let processed = 0;

    async function processPhoto(photo) {
      const itemRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/drive/items/${photo.id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const itemData = await itemRes.json();
      photo['@microsoft.graph.downloadUrl'] = itemData['@microsoft.graph.downloadUrl'];
      await indexPhotoWithFaces(photo, token, model);
      processed++;
      if (processed % 10 === 0) {
        await pool.query(
          `UPDATE indexing_state SET processed_items = $1, total_items = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = (SELECT MAX(id) FROM indexing_state)`,
          [processed, photos.length]
        );
      }
    }

    // Process in batches of CONCURRENCY
    for (let i = 0; i < photos.length; i += CONCURRENCY) {
      const batch = photos.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(processPhoto));
    }

    // Cluster faces
    console.log('Clustering faces by person...');
    await updateIndexingStatus('clustering');
    await clusterFacesByPerson(distance);

    client = await pool.connect();
    try {
      await client.query(
        `UPDATE indexing_state SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT MAX(id) FROM indexing_state)`
      );
    } finally {
      client.release();
    }

    console.log('Face detection completed');
    return { success: true, total: photos.length };
  } catch (err) {
    console.error('Face detection error:', err);
    const errorClient = await pool.connect();
    try {
      await errorClient.query(
        `UPDATE indexing_state SET status = 'error', error = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = (SELECT MAX(id) FROM indexing_state)`,
        [err.message]
      );
    } finally {
      errorClient.release();
    }
    throw err;
  }
}

async function getIndexingState() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT * FROM indexing_state ORDER BY id DESC LIMIT 1`
    );
    return result.rows[0] || { status: 'idle' };
  } finally {
    client.release();
  }
}

module.exports = { startIndexing, startFaceDetection, getIndexingState, fetchAllPhotosMetadata, savePhotosToDb };
