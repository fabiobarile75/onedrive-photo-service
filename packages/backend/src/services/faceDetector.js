const { getPool } = require('../db/init');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PYTHON_DAEMON = path.join(__dirname, 'detect_faces_daemon.py');

let daemonProc = null;
let daemonReady = false;
let pendingRequests = new Map(); // reqId -> { resolve, reject, buffer }
let reqIdCounter = 0;
let rl = null;

function startDaemon() {
  daemonProc = spawn('python3', [PYTHON_DAEMON]);
  daemonReady = false;

  rl = readline.createInterface({ input: daemonProc.stdout });

  rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    try {
      const msg = JSON.parse(line);
      if (msg.status === 'ready') {
        daemonReady = true;
        for (const [id, req] of pendingRequests) {
          if (!req.sent) sendRequest(id, req);
        }
        return;
      }
      // Find the oldest pending request and resolve it
      const firstKey = pendingRequests.keys().next().value;
      if (firstKey !== undefined) {
        const req = pendingRequests.get(firstKey);
        pendingRequests.delete(firstKey);
        try { fs.unlinkSync(req.tmpFile); } catch {}
        if (msg.error) {
          console.error('Python face detection error:', msg.error);
          req.resolve([]);
        } else {
          req.resolve(msg.faces || []);
        }
      }
    } catch (e) {
      console.error('Failed to parse daemon output:', line.substring(0, 100));
    }
  });

  daemonProc.on('error', (err) => {
    console.error('Daemon error:', err.message);
    daemonProc = null;
    daemonReady = false;
  });

  daemonProc.on('close', (code) => {
    console.log('Daemon exited with code', code, '— restarting...');
    daemonProc = null;
    daemonReady = false;
    // Reject all pending
    for (const [id, req] of pendingRequests) {
      try { fs.unlinkSync(req.tmpFile); } catch {}
      req.resolve([]);
    }
    pendingRequests.clear();
    setTimeout(startDaemon, 1000);
  });
}

function sendRequest(id, req) {
  req.sent = true;
  const msg = JSON.stringify({ image_path: req.tmpFile, model: req.model }) + '\n';
  daemonProc.stdin.write(msg);
}

function ensureDaemon() {
  if (!daemonProc) startDaemon();
}

async function detectFacesInImage(imageBuffer, ext = '.jpg', model = 'hog') {
  ensureDaemon();
  const tmpFile = path.join(os.tmpdir(), `face_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmpFile, imageBuffer);

  return new Promise((resolve) => {
    const id = reqIdCounter++;
    const req = { resolve, tmpFile, model, sent: false };
    pendingRequests.set(id, req);
    if (daemonReady) sendRequest(id, req);
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        try { fs.unlinkSync(tmpFile); } catch {}
        console.error('Face detection timeout');
        resolve([]);
      }
    }, 120000);
  });
}

// Start daemon eagerly at module load
startDaemon();

// Kill daemon on process exit
function killDaemon() {
  if (daemonProc) {
    daemonProc.kill();
    daemonProc = null;
  }
}
process.on('exit', killDaemon);
process.on('SIGINT', () => { killDaemon(); process.exit(0); });
process.on('SIGTERM', () => { killDaemon(); process.exit(0); });

async function extractFaceThumbnail(imageBuffer, box, size = 256) {
  const sharp = require('sharp');

  try {
    const metadata = await sharp(imageBuffer).metadata();
    const imgW = metadata.width;
    const imgH = metadata.height;

    const padding = 0.15;
    // box coords are percentages (0-1)
    const bx = box.x * imgW;
    const by = box.y * imgH;
    const bw = box.width * imgW;
    const bh = box.height * imgH;

    const x = Math.max(0, Math.floor(bx - bw * padding));
    const y = Math.max(0, Math.floor(by - bh * padding));
    const width = Math.min(imgW - x, Math.ceil(bw * (1 + 2 * padding)));
    const height = Math.min(imgH - y, Math.ceil(bh * (1 + 2 * padding)));

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
