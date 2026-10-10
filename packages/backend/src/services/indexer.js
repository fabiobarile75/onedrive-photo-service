const fetch = require('node-fetch').default;
const { getValidAccessToken } = require('../auth/oauth');
const { getPool } = require('../db/init');
const { convertPhotoBuffer } = require('./imageConverter');
const { detectFacesInImage, extractFaceThumbnail, saveFaceToDb, clusterFacesByPerson } = require('./faceDetector');

// Per-user metrics buffer (last 600 events = ~10 min at 1/s)
const metricsBuffers = new Map();
function getMetricsBuffer(userId) {
  if (!metricsBuffers.has(userId)) metricsBuffers.set(userId, []);
  return metricsBuffers.get(userId);
}
function pushMetric(userId, downloadMs, detectMs) {
  const buf = getMetricsBuffer(userId);
  buf.push({ ts: Date.now(), downloadMs, detectMs });
  if (buf.length > 600) buf.shift();
}
function getFaceDetectionMetrics(userId) {
  return getMetricsBuffer(userId);
}

async function downloadPhotoBuffer(photoId, downloadUrl, token) {
  const res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to download photo ${photoId}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchAndSavePhotosMetadata(userId, stateId) {
  const token = await getValidAccessToken(userId);
  const pool = getPool();

  let url = "https://graph.microsoft.com/v1.0/me/drive/special/cameraroll/delta" +
    "?$select=id,name,size,createdDateTime,lastModifiedDateTime,photo,location,file,deleted,@microsoft.graph.downloadUrl" +
    "&$top=1000";

  let page = 0;
  let totalProcessed = 0;

  while (url) {
    page++;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.error) throw new Error(`Graph API error: ${JSON.stringify(data.error)}`);
    const items = (data.value || []).filter(i => i.file && !i.deleted);

    const client = await pool.connect();
    try {
      for (const photo of items) {
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

    totalProcessed += items.length;
    await pool.query(
      `UPDATE indexing_state SET processed_items = $1, current_page = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [totalProcessed, page, stateId]
    );

    url = data['@odata.nextLink'] || null;
  }

  return totalProcessed;
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
  let stateId;

  try {
    const stateRes = await client.query(
      `INSERT INTO indexing_state (user_id, status, started_at, created_at, updated_at)
       VALUES ($1, 'indexing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id`,
      [userId]
    );
    stateId = stateRes.rows[0].id;
    client.release();

    console.log(`Starting indexing for user ${userId}`);
    const processed = await fetchAndSavePhotosMetadata(userId, stateId);
    console.log(`Indexed ${processed} photos for user ${userId}`);

    await pool.query(
      `UPDATE indexing_state SET status = 'completed', total_items = $1, processed_items = $1,
       completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [processed, stateId]
    );

    return { success: true, total: processed };
  } catch (err) {
    console.error('Indexing error:', err);
    if (stateId) {
      const pool = getPool();
      const c = await pool.connect();
      try {
        await c.query(
          `UPDATE indexing_state SET status = 'error', error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [err.message, stateId]
        );
      } finally { c.release(); }
    }
    throw err;
  }
}

async function startFaceDetection(userId, distance = 1.0, model = 'hog', limit = 100, concurrency = 5) {
  const pool = getPool();
  let client = await pool.connect();

  try {
    await client.query(
      `INSERT INTO face_detection_state (user_id, status, started_at, created_at, updated_at)
       VALUES ($1, 'indexing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId]
    );
    client.release();

    await pool.query(`DELETE FROM photo_faces WHERE user_id = $1`, [userId]);

    const token = await getValidAccessToken(userId);

    const result = await pool.query(
      `SELECT id, name FROM photos WHERE user_id = $1
       AND lower(substring(name from '\\.[^.]+$')) NOT IN ('.mov', '.mp4', '.3gp', '.avi', '.mkv', '.wmv')
       LIMIT $2`,
      [userId, limit]
    );
    const photos = result.rows.map(r => ({ id: r.id, name: r.name }));

    await pool.query(
      `UPDATE face_detection_state SET total_items = $1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $2)`,
      [photos.length, userId]
    );

    let processed = 0;
    const BUFFER_SIZE = concurrency * 2;

    // Bounded async queue
    class AsyncQueue {
      constructor(maxSize) {
        this.maxSize = maxSize;
        this.items = [];
        this.waiters = [];
        this.pushWaiters = [];
        this.closed = false;
      }
      async push(item) {
        while (this.items.length >= this.maxSize) {
          await new Promise(r => this.pushWaiters.push(r));
        }
        this.items.push(item);
        if (this.waiters.length) this.waiters.shift()();
      }
      async pop() {
        while (this.items.length === 0) {
          if (this.closed) return null;
          await new Promise(r => this.waiters.push(r));
        }
        const item = this.items.shift();
        if (this.pushWaiters.length) this.pushWaiters.shift()();
        return item;
      }
      close() {
        this.closed = true;
        this.waiters.forEach(r => r());
      }
    }

    const queue = new AsyncQueue(BUFFER_SIZE);

    // Producer: download photos concurrently and push to queue
    async function producer() {
      const semaphore = Array(concurrency).fill(null);
      let idx = 0;
      async function worker() {
        while (idx < photos.length) {
          const photo = photos[idx++];
          if (!photo) break;
          try {
            const url = `https://graph.microsoft.com/v1.0/me/drive/items/${photo.id}/content`;
            const dlStart = Date.now();
            const buf = await downloadPhotoBuffer(photo.id, url, token);
            const downloadMs = Date.now() - dlStart;
            await queue.push({ photo, buf, downloadMs });
          } catch (e) {
            console.error(`Download error ${photo.name}:`, e.message);
          }
        }
      }
      await Promise.all(semaphore.map(() => worker()));
      queue.close();
    }

    // Consumer: process photos from queue one by one
    async function consumer() {
      while (true) {
        const item = await queue.pop();
        if (!item) break;
        const { photo, buf, downloadMs } = item;
        try {
          const ext = require('path').extname(photo.name).toLowerCase() || '.jpg';
          const processedBuffer = await convertPhotoBuffer(buf, photo.name);
          const detectStart = Date.now();
          const detections = await detectFacesInImage(processedBuffer, ext, model);
          const detectMs = Date.now() - detectStart;
          pushMetric(userId, downloadMs, detectMs);
          if (detections.length > 0) {
            for (let i = 0; i < detections.length; i++) {
              const thumbnail = await extractFaceThumbnail(processedBuffer, detections[i].box);
              await saveFaceToDb(photo.id, userId, i, detections[i], thumbnail);
            }
          }
        } catch (e) {
          console.error(`Error processing ${photo.name}:`, e.message);
        }
        processed++;
        if (processed % 10 === 0) {
          await pool.query(
            `UPDATE face_detection_state SET processed_items = $1, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $2 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $2)`,
            [processed, userId]
          );
        }
      }
    }

    await Promise.all([producer(), consumer()]);

    await pool.query(
      `UPDATE face_detection_state SET status = 'clustering', updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $1)`,
      [userId]
    );
    await clusterFacesByPerson(distance, userId);

    client = await pool.connect();
    try {
      await client.query(
        `UPDATE face_detection_state SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $1)`,
        [userId]
      );
    } finally { client.release(); }

    return { success: true, total: photos.length };
  } catch (err) {
    console.error('Face detection error:', err);
    const c = await pool.connect();
    try {
      await c.query(
        `UPDATE face_detection_state SET status = 'error', error = $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $2)`,
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

async function getFaceDetectionState(userId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM face_detection_state WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    return result.rows[0] || { status: 'idle' };
  } finally {
    client.release();
  }
}

module.exports = { startIndexing, startFaceDetection, getIndexingState, getFaceDetectionState, getFaceDetectionMetrics };
