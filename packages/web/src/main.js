const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const AUTH_URL = import.meta.env.VITE_AUTH_URL || 'https://ai-assistant.freeddns.org/auth';

// Auth token management
function getAuthToken() {
  return localStorage.getItem('ai_core_token');
}

function checkAuth() {
  const token = getAuthToken();
  if (!token) {
    const redirect = encodeURIComponent(window.location.href);
    window.location.href = `${AUTH_URL}?redirect=${redirect}`;
    return false;
  }
  return true;
}

async function apiFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Don't set Content-Type for FormData (let browser set boundary)
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem('ai_core_token');
    const redirect = encodeURIComponent(window.location.href);
    window.location.href = `${AUTH_URL}?redirect=${redirect}`;
    return null;
  }
  return res;
}

if (!checkAuth()) {
  throw new Error('Redirecting to login');
}

// DOM Elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const startBtn = document.getElementById('start-btn');
const faceDetectBtn = document.getElementById('face-detect-btn');
const faceResumeBtn = document.getElementById('face-resume-btn');
const faceStopBtn = document.getElementById('face-stop-btn');
const confirmModal = document.getElementById('confirm-modal');
const confirmModalTitle = document.getElementById('confirm-modal-title');
const confirmModalMessage = document.getElementById('confirm-modal-message');
const confirmModalBtn = document.getElementById('confirm-modal-btn');
let confirmCallback = null;
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

// Confirmation Modal functions
function showConfirmModal(title, message, onConfirm, btnClass = 'btn-primary') {
  confirmModalTitle.textContent = title;
  confirmModalMessage.textContent = message;
  confirmModalBtn.className = `btn ${btnClass}`;
  confirmCallback = onConfirm;
  confirmModal.classList.remove('hidden');
}

function closeConfirmModal() {
  confirmModal.classList.add('hidden');
  confirmCallback = null;
}

confirmModalBtn.addEventListener('click', () => {
  if (confirmCallback) {
    confirmCallback();
  }
  closeConfirmModal();
});

// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('auth_token');
  window.location.href = AUTH_URL;
});

// OneDrive connect banner
async function checkOneDriveStatus() {
  try {
    const res = await apiFetch(`${API_BASE}/auth/onedrive/status`);
    if (!res) return;
    const data = await res.json();
    const banner = document.getElementById('onedrive-status-banner');
    if (!data.connected) {
      banner.style.display = 'flex';
      document.getElementById('onedrive-connect-btn').href = `${API_BASE}/auth/onedrive/connect`;
    } else {
      banner.style.display = 'none';
    }
  } catch (err) {
    console.error('OneDrive status check failed:', err);
  }
}
const distanceSlider = document.getElementById('distance-slider');
const distanceValue = document.getElementById('distance-value');
const testImageInput = document.getElementById('test-image-input');
const testImageBtn = document.getElementById('test-image-btn');
const testImageCanvas = document.getElementById('test-image-canvas');
const testImageResult = document.getElementById('test-image-result');

distanceSlider.addEventListener('input', () => {
  distanceValue.textContent = distanceSlider.value;
});

const identifyThresholdSlider = document.getElementById('identify-threshold-slider');
const identifyThresholdValue = document.getElementById('identify-threshold-value');
identifyThresholdSlider.addEventListener('input', () => {
  identifyThresholdValue.textContent = identifyThresholdSlider.value;
});

testImageBtn.addEventListener('click', testImageIdentify);

async function testImageIdentify() {
  const file = testImageInput.files[0];
  if (!file) { alert('Please select an image first.'); return; }

  testImageBtn.disabled = true;
  testImageBtn.textContent = '⏳ Analyzing...';

  try {
    const model = document.getElementById('test-model-select').value;
    const threshold = parseFloat(identifyThresholdSlider.value);
    const formData = new FormData();
    formData.append('image', file);
    formData.append('model', model);
    formData.append('threshold', threshold);

    const res = await apiFetch(`${API_BASE}/faces/identify`, { method: 'POST', body: formData });
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
        // box coords are percentages (0-1)
        const x = face.box.x * testImageCanvas.width;
        const y = face.box.y * testImageCanvas.height;
        const w = face.box.width * testImageCanvas.width;
        const h = face.box.height * testImageCanvas.height;

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
startBtn.addEventListener('click', () => {
  showConfirmModal(
    'Démarrer l\'indexation',
    'Voulez-vous vraiment démarrer l\'indexation des photos ? Cela va télécharger les métadonnées de toutes vos photos depuis OneDrive.',
    startIndexing,
    'btn-primary'
  );
});

faceDetectBtn.addEventListener('click', () => {
  showConfirmModal(
    'Détecter les visages',
    'Voulez-vous vraiment lancer la détection de visages ? Cela va traiter les photos et peut prendre du temps. Les faces déjà détectées seront supprimées.',
    startFaceDetectionJob,
    'btn-primary'
  );
});

faceResumeBtn.addEventListener('click', () => {
  showConfirmModal(
    'Reprendre la détection',
    'Voulez-vous vraiment reprendre la détection de visages ? Cela va continuer le traitement des photos non traitées et en erreur, sans refaire celles déjà traitées.',
    resumeFaceDetection,
    'btn-warning'
  );
});

faceStopBtn.addEventListener('click', () => {
  showConfirmModal(
    'Arrêter la détection',
    'Voulez-vous vraiment arrêter la détection de visages en cours ? Le processus sera interrompu et vous pourrez le reprendre plus tard.',
    stopFaceDetection,
    'btn-danger'
  );
});

modalClose?.addEventListener('click', closeClustersModal);

async function startFaceDetectionJob() {
  try {
    faceDetectBtn.disabled = true;
  document.getElementById('face-error-section').classList.add('hidden');
  document.getElementById('face-reprise-status').textContent = '';

  const distance = parseFloat(distanceSlider.value);
    const detectionModel = document.getElementById('detection-model-select').value;
    const limit = parseInt(document.getElementById('face-limit-input').value) || 100;
    const concurrency = parseInt(document.getElementById('face-concurrency-input').value) || 5;
    const res = await apiFetch(`${API_BASE}/indexing/faces/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distance, model: detectionModel, limit, concurrency, autoRetry: true })
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
    metricsPollingInterval = setInterval(pollMetrics, 2000);
  } catch (err) {
    document.getElementById('face-error-text').textContent = err.message;
    document.getElementById('face-error-section').classList.remove('hidden');
    faceDetectBtn.disabled = false;
  }
}

async function pollFaceDetectionState() {
  try {
    const res = await apiFetch(`${API_BASE}/indexing/faces/state`);
    const state = await res.json();

    // Afficher le nombre d'erreurs 429
    const error429Count = state.error_429_count || 0;
    const errorInfo = document.getElementById('face-429-info');
    if (error429Count > 0) {
      errorInfo.style.display = 'block';
      document.getElementById('face-429-count').textContent = error429Count;
    } else {
      errorInfo.style.display = 'none';
    }

    if (state.status === 'completed') {
      document.getElementById('face-indexing-status').className = 'status completed';
      document.getElementById('face-progress-status').textContent = 'Face detection completed successfully!';
      document.getElementById('face-progress-fill').style.width = '100%';
      clearInterval(facePollingInterval);
      clearInterval(metricsPollingInterval);
      faceDetectBtn.disabled = false;
      faceResumeBtn.disabled = false;
      faceStopBtn.style.display = 'none';
      setTimeout(() => {
        document.getElementById('face-progress-section').classList.add('hidden');
        loadClusters();
      }, 2000);
    } else if (state.status === 'stopped') {
      document.getElementById('face-indexing-status').className = 'status idle';
      document.getElementById('face-status-text').textContent = 'Arrêté';
      document.getElementById('face-progress-section').classList.add('hidden');
      document.getElementById('face-reprise-status').textContent = '⏹️ Détection arrêtée par l\'utilisateur';
      document.getElementById('face-reprise-status').style.color = '#ff6b6b';
      clearInterval(facePollingInterval);
      clearInterval(metricsPollingInterval);
      faceDetectBtn.disabled = false;
      faceResumeBtn.disabled = false;
      faceStopBtn.style.display = 'none';
    } else if (state.status === 'waiting_retry') {
      // En attente de reprise automatique après erreur 429
      document.getElementById('face-indexing-status').className = 'status indexing';
      document.getElementById('face-status-text').textContent = 'En attente (rate limit)';
      document.getElementById('face-progress-section').classList.remove('hidden');
      
      // Afficher le compte à rebours
      const countdownContainer = document.getElementById('face-retry-countdown-container');
      countdownContainer.style.display = 'inline';
      
      if (state.next_retry_at) {
        const retryTime = new Date(state.next_retry_at).getTime();
        const now = Date.now();
        const secondsLeft = Math.max(0, Math.ceil((retryTime - now) / 1000));
        document.getElementById('face-retry-countdown').textContent = secondsLeft;
        document.getElementById('face-progress-status').textContent = `Rate limit atteint — reprise automatique dans ${secondsLeft}s...`;
      } else {
        document.getElementById('face-progress-status').textContent = 'Rate limit atteint — en attente de reprise...';
      }
      
      // Afficher la progression actuelle
      const pct = state.total_items > 0 ? Math.round((state.processed_items / state.total_items) * 100) : 0;
      document.getElementById('face-progress-fill').style.width = pct + '%';
      document.getElementById('face-progress-text').textContent = `${state.processed_items} / ${state.total_items}`;
      
      faceDetectBtn.disabled = true;
      faceResumeBtn.disabled = true;
      faceStopBtn.style.display = 'inline-block';
      
      // Polling plus fréquent pour le compte à rebours
      if (!facePollingInterval) facePollingInterval = setInterval(pollFaceDetectionState, 1000);
    } else if (state.status === 'error') {
      document.getElementById('face-indexing-status').className = 'status error';
      document.getElementById('face-status-text').textContent = 'Error';
      document.getElementById('face-error-text').textContent = state.error;
      document.getElementById('face-error-section').classList.remove('hidden');
      clearInterval(facePollingInterval);
      clearInterval(metricsPollingInterval);
      faceDetectBtn.disabled = false;
      faceResumeBtn.disabled = false;
      faceStopBtn.style.display = 'none';
    } else if (state.status === 'clustering') {
      document.getElementById('face-indexing-status').className = 'status indexing';
      document.getElementById('face-status-text').textContent = 'Clustering faces...';
      document.getElementById('face-progress-section').classList.remove('hidden');
      document.getElementById('face-progress-status').textContent = 'Clustering faces...';
      document.getElementById('face-progress-fill').style.width = '100%';
      faceDetectBtn.disabled = true;
      faceResumeBtn.disabled = true;
      faceStopBtn.style.display = 'inline-block';
      if (!facePollingInterval) facePollingInterval = setInterval(pollFaceDetectionState, 2000);
    } else if (state.status === 'indexing') {
      const pct = state.total_items > 0 ? Math.round((state.processed_items / state.total_items) * 100) : 0;
      document.getElementById('face-indexing-status').className = 'status indexing';
      document.getElementById('face-status-text').textContent = 'Detecting faces...';
      document.getElementById('face-progress-section').classList.remove('hidden');
      document.getElementById('face-progress-fill').style.width = pct + '%';
      document.getElementById('face-progress-text').textContent = `${state.processed_items} / ${state.total_items}`;
      document.getElementById('face-progress-status').textContent = 'Detecting faces...';
      faceDetectBtn.disabled = true;
      faceResumeBtn.disabled = true;
      faceStopBtn.style.display = 'inline-block';
      // Masquer le compte à rebours si on est en indexing normal
      document.getElementById('face-retry-countdown-container').style.display = 'none';
      if (!facePollingInterval) facePollingInterval = setInterval(pollFaceDetectionState, 2000);
      if (!metricsPollingInterval) metricsPollingInterval = setInterval(pollMetrics, 2000);
    }
  } catch (err) {
    console.error('Face poll error:', err);
  }
}

async function resumeFaceDetection() {
  try {
    faceResumeBtn.disabled = true;
    document.getElementById('face-reprise-status').textContent = 'Resuming face detection from where it stopped...';
    document.getElementById('face-reprise-status').style.color = '#ffcc00';
    
    const res = await apiFetch(`${API_BASE}/indexing/faces/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        distance: parseFloat(distanceSlider.value),
        model: document.getElementById('detection-model-select').value,
        limit: parseInt(document.getElementById('face-limit-input').value) || 100,
        concurrency: parseInt(document.getElementById('face-concurrency-input').value) || 5,
        autoRetry: true
      })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      document.getElementById('face-reprise-status').textContent = `Error: ${data.error}`;
      document.getElementById('face-reprise-status').style.color = '#ff4444';
      faceResumeBtn.disabled = false;
      return;
    }
    
    document.getElementById('face-reprise-status').textContent = '✅ Face detection resumed successfully! Continuing from where it stopped.';
    document.getElementById('face-reprise-status').style.color = '#4aff8c';
    
    // Démarrer le polling pour suivre la progression
    document.getElementById('face-indexing-status').className = 'status indexing';
    document.getElementById('face-status-text').textContent = 'Detecting faces...';
    document.getElementById('face-progress-section').classList.remove('hidden');
    document.getElementById('face-progress-status').textContent = 'Resuming face detection...';
    
    facePollingInterval = setInterval(pollFaceDetectionState, 2000);
    metricsPollingInterval = setInterval(pollMetrics, 2000);
    
  } catch (err) {
    document.getElementById('face-reprise-status').textContent = `Error: ${err.message}`;
    document.getElementById('face-reprise-status').style.color = '#ff4444';
    faceResumeBtn.disabled = false;
  } finally {
    setTimeout(() => {
      faceResumeBtn.disabled = false;
    }, 5000);
  }
}

async function stopFaceDetection() {
  try {
    faceStopBtn.disabled = true;
    document.getElementById('face-reprise-status').textContent = 'Stopping face detection...';
    document.getElementById('face-reprise-status').style.color = '#ff6b6b';
    
    const res = await apiFetch(`${API_BASE}/indexing/faces/stop`, {
      method: 'POST'
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      document.getElementById('face-reprise-status').textContent = `Error: ${data.error}`;
      document.getElementById('face-reprise-status').style.color = '#ff4444';
      faceStopBtn.disabled = false;
      return;
    }
    
    document.getElementById('face-reprise-status').textContent = '⏹️ Face detection stopped';
    document.getElementById('face-reprise-status').style.color = '#ff6b6b';
    
  } catch (err) {
    document.getElementById('face-reprise-status').textContent = `Error: ${err.message}`;
    document.getElementById('face-reprise-status').style.color = '#ff4444';
    faceStopBtn.disabled = false;
  }
}

async function startIndexing() {
  try {
    startBtn.disabled = true;
    errorSection.classList.add('hidden');

    // Check OneDrive connection
    const authRes = await apiFetch(`${API_BASE}/auth/onedrive/status`);
    if (!authRes) return;
    const authData = await authRes.json();
    if (!authData.connected) {
      showError('OneDrive not connected. Please connect your OneDrive first.');
      startBtn.disabled = false;
      return;
    }

    const res = await apiFetch(`${API_BASE}/indexing/start`, { method: 'POST' });
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
    const res = await apiFetch(`${API_BASE}/indexing/state`);
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
      if (state.total_items > 0) {
        const percentage = Math.round((state.processed_items / state.total_items) * 100);
        progressFill.style.width = percentage + '%';
        progressFill.closest('.progress-bar').style.display = '';
        progressText.textContent = `${state.processed_items} / ${state.total_items} items (${percentage}%)`;
      } else {
        progressFill.closest('.progress-bar').style.display = 'none';
        progressText.textContent = `${state.processed_items} items indexed`;
      }
      progressPages.textContent = `Page ${state.current_page}`;
      progressStatus.textContent = 'Indexing in progress...';
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
    const res = await apiFetch(`${API_BASE}/faces/clusters`);
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
    const res = await apiFetch(`${API_BASE}/faces/clusters/${clusterId}`);
    const faces = await res.json();

    document.querySelector('#cluster-modal h2').innerHTML =
      `Cluster <span id="cluster-name-display">${clusterId.substring(0, 6)}</span>
       <button onclick="renameCluster('${clusterId}')" style="font-size:0.6em;margin-left:8px;" class="btn btn-sm btn-secondary">✏️ Rename</button>`;

    const clusterFacesDiv = document.getElementById('cluster-faces');
    clusterFacesDiv.innerHTML = faces.map(face => `
      <div class="face-thumbnail" title="${face.photo_name}\n${face.gender || ''}" style="position:relative;">
        ${face.thumbnail ? `<img src="data:image/jpeg;base64,${face.thumbnail}" alt="Face">` : `<div style="width:100%;height:100%;background:#333;display:flex;align-items:center;justify-content:center;color:#666;font-size:24px;">👤</div>`}
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
  await apiFetch(`${API_BASE}/faces/clusters/${clusterId}/name`, {
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
  await apiFetch(`${API_BASE}/faces/clusters/${clusterId}/faces/${faceId}`, { method: 'DELETE' });
  openClusterDetail(clusterId);
  loadClusters();
}
window.removeFaceFromCluster = removeFaceFromCluster;

async function moveFaceToCluster(fromClusterId, faceId) {
  const res = await apiFetch(`${API_BASE}/faces/clusters`);
  const clusters = await res.json();
  const others = clusters.filter(c => c.person_cluster_id !== fromClusterId);
  if (others.length === 0) { alert('No other clusters to move to.'); return; }

  const options = others.map((c, i) => `${i + 1}. ${c.cluster_name || c.person_cluster_id.substring(0, 6)} (${c.face_count} faces)`).join('\n');
  const input = prompt(`Move face to which cluster?\n${options}`);
  if (!input) return;
  const idx = parseInt(input) - 1;
  if (idx < 0 || idx >= others.length) { alert('Invalid selection'); return; }

  const targetId = others[idx].person_cluster_id;
  await apiFetch(`${API_BASE}/faces/${faceId}/cluster`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clusterId: targetId })
  });
  openClusterDetail(fromClusterId);
  loadClusters();
}
window.moveFaceToCluster = moveFaceToCluster;

async function showMergeDialog(clusterId) {
  const res = await apiFetch(`${API_BASE}/faces/clusters`);
  const clusters = await res.json();
  const others = clusters.filter(c => c.person_cluster_id !== clusterId);
  if (others.length === 0) { alert('No other clusters to merge with.'); return; }

  const options = others.map((c, i) => `${i + 1}. ${c.cluster_name || c.person_cluster_id.substring(0, 6)} (${c.face_count} faces)`).join('\n');
  const input = prompt(`Merge into which cluster? Enter number:\n${options}`);
  if (!input) return;
  const idx = parseInt(input) - 1;
  if (idx < 0 || idx >= others.length) { alert('Invalid selection'); return; }

  await apiFetch(`${API_BASE}/faces/clusters/${clusterId}/merge/${others[idx].person_cluster_id}`, { method: 'POST' });
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
      const res = await apiFetch(`${API_BASE}/photos/by-cluster/${clusterId}?limit=200`);
      data = await res.json();
    } else {
      const res = await apiFetch(`${API_BASE}/photos?limit=50`);
      data = await res.json();
    }

    if (!data.photos || data.photos.length === 0) {
      photosGrid.innerHTML = '<p class="empty">No photos found</p>';
      return;
    }

    photosGrid.innerHTML = data.photos.map(photo => `
      <div class="photo-item" title="${photo.name}" onclick="viewPhoto('${photo.id}', '${photo.name.replace(/'/g, "\\'")}')" style="cursor:pointer;">
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

  const res = await apiFetch(`${API_BASE}/faces/clusters`);
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
    const res = await apiFetch(`${API_BASE}/faces/stats/summary`);
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

function viewPhoto(photoId, name) {
  const lightbox = document.getElementById('photo-lightbox');
  const loading = document.getElementById('lightbox-loading');
  const nameEl = document.getElementById('lightbox-name');

  // Replace img with canvas for face box overlay
  let canvas = document.getElementById('lightbox-canvas');
  if (!canvas) {
    const img = document.getElementById('lightbox-img');
    canvas = document.createElement('canvas');
    canvas.id = 'lightbox-canvas';
    canvas.style.cssText = 'max-width:95vw;max-height:88vh;border-radius:6px;display:none;';
    img.parentNode.replaceChild(canvas, img);
  }
  canvas.style.display = 'none';
  loading.style.display = 'block';
  loading.textContent = 'Loading...';
  nameEl.textContent = name;
  lightbox.classList.remove('hidden');

  // Load image and faces in parallel
  const imgLoader = new Image();
  const facesPromise = apiFetch(`${API_BASE}/faces/photo/${photoId}`).then(r => r ? r.json() : []).then(d => Array.isArray(d) ? d : []).catch(() => []);

  imgLoader.onload = async () => {
    const faces = await facesPromise;
    const maxW = Math.min(window.innerWidth * 0.92, 1200);
    const scale = imgLoader.naturalWidth > maxW ? maxW / imgLoader.naturalWidth : 1;
    canvas.width = imgLoader.naturalWidth * scale;
    canvas.height = imgLoader.naturalHeight * scale;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgLoader, 0, 0, canvas.width, canvas.height);

    const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
    faces.forEach((face, i) => {
      if (!face.bounding_box) return;
      const box = typeof face.bounding_box === 'string' ? JSON.parse(face.bounding_box) : face.bounding_box;
      const color = colors[i % colors.length];

      let bx = box.x, by = box.y, bw = box.width, bh = box.height;

      // box coords are percentages (0-1), convert to canvas pixels
      const x = bx * canvas.width, y = by * canvas.height;
      const w = bw * canvas.width, h = bh * canvas.height;

      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);

      const label = face.cluster_name || (face.person_cluster_id ? face.person_cluster_id.substring(0, 6) : 'Unknown');
      ctx.font = 'bold 14px sans-serif';
      const textW = ctx.measureText(label).width + 8;
      ctx.fillStyle = color;
      ctx.fillRect(x, y > 20 ? y - 20 : y + h, textW, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 4, y > 20 ? y - 5 : y + h + 15);
    });

    loading.style.display = 'none';
    canvas.style.display = 'block';
  };

  imgLoader.onerror = () => { loading.textContent = 'Failed to load image'; };
  imgLoader.src = `${API_BASE}/photos/${photoId}/view?token=${encodeURIComponent(getAuthToken())}`;
}
window.viewPhoto = viewPhoto;

function closeLightbox() {
  const lightbox = document.getElementById('photo-lightbox');
  lightbox.classList.add('hidden');
  const canvas = document.getElementById('lightbox-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
window.closeLightbox = closeLightbox;
window.closeConfirmModal = closeConfirmModal;

// Initial load
checkOneDriveStatus();
loadStats();
pollIndexingState();

// ── Photo Map ────────────────────────────────────────────────────────────────

let mapInstance = null;
let mapMarkers = [];
let mapSearchTimeout = null;

function getBoundsRadiusKm(map) {
  const bounds = map.getBounds();
  const center = bounds.getCenter();
  const ne = bounds.getNorthEast();
  // Haversine distance from center to corner
  const R = 6371;
  const dLat = (ne.lat - center.lat) * Math.PI / 180;
  const dLng = (ne.lng - center.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(center.lat * Math.PI/180) * Math.cos(ne.lat * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function initMap() {
  if (mapInstance) return;
  const L = window.L;
  if (!L) { console.error('Leaflet not loaded'); return; }

  const initLat = parseFloat(document.getElementById('map-lat').value) || 45.1;
  const initLng = parseFloat(document.getElementById('map-lng').value) || 6.07;

  mapInstance = L.map('map-container').setView([initLat, initLng], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(mapInstance);

  // Auto-reload on map move/zoom with debounce
  mapInstance.on('moveend', () => {
    const center = mapInstance.getCenter();
    document.getElementById('map-lat').value = center.lat.toFixed(4);
    document.getElementById('map-lng').value = center.lng.toFixed(4);
    document.getElementById('map-radius').value = Math.ceil(getBoundsRadiusKm(mapInstance));
    clearTimeout(mapSearchTimeout);
    mapSearchTimeout = setTimeout(() => searchMapPhotos(false), 600);
  });

  // Load persons into select
  try {
    const res = await apiFetch(`${API_BASE}/faces/clusters`);
    if (res) {
      const clusters = await res.json();
      const sel = document.getElementById('map-person-select');
      clusters.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name || `Cluster ${c.id.substring(0, 6)}`;
        sel.appendChild(opt);
      });
    }
  } catch {}
}

async function searchMapPhotos(recenter = true) {
  const L = window.L;
  if (!L || !mapInstance) return;

  const lat = parseFloat(document.getElementById('map-lat').value);
  const lng = parseFloat(document.getElementById('map-lng').value);
  const radius = parseFloat(document.getElementById('map-radius').value) || Math.ceil(getBoundsRadiusKm(mapInstance));
  const personId = document.getElementById('map-person-select').value;

  if (isNaN(lat) || isNaN(lng)) return;

  // Remove existing cluster layer
  if (window._mapClusterGroup) {
    mapInstance.removeLayer(window._mapClusterGroup);
    window._mapClusterGroup = null;
  }
  mapMarkers = [];

  const countEl = document.getElementById('map-result-count');
  countEl.textContent = 'Searching…';

  const params = new URLSearchParams({ lat, lng, radius, limit: 500 });
  if (personId) params.set('personIds', personId);

  const res = await apiFetch(`${API_BASE}/photos/map?${params}`);
  if (!res) return;
  const data = await res.json();

  countEl.textContent = `${data.count} photo(s) found within ${radius} km`;

  if (recenter) mapInstance.setView([lat, lng], 11);

  const clusterRadius = parseInt(document.getElementById('map-cluster-radius')?.value) || 120;
  const clusterGroup = L.markerClusterGroup({
    maxClusterRadius: clusterRadius,
    iconCreateFunction(cluster) {
      const children = cluster.getAllChildMarkers();
      const first = children[0];
      const thumbUrl = first?.options?.thumbUrl || '';
      const count = cluster.getChildCount();
      return L.divIcon({
        className: '',
        html: `<div class="map-cluster-icon">
          <img src="${thumbUrl}" onerror="this.style.display='none'" />
          <span class="map-cluster-count">${count}</span>
        </div>`,
        iconSize: [56, 56],
        iconAnchor: [28, 28],
      });
    },
  });

  data.photos.forEach(photo => {
    const thumbUrl = `${API_BASE}/photos/${photo.id}/thumbnail?token=${encodeURIComponent(getAuthToken())}`;
    const icon = L.divIcon({
      className: '',
      html: `<img class="map-photo-marker" src="${thumbUrl}" onerror="this.style.display='none'" />`,
      iconSize: [52, 52],
      iconAnchor: [26, 26],
    });

    const marker = L.marker([photo.lat, photo.lng], { icon, thumbUrl })
      .bindPopup(`
        <img src="${thumbUrl}" style="max-width:180px;border-radius:4px;" /><br>
        <p><strong>${photo.name}</strong></p>
        <p>${photo.taken_at ? new Date(photo.taken_at).toLocaleDateString() : ''}</p>
        <p>${photo.distance_km ? photo.distance_km.toFixed(1) + ' km' : ''}</p>
        <a href="#" onclick="viewPhoto('${photo.id}');return false;">Voir la photo</a>
      `);
    clusterGroup.addLayer(marker);
    mapMarkers.push(marker);
  });

  mapInstance.addLayer(clusterGroup);
  window._mapClusterGroup = clusterGroup;
}

// Init map when tab is activated
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'map') {
      setTimeout(async () => {
        await initMap();
        mapInstance.invalidateSize();
        // Initial search on first open
        if (mapMarkers.length === 0) searchMapPhotos(false);
      }, 50);
    }
  });
});

document.getElementById('map-search-btn').addEventListener('click', async () => {
  await initMap();
  searchMapPhotos(true);
});

document.getElementById('map-cluster-radius').addEventListener('input', (e) => {
  document.getElementById('map-cluster-radius-value').textContent = e.target.value;
  if (mapInstance) searchMapPhotos(false);
});

// Person filter change triggers reload
document.getElementById('map-person-select').addEventListener('change', () => {
  if (mapInstance) searchMapPhotos(false);
});
let metricsPollingInterval;
let metricsChart = null;

function initMetricsChart() {
  if (metricsChart) return;
  const ctx = document.getElementById('metrics-chart').getContext('2d');
  metricsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Download (ms)',
          data: [],
          borderColor: '#4a9eff',
          backgroundColor: 'rgba(74,158,255,0.1)',
          tension: 0.3,
          pointRadius: 2,
          yAxisID: 'y',
        },
        {
          label: 'Detect (ms)',
          data: [],
          borderColor: '#4aff8c',
          backgroundColor: 'rgba(74,255,140,0.1)',
          tension: 0.3,
          pointRadius: 2,
          yAxisID: 'y',
        },
        {
          label: 'Photos/s',
          data: [],
          borderColor: '#ffb84a',
          backgroundColor: 'rgba(255,184,74,0.1)',
          tension: 0.3,
          pointRadius: 2,
          yAxisID: 'y2',
        }
      ]
    },
    options: {
      animation: false,
      scales: {
        x: { ticks: { color: '#888', maxTicksLimit: 6 }, grid: { color: '#333' } },
        y: { ticks: { color: '#888' }, grid: { color: '#333' }, title: { display: true, text: 'ms', color: '#888' } },
        y2: { position: 'right', ticks: { color: '#ffb84a' }, grid: { drawOnChartArea: false }, title: { display: true, text: 'photo/s', color: '#ffb84a' } }
      },
      plugins: { legend: { labels: { color: '#ccc', boxWidth: 12 } } }
    }
  });
}

async function pollMetrics() {
  try {
    const res = await apiFetch(`${API_BASE}/indexing/faces/metrics`);
    if (!res) return;
    const metrics = await res.json();
    if (!Array.isArray(metrics) || metrics.length === 0) return;

    const section = document.getElementById('face-metrics-section');
    section.style.display = 'block';
    initMetricsChart();

    const now = Date.now();
    const window10min = metrics.filter(m => now - m.ts < 10 * 60 * 1000);

    if (window10min.length === 0) return;

    const last = window10min[window10min.length - 1];
    document.getElementById('metric-last-download').textContent =
      last.downloadMs != null ? last.downloadMs + ' ms' : '—';
    document.getElementById('metric-last-detect').textContent =
      last.detectMs != null ? last.detectMs + ' ms' : '—';

    // Bucket into 10s slots for photos/s
    const buckets = {};
    window10min.forEach(m => {
      const slot = Math.floor(m.ts / 10000) * 10000;
      buckets[slot] = (buckets[slot] || 0) + 1;
    });
    const slots = Object.keys(buckets).sort();
    const photosPerS = slots.map(s => (buckets[s] / 10).toFixed(2));
    const labels = slots.map(s => {
      const d = new Date(parseInt(s));
      return d.getHours().toString().padStart(2, '0') + ':' +
             d.getMinutes().toString().padStart(2, '0') + ':' +
             d.getSeconds().toString().padStart(2, '0');
    });

    // Raw download/detect times (last 60 for readability)
    const recent = window10min.slice(-60);
    const dlLabels = recent.map(m => {
      const d = new Date(m.ts);
      return d.getHours().toString().padStart(2, '0') + ':' +
             d.getMinutes().toString().padStart(2, '0') + ':' +
             d.getSeconds().toString().padStart(2, '0');
    });

    metricsChart.data.labels = dlLabels;
    metricsChart.data.datasets[0].data = recent.map(m => m.downloadMs);
    metricsChart.data.datasets[1].data = recent.map(m => m.detectMs);
    // photos/s dataset uses same labels (may differ in length — pad with null)
    metricsChart.data.datasets[2].data = dlLabels.map((_, i) => {
      const slot = Math.floor(recent[i].ts / 10000) * 10000;
      return buckets[slot] ? (buckets[slot] / 10).toFixed(2) : null;
    });
    metricsChart.update();
  } catch (err) {
    console.error('Metrics poll error:', err);
  }
}

pollFaceDetectionState();
