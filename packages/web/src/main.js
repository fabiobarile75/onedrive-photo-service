const API_BASE = 'http://localhost:8000/api';

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const startBtn = document.getElementById('start-btn');
const faceDetectBtn = document.getElementById('face-detect-btn');
const statusText = document.getElementById('status-text');
const statusDiv = document.getElementById('indexing-status');
const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const progressPages = document.getElementById('progress-pages');
const progressStatus = document.getElementById('progress-status');
const errorSection = document.getElementById('error-section');
const errorText = document.getElementById('error-text');
const photosGrid = document.getElementById('photos-grid');
const clustersContainer = document.getElementById('clusters-container');
const clusterModal = document.getElementById('cluster-modal');
const modalClose = document.querySelector('.modal-close');
const authStatusBtn = document.getElementById('auth-status-btn');
const refreshTokenBtn = document.getElementById('refresh-token-btn');
const distanceSlider = document.getElementById('distance-slider');
const distanceValue = document.getElementById('distance-value');
const testImageInput = document.getElementById('test-image-input');
const testImageBtn = document.getElementById('test-image-btn');
const testImageCanvas = document.getElementById('test-image-canvas');
const testImageResult = document.getElementById('test-image-result');

distanceSlider.addEventListener('input', () => {
  distanceValue.textContent = distanceSlider.value;
});

testImageBtn.addEventListener('click', testImageIdentify);

async function testImageIdentify() {
  const file = testImageInput.files[0];
  if (!file) { alert('Please select an image first.'); return; }

  testImageBtn.disabled = true;
  testImageBtn.textContent = '⏳ Analyzing...';

  try {
    const model = document.getElementById('test-model-select').value;
    const formData = new FormData();
    formData.append('image', file);
    formData.append('model', model);

    const res = await fetch(`${API_BASE}/faces/identify`, { method: 'POST', body: formData });
    const data = await res.json();

    // Draw image on canvas
    const img = new Image();
    img.onload = () => {
      const maxW = 800;
      const scale = img.width > maxW ? maxW / img.width : 1;
      testImageCanvas.width = img.width * scale;
      testImageCanvas.height = img.height * scale;

      const ctx = testImageCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0, testImageCanvas.width, testImageCanvas.height);

      const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];

      (data.faces || []).forEach((face, i) => {
        const color = colors[i % colors.length];
        const x = face.box.x * scale;
        const y = face.box.y * scale;
        const w = face.box.width * scale;
        const h = face.box.height * scale;

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);

        const label = face.clusterName || 'Unknown';
        ctx.font = 'bold 14px sans-serif';
        const textW = ctx.measureText(label).width + 8;
        const textH = 20;

        ctx.fillStyle = color;
        ctx.fillRect(x, y - textH, textW, textH);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + 4, y - 5);
      });

      testImageResult.style.display = 'block';
    };
    // Use base64 preview from backend (supports HEIC and other formats)
    if (data.preview) {
      img.src = 'data:image/jpeg;base64,' + data.preview;
    } else {
      img.src = URL.createObjectURL(file);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    testImageBtn.disabled = false;
    testImageBtn.textContent = '🔍 Identify Faces';
  }
}

let pollingInterval;
let facePollingInterval;

// Authentication controls
authStatusBtn.addEventListener('click', checkAuthStatus);
refreshTokenBtn.addEventListener('click', refreshToken);

async function checkAuthStatus() {
  try {
    authStatusBtn.disabled = true;
    const res = await fetch(`${API_BASE}/auth/status`);
    const data = await res.json();

    if (res.ok) {
      showNotification('✓ OAuth token is valid', 'success');
    } else {
      showNotification('⚠ OAuth token invalid or expired', 'error');
    }
  } catch (err) {
    showNotification('✗ Failed to check auth status', 'error');
  } finally {
    authStatusBtn.disabled = false;
  }
}

async function refreshToken() {
  try {
    refreshTokenBtn.disabled = true;
    refreshTokenBtn.textContent = '⏳ Refreshing...';

    const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST' });
    const data = await res.json();

    if (res.ok) {
      showNotification('✓ Token refreshed successfully', 'success');
    } else {
      showNotification(`✗ Token refresh failed: ${data.details || data.error}`, 'error');
    }
  } catch (err) {
    showNotification(`✗ Error: ${err.message}`, 'error');
  } finally {
    refreshTokenBtn.disabled = false;
    refreshTokenBtn.textContent = '🔄 Refresh Token';
  }
}

function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Tab switching
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;

    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(tabName).classList.add('active');

    // Load data when switching tabs
    if (tabName === 'clusters') loadClusters();
    if (tabName === 'gallery') loadPhotos();
    if (tabName === 'stats') loadStats();
  });
});

// Indexing controls
startBtn.addEventListener('click', startIndexing);
faceDetectBtn.addEventListener('click', startFaceDetectionJob);
modalClose?.addEventListener('click', closeClustersModal);

async function startFaceDetectionJob() {
  try {
    faceDetectBtn.disabled = true;
    document.getElementById('face-error-section').classList.add('hidden');

    const distance = parseFloat(distanceSlider.value);
    const detectionModel = document.getElementById('detection-model-select').value;
    const limit = parseInt(document.getElementById('face-limit-input').value) || 100;
    const concurrency = parseInt(document.getElementById('face-concurrency-input').value) || 5;
    const res = await fetch(`${API_BASE}/indexing/faces/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distance, model: detectionModel, limit, concurrency })
    });
    const data = await res.json();

    if (!res.ok) {
      document.getElementById('face-error-text').textContent = data.error;
      document.getElementById('face-error-section').classList.remove('hidden');
      faceDetectBtn.disabled = false;
      return;
    }

    document.getElementById('face-indexing-status').className = 'status indexing';
    document.getElementById('face-status-text').textContent = 'Detecting faces...';
    document.getElementById('face-progress-section').classList.remove('hidden');
    document.getElementById('face-progress-status').textContent = 'Starting face detection...';

    facePollingInterval = setInterval(pollFaceDetectionState, 2000);
  } catch (err) {
    document.getElementById('face-error-text').textContent = err.message;
    document.getElementById('face-error-section').classList.remove('hidden');
    faceDetectBtn.disabled = false;
  }
}

async function pollFaceDetectionState() {
  try {
    const res = await fetch(`${API_BASE}/indexing/state`);
    const state = await res.json();

    if (state.status === 'completed') {
      document.getElementById('face-indexing-status').className = 'status completed';
      document.getElementById('face-status-text').textContent = 'Detection completed!';
      document.getElementById('face-progress-status').textContent = 'Face detection completed successfully!';
      document.getElementById('face-progress-fill').style.width = '100%';
      clearInterval(facePollingInterval);
      faceDetectBtn.disabled = false;
      setTimeout(() => {
        document.getElementById('face-progress-section').classList.add('hidden');
        loadClusters();
      }, 2000);
    } else if (state.status === 'error') {
      document.getElementById('face-indexing-status').className = 'status error';
      document.getElementById('face-status-text').textContent = 'Error';
      document.getElementById('face-error-text').textContent = state.error;
      document.getElementById('face-error-section').classList.remove('hidden');
      clearInterval(facePollingInterval);
      faceDetectBtn.disabled = false;
    } else if (state.status === 'clustering') {
      document.getElementById('face-progress-status').textContent = 'Clustering faces...';
      document.getElementById('face-progress-fill').style.width = '100%';
    } else if (state.status === 'indexing') {
      const pct = state.total_items > 0 ? Math.round((state.processed_items / state.total_items) * 100) : 0;
      document.getElementById('face-progress-fill').style.width = pct + '%';
      document.getElementById('face-progress-text').textContent = `${state.processed_items} / ${state.total_items}`;
      document.getElementById('face-progress-status').textContent = 'Detecting faces...';
    }
  } catch (err) {
    console.error('Face poll error:', err);
  }
}

async function startIndexing() {
  try {
    startBtn.disabled = true;
    errorSection.classList.add('hidden');

    // Check auth first
    const authRes = await fetch(`${API_BASE}/auth/status`);
    if (!authRes.ok) {
      showError('OAuth token is invalid or expired. Please refresh token first.');
      startBtn.disabled = false;
      return;
    }

    const res = await fetch(`${API_BASE}/indexing/start`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      showError(data.error);
      startBtn.disabled = false;
      return;
    }

    updateStatus('indexing');
    progressSection.classList.remove('hidden');
    progressStatus.textContent = 'Starting indexing...';

    // Poll for updates
    pollingInterval = setInterval(pollIndexingState, 1000);
  } catch (err) {
    showError(err.message);
    startBtn.disabled = false;
  }
}

async function pollIndexingState() {
  try {
    const res = await fetch(`${API_BASE}/indexing/state`);
    const state = await res.json();

    if (state.status === 'completed') {
      updateStatus('completed');
      progressStatus.textContent = 'Completed successfully!';
      clearInterval(pollingInterval);
      startBtn.disabled = false;
      faceDetectBtn.disabled = false;
      setTimeout(() => {
        progressSection.classList.add('hidden');
        loadClusters();
        loadStats();
      }, 2000);
    } else if (state.status === 'error') {
      updateStatus('error');
      showError(state.error);
      clearInterval(pollingInterval);
      startBtn.disabled = false;
      faceDetectBtn.disabled = false;
    } else if (state.status === 'clustering') {
      updateStatus('indexing');
      progressStatus.textContent = 'Clustering faces by person...';
      progressFill.style.width = '100%';
      progressText.textContent = 'Processing clusters...';
    } else if (state.status === 'indexing') {
      const percentage = state.total_items > 0
        ? Math.round((state.processed_items / state.total_items) * 100)
        : 0;

      progressFill.style.width = percentage + '%';
      progressText.textContent = `${state.processed_items} / ${state.total_items} items`;
      progressPages.textContent = `Processed: ${state.processed_items}`;
      progressStatus.textContent = `Page ${state.current_page}...`;
    }
  } catch (err) {
    console.error('Poll error:', err);
    if (err.message.includes('401') || err.message.includes('token')) {
      showError('Session lost. Please refresh your token.');
      clearInterval(pollingInterval);
      updateStatus('error');
      startBtn.disabled = false;
    }
  }
}

function updateStatus(status) {
  statusDiv.className = `status ${status}`;
  const labels = {
    idle: 'Idle',
    indexing: 'Indexing in progress...',
    completed: 'Indexing completed!',
    error: 'Error during indexing'
  };
  statusText.textContent = labels[status] || status;
}

function showError(message) {
  errorSection.classList.remove('hidden');
  errorText.textContent = message;
}

async function loadClusters() {
  try {
    const res = await fetch(`${API_BASE}/faces/clusters`);
    const clusters = await res.json();

    if (clusters.length === 0) {
      clustersContainer.innerHTML = '<p class="empty">No clusters yet. Start indexing first.</p>';
      return;
    }

    clustersContainer.innerHTML = clusters.map(cluster => `
      <div class="cluster-card" onclick="openClusterDetail('${cluster.person_cluster_id}')">
        <div class="cluster-preview">
          ${cluster.thumbnail
            ? `<img src="data:image/jpeg;base64,${cluster.thumbnail}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">`
            : `<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);border-radius:8px;width:100%;height:100%;"></div>`
          }
        </div>
        <div class="cluster-info">
          <h3>${cluster.cluster_name || 'Person ' + cluster.person_cluster_id.substring(0, 6)}</h3>
          <div class="cluster-stats">
            <span>${cluster.photo_count} photos</span>
            <span>${cluster.face_count} faces</span>
          </div>
          ${cluster.avg_age ? `<p style="margin-top: 8px; font-size: 0.85em; color: #999;">~${cluster.avg_age} years old</p>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading clusters:', err);
    clustersContainer.innerHTML = '<p class="empty">Error loading clusters</p>';
  }
}

function emotionEmoji(emotion) {
  const map = { happy: '😊', sad: '😢', angry: '😠', fear: '😨', surprise: '😲', disgust: '🤢', neutral: '😐' };
  return map[emotion] || emotion || '';
}

async function openClusterDetail(clusterId) {
  try {
    const res = await fetch(`${API_BASE}/faces/clusters/${clusterId}`);
    const faces = await res.json();

    document.querySelector('#cluster-modal h2').innerHTML =
      `Cluster <span id="cluster-name-display">${clusterId.substring(0, 6)}</span>
       <button onclick="renameCluster('${clusterId}')" style="font-size:0.6em;margin-left:8px;" class="btn btn-sm btn-secondary">✏️ Rename</button>`;

    const clusterFacesDiv = document.getElementById('cluster-faces');
    clusterFacesDiv.innerHTML = faces.map(face => `
      <div class="face-thumbnail" title="${face.photo_name}\n${face.gender || ''}" style="position:relative;">
        <img src="data:image/jpeg;base64,${face.thumbnail}" alt="Face">
        <div class="face-info">
          ${face.age ? `${face.age}y` : ''}
          ${face.gender ? ` ${emotionEmoji(face.gender)}` : ''}
        </div>
        <div style="position:absolute;top:2px;right:2px;display:flex;gap:2px;">
          <button onclick="moveFaceToCluster('${clusterId}', ${face.id})" title="Move to another cluster"
            style="background:rgba(52,152,219,0.85);color:white;border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:11px;line-height:20px;padding:0;">↗</button>
          <button onclick="removeFaceFromCluster('${clusterId}', ${face.id})" title="Remove from cluster"
            style="background:rgba(0,0,0,0.6);color:white;border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:12px;line-height:20px;padding:0;">✕</button>
        </div>
      </div>
    `).join('');

    document.querySelector('.modal-actions').innerHTML = `
      <button class="btn btn-secondary" onclick="showMergeDialog('${clusterId}')">🔗 Merge with...</button>
      <button class="btn btn-secondary" onclick="closeClustersModal()">Close</button>
    `;

    clusterModal.classList.remove('hidden');
  } catch (err) {
    console.error('Error loading cluster detail:', err);
  }
}
window.openClusterDetail = openClusterDetail;

async function renameCluster(clusterId) {
  const name = prompt('Enter a name for this person:');
  if (!name) return;
  await fetch(`${API_BASE}/faces/clusters/${clusterId}/name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  document.getElementById('cluster-name-display').textContent = name;
  loadClusters();
}
window.renameCluster = renameCluster;

async function removeFaceFromCluster(clusterId, faceId) {
  if (!confirm('Remove this face from the cluster?')) return;
  await fetch(`${API_BASE}/faces/clusters/${clusterId}/faces/${faceId}`, { method: 'DELETE' });
  openClusterDetail(clusterId);
  loadClusters();
}
window.removeFaceFromCluster = removeFaceFromCluster;

async function moveFaceToCluster(fromClusterId, faceId) {
  const res = await fetch(`${API_BASE}/faces/clusters`);
  const clusters = await res.json();
  const others = clusters.filter(c => c.person_cluster_id !== fromClusterId);
  if (others.length === 0) { alert('No other clusters to move to.'); return; }

  const options = others.map((c, i) => `${i + 1}. ${c.cluster_name || c.person_cluster_id.substring(0, 6)} (${c.face_count} faces)`).join('\n');
  const input = prompt(`Move face to which cluster?\n${options}`);
  if (!input) return;
  const idx = parseInt(input) - 1;
  if (idx < 0 || idx >= others.length) { alert('Invalid selection'); return; }

  const targetId = others[idx].person_cluster_id;
  await fetch(`${API_BASE}/faces/${faceId}/cluster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clusterId: targetId })
  });
  openClusterDetail(fromClusterId);
  loadClusters();
}
window.moveFaceToCluster = moveFaceToCluster;

async function showMergeDialog(clusterId) {
  const res = await fetch(`${API_BASE}/faces/clusters`);
  const clusters = await res.json();
  const others = clusters.filter(c => c.person_cluster_id !== clusterId);
  if (others.length === 0) { alert('No other clusters to merge with.'); return; }

  const options = others.map((c, i) => `${i + 1}. ${c.cluster_name || c.person_cluster_id.substring(0, 6)} (${c.face_count} faces)`).join('\n');
  const input = prompt(`Merge into which cluster? Enter number:\n${options}`);
  if (!input) return;
  const idx = parseInt(input) - 1;
  if (idx < 0 || idx >= others.length) { alert('Invalid selection'); return; }

  await fetch(`${API_BASE}/faces/clusters/${clusterId}/merge/${others[idx].person_cluster_id}`, { method: 'POST' });
  closeClustersModal();
  loadClusters();
}
window.showMergeDialog = showMergeDialog;

function closeClustersModal() {
  clusterModal.classList.add('hidden');
}
window.closeClustersModal = closeClustersModal;

async function loadPhotos(clusterId = null) {
  try {
    let url, data;
    if (clusterId) {
      const res = await fetch(`${API_BASE}/photos/by-cluster/${clusterId}?limit=200`);
      data = await res.json();
    } else {
      const res = await fetch(`${API_BASE}/photos?limit=50`);
      data = await res.json();
    }

    if (!data.photos || data.photos.length === 0) {
      photosGrid.innerHTML = '<p class="empty">No photos found</p>';
      return;
    }

    photosGrid.innerHTML = data.photos.map(photo => `
      <div class="photo-item" title="${photo.name}">
        ${photo.face_thumbnail
          ? `<div style="position:relative;width:100%;height:80px;overflow:hidden;border-radius:6px;margin-bottom:4px;">
               <img src="data:image/jpeg;base64,${photo.face_thumbnail}" style="width:100%;height:100%;object-fit:cover;">
             </div>`
          : ''}
        <div class="photo-info">
          <strong>${photo.name.substring(0, 20)}...</strong>
          ${photo.taken_at ? `<div>${new Date(photo.taken_at).toLocaleDateString()}</div>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading photos:', err);
  }
}

let galleryFilterClusterId = null;

function clearGalleryFilter() {
  galleryFilterClusterId = null;
  document.getElementById('gallery-filter-label').style.display = 'none';
  document.getElementById('gallery-search').value = '';
  loadPhotos();
}
window.clearGalleryFilter = clearGalleryFilter;

// Gallery search autocomplete
const gallerySearch = document.getElementById('gallery-search');
const gallerySuggestions = document.getElementById('gallery-search-suggestions');

gallerySearch.addEventListener('input', async () => {
  const q = gallerySearch.value.trim().toLowerCase();
  if (!q) { gallerySuggestions.style.display = 'none'; return; }

  const res = await fetch(`${API_BASE}/faces/clusters`);
  const clusters = await res.json();
  const matches = clusters.filter(c => {
    const name = (c.cluster_name || 'Person ' + c.person_cluster_id.substring(0, 6)).toLowerCase();
    return name.includes(q);
  });

  if (matches.length === 0) { gallerySuggestions.style.display = 'none'; return; }

  gallerySuggestions.style.display = 'block';
  gallerySuggestions.innerHTML = matches.map(c => {
    const name = c.cluster_name || 'Person ' + c.person_cluster_id.substring(0, 6);
    return `<div onclick="selectGalleryCluster('${c.person_cluster_id}','${name.replace(/'/g, "\\'")}')"
      style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px;">
      ${c.thumbnail ? `<img src="data:image/jpeg;base64,${c.thumbnail}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">` : ''}
      <span>${name}</span>
      <span style="color:#888;font-size:0.85em;margin-left:auto;">${c.face_count} faces</span>
    </div>`;
  }).join('');
});

gallerySearch.addEventListener('blur', () => {
  setTimeout(() => { gallerySuggestions.style.display = 'none'; }, 200);
});

function selectGalleryCluster(clusterId, name) {
  galleryFilterClusterId = clusterId;
  gallerySearch.value = name;
  gallerySuggestions.style.display = 'none';
  document.getElementById('gallery-filter-label').style.display = 'block';
  document.getElementById('gallery-filter-name').textContent = name;
  loadPhotos(clusterId);
}
window.selectGalleryCluster = selectGalleryCluster;

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/faces/stats/summary`);
    const stats = await res.json();

    document.getElementById('stat-photos').textContent = stats.total_photos || 0;
    document.getElementById('stat-faces').textContent = stats.total_faces || 0;
    document.getElementById('stat-clusters').textContent = stats.clusters || 0;
    document.getElementById('stat-unclassified').textContent = stats.unclassified_faces || 0;
    document.getElementById('stat-avg-age').textContent = stats.avg_age ? `${stats.avg_age}y` : '-';
  } catch (err) {
    console.error('Error loading stats:', err);
  }
}

// Initial load
checkAuthStatus();
loadStats();
pollIndexingState();
