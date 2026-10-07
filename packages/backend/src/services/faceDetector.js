const { getPool } = require('../db/init');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PYTHON_SCRIPT = path.join(__dirname, 'detect_faces.py');

async function detectFacesInImage(imageBuffer, ext = '.jpg', model = 'hog') {
  const tmpFile = path.join(os.tmpdir(), `face_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);

  try {
    fs.writeFileSync(tmpFile, imageBuffer);

    return await new Promise((resolve, reject) => {
      const proc = spawn('python3', [PYTHON_SCRIPT, tmpFile, model]);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);

      proc.on('close', code => {
        try {
          // Extract the JSON line (ignore any warnings/noise before it)
          const jsonLine = stdout.split('\n').find(line => line.trim().startsWith('{'));
          if (!jsonLine) {
            console.error('No JSON found in Python output:', stdout.substring(0, 200));
            resolve([]);
            return;
          }
          const result = JSON.parse(jsonLine);
          if (result.error) {
            console.error('Python face detection error:', result.error);
            resolve([]);
          } else {
            resolve(result.faces || []);
          }
        } catch (e) {
          console.error('Failed to parse Python output:', stdout.substring(0, 200));
          resolve([]);
        }
      });

      proc.on('error', err => {
        console.error('Failed to spawn python3:', err.message);
        resolve([]);
      });
    });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function extractFaceThumbnail(imageBuffer, box, size = 256) {
  const sharp = require('sharp');

  try {
    const padding = 0.15;
    const x = Math.max(0, Math.floor(box.x - box.width * padding));
    const y = Math.max(0, Math.floor(box.y - box.height * padding));
    const width = Math.ceil(box.width * (1 + 2 * padding));
    const height = Math.ceil(box.height * (1 + 2 * padding));

    const thumbnail = await sharp(imageBuffer)
      .extract({ left: x, top: y, width, height })
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();

    return thumbnail;
  } catch (err) {
    console.error('Thumbnail extraction error:', err);
    return null;
  }
}

async function saveFaceToDb(photoId, faceIndex, detection, thumbnailBuffer) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const box = detection.box;
    const descriptor = Buffer.from(new Float32Array(detection.descriptor).buffer);

    await client.query(
      `INSERT INTO photo_faces
       (photo_id, face_index, bounding_box, descriptor, age, gender, expressions, thumbnail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        photoId,
        faceIndex,
        JSON.stringify(box),
        descriptor,
        detection.age || null,
        detection.emotion || null,
        JSON.stringify(detection.emotions || {}),
        thumbnailBuffer
      ]
    );
  } finally {
    client.release();
  }
}

function faceDistance(desc1, desc2) {
  let sum = 0;
  const view1 = new Float32Array(desc1.buffer, desc1.byteOffset, desc1.byteLength / 4);
  const view2 = new Float32Array(desc2.buffer, desc2.byteOffset, desc2.byteLength / 4);

  for (let i = 0; i < view1.length; i++) {
    sum += Math.pow(view1[i] - view2[i], 2);
  }

  return Math.sqrt(sum);
}

async function clusterFacesByPerson(threshold = 0.5) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    // Reset existing clusters
    await client.query(`UPDATE photo_faces SET person_cluster_id = NULL`);
    console.log('Fetching all faces for clustering...');
    const allFaces = await client.query(
      `SELECT id, photo_id, descriptor FROM photo_faces
       WHERE descriptor IS NOT NULL
       ORDER BY photo_id, face_index`
    );

    const faces = allFaces.rows.map(row => ({
      id: row.id,
      photoId: row.photo_id,
      descriptor: row.descriptor
    }));

    console.log(`Clustering ${faces.length} faces with threshold ${threshold}...`);

    const clusters = [];

    for (let i = 0; i < faces.length; i++) {
      const face = faces[i];
      let assigned = false;

      for (const cluster of clusters) {
        const distances = cluster.faces.map(f =>
          faceDistance(face.descriptor, f.descriptor)
        );
        const avgDistance = distances.reduce((a, b) => a + b) / distances.length;

        if (avgDistance < threshold) {
          cluster.faces.push(face);
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        clusters.push({
          id: Math.random().toString(36).substr(2, 9),
          faces: [face]
        });
      }

      if ((i + 1) % 100 === 0) {
        console.log(`Processed ${i + 1}/${faces.length} faces...`);
      }
    }

    console.log(`Created ${clusters.length} clusters`);

    for (const cluster of clusters) {
      for (const face of cluster.faces) {
        await client.query(
          `UPDATE photo_faces SET person_cluster_id = $1 WHERE id = $2`,
          [cluster.id, face.id]
        );
      }
    }

    return clusters;
  } finally {
    client.release();
  }
}

module.exports = {
  detectFacesInImage,
  extractFaceThumbnail,
  saveFaceToDb,
  faceDistance,
  clusterFacesByPerson
};
