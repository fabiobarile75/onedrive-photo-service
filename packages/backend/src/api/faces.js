const express = require('express');
const multer = require('multer');
const { getPool } = require('../db/init');
const { detectFacesInImage, faceDistance } = require('../services/faceDetector');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router = express.Router();

// Get all clusters with face counts
router.get('/clusters', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();

    try {
      const result = await client.query(`
        SELECT
          pf.person_cluster_id,
          pc.name as cluster_name,
          COUNT(DISTINCT pf.photo_id) as photo_count,
          COUNT(*) as face_count,
          AVG(pf.age)::INT as avg_age,
          MAX(pf.gender) as gender,
          (SELECT encode(pf2.thumbnail, 'base64') FROM photo_faces pf2
           WHERE pf2.person_cluster_id = pf.person_cluster_id
           AND pf2.thumbnail IS NOT NULL LIMIT 1) as thumbnail
        FROM photo_faces pf
        LEFT JOIN person_clusters pc ON pc.id = pf.person_cluster_id
        WHERE pf.person_cluster_id IS NOT NULL
        GROUP BY pf.person_cluster_id, pc.name
        ORDER BY photo_count DESC
      `);

      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching clusters:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get faces in a cluster
router.get('/clusters/:clusterId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();

    try {
      const result = await client.query(`
        SELECT
          pf.id,
          pf.photo_id,
          pf.face_index,
          pf.age,
          pf.gender,
          pf.expressions,
          pf.bounding_box,
          encode(pf.thumbnail, 'base64') as thumbnail,
          p.name as photo_name,
          p.taken_at
        FROM photo_faces pf
        JOIN photos p ON pf.photo_id = p.id
        WHERE pf.person_cluster_id = $1
        ORDER BY p.taken_at DESC NULLS LAST, pf.photo_id
      `, [req.params.clusterId]);

      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching cluster details:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get faces in a specific photo
router.get('/photo/:photoId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();

    try {
      const result = await client.query(`
        SELECT
          id,
          face_index,
          bounding_box,
          age,
          gender,
          expressions,
          person_cluster_id,
          encode(thumbnail, 'base64') as thumbnail
        FROM photo_faces
        WHERE photo_id = $1
        ORDER BY face_index
      `, [req.params.photoId]);

      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching photo faces:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get face thumbnail
router.get('/thumbnail/:faceId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();

    try {
      const result = await client.query(
        'SELECT thumbnail FROM photo_faces WHERE id = $1',
        [req.params.faceId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Face not found' });
      }

      const thumbnail = result.rows[0].thumbnail;
      res.type('image/jpeg').send(thumbnail);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching thumbnail:', err);
    res.status(500).json({ error: err.message });
  }
});

// Merge two clusters
router.post('/clusters/merge', async (req, res) => {
  try {
    const { sourceClusterId, targetClusterId } = req.body;

    if (!sourceClusterId || !targetClusterId) {
      return res.status(400).json({ error: 'sourceClusterId and targetClusterId required' });
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query(
        `UPDATE photo_faces SET person_cluster_id = $1
         WHERE person_cluster_id = $2`,
        [targetClusterId, sourceClusterId]
      );

      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error merging clusters:', err);
    res.status(500).json({ error: err.message });
  }
});

// Split cluster (move specific faces to new cluster)
router.post('/clusters/:clusterId/split', async (req, res) => {
  try {
    const { faceIds } = req.body;

    if (!Array.isArray(faceIds) || faceIds.length === 0) {
      return res.status(400).json({ error: 'faceIds array required' });
    }

    const newClusterId = `split_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query(
        `UPDATE photo_faces SET person_cluster_id = $1
         WHERE id = ANY($2)`,
        [newClusterId, faceIds]
      );

      res.json({ newClusterId });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error splitting cluster:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get unclassified faces
router.get('/unclassified/all', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const pool = getPool();
    const client = await pool.connect();

    try {
      const result = await client.query(`
        SELECT
          pf.id,
          pf.photo_id,
          pf.face_index,
          pf.age,
          pf.gender,
          pf.bounding_box,
          encode(pf.thumbnail, 'base64') as thumbnail,
          p.name as photo_name,
          p.taken_at
        FROM photo_faces pf
        JOIN photos p ON pf.photo_id = p.id
        WHERE pf.person_cluster_id IS NULL
        ORDER BY p.taken_at DESC NULLS LAST, pf.photo_id
        LIMIT $1 OFFSET $2
      `, [limit, offset]);

      const countResult = await client.query(
        'SELECT COUNT(*) as count FROM photo_faces WHERE person_cluster_id IS NULL'
      );

      res.json({
        faces: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching unclassified faces:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manually assign face to cluster
router.post('/faces/:faceId/cluster', async (req, res) => {
  try {
    const { clusterId } = req.body;

    if (!clusterId) {
      return res.status(400).json({ error: 'clusterId required' });
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query(
        `UPDATE photo_faces SET person_cluster_id = $1
         WHERE id = $2`,
        [clusterId, req.params.faceId]
      );

      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error assigning face to cluster:', err);
    res.status(500).json({ error: err.message });
  }
});

// Remove face from cluster
router.delete('/clusters/:clusterId/faces/:faceId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE photo_faces SET person_cluster_id = NULL WHERE id = $1 AND person_cluster_id = $2`,
        [req.params.faceId, req.params.clusterId]
      );
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error removing face from cluster:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rename cluster
router.put('/clusters/:clusterId/name', async (req, res) => {
  try {
    const { name } = req.body;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO person_clusters (id, name, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET name = $2, updated_at = CURRENT_TIMESTAMP`,
        [req.params.clusterId, name]
      );
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error renaming cluster:', err);
    res.status(500).json({ error: err.message });
  }
});

// Merge cluster into another
router.post('/clusters/:clusterId/merge/:targetId', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE photo_faces SET person_cluster_id = $1 WHERE person_cluster_id = $2`,
        [req.params.targetId, req.params.clusterId]
      );
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error merging clusters:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get stats
router.get('/stats/summary', async (req, res) => {
  try {
    const pool = getPool();
    const client = await pool.connect();

    try {
      const stats = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM photos) as total_photos,
          (SELECT COUNT(*) FROM photo_faces) as total_faces,
          (SELECT COUNT(DISTINCT person_cluster_id) FROM photo_faces WHERE person_cluster_id IS NOT NULL) as clusters,
          (SELECT COUNT(*) FROM photo_faces WHERE person_cluster_id IS NULL) as unclassified_faces,
          (SELECT AVG(age) FROM photo_faces WHERE age IS NOT NULL)::INT as avg_age
      `);

      res.json(stats.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Identify faces in an uploaded image
router.post('/identify', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err);
      return res.status(400).json({ error: 'Upload error: ' + err.message });
    }
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
      // Convert HEIC to JPEG via Python/pillow-heif
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
        imageBuffer = await sharp(req.file.buffer).jpeg().toBuffer();
      } catch (e) {
        imageBuffer = req.file.buffer;
      }
    }
    const model = ['hog', 'cnn', 'mediapipe', 'mtcnn'].includes(req.body?.model) ? req.body.model : 'hog';
    const detectedFaces = await detectFacesInImage(imageBuffer, '.jpg', model);

    // Convert to JPEG for browser display
    let previewBase64;
    try {
      const jpegBuf = await sharp(imageBuffer).jpeg({ quality: 85 }).toBuffer();
      previewBase64 = jpegBuf.toString('base64');
    } catch (e) {
      previewBase64 = null;
    }

    if (detectedFaces.length === 0) return res.json({ faces: [], preview: previewBase64 });

    const pool = getPool();
    const client = await pool.connect();
    try {
      const dbFaces = await client.query(
        `SELECT pf.id, pf.descriptor, pf.person_cluster_id, pc.name as cluster_name
         FROM photo_faces pf
         LEFT JOIN person_clusters pc ON pc.id = pf.person_cluster_id
         WHERE pf.descriptor IS NOT NULL AND pf.person_cluster_id IS NOT NULL`
      );

      const threshold = 0.6;
      const results = detectedFaces.map(face => {
        const detDesc = Buffer.from(new Float32Array(face.descriptor).buffer);
        let minDist = Infinity;
        let bestClusterId = null;
        let bestClusterName = null;

        for (const row of dbFaces.rows) {
          const dist = faceDistance(detDesc, row.descriptor);
          if (dist < minDist) {
            minDist = dist;
            bestClusterId = row.person_cluster_id;
            bestClusterName = row.cluster_name;
          }
        }

        return {
          box: face.box,
          clusterId: minDist < threshold ? bestClusterId : null,
          clusterName: minDist < threshold ? (bestClusterName || bestClusterId?.substring(0, 6)) : null,
          distance: Math.round(minDist * 1000) / 1000
        };
      });

      res.json({ faces: results, preview: previewBase64 });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Identify error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
