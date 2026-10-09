const fetch = require('node-fetch').default;
const { getValidAccessToken } = require('../auth/oauth');
const { getPool } = require('../db/init');
const { convertPhotoBuffer } = require('./imageConverter');
const { detectFacesInImage, extractFaceThumbnail, saveFaceToDb, clusterFacesByPerson } = require('./faceDetector');

async function downloadPhotoBuffer(photoId, downloadUrl, token) {
  const res = await fetch(downloadUrl);
  if (res.ok) return Buffer.from(await res.arrayBuffer());

  const res2 = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res2.ok) throw new Error(`Failed to download photo ${photoId}: ${res2.status}`);
  return Buffer.from(await res2.arrayBuffer());
}

async function fetchAllPhotosMetadata(userId) {
  const token = await getValidAccessToken(userId);
  const pool = getPool();

  let allItems = [];
  let url = "https://graph.microsoft.com/v1.0/me/drive/special/cameraroll/delta" +
    "?$select=id,name,size,createdDateTime,lastModifiedDateTime,photo,location,file,deleted,@microsoft.graph.downloadUrl" +
    "&$top=1000";

  let page = 0;

  while (url) {
    page++;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.error) throw new Error(`Graph API error: ${JSON.stringify(data.error)}`);
    const items = (data.value || []).filter(i => i.file && !i.deleted);
    allItems = allItems.concat(items);
    url = data['@odata.nextLink'] || null;
  }

  return allItems;
}

async function savePhotosToDb(photos, userId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    for (const photo of photos) {
      const takenAt = photo.photo?.takenDateTime || photo.createdDateTime;
      await client.query(
        `INSERT INTO photos (id, user_id, name, taken_at, metadata)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id, user_id) DO UPDATE SET
           metadata = $5, updated_at = CURRENT_TIMESTAMP`,
        [photo.id, userId, photo.name, takenAt, JSON.stringify(photo)]
      );
    }
  } finally {
    client.release();
  }
}

async function indexPhotoWithFaces(photo, token, model, userId) {
  try {
    const downloadUrl = photo['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      console.warn(`No download URL for ${photo.name}`);
      return;
    }

    const imageBuffer = await downloadPhotoBuffer(photo.id, downloadUrl, token);
    const ext = require('path').extname(photo.name).toLowerCase() || '.jpg';
    const processedBuffer = await convertPhotoBuffer(imageBuffer, photo.name);

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
    if (detections.length === 0) return;

    for (let i = 0; i < detections.length; i++) {
      const thumbnail = await extractFaceThumbnail(thumbnailBuffer, detections[i].box);
      await saveFaceToDb(photo.id, userId, i, detections[i], thumbnail);
    }
  } catch (err) {
    console.error(`Error processing ${photo.name}:`, err.message);
  }
}

async function updateIndexingStatus(status, userId) {
  const pool = getPool();
  await pool.query(
    `UPDATE indexing_state SET status = $1, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $2 AND id = (SELECT MAX(id) FROM indexing_state WHERE user_id = $2)`,
    [status, userId]
  );
}

async function startIndexing(userId) {
  const pool = getPool();
  let client = await pool.connect();

  try {
    await client.query(
      `INSERT INTO indexing_state (user_id, status, started_at, created_at, updated_at)
       VALUES ($1, 'indexing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId]
    );
    client.release();

    const photos = await fetchAllPhotosMetadata(userId);
    console.log(`Found ${photos.length} photos for user ${userId}`);
    await savePhotosToDb(photos, userId);

    client = await pool.connect();
    try {
      await client.query(
        `UPDATE indexing_state SET status = 'completed', total_items = $1, processed_items = $1,
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2 AND id = (SELECT MAX(id) FROM indexing_state WHERE user_id = $2)`,
        [photos.length, userId]
      );
    } finally {
      client.release();
    }

    return { success: true, total: photos.length };
  } catch (err) {
    console.error('Indexing error:', err);
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE indexing_state SET status = 'error', error = $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2 AND id = (SELECT MAX(id) FROM indexing_state WHERE user_id = $2)`,
        [err.message, userId]
      );
    } finally { c.release(); }
    throw err;
  }
}

async function startFaceDetection(userId, distance = 1.0, model = 'hog', limit = 100, concurrency = 5) {
  const pool = getPool();
  let client = await pool.connect();

  try {
    await client.query(
      `INSERT INTO indexing_state (user_id, status, started_at, created_at, updated_at)
       VALUES ($1, 'indexing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId]
    );
    client.release();

    await pool.query(`DELETE FROM photo_faces WHERE user_id = $1`, [userId]);

    const token = await getValidAccessToken(userId);

    const result = await pool.query(`SELECT id, name FROM photos WHERE user_id = $1 LIMIT $2`, [userId, limit]);
    const photos = result.rows.map(r => ({ id: r.id, name: r.name }));

    await pool.query(
      `UPDATE indexing_state SET total_items = $1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 AND id = (SELECT MAX(id) FROM indexing_state WHERE user_id = $2)`,
      [photos.length, userId]
    );

    let processed = 0;

    async function processPhoto(photo) {
      const itemRes = await fetch(
        `https://graph.microsoft.com/v1.0/me/drive/items/${photo.id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const itemData = await itemRes.json();
      photo['@microsoft.graph.downloadUrl'] = itemData['@microsoft.graph.downloadUrl'];
      await indexPhotoWithFaces(photo, token, model, userId);
      processed++;
      if (processed % 10 === 0) {
        await pool.query(
          `UPDATE indexing_state SET processed_items = $1, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2 AND id = (SELECT MAX(id) FROM indexing_state WHERE user_id = $2)`,
          [processed, userId]
        );
      }
    }

    for (let i = 0; i < photos.length; i += concurrency) {
      await Promise.all(photos.slice(i, i + concurrency).map(processPhoto));
    }

    await updateIndexingStatus('clustering', userId);
    await clusterFacesByPerson(distance, userId);

    client = await pool.connect();
    try {
      await client.query(
        `UPDATE indexing_state SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND id = (SELECT MAX(id) FROM indexing_state WHERE user_id = $1)`,
        [userId]
      );
    } finally { client.release(); }

    return { success: true, total: photos.length };
  } catch (err) {
    console.error('Face detection error:', err);
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE indexing_state SET status = 'error', error = $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2 AND id = (SELECT MAX(id) FROM indexing_state WHERE user_id = $2)`,
        [err.message, userId]
      );
    } finally { c.release(); }
    throw err;
  }
}

async function getIndexingState(userId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM indexing_state WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    return result.rows[0] || { status: 'idle' };
  } finally {
    client.release();
  }
}

module.exports = { startIndexing, startFaceDetection, getIndexingState, fetchAllPhotosMetadata, savePhotosToDb };
