const fetch = require('node-fetch').default;
const { getValidAccessToken } = require('../auth/oauth');
const { getPool } = require('../db/init');
const { detectFacesInImage, extractFaceThumbnail, saveFaceToDb, clusterFacesByPerson } = require('./faceDetector');

// Processus actifs par userId (pour pouvoir les arrêter)
const activeProcesses = new Map(); // userId -> { cancel: () => void, retryTimeoutId: NodeJS.Timeout | null }

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

async function processPhotos(userId, photos, distance, model, concurrency, initialProcessed = 0, autoRetry = false) {
  const pool = getPool();
  let processed = initialProcessed;
  let cancelled = false;
  let retryTimeoutId = null;
  const BUFFER_SIZE = concurrency * 2;

  // Enregistrer le processus pour pouvoir l'annuler
  const cancelFn = () => {
    cancelled = true;
    if (retryTimeoutId) {
      clearTimeout(retryTimeoutId);
      retryTimeoutId = null;
    }
  };
  activeProcesses.set(userId, { cancel: cancelFn, retryTimeoutId: null });

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
          const url = `https://graph.microsoft.com/v1.0/me/drive/items/${photo.id}/thumbnails/0/large/content`;
          const freshToken = await getValidAccessToken(userId);
          const dlStart = Date.now();
          const buf = await downloadPhotoBuffer(photo.id, url, freshToken);
          const downloadMs = Date.now() - dlStart;
          await queue.push({ photo, buf, downloadMs });
        } catch (e) {
          console.error(`Download error ${photo.name}:`, e.message);
          // Marquer la photo comme en erreur de téléchargement
          await pool.query(
            `UPDATE photos SET face_error = $1, face_retries = face_retries + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [e.message, photo.id]
          );
        }
      }
    }
    await Promise.all(semaphore.map(() => worker()));
    queue.close();
  }

  // Consumer: process photos from queue one by one
  async function consumer() {
    while (true) {
      if (cancelled) {
        console.log(`Process cancelled for user ${userId}`);
        break;
      }
      const item = await queue.pop();
      if (!item) break;
      const { photo, buf, downloadMs } = item;
      
      try {
        const detectStart = Date.now();
        const detections = await detectFacesInImage(buf, '.jpg', model);
        const detectMs = Date.now() - detectStart;
        pushMetric(userId, downloadMs, detectMs);
        
        if (detections.length > 0) {
          for (let i = 0; i < detections.length; i++) {
            const thumbnail = await extractFaceThumbnail(buf, detections[i].box);
            await saveFaceToDb(photo.id, userId, i, detections[i], thumbnail);
          }
        }
        
        // Marquer la photo comme traitée avec succès (efface l'erreur précédente si existante)
        await pool.query(
          `UPDATE photos SET face_processed_at = CURRENT_TIMESTAMP, face_error = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [photo.id]
        );
      } catch (e) {
        console.error(`Error processing ${photo.name}:`, e.message);
        
        // Marquer la photo comme en erreur
        await pool.query(
          `UPDATE photos SET face_error = $1, face_retries = face_retries + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [e.message, photo.id]
        );
        
        // Si c'est une erreur 429, arrêter le processus
        if (e.message.includes('429')) {
          console.error('Rate limit (429) reached. Stopping face detection process.');
          
          // Incrémenter le compteur d'erreurs 429
          await pool.query(
            `UPDATE face_detection_state SET 
              status = 'waiting_retry', 
              error = $1,
              error_429_count = COALESCE(error_429_count, 0) + 1,
              next_retry_at = CURRENT_TIMESTAMP + INTERVAL '60 seconds',
              updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $2 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $2)`,
            ['Rate limit exceeded (429) — reprise automatique dans 60s', userId]
          );
          
          if (autoRetry && !cancelled) {
            // Programmer la reprise automatique dans 60 secondes
            console.log(`Auto-resuming face detection for user ${userId} in 60 seconds...`);
            retryTimeoutId = setTimeout(async () => {
              if (cancelled) return;
              console.log(`Auto-resuming face detection for user ${userId} after 429...`);
              try {
                // Récupérer les paramètres depuis la dernière session
                const stateRes = await pool.query(
                  `SELECT * FROM face_detection_state WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
                  [userId]
                );
                if (stateRes.rows[0]) {
                  // Compter les photos déjà traitées
                  const countResult = await pool.query(
                    `SELECT COUNT(*) as count FROM photos WHERE user_id = $1 AND face_processed_at IS NOT NULL`,
                    [userId]
                  );
                  const alreadyProcessed = parseInt(countResult.rows[0].count);
                  
                  // Récupérer les photos à traiter
                  const result = await pool.query(
                    `SELECT id, name FROM photos WHERE user_id = $1
                     AND lower(substring(name from '\\.[^.]+$')) NOT IN ('.mov', '.mp4', '.3gp', '.avi', '.mkv', '.wmv')
                     AND (face_processed_at IS NULL OR (face_error IS NOT NULL AND face_retries < 5))
                     ORDER BY 
                       CASE WHEN face_error IS NOT NULL THEN 0 ELSE 1 END,
                       taken_at
                     LIMIT 100`,
                    [userId]
                  );
                  const photos = result.rows.map(r => ({ id: r.id, name: r.name }));
                  
                  if (photos.length > 0) {
                    await pool.query(
                      `INSERT INTO face_detection_state (user_id, status, started_at, processed_items, created_at, updated_at)
                       VALUES ($1, 'indexing', CURRENT_TIMESTAMP, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                      [userId, alreadyProcessed]
                    );
                    
                    await pool.query(
                      `UPDATE face_detection_state SET total_items = $1, updated_at = CURRENT_TIMESTAMP
                       WHERE user_id = $2 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $2)`,
                      [alreadyProcessed + photos.length, userId]
                    );
                    
                    await processPhotos(userId, photos, distance, model, concurrency, alreadyProcessed, autoRetry);
                  } else {
                    // Plus de photos à traiter
                    await pool.query(
                      `UPDATE face_detection_state SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                       WHERE user_id = $1 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $1)`,
                      [userId]
                    );
                  }
                }
              } catch (err) {
                console.error('Auto-resume failed:', err);
              }
            }, 60000);
            
            activeProcesses.get(userId).retryTimeoutId = retryTimeoutId;
          }
          
          throw new Error('Rate limit exceeded. Process paused for retry.');
        }
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

  // Nettoyer le processus actif
  activeProcesses.delete(userId);

  // Si le processus a été annulé manuellement
  if (cancelled) {
    await pool.query(
      `UPDATE face_detection_state SET status = 'stopped', stop_requested = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $1)`,
      [userId]
    );
    return { success: false, cancelled: true, total: photos.length, processed };
  }

  // Dernière mise à jour de processed_items (même si pas multiple de 10)
  await pool.query(
    `UPDATE face_detection_state SET processed_items = $1, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $2 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $2)`,
    [processed, userId]
  );

  await pool.query(
    `UPDATE face_detection_state SET status = 'clustering', updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $1)`,
    [userId]
  );
  await clusterFacesByPerson(distance, userId);

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE face_detection_state SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $1)`,
      [userId]
    );
  } finally { client.release(); }

  return { success: true, total: photos.length, processed };
}

async function startFaceDetection(userId, distance = 1.0, model = 'hog', limit = 100, concurrency = 5, autoRetry = false) {
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

    return await processPhotos(userId, photos, distance, model, concurrency, 0, autoRetry);
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

async function resumeFaceDetection(userId, distance = 1.0, model = 'hog', limit = 100, concurrency = 5, autoRetry = false) {
  const pool = getPool();
  let client = await pool.connect();

  try {
    // Compter les photos déjà traitées pour continuer le compteur
    const countResult = await client.query(
      `SELECT COUNT(*) as count FROM photos WHERE user_id = $1 AND face_processed_at IS NOT NULL`,
      [userId]
    );
    const alreadyProcessed = parseInt(countResult.rows[0].count);

    await client.query(
      `INSERT INTO face_detection_state (user_id, status, started_at, processed_items, created_at, updated_at)
       VALUES ($1, 'indexing', CURRENT_TIMESTAMP, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId, alreadyProcessed]
    );
    client.release();

    // Récupérer les photos à traiter : non traitées OU en erreur (avec moins de 5 tentatives)
    const result = await pool.query(
      `SELECT id, name FROM photos WHERE user_id = $1
       AND lower(substring(name from '\\.[^.]+$')) NOT IN ('.mov', '.mp4', '.3gp', '.avi', '.mkv', '.wmv')
       AND (face_processed_at IS NULL OR (face_error IS NOT NULL AND face_retries < 5))
       ORDER BY 
         CASE WHEN face_error IS NOT NULL THEN 0 ELSE 1 END,  -- Photos en erreur d'abord
         taken_at
       LIMIT $2`,
      [userId, limit]
    );
    const photos = result.rows.map(r => ({ id: r.id, name: r.name }));

    await pool.query(
      `UPDATE face_detection_state SET total_items = $1, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $2)`,
      [alreadyProcessed + photos.length, userId]
    );

    console.log(`Resuming face detection for user ${userId}: ${alreadyProcessed} already processed, ${photos.length} to process`);

    return await processPhotos(userId, photos, distance, model, concurrency, alreadyProcessed, autoRetry);
  } catch (err) {
    console.error('Face detection resume error:', err);
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

async function stopFaceDetection(userId) {
  console.log(`Stopping face detection for user ${userId}...`);
  
  const process = activeProcesses.get(userId);
  if (process) {
    process.cancel();
    activeProcesses.delete(userId);
  }
  
  const pool = getPool();
  await pool.query(
    `UPDATE face_detection_state SET 
      status = 'stopped', 
      stop_requested = TRUE,
      updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND id = (SELECT MAX(id) FROM face_detection_state WHERE user_id = $1)
     AND status IN ('indexing', 'clustering', 'waiting_retry')`,
    [userId]
  );
  
  console.log(`Face detection stopped for user ${userId}`);
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

module.exports = { startIndexing, startFaceDetection, resumeFaceDetection, getIndexingState, getFaceDetectionState, getFaceDetectionMetrics };
