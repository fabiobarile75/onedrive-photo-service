const express = require('express');
const multer = require('multer');
const { getPool } = require('../db/init');
const { detectFacesInImage, faceDistance } = require('../services/faceDetector');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router = express.Router();

router.get('/clusters', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          pf.person_cluster_id,
          pc.name as cluster_name,
          pc.description as cluster_description,
          pc.person_id,
          p2.name as person_name,
          COUNT(DISTINCT pf.photo_id) as photo_count,
          COUNT(*) as face_count,
          AVG(pf.age)::INT as avg_age,
          MAX(pf.gender) as gender,
          (SELECT encode(pf2.thumbnail, 'base64') FROM photo_faces pf2
           WHERE pf2.person_cluster_id = pf.person_cluster_id
           AND pf2.user_id = $1
           AND pf2.thumbnail IS NOT NULL LIMIT 1) as thumbnail
        FROM photo_faces pf
        LEFT JOIN person_clusters pc ON pc.id = pf.person_cluster_id AND pc.user_id = pf.user_id
        LEFT JOIN persons p2 ON p2.id = pc.person_id AND p2.user_id = pf.user_id
        WHERE pf.person_cluster_id IS NOT NULL AND pf.user_id = $1
        GROUP BY pf.person_cluster_id, pc.name, pc.description, pc.person_id, p2.name
        ORDER BY photo_count DESC
      `, [req.userId]);
      res.json(result.rows);
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/clusters/:clusterId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const clusterResult = await client.query(
        `SELECT id, name, description FROM person_clusters WHERE id = $1 AND user_id = $2`,
        [req.params.clusterId, req.userId]
      );
      const result = await client.query(`
        SELECT pf.id, pf.photo_id, pf.face_index, pf.age, pf.gender, pf.expressions,
               pf.bounding_box, encode(pf.thumbnail, 'base64') as thumbnail,
               p.name as photo_name, p.taken_at
        FROM photo_faces pf
        JOIN photos p ON pf.photo_id = p.id AND p.user_id = pf.user_id
        WHERE pf.person_cluster_id = $1 AND pf.user_id = $2
        ORDER BY p.taken_at DESC NULLS LAST, pf.photo_id
      `, [req.params.clusterId, req.userId]);
      res.json({
        cluster: clusterResult.rows[0] || null,
        faces: result.rows,
      });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/photo/:photoId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT pf.id, pf.face_index, pf.bounding_box, pf.age, pf.gender, pf.expressions,
               pf.person_cluster_id, pc.name as cluster_name,
               encode(pf.thumbnail, 'base64') as thumbnail,
               (p.metadata->'photo'->>'orientation')::int as exif_orientation
        FROM photo_faces pf
        LEFT JOIN person_clusters pc ON pc.id = pf.person_cluster_id AND pc.user_id = pf.user_id
        JOIN photos p ON p.id = pf.photo_id AND p.user_id = pf.user_id
        WHERE pf.photo_id = $1 AND pf.user_id = $2
        ORDER BY pf.face_index
      `, [req.params.photoId, req.userId]);
      res.json(result.rows);
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/thumbnail/:faceId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT thumbnail FROM photo_faces WHERE id = $1 AND user_id = $2',
        [req.params.faceId, req.userId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Face not found' });
      res.type('image/jpeg').send(result.rows[0].thumbnail);
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clusters/merge', async (req, res) => {
  try {
    const { sourceClusterId, targetClusterId } = req.body;
    if (!sourceClusterId || !targetClusterId) return res.status(400).json({ error: 'sourceClusterId and targetClusterId required' });
    const pool = getPool();
    const client = await pool.connect();
    try {
      // Get existing person_id from target or source clusters
      const clustersResult = await client.query(
        `SELECT id, person_id, name FROM person_clusters WHERE id = ANY($1) AND user_id = $2`,
        [[sourceClusterId, targetClusterId], req.userId]
      );
      const targetCluster = clustersResult.rows.find(r => r.id === targetClusterId);
      const sourceCluster = clustersResult.rows.find(r => r.id === sourceClusterId);

      let personId = targetCluster?.person_id || sourceCluster?.person_id;

      if (!personId) {
        // Create a new person using target cluster's name
        personId = Math.random().toString(36).substr(2, 9);
        const personName = targetCluster?.name || sourceCluster?.name || null;
        await client.query(
          `INSERT INTO persons (id, user_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [personId, req.userId, personName]
        );
      }

      // Link both clusters to the person
      await client.query(
        `UPDATE person_clusters SET person_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ANY($2) AND user_id = $3`,
        [personId, [sourceClusterId, targetClusterId], req.userId]
      );
      // Ensure both clusters exist in person_clusters table
      await client.query(
        `INSERT INTO person_clusters (id, user_id, person_id) VALUES ($1, $2, $3)
         ON CONFLICT (id, user_id) DO UPDATE SET person_id = $3, updated_at = CURRENT_TIMESTAMP`,
        [sourceClusterId, req.userId, personId]
      );
      await client.query(
        `INSERT INTO person_clusters (id, user_id, person_id) VALUES ($1, $2, $3)
         ON CONFLICT (id, user_id) DO UPDATE SET person_id = $3, updated_at = CURRENT_TIMESTAMP`,
        [targetClusterId, req.userId, personId]
      );

      res.json({ success: true, personId });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clusters/:clusterId/split', async (req, res) => {
  try {
    const { faceIds } = req.body;
    if (!Array.isArray(faceIds) || faceIds.length === 0) return res.status(400).json({ error: 'faceIds array required' });
    const newClusterId = `split_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE photo_faces SET person_cluster_id = $1
         WHERE id = ANY($2) AND user_id = $3`,
        [newClusterId, faceIds, req.userId]
      );
      res.json({ newClusterId });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/unclassified/all', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT pf.id, pf.photo_id, pf.face_index, pf.age, pf.gender, pf.bounding_box,
               encode(pf.thumbnail, 'base64') as thumbnail, p.name as photo_name, p.taken_at
        FROM photo_faces pf
        JOIN photos p ON pf.photo_id = p.id AND p.user_id = pf.user_id
        WHERE pf.person_cluster_id IS NULL AND pf.user_id = $1
        ORDER BY p.taken_at DESC NULLS LAST, pf.photo_id
        LIMIT $2 OFFSET $3
      `, [req.userId, limit, offset]);
      const countResult = await client.query(
        'SELECT COUNT(*) as count FROM photo_faces WHERE person_cluster_id IS NULL AND user_id = $1',
        [req.userId]
      );
      res.json({ faces: result.rows, total: parseInt(countResult.rows[0].count), limit, offset });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/faces/:faceId/cluster', async (req, res) => {
  try {
    const { clusterId } = req.body;
    if (!clusterId) return res.status(400).json({ error: 'clusterId required' });
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE photo_faces SET person_cluster_id = $1 WHERE id = $2 AND user_id = $3`,
        [clusterId, req.params.faceId, req.userId]
      );
      res.json({ success: true });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/clusters/:clusterId/faces/:faceId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE photo_faces SET person_cluster_id = NULL
         WHERE id = $1 AND person_cluster_id = $2 AND user_id = $3`,
        [req.params.faceId, req.params.clusterId, req.userId]
      );
      res.json({ success: true });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/clusters/:clusterId/name', async (req, res) => {
  try {
    const { name } = req.body;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO person_clusters (id, user_id, name, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (id, user_id) DO UPDATE SET name = $3, updated_at = CURRENT_TIMESTAMP`,
        [req.params.clusterId, req.userId, name]
      );
      res.json({ success: true });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/clusters/:clusterId/description', async (req, res) => {
  try {
    const { description } = req.body;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO person_clusters (id, user_id, description, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (id, user_id) DO UPDATE SET description = $3, updated_at = CURRENT_TIMESTAMP`,
        [req.params.clusterId, req.userId, description ?? null]
      );
      res.json({ success: true });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clusters/:clusterId/merge/:targetId', async (req, res) => {
  try {
    const { clusterId: sourceClusterId, targetId: targetClusterId } = req.params;
    const pool = getPool();
    const client = await pool.connect();
    try {
      const clustersResult = await client.query(
        `SELECT id, person_id, name FROM person_clusters WHERE id = ANY($1) AND user_id = $2`,
        [[sourceClusterId, targetClusterId], req.userId]
      );
      const targetCluster = clustersResult.rows.find(r => r.id === targetClusterId);
      const sourceCluster = clustersResult.rows.find(r => r.id === sourceClusterId);

      let personId = targetCluster?.person_id || sourceCluster?.person_id;

      if (!personId) {
        personId = Math.random().toString(36).substr(2, 9);
        const personName = targetCluster?.name || sourceCluster?.name || null;
        await client.query(
          `INSERT INTO persons (id, user_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [personId, req.userId, personName]
        );
      }

      await client.query(
        `INSERT INTO person_clusters (id, user_id, person_id) VALUES ($1, $2, $3)
         ON CONFLICT (id, user_id) DO UPDATE SET person_id = $3, updated_at = CURRENT_TIMESTAMP`,
        [sourceClusterId, req.userId, personId]
      );
      await client.query(
        `INSERT INTO person_clusters (id, user_id, person_id) VALUES ($1, $2, $3)
         ON CONFLICT (id, user_id) DO UPDATE SET person_id = $3, updated_at = CURRENT_TIMESTAMP`,
        [targetClusterId, req.userId, personId]
      );

      res.json({ success: true, personId });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats/summary', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const stats = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM photos WHERE user_id = $1) as total_photos,
          (SELECT COUNT(*) FROM photo_faces WHERE user_id = $1) as total_faces,
          (SELECT COUNT(DISTINCT person_cluster_id) FROM photo_faces WHERE person_cluster_id IS NOT NULL AND user_id = $1) as clusters,
          (SELECT COUNT(*) FROM photo_faces WHERE person_cluster_id IS NULL AND user_id = $1) as unclassified_faces,
          (SELECT AVG(age) FROM photo_faces WHERE age IS NOT NULL AND user_id = $1)::INT as avg_age
      `, [req.userId]);
      res.json(stats.rows[0]);
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/identify', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload error: ' + err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const sharp = require('sharp');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    let imageBuffer;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const isHeic = ext === '.heic' || ext === '.heif' || req.file.mimetype === 'image/heic' || req.file.mimetype === 'image/heif';

    if (isHeic) {
      const tmpHeic = path.join(os.tmpdir(), `heic_${Date.now()}.heic`);
      const tmpJpeg = path.join(os.tmpdir(), `heic_${Date.now()}.jpg`);
      fs.writeFileSync(tmpHeic, req.file.buffer);
      await new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const proc = spawn('python3', ['-c', `
from pillow_heif import open_heif
from PIL import Image
heif = open_heif('${tmpHeic}', convert_hdr_to_8bit=True)
img = Image.frombytes(heif.mode, heif.size, heif.data)
img.save('${tmpJpeg}', 'JPEG', quality=90)
print('ok')
`]);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error('HEIC conversion failed')));
        proc.on('error', reject);
      });
      imageBuffer = fs.readFileSync(tmpJpeg);
      try { fs.unlinkSync(tmpHeic); fs.unlinkSync(tmpJpeg); } catch {}
    } else {
      try {
        imageBuffer = await sharp(req.file.buffer)
          .rotate()
          .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer();
      } catch (e) {
        imageBuffer = req.file.buffer;
      }
    }

    const model = ['hog', 'cnn', 'mediapipe', 'mtcnn'].includes(req.body?.model) ? req.body.model : 'hog';
    const detectedFaces = await detectFacesInImage(imageBuffer, '.jpg', model);

    let previewBase64;
    try {
      previewBase64 = (await sharp(imageBuffer).jpeg({ quality: 85 }).toBuffer()).toString('base64');
    } catch (e) { previewBase64 = null; }

    if (detectedFaces.length === 0) return res.json({ faces: [], preview: previewBase64 });

    const pool = getPool();
    const client = await pool.connect();
    try {
      const dbFaces = await client.query(
        `SELECT pf.id, pf.descriptor, pf.person_cluster_id,
                pc.name as cluster_name, pc.description as cluster_description, pc.person_id,
                p.name as person_name, p.description as person_description
         FROM photo_faces pf
         LEFT JOIN person_clusters pc ON pc.id = pf.person_cluster_id AND pc.user_id = pf.user_id
         LEFT JOIN persons p ON p.id = pc.person_id AND p.user_id = pf.user_id
         WHERE pf.descriptor IS NOT NULL AND pf.person_cluster_id IS NOT NULL AND pf.user_id = $1`,
        [req.userId]
      );

      const threshold = parseFloat(req.body?.threshold) || 1.0;
      const results = detectedFaces.map(face => {
        const detDesc = Buffer.from(new Float32Array(face.descriptor).buffer);
        let minDist = Infinity, bestRow = null;
        for (const row of dbFaces.rows) {
          const dist = faceDistance(detDesc, row.descriptor);
          if (dist < minDist) { minDist = dist; bestRow = row; }
        }
        const identified = minDist < threshold && bestRow;
        return {
          box: face.box,
          clusterId: identified ? bestRow.person_cluster_id : null,
          clusterName: identified ? (bestRow.cluster_name || bestRow.person_cluster_id?.substring(0, 6)) : null,
          clusterDescription: identified ? bestRow.cluster_description : null,
          personId: identified ? bestRow.person_id : null,
          personName: identified ? bestRow.person_name : null,
          personDescription: identified ? bestRow.person_description : null,
          distance: Math.round(minDist * 1000) / 1000
        };
      });

      res.json({ faces: results, preview: previewBase64 });
    } finally { client.release(); }
  } catch (err) {
    console.error('Identify error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/persons', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          p.id as person_id,
          p.name as person_name,
          COUNT(DISTINCT pc.id) as cluster_count,
          COUNT(DISTINCT pf.photo_id) as photo_count,
          COUNT(pf.id) as face_count,
          AVG(pf.age)::INT as avg_age,
          (SELECT encode(pf2.thumbnail, 'base64') FROM photo_faces pf2
           JOIN person_clusters pc2 ON pc2.id = pf2.person_cluster_id AND pc2.user_id = pf2.user_id
           WHERE pc2.person_id = p.id AND pf2.user_id = $1 AND pf2.thumbnail IS NOT NULL LIMIT 1) as thumbnail
        FROM persons p
        LEFT JOIN person_clusters pc ON pc.person_id = p.id AND pc.user_id = p.user_id
        LEFT JOIN photo_faces pf ON pf.person_cluster_id = pc.id AND pf.user_id = p.user_id
        WHERE p.user_id = $1
        GROUP BY p.id, p.name
        ORDER BY face_count DESC
      `, [req.userId]);
      res.json(result.rows);
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/persons/:personId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const personResult = await client.query(
        `SELECT id, name, description FROM persons WHERE id = $1 AND user_id = $2`,
        [req.params.personId, req.userId]
      );
      if (personResult.rows.length === 0) return res.status(404).json({ error: 'Person not found' });

      const clustersResult = await client.query(`
        SELECT pc.id as cluster_id, pc.name as cluster_name, pc.description
        FROM person_clusters pc
        WHERE pc.person_id = $1 AND pc.user_id = $2
        ORDER BY pc.created_at
      `, [req.params.personId, req.userId]);

      const clusters = [];
      for (const cluster of clustersResult.rows) {
        const facesResult = await client.query(`
          SELECT pf.id, pf.photo_id, pf.face_index, pf.age, pf.gender, pf.expressions,
                 pf.bounding_box, encode(pf.thumbnail, 'base64') as thumbnail,
                 p.name as photo_name, p.taken_at
          FROM photo_faces pf
          JOIN photos p ON pf.photo_id = p.id AND p.user_id = pf.user_id
          WHERE pf.person_cluster_id = $1 AND pf.user_id = $2
          ORDER BY p.taken_at DESC NULLS LAST, pf.photo_id
        `, [cluster.cluster_id, req.userId]);
        clusters.push({ ...cluster, faces: facesResult.rows });
      }

      res.json({ person: personResult.rows[0], clusters });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/persons/:personId/name', async (req, res) => {
  try {
    const { name } = req.body;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE persons SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3`,
        [name, req.params.personId, req.userId]
      );
      res.json({ success: true });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/persons/:personId/description', async (req, res) => {
  try {
    const { description } = req.body;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE persons SET description = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3`,
        [description || null, req.params.personId, req.userId]
      );
      res.json({ success: true });
    } finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
