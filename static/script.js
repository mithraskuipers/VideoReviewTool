let SLIDESHOW_INTERVAL_MS = 225; // 2x faster than the original 450ms default; adjustable in the UI
let NUM_SNAPSHOTS = 20; // overwritten by the snapshot-count selector / server state
let currentSettings = null; // { delete_key, keep_key, default_num_snapshots, sort_buttons: [{id,key,folder}] }

const introScreen = document.getElementById('intro-screen');
const modeScreen = document.getElementById('mode-screen');
const reviewSettingsScreen = document.getElementById('review-settings-screen');
const compileSettingsScreen = document.getElementById('compile-settings-screen');
const compileProgressScreen = document.getElementById('compile-progress-screen');
const overviewSettingsScreen = document.getElementById('overview-settings-screen');
const reviewScreen = document.getElementById('review-screen');
const doneScreen = document.getElementById('done-screen');
const allScreens = [introScreen, modeScreen, reviewSettingsScreen, compileSettingsScreen,
  compileProgressScreen, overviewSettingsScreen, reviewScreen, doneScreen];

function showScreen(target) {
  allScreens.forEach(s => { if (s) s.classList.toggle('hidden', s !== target); });
}

const dropzone = document.getElementById('dropzone');
const browseFolderBtn = document.getElementById('browse-folder-btn');
const browseFileBtn = document.getElementById('browse-file-btn');
const pathInput = document.getElementById('path-input');
const recursiveCheckbox = document.getElementById('recursive-checkbox');
const introMessage = document.getElementById('intro-message');
const introNextBtn = document.getElementById('intro-next-btn');

const modeHeading = document.getElementById('mode-heading');
const modeLocation = document.getElementById('mode-location');
const modeBackBtn = document.getElementById('mode-back-btn');
const modeMessage = document.getElementById('mode-message');
const optionReviewBtn = document.getElementById('option-review-btn');
const optionCompileBtn = document.getElementById('option-compile-btn');
const optionOverviewBtn = document.getElementById('option-overview-btn');
const optionVideoBtn = document.getElementById('option-video-btn');
const previewVideo = document.getElementById('preview-video');
const scanList = document.getElementById('scan-list');

const reviewSettingsBackBtn = document.getElementById('review-settings-back-btn');
const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');
const setupMessage = document.getElementById('setup-message');
const snapshotPreset = document.getElementById('snapshot-preset');
const snapshotCountInput = document.getElementById('snapshot-count');
const snapshotIntervalLabel = document.getElementById('snapshot-interval');
const frameTotalEl = document.getElementById('frame-total');

// Prepare mode exists in three places (setup screen, review-screen sidebar,
// done screen) that all drive the same single background job on the
// backend. Each entry below is one panel's DOM refs; wirePreparePanel()
// binds its button/cancel button, and every poll tick updates all three
// panels together (see renderPrepareStatus/onPrepareFinished) so whichever
// screen you're looking at always reflects the current job, regardless of
// which panel actually started it.
const preparePanels = [
  {
    idleLabel: '⚡ Prepare snapshots for this folder',
    pathInput: document.getElementById('path-input'),
    btn: document.getElementById('prepare-btn'),
    progress: document.getElementById('prepare-progress'),
    statusLabel: document.getElementById('prepare-status-label'),
    fill: document.getElementById('prepare-progress-fill'),
    currentFile: document.getElementById('prepare-current-file'),
    message: document.getElementById('prepare-message'),
    cancelBtn: document.getElementById('prepare-cancel-btn'),
    // This is the only panel that operates on the folder you're about to
    // review (the other two prime a *different, upcoming* folder in the
    // background). So it's the only one that scans first and automatically
    // drops you into review once every snapshot is ready.
    autoReview: true,
  },
  {
    idleLabel: '⚡ Prepare snapshots',
    pathInput: document.getElementById('review-prepare-path'),
    btn: document.getElementById('review-prepare-btn'),
    progress: document.getElementById('review-prepare-progress'),
    statusLabel: document.getElementById('review-prepare-status-label'),
    fill: document.getElementById('review-prepare-progress-fill'),
    currentFile: document.getElementById('review-prepare-current-file'),
    message: document.getElementById('review-prepare-message'),
    cancelBtn: document.getElementById('review-prepare-cancel-btn'),
  },
  {
    idleLabel: '⚡ Prepare',
    pathInput: document.getElementById('done-prepare-path'),
    btn: document.getElementById('done-prepare-btn'),
    progress: document.getElementById('done-prepare-progress'),
    statusLabel: document.getElementById('done-prepare-status-label'),
    fill: document.getElementById('done-prepare-progress-fill'),
    currentFile: document.getElementById('done-prepare-current-file'),
    message: document.getElementById('done-prepare-message'),
    cancelBtn: document.getElementById('done-prepare-cancel-btn'),
  },
];
let preparePollTimer = null;

const speedPreset = document.getElementById('speed-preset');
const speedCountInput = document.getElementById('speed-count');
const speedLabel = document.getElementById('speed-label');

const reviewSnapshotPreset = document.getElementById('review-snapshot-preset');
const reviewSnapshotCountInput = document.getElementById('review-snapshot-count');
const reviewSnapshotIntervalLabel = document.getElementById('review-snapshot-interval');
const reviewSpeedPreset = document.getElementById('review-speed-preset');
const reviewSpeedCountInput = document.getElementById('review-speed-count');
const reviewSpeedLabel = document.getElementById('review-speed-label');

const stopBtn = document.getElementById('stop-btn');
const frameScrubber = document.getElementById('frame-scrubber');
const skipBtn = document.getElementById('skip-btn');
const undoBtn = document.getElementById('undo-btn');
const doneUndoBtn = document.getElementById('done-undo-btn');

const toggleSettingsBtn = document.getElementById('toggle-settings-btn');
const settingsEditor = document.getElementById('settings-editor');
const deleteKeyInput = document.getElementById('delete-key-input');
const keepKeyInput = document.getElementById('keep-key-input');
const sortButtonsList = document.getElementById('sort-buttons-list');
const addSortBtn = document.getElementById('add-sort-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const resetSettingsBtn = document.getElementById('reset-settings-btn');
const settingsMessage = document.getElementById('settings-message');
const keyLegend = document.getElementById('key-legend');

const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const previewImg = document.getElementById('preview-img');
const previewLoading = document.getElementById('preview-loading');
const frameIndexEl = document.getElementById('frame-index');
const framePercentEl = document.getElementById('frame-percent');
const currentFilename = document.getElementById('current-filename');
const currentFilemeta = document.getElementById('current-filemeta');
const queueList = document.getElementById('queue-list');
const unreadablePanel = document.getElementById('unreadable-panel');
const unreadableList = document.getElementById('unreadable-list');
const doneSummary = document.getElementById('done-summary');

let scannedVideos = [];
let deselectedVideoIds = new Set(); // ids the person unchecked in the scan-results list
let reviewMode = 'thumbnails'; // 'thumbnails' (live slideshow), 'overview' (static screenshot-overview image) or 'video' (plain playback)
let slideshowTimer = null;
let slideshowIdx = 0;
let currentVideo = null;
let currentImages = null; // the preloaded Image() array for the video currently being reviewed
let busy = false; // guard against double key-presses while an action is in flight
let loadToken = 0; // bumped every time loadPreview() starts, so late-arriving image
                    // loads for a video the user already skipped/actioned past are ignored
let brokenPollTimer = null; // polls while a video is loading to catch the backend
                             // flagging it unreadable, so we can auto-skip quickly

const VIDEO_SEEK_SECONDS = 5;
const VIDEO_SEEK_SECONDS_LONG = 30;

const DEFAULT_SETTINGS = {
  delete_key: 'd',
  keep_key: 'k',
  compile_key: 'c',
  default_num_snapshots: 20,
  slideshow_interval_ms: 225,
  compilation_shots: 9,
  sort_buttons: [
    { id: 'sort_1', key: '1', folder: '1' },
    { id: 'sort_2', key: '2', folder: '2' },
    { id: 'sort_3', key: '3', folder: '3' },
  ],
};

/* ---------------- Screenshot compilation: shared helpers ---------------- */

const compilationShotsSlider = document.getElementById('compilation-shots-slider');
const compilationShotsValue = document.getElementById('compilation-shots-value');
const compileOutputInput = document.getElementById('compile-output-input');
const compileOutputBrowseBtn = document.getElementById('compile-output-browse-btn');
const compileSettingsBackBtn = document.getElementById('compile-settings-back-btn');
const compileStartBtn = document.getElementById('compile-start-btn');
const compileSettingsMessage = document.getElementById('compile-settings-message');

const compileProgressSubtitle = document.getElementById('compile-progress-subtitle');
const compileBatchFill = document.getElementById('compile-batch-progress-fill');
const compileBatchProgressLabel = document.getElementById('compile-batch-progress-label');
const compileFileList = document.getElementById('compile-file-list');
const compileBatchMessage = document.getElementById('compile-batch-message');
const compileBatchCancelBtn = document.getElementById('compile-batch-cancel-btn');
const compileBatchDoneBtn = document.getElementById('compile-batch-done-btn');
const compileBatchBackToOverviewBtn = document.getElementById('compile-batch-back-to-overview-btn');

/* ---------------- Sort by screenshot overview ---------------- */

const overviewDirInput = document.getElementById('overview-dir-input');
const overviewDirBrowseBtn = document.getElementById('overview-dir-browse-btn');
const overviewRescanBtn = document.getElementById('overview-rescan-btn');
const overviewStatusText = document.getElementById('overview-status-text');
const overviewScanList = document.getElementById('overview-scan-list');
const overviewReviewBtn = document.getElementById('overview-review-btn');
const overviewReviewDesc = document.getElementById('overview-review-desc');
const overviewGenerateBtn = document.getElementById('overview-generate-btn');
const overviewGenerateDesc = document.getElementById('overview-generate-desc');
const overviewVideoBtn = document.getElementById('overview-video-btn');
const overviewBackBtn = document.getElementById('overview-back-btn');
const overviewMessage = document.getElementById('overview-message');

let overviewScanResults = []; // videos (with overview_path resolved for the current overview_dir) shown on this screen
let compileBatchFromOverview = false; // true when the running compile batch was launched from this screen

const reviewCompilationSlider = document.getElementById('review-compilation-slider');
const reviewCompilationValue = document.getElementById('review-compilation-value');
const compileBtn = document.getElementById('compile-btn');
const compileKeyKbd = document.getElementById('compile-key-kbd');

const compileKeyInput = document.getElementById('compile-key-input');

function clampCompilationShots(n) {
  return Math.min(64, Math.max(4, n));
}

function compilationGridLabel(n) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const interval = Number.isInteger(100 / n) ? `${(100 / n).toFixed(0)}%` : `~${(100 / n).toFixed(1)}%`;
  return `${n} (${rows} × ${cols} · every ${interval})`;
}

function updateCompilationLabels(n) {
  const label = compilationGridLabel(n);
  if (compilationShotsValue) compilationShotsValue.textContent = label;
  if (reviewCompilationValue) reviewCompilationValue.textContent = label;
}

async function saveCompilationShots(n) {
  try {
    await fetch('/api/compilation_shots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_shots: n }),
    });
    if (currentSettings) currentSettings.compilation_shots = n;
  } catch (e) {
    // non-critical - the chosen value still works for this session
  }
}

function commitCompilationShots(n) {
  n = clampCompilationShots(n);
  if (compilationShotsSlider) compilationShotsSlider.value = n;
  if (reviewCompilationSlider) reviewCompilationSlider.value = n;
  updateCompilationLabels(n);
  saveCompilationShots(n);
}

if (compilationShotsSlider) {
  compilationShotsSlider.addEventListener('input', () => {
    updateCompilationLabels(clampCompilationShots(parseInt(compilationShotsSlider.value, 10)));
  });
  compilationShotsSlider.addEventListener('change', () => {
    commitCompilationShots(parseInt(compilationShotsSlider.value, 10));
  });
}

if (reviewCompilationSlider) {
  reviewCompilationSlider.addEventListener('input', () => {
    updateCompilationLabels(clampCompilationShots(parseInt(reviewCompilationSlider.value, 10)));
  });
  reviewCompilationSlider.addEventListener('change', () => {
    commitCompilationShots(parseInt(reviewCompilationSlider.value, 10));
  });
}

function getCompilationShots() {
  const n = (reviewCompilationSlider && parseInt(reviewCompilationSlider.value, 10)) ||
    (currentSettings && currentSettings.compilation_shots) || 9;
  return clampCompilationShots(n);
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return val.toFixed(1) + ' ' + units[i];
}

/* ---------------- Folder / file picker ----------------
   Drawn in the page (not by the server's desktop), so it opens on the
   device you are using while listing the files on the machine running the
   app. pickPath() resolves with the chosen path, or null if cancelled. */

const pickerModal = document.getElementById('picker-modal');
const pickerTitle = document.getElementById('picker-title');
const pickerPathInput = document.getElementById('picker-path-input');
const pickerList = document.getElementById('picker-list');
const pickerMessage = document.getElementById('picker-message');
const pickerUpBtn = document.getElementById('picker-up-btn');
const pickerGoBtn = document.getElementById('picker-go-btn');
const pickerCancelBtn = document.getElementById('picker-cancel-btn');
const pickerSelectBtn = document.getElementById('picker-select-btn');

let pickerResolve = null;
let pickerMode = 'folder';
let pickerCurrent = '';
let pickerParent = null;
let pickerRequest = 0;

function pickPath(mode, startPath) {
  return new Promise((resolve) => {
    if (pickerResolve) pickerResolve(null);
    pickerResolve = resolve;
    pickerMode = mode;
    pickerTitle.textContent = mode === 'file' ? 'Select a video file'
      : mode === 'output' ? 'Select an output folder' : 'Select a folder with videos';
    pickerSelectBtn.classList.toggle('hidden', mode === 'file');
    pickerMessage.textContent = '';
    pickerModal.classList.remove('hidden');
    loadPickerDir((startPath || '').trim());
  });
}

function closePicker(result) {
  pickerModal.classList.add('hidden');
  const resolve = pickerResolve;
  pickerResolve = null;
  if (resolve) resolve(result);
}

async function loadPickerDir(path) {
  const myRequest = ++pickerRequest;
  pickerMessage.textContent = '';
  try {
    const res = await fetch('/api/listdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, mode: pickerMode }),
    });
    const data = await res.json();
    if (myRequest !== pickerRequest) return;
    if (!data.success) { pickerMessage.textContent = data.error || 'Could not open that folder.'; return; }
    renderPickerDir(data);
  } catch (e) {
    if (myRequest !== pickerRequest) return;
    pickerMessage.textContent = 'Could not reach the server.';
  }
}

function renderPickerDir(data) {
  pickerCurrent = data.path;
  pickerParent = data.parent;
  pickerPathInput.value = data.is_drives ? '' : data.path;
  pickerPathInput.placeholder = data.is_drives ? 'Drives' : '';
  pickerUpBtn.disabled = pickerParent === null;
  pickerSelectBtn.disabled = !!data.is_drives;

  pickerList.textContent = '';
  if (!data.entries.length) {
    const li = document.createElement('li');
    li.className = 'picker-empty';
    li.textContent = pickerMode === 'file' ? 'No subfolders or video files here.' : 'No subfolders here.';
    pickerList.appendChild(li);
    return;
  }
  for (const entry of data.entries) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'picker-item';
    const icon = document.createElement('span');
    icon.textContent = entry.is_dir ? '📁' : '🎞️';
    const name = document.createElement('span');
    name.className = 'picker-item-name';
    name.textContent = entry.name;
    btn.append(icon, name);
    btn.addEventListener('click', () => {
      if (entry.is_dir) loadPickerDir(entry.path);
      else closePicker(entry.path);
    });
    li.appendChild(btn);
    pickerList.appendChild(li);
  }
}

pickerUpBtn.addEventListener('click', () => { if (pickerParent !== null) loadPickerDir(pickerParent); });
pickerGoBtn.addEventListener('click', () => loadPickerDir(pickerPathInput.value.trim()));
pickerPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); loadPickerDir(pickerPathInput.value.trim()); }
});
pickerCancelBtn.addEventListener('click', () => closePicker(null));
pickerSelectBtn.addEventListener('click', () => closePicker(pickerCurrent));
pickerModal.addEventListener('mousedown', (e) => { if (e.target === pickerModal) closePicker(null); });
// Capture phase so Esc closes the picker instead of reaching the app's own hotkeys.
document.addEventListener('keydown', (e) => {
  if (pickerModal.classList.contains('hidden')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePicker(null); }
}, true);

/* ---------------- Setup screen ---------------- */

browseFolderBtn.addEventListener('click', async () => {
  introMessage.textContent = '';
  const picked = await pickPath('folder', pathInput.value);
  if (picked) pathInput.value = picked;
});

browseFileBtn.addEventListener('click', async () => {
  introMessage.textContent = '';
  const picked = await pickPath('file', pathInput.value);
  if (picked) pathInput.value = picked;
});

pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') goToModeScreen(); });
introNextBtn.addEventListener('click', goToModeScreen);

['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
);
dropzone.addEventListener('drop', (e) => {
  // Browsers do not expose a real filesystem path from drag-and-drop for
  // security reasons, so we can't act on it directly here. Guide the user
  // to the reliable option instead.
  introMessage.textContent = 'Browsers hide the real disk path on drag-and-drop - ' +
    'please use one of the Browse buttons above, or paste the path below.';
});

async function goToModeScreen() {
  if (introNextBtn.disabled) return;
  introNextBtn.disabled = true;
  const idle = introNextBtn.textContent;
  introNextBtn.textContent = 'Scanning…';
  const ok = await doScan(pathInput.value);
  introNextBtn.disabled = false;
  introNextBtn.textContent = idle;
  if (!ok) return;

  modeMessage.textContent = '';
  modeLocation.textContent = scanRecursive
    ? `${scanFolder || pathInput.value.trim()} (including subfolders)`
    : (scanFolder || pathInput.value.trim());
  if (scannedVideos.length === 1) {
    modeHeading.textContent = '1 video selected';
  } else {
    modeHeading.textContent = `${scannedVideos.length} video files found`;
  }
  renderScanList();
  showScreen(modeScreen);
}

function updateSnapshotInterval() {
  const n = clampSnapshotCount(parseInt(snapshotCountInput.value, 10) || 20);
  snapshotIntervalLabel.textContent = Number.isInteger(100 / n)
    ? `every ${(100 / n).toFixed(0)}%`
    : `every ~${(100 / n).toFixed(1)}%`;
}

function clampSnapshotCount(n) {
  return Math.min(100, Math.max(2, n));
}

snapshotPreset.addEventListener('change', () => {
  if (snapshotPreset.value === 'custom') {
    snapshotCountInput.focus();
    snapshotCountInput.select();
  } else {
    snapshotCountInput.value = snapshotPreset.value;
    updateSnapshotInterval();
  }
});

snapshotCountInput.addEventListener('input', () => {
  const matchingPreset = Array.from(snapshotPreset.options)
    .find(o => o.value === snapshotCountInput.value);
  snapshotPreset.value = matchingPreset ? matchingPreset.value : 'custom';
  updateSnapshotInterval();
});

updateSnapshotInterval();

/* ---- Snapshot count on the review screen: changes take effect immediately
   (unlike the setup screen, where it only applies at the next Scan) ---- */

function formatIntervalLabel(n) {
  return Number.isInteger(100 / n) ? `every ${(100 / n).toFixed(0)}%` : `every ~${(100 / n).toFixed(1)}%`;
}

function updateReviewSnapshotLabel() {
  const n = clampSnapshotCount(parseInt(reviewSnapshotCountInput.value, 10) || NUM_SNAPSHOTS);
  reviewSnapshotIntervalLabel.textContent = formatIntervalLabel(n);
}

async function commitReviewSnapshotCount(n) {
  n = clampSnapshotCount(Number.isNaN(n) ? NUM_SNAPSHOTS : n);
  reviewSnapshotCountInput.value = n;
  updateReviewSnapshotLabel();
  const matchingPreset = Array.from(reviewSnapshotPreset.options).find(o => o.value == n);
  reviewSnapshotPreset.value = matchingPreset ? matchingPreset.value : 'custom';

  if (n === NUM_SNAPSHOTS) return; // no real change, skip the round trip

  try {
    const res = await fetch('/api/num_snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ num_snapshots: n }),
    });
    const data = await res.json();
    if (!data.success) return;

    NUM_SNAPSHOTS = data.num_snapshots;
    frameTotalEl.textContent = NUM_SNAPSHOTS;
    if (currentSettings) currentSettings.default_num_snapshots = NUM_SNAPSHOTS;

    // Keep the setup screen's own field in sync too, for the next folder.
    snapshotCountInput.value = NUM_SNAPSHOTS;
    const setupMatch = Array.from(snapshotPreset.options).find(o => o.value == NUM_SNAPSHOTS);
    snapshotPreset.value = setupMatch ? setupMatch.value : 'custom';
    updateSnapshotInterval();

    if (currentVideo) loadPreview(currentVideo); // re-fetch thumbnails at the new count
  } catch (e) {
    // non-critical - the old count keeps working for this session
  }
}

reviewSnapshotPreset.addEventListener('change', () => {
  if (reviewSnapshotPreset.value === 'custom') {
    reviewSnapshotCountInput.focus();
    reviewSnapshotCountInput.select();
  } else {
    commitReviewSnapshotCount(parseInt(reviewSnapshotPreset.value, 10));
  }
});

reviewSnapshotCountInput.addEventListener('input', () => {
  const matchingPreset = Array.from(reviewSnapshotPreset.options)
    .find(o => o.value === reviewSnapshotCountInput.value);
  reviewSnapshotPreset.value = matchingPreset ? matchingPreset.value : 'custom';
  updateReviewSnapshotLabel();
});

reviewSnapshotCountInput.addEventListener('change', () => {
  commitReviewSnapshotCount(parseInt(reviewSnapshotCountInput.value, 10));
});

/* ---------------- Slideshow speed (setup screen + review screen, kept in sync) ---------------- */

function clampSpeed(ms) {
  return Math.min(3000, Math.max(50, ms));
}

function updateSpeedLabels(ms) {
  const text = `${ms} ms/frame`;
  speedLabel.textContent = text;
  if (reviewSpeedLabel) reviewSpeedLabel.textContent = text;
}

function syncSpeedPresets(ms) {
  const matchSetup = Array.from(speedPreset.options).find(o => o.value == ms);
  speedPreset.value = matchSetup ? matchSetup.value : 'custom';
  if (reviewSpeedPreset) {
    const matchReview = Array.from(reviewSpeedPreset.options).find(o => o.value == ms);
    reviewSpeedPreset.value = matchReview ? matchReview.value : 'custom';
  }
}

// Applies the speed to playback immediately (used while typing/dragging) without
// stomping whichever field the user is actively editing.
function applySpeedLive(ms) {
  ms = clampSpeed(ms);
  SLIDESHOW_INTERVAL_MS = ms;
  updateSpeedLabels(ms);
  if (slideshowTimer) restartSlideshowTimer(); // apply live if a slideshow is currently playing
}

// Normalizes both fields, updates both presets, and persists - used on blur/enter/preset-select.
function commitSpeed(ms) {
  ms = clampSpeed(ms);
  applySpeedLive(ms);
  speedCountInput.value = ms;
  if (reviewSpeedCountInput) reviewSpeedCountInput.value = ms;
  syncSpeedPresets(ms);
  saveSpeed(ms);
}

async function saveSpeed(ms) {
  try {
    await fetch('/api/speed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slideshow_interval_ms: ms }),
    });
    if (currentSettings) currentSettings.slideshow_interval_ms = ms;
  } catch (e) {
    // non-critical - speed still works for this session even if it can't be saved
  }
}

speedPreset.addEventListener('change', () => {
  if (speedPreset.value === 'custom') {
    speedCountInput.focus();
    speedCountInput.select();
  } else {
    commitSpeed(parseInt(speedPreset.value, 10));
  }
});

speedCountInput.addEventListener('input', () => {
  const matchingPreset = Array.from(speedPreset.options).find(o => o.value === speedCountInput.value);
  speedPreset.value = matchingPreset ? matchingPreset.value : 'custom';
  const n = parseInt(speedCountInput.value, 10);
  if (!Number.isNaN(n)) applySpeedLive(n);
});

speedCountInput.addEventListener('change', () => {
  const n = parseInt(speedCountInput.value, 10);
  commitSpeed(Number.isNaN(n) ? SLIDESHOW_INTERVAL_MS : n);
});

if (reviewSpeedPreset) {
  reviewSpeedPreset.addEventListener('change', () => {
    if (reviewSpeedPreset.value === 'custom') {
      reviewSpeedCountInput.focus();
      reviewSpeedCountInput.select();
    } else {
      commitSpeed(parseInt(reviewSpeedPreset.value, 10));
    }
  });

  reviewSpeedCountInput.addEventListener('input', () => {
    const matchingPreset = Array.from(reviewSpeedPreset.options).find(o => o.value === reviewSpeedCountInput.value);
    reviewSpeedPreset.value = matchingPreset ? matchingPreset.value : 'custom';
    const n = parseInt(reviewSpeedCountInput.value, 10);
    if (!Number.isNaN(n)) applySpeedLive(n);
  });

  reviewSpeedCountInput.addEventListener('change', () => {
    const n = parseInt(reviewSpeedCountInput.value, 10);
    commitSpeed(Number.isNaN(n) ? SLIDESHOW_INTERVAL_MS : n);
  });
}

updateSpeedLabels(SLIDESHOW_INTERVAL_MS);

/* ---------------- Settings (customizable buttons) ---------------- */

function newButtonId() {
  return 'sort_' + Math.random().toString(36).slice(2, 10);
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    currentSettings = data.success ? data.settings : deepClone(DEFAULT_SETTINGS);
  } catch (e) {
    currentSettings = deepClone(DEFAULT_SETTINGS);
  }
  applyLoadedSettings();
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function applyLoadedSettings() {
  // Prefill snapshot count from the remembered setting.
  const n = currentSettings.default_num_snapshots || 20;
  snapshotCountInput.value = n;
  const matchingPreset = Array.from(snapshotPreset.options).find(o => o.value == n);
  snapshotPreset.value = matchingPreset ? matchingPreset.value : 'custom';
  updateSnapshotInterval();

  const loadedSpeed = clampSpeed(currentSettings.slideshow_interval_ms || 225);
  applySpeedLive(loadedSpeed);
  speedCountInput.value = loadedSpeed;
  if (reviewSpeedCountInput) reviewSpeedCountInput.value = loadedSpeed;
  syncSpeedPresets(loadedSpeed);

  const shots = clampCompilationShots(currentSettings.compilation_shots || 9);
  if (compilationShotsSlider) compilationShotsSlider.value = shots;
  if (reviewCompilationSlider) reviewCompilationSlider.value = shots;
  updateCompilationLabels(shots);

  renderSettingsEditor(currentSettings);
  renderLegend(currentSettings);
}

function renderSettingsEditor(settings) {
  deleteKeyInput.value = settings.delete_key.toUpperCase();
  keepKeyInput.value = settings.keep_key.toUpperCase();
  if (compileKeyInput) compileKeyInput.value = (settings.compile_key || 'c').toUpperCase();
  sortButtonsList.innerHTML = '';
  settings.sort_buttons.forEach(b => sortButtonsList.appendChild(buildSortButtonRow(b)));
}

function buildSortButtonRow(button) {
  const row = document.createElement('div');
  row.className = 'sort-button-row';
  row.dataset.id = button.id;
  row.innerHTML = `
    <input type="text" class="key-input sort-key-input" maxlength="1" value="${escapeAttr(button.key.toUpperCase())}">
    <span class="folder-prefix">→ /</span>
    <input type="text" class="folder-input" value="${escapeAttr(button.folder)}" placeholder="subfolder name">
    <button type="button" class="btn-remove" title="Remove this button">✕</button>
  `;
  row.querySelector('.btn-remove').addEventListener('click', () => row.remove());
  return row;
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

toggleSettingsBtn.addEventListener('click', () => {
  settingsEditor.classList.toggle('hidden');
});

addSortBtn.addEventListener('click', () => {
  sortButtonsList.appendChild(buildSortButtonRow({ id: newButtonId(), key: '', folder: '' }));
});

function collectSettingsFromEditor() {
  const sortButtons = Array.from(sortButtonsList.querySelectorAll('.sort-button-row')).map(row => ({
    id: row.dataset.id,
    key: row.querySelector('.sort-key-input').value.trim(),
    folder: row.querySelector('.folder-input').value.trim(),
  })).filter(b => b.key && b.folder);

  return {
    delete_key: deleteKeyInput.value.trim() || 'd',
    keep_key: keepKeyInput.value.trim() || 'k',
    compile_key: (compileKeyInput ? compileKeyInput.value.trim() : '') || 'c',
    default_num_snapshots: currentSettings ? currentSettings.default_num_snapshots : 20,
    compilation_shots: currentSettings ? currentSettings.compilation_shots : 9,
    sort_buttons: sortButtons,
  };
}

saveSettingsBtn.addEventListener('click', async () => {
  settingsMessage.style.color = '';
  settingsMessage.textContent = '';
  const proposed = collectSettingsFromEditor();

  // quick client-side uniqueness check before hitting the server
  const keys = [proposed.delete_key, proposed.keep_key, proposed.compile_key, ...proposed.sort_buttons.map(b => b.key)]
    .map(k => k.toLowerCase());
  const hasDupes = new Set(keys).size !== keys.length;
  if (hasDupes) {
    settingsMessage.textContent = 'Each key can only be used once - check for duplicates.';
    return;
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: proposed }),
    });
    const data = await res.json();
    if (!data.success) {
      settingsMessage.textContent = data.error || 'Could not save settings.';
      return;
    }
    currentSettings = data.settings;
    renderSettingsEditor(currentSettings);
    renderLegend(currentSettings);
    settingsMessage.style.color = 'var(--success)';
    settingsMessage.textContent = 'Saved - these buttons will be remembered next time too.';
  } catch (e) {
    settingsMessage.textContent = 'Could not reach the local server.';
  }
});

resetSettingsBtn.addEventListener('click', () => {
  const defaults = deepClone(DEFAULT_SETTINGS);
  defaults.default_num_snapshots = currentSettings ? currentSettings.default_num_snapshots : 20;
  renderSettingsEditor(defaults);
  settingsMessage.style.color = '';
  settingsMessage.textContent = 'Defaults loaded - click "Save settings" to keep them.';
});

function renderLegend(settings) {
  let html = `<li><kbd>${escapeHtml(settings.delete_key.toUpperCase())}</kbd><span>Delete file <em>(sent to Recycle Bin / Trash)</em></span></li>`;
  html += `<li><kbd>${escapeHtml(settings.keep_key.toUpperCase())}</kbd><span>Keep <em>(leave in place, no changes)</em></span></li>`;
  html += `<li><kbd>${escapeHtml((settings.compile_key || 'c').toUpperCase())}</kbd><span>Save screenshot compilation <em>(grid image next to the file, then moves on)</em></span></li>`;
  html += `<li><kbd>Esc</kbd><span>Skip <em>(move on, no changes - for stuck/broken videos)</em></span></li>`;
  html += `<li><kbd>⌫</kbd><span>Undo <em>(reverse the previous action and go back)</em></span></li>`;
  if (reviewMode === 'video') {
    html += `<li><kbd>←</kbd><span>Rewind <em>(${VIDEO_SEEK_SECONDS}s, hold Shift for ${VIDEO_SEEK_SECONDS_LONG}s)</em></span></li>`;
    html += `<li><kbd>→</kbd><span>Fast-forward <em>(${VIDEO_SEEK_SECONDS}s, hold Shift for ${VIDEO_SEEK_SECONDS_LONG}s)</em></span></li>`;
    html += `<li><kbd>␣</kbd><span>Play / pause</span></li>`;
  }
  html += `<li><span style="width:26px;text-align:center;color:var(--text-dim);font-size:11px;">auto</span><span>Unreadable files are skipped automatically <em>(listed below)</em></span></li>`;
  settings.sort_buttons.forEach(b => {
    html += `<li><kbd>${escapeHtml(b.key.toUpperCase())}</kbd><span>Move to subfolder <b>/${escapeHtml(b.folder)}</b></span></li>`;
  });
  keyLegend.innerHTML = html;
  if (compileKeyKbd) compileKeyKbd.textContent = (settings.compile_key || 'c').toUpperCase();
}

function buildKeyActionMap(settings) {
  const map = {};
  map[settings.delete_key.toLowerCase()] = 'delete';
  map[settings.keep_key.toLowerCase()] = 'keep';
  map[(settings.compile_key || 'c').toLowerCase()] = 'compile';
  settings.sort_buttons.forEach(b => { map[b.key.toLowerCase()] = b.id; });
  return map;
}

loadSettings();

let scanFolder = null; // the resolved base folder returned by /api/scan (parent dir for a single file)
let scanRecursive = false; // whether the current scan included subfolders - reused by batch compile

async function doScan(path) {
  path = (path || '').trim();
  if (!path) {
    introMessage.textContent = 'Choose or paste a folder or video file path first.';
    return false;
  }
  introMessage.textContent = '';

  const numSnapshots = clampSnapshotCount(parseInt(snapshotCountInput.value, 10) || 20);
  const recursive = !!(recursiveCheckbox && recursiveCheckbox.checked);

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, num_snapshots: numSnapshots, recursive }),
    });
    const data = await res.json();
    if (!data.success) {
      introMessage.textContent = data.error || 'Could not scan that path.';
      return false;
    }
    NUM_SNAPSHOTS = data.num_snapshots || numSnapshots;
    frameTotalEl.textContent = NUM_SNAPSHOTS;
    if (data.settings) {
      currentSettings = data.settings;
      renderLegend(currentSettings);
    }
    scannedVideos = data.videos;
    scanFolder = data.folder || null;
    scanRecursive = recursive;
    if (data.count === 0) {
      introMessage.textContent = 'No supported video files were found there.';
      return false;
    }
    deselectedVideoIds = new Set();
    return true;
  } catch (e) {
    introMessage.textContent = 'Could not reach the local server.';
    return false;
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ---------------- Scan results: deselecting individual files ---------------- */

const scanSelectAll = document.getElementById('scan-select-all');
const scanSelectedCount = document.getElementById('scan-selected-count');

function renderScanList() {
  scanList.innerHTML = scannedVideos.map(v => {
    const checked = deselectedVideoIds.has(v.id) ? '' : 'checked';
    const cls = deselectedVideoIds.has(v.id) ? 'deselected' : '';
    return `<li class="${cls}" data-id="${escapeAttr(v.id)}">
      <label class="scan-item">
        <input type="checkbox" class="scan-item-checkbox" ${checked}>
        <span class="fname">${escapeHtml(v.filename)}</span>
      </label>
      <span class="fsize">${fmtSize(v.size)}</span>
    </li>`;
  }).join('');
  updateScanSelectedCount();
}

function updateScanSelectedCount() {
  const total = scannedVideos.length;
  const selected = total - deselectedVideoIds.size;
  if (scanSelectedCount) {
    scanSelectedCount.textContent = deselectedVideoIds.size
      ? `${selected} of ${total} selected`
      : '';
  }
  if (scanSelectAll) scanSelectAll.checked = deselectedVideoIds.size === 0;
}

scanList.addEventListener('change', (e) => {
  const checkbox = e.target.closest('.scan-item-checkbox');
  if (!checkbox) return;
  const li = e.target.closest('li[data-id]');
  const id = li.dataset.id;
  if (checkbox.checked) {
    deselectedVideoIds.delete(id);
    li.classList.remove('deselected');
  } else {
    deselectedVideoIds.add(id);
    li.classList.add('deselected');
  }
  updateScanSelectedCount();
});

if (scanSelectAll) {
  scanSelectAll.addEventListener('change', () => {
    deselectedVideoIds = scanSelectAll.checked ? new Set() : new Set(scannedVideos.map(v => v.id));
    renderScanList();
  });
}

/* ---------------- Mode screen: choose review vs. compile ---------------- */

modeBackBtn.addEventListener('click', () => {
  introMessage.textContent = '';
  showScreen(introScreen);
});

optionReviewBtn.addEventListener('click', () => {
  showScreen(reviewSettingsScreen);
});

optionCompileBtn.addEventListener('click', () => {
  compileSettingsMessage.textContent = '';
  showScreen(compileSettingsScreen);
});

/* "Play the videos directly": no snapshots, no overview images. Reviews
   with a plain <video> element instead. Reachable from the mode screen and
   from the sort-by-overview screen (as the "skip making overviews" choice). */
async function startVideoReview(messageEl) {
  messageEl.textContent = '';
  try {
    if (deselectedVideoIds.size) {
      await fetch('/api/exclude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(deselectedVideoIds) }),
      });
    }
    await fetch('/api/review_mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'video' }),
    });
  } catch (e) {
    messageEl.textContent = 'Could not reach the local server.';
    return;
  }

  reviewMode = 'video';
  showScreen(reviewScreen);
  refreshStatus();
}

if (optionVideoBtn) optionVideoBtn.addEventListener('click', () => startVideoReview(modeMessage));
if (overviewVideoBtn) overviewVideoBtn.addEventListener('click', () => startVideoReview(overviewMessage));

if (optionOverviewBtn) {
  optionOverviewBtn.addEventListener('click', () => {
    overviewMessage.textContent = '';
    overviewDirInput.value = '';
    // scannedVideos already carries overview_path from /api/scan (which
    // checks right next to each video by default), so the first render
    // here needs no extra round trip - Rescan only matters once the person
    // points at a separate overview folder.
    overviewScanResults = scannedVideos;
    renderOverviewScreen();
    showScreen(overviewSettingsScreen);
  });
}

reviewSettingsBackBtn.addEventListener('click', () => {
  showScreen(modeScreen);
});

compileSettingsBackBtn.addEventListener('click', () => {
  showScreen(modeScreen);
});

if (overviewBackBtn) {
  overviewBackBtn.addEventListener('click', () => {
    showScreen(modeScreen);
  });
}

/* ---------------- Prepare mode: pre-cache snapshots ahead of time ---------------- */

function getPreferredNumSnapshots() {
  // The setup screen's field is always present in the DOM (even when that
  // screen is hidden) and is kept in sync with currentSettings, so it's a
  // reasonable single source of truth for "how many snapshots" even when
  // prepare is kicked off from the review or done screens, which don't
  // have their own snapshot-count picker.
  const n = parseInt(snapshotCountInput.value, 10) ||
    (currentSettings && currentSettings.default_num_snapshots) || NUM_SNAPSHOTS || 20;
  return clampSnapshotCount(n);
}

let preparingForReview = false; // true while the setup-screen "Prepare" panel is
                                 // blocking Start-reviewing until every snapshot is ready
const startBtnIdleLabel = startBtn.textContent;

function setFolderControlsDisabled(disabled) {
  // Only one prepare job can run on the backend at a time - keep the other
  // two panels' buttons disabled too so a click there can't silently fail
  // (or, worse, target a different folder while this one is still running).
  preparePanels.forEach(p => {
    if (p.autoReview) return;
    if (p.btn) p.btn.disabled = disabled;
  });
}

function wirePreparePanel(panel) {
  if (!panel.btn) return;

  panel.btn.addEventListener('click', async () => {
    const path = (panel.pathInput.value || '').trim();
    if (!path) {
      panel.message.style.color = '';
      panel.message.textContent = 'Enter a folder path first.';
      return;
    }

    panel.message.style.color = '';
    panel.message.textContent = '';
    panel.btn.disabled = true;
    panel.btn.textContent = 'Starting…';

    if (panel.autoReview) {
      // The folder/file was already scanned back on the intro screen (that's
      // how we got to this settings screen at all) - no need to scan again,
      // which would also wipe out any files deselected on the mode screen.
      preparingForReview = true;
      startBtn.disabled = true;
      startBtn.textContent = 'Preparing snapshots…';
      setFolderControlsDisabled(true);
    }

    try {
      const res = await fetch('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, num_snapshots: getPreferredNumSnapshots() }),
      });
      const data = await res.json();
      if (!data.success) {
        panel.message.textContent = data.error || 'Could not start preparing that folder.';
        panel.btn.disabled = false;
        panel.btn.textContent = panel.idleLabel;
        if (panel.autoReview) {
          preparingForReview = false;
          startBtn.disabled = false;
          startBtn.textContent = startBtnIdleLabel;
          setFolderControlsDisabled(false);
        }
        return;
      }
      preparePanels.forEach(p => {
        if (p.cancelBtn) p.cancelBtn.disabled = false;
        if (p.progress) p.progress.classList.remove('hidden');
      });
      pollPrepareStatus();
    } catch (e) {
      panel.message.textContent = 'Could not reach the local server.';
      panel.btn.disabled = false;
      panel.btn.textContent = panel.idleLabel;
      if (panel.autoReview) {
        preparingForReview = false;
        startBtn.disabled = false;
        startBtn.textContent = startBtnIdleLabel;
        setFolderControlsDisabled(false);
      }
    }
  });

  if (panel.cancelBtn) {
    panel.cancelBtn.addEventListener('click', async () => {
      preparePanels.forEach(p => { if (p.cancelBtn) p.cancelBtn.disabled = true; });
      try {
        await fetch('/api/prepare/cancel', { method: 'POST' });
      } catch (e) {
        preparePanels.forEach(p => { if (p.cancelBtn) p.cancelBtn.disabled = false; });
      }
    });
  }
}

preparePanels.forEach(wirePreparePanel);

function pollPrepareStatus() {
  if (preparePollTimer) clearInterval(preparePollTimer);
  preparePollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/prepare/status');
      const data = await res.json();
      renderPrepareStatus(data);
      if (!data.running) {
        clearInterval(preparePollTimer);
        preparePollTimer = null;
        onPrepareFinished(data);
      }
    } catch (e) {
      // transient fetch error - keep polling rather than giving up
    }
  }, 700);
}

function renderPrepareStatus(data) {
  const total = data.total_videos || 0;
  const done = data.done_videos || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  preparePanels.forEach(panel => {
    if (!panel.fill) return;
    panel.progress.classList.remove('hidden');
    panel.fill.style.width = pct + '%';
    panel.statusLabel.textContent = data.running
      ? `Preparing… ${done} / ${total} video${total === 1 ? '' : 's'} (${pct}%)`
      : `${done} / ${total} video${total === 1 ? '' : 's'} prepared`;
    panel.currentFile.textContent = data.current_filename ? `Working on: ${data.current_filename}` : '';
  });
}

function onPrepareFinished(data) {
  preparePanels.forEach(panel => {
    if (!panel.btn) return;
    panel.btn.disabled = false;
    panel.btn.textContent = panel.idleLabel;
    if (panel.cancelBtn) panel.cancelBtn.disabled = true;
    panel.message.style.color = '';

    if (data.error) {
      panel.message.textContent = `Prepare stopped early: ${data.error}`;
      return;
    }
    if (data.cancelled) {
      panel.message.textContent = `Cancelled - ${data.done_videos} video${data.done_videos === 1 ? '' : 's'} were already cached before stopping.`;
      return;
    }
    let msg = `Done - ${data.done_videos} video${data.done_videos === 1 ? '' : 's'} ready for instant review.`;
    if (data.unreadable && data.unreadable.length) {
      msg += ` ${data.unreadable.length} file${data.unreadable.length === 1 ? '' : 's'} couldn't be read and will be auto-skipped during review.`;
    }
    panel.message.style.color = 'var(--success)';
    panel.message.textContent = msg;
  });

  if (preparingForReview) {
    preparingForReview = false;
    setFolderControlsDisabled(false);
    if (!data.error && !data.cancelled) {
      // Every snapshot is ready - go straight into reviewing this folder.
      startBtn.disabled = false;
      startBtn.textContent = startBtnIdleLabel;
      enterReviewScreen();
    } else {
      // Cancelled or failed - stay on the setup screen; the scan results
      // (and a manual Start button) are still right there if the person
      // wants to review anyway, with whatever got cached before stopping.
      startBtn.disabled = false;
      startBtn.textContent = startBtnIdleLabel;
    }
  }
}

/* ---------------- Batch screenshot compilation (settings + progress screens) ---------------- */

let compileBatchPollTimer = null;
const compileStartIdleLabel = compileStartBtn ? compileStartBtn.textContent : '';

function getExcludedIdsForBatch() {
  return Array.from(deselectedVideoIds);
}

if (compileOutputBrowseBtn) {
  compileOutputBrowseBtn.addEventListener('click', async () => {
    compileSettingsMessage.textContent = '';
    const picked = await pickPath('output', compileOutputInput.value);
    if (picked) compileOutputInput.value = picked;
  });
}

// Shared by both entry points into batch compilation: the normal "Create
// screenshot compilations" flow, and "Generate the missing overviews first"
// from the Sort-by-overview screen. `messageEl`/`triggerBtn` are whichever
// setup screen's own message/button the caller wants updated on failure.
async function launchCompileBatch({ path, excludedIds, outputDir, fromOverview, messageEl, triggerBtn, idleLabel }) {
  if (!path) {
    messageEl.textContent = 'Choose or paste a folder or video file path first.';
    return;
  }

  messageEl.textContent = '';
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = 'Starting…'; }

  try {
    const res = await fetch('/api/compile_batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        num_shots: getCompilationShots(),
        excluded_ids: excludedIds,
        output_dir: outputDir || '',
        recursive: scanRecursive,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      messageEl.textContent = data.error || 'Could not start creating compilations for that folder.';
      if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = idleLabel; }
      return;
    }
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = idleLabel; }

    compileBatchFromOverview = !!fromOverview;
    compileProgressSubtitle.textContent = `${data.total} video${data.total === 1 ? '' : 's'} · ${data.num_shots} screenshots each`;
    compileBatchFill.style.width = '0%';
    compileBatchProgressLabel.textContent = `0 / ${data.total} · 0%`;
    compileFileList.innerHTML = '';
    compileBatchMessage.style.color = '';
    compileBatchMessage.textContent = '';
    compileBatchCancelBtn.disabled = false;
    compileBatchDoneBtn.classList.add('hidden');
    if (compileBatchBackToOverviewBtn) compileBatchBackToOverviewBtn.classList.add('hidden');
    showScreen(compileProgressScreen);
    pollCompileBatchStatus();
  } catch (e) {
    messageEl.textContent = 'Could not reach the local server.';
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = idleLabel; }
  }
}

if (compileStartBtn) {
  compileStartBtn.addEventListener('click', () => {
    launchCompileBatch({
      path: (pathInput.value || '').trim(),
      excludedIds: getExcludedIdsForBatch(),
      outputDir: (compileOutputInput.value || '').trim(),
      fromOverview: false,
      messageEl: compileSettingsMessage,
      triggerBtn: compileStartBtn,
      idleLabel: compileStartIdleLabel,
    });
  });

  compileBatchCancelBtn.addEventListener('click', async () => {
    compileBatchCancelBtn.disabled = true;
    try {
      await fetch('/api/compile_batch/cancel', { method: 'POST' });
    } catch (e) {
      compileBatchCancelBtn.disabled = false;
    }
  });

  compileBatchDoneBtn.addEventListener('click', () => location.reload());

  if (compileBatchBackToOverviewBtn) {
    compileBatchBackToOverviewBtn.addEventListener('click', async () => {
      await rescanOverviews(); // pick up the overviews that were just generated
      showScreen(overviewSettingsScreen);
    });
  }
}

function pollCompileBatchStatus() {
  if (compileBatchPollTimer) clearInterval(compileBatchPollTimer);
  compileBatchPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/compile_batch/status');
      const data = await res.json();
      renderCompileBatchStatus(data);
      if (!data.running) {
        clearInterval(compileBatchPollTimer);
        compileBatchPollTimer = null;
        onCompileBatchFinished(data);
      }
    } catch (e) {
      // transient fetch error - keep polling rather than giving up
    }
  }, 700);
}

const COMPILE_FILE_BADGE = {
  pending: 'PENDING',
  processing: 'WORKING…',
  done: 'DONE',
  failed: 'FAILED',
};

function renderCompileBatchStatus(data) {
  const total = data.total_videos || 0;
  const done = data.done_videos || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  compileBatchFill.style.width = pct + '%';
  compileBatchProgressLabel.textContent = `${done} / ${total} · ${pct}%`;
  compileProgressSubtitle.textContent = data.running
    ? `Working on: ${data.current_filename || '…'}`
    : `${done} / ${total} video${total === 1 ? '' : 's'} processed`;

  const videos = data.videos || [];
  compileFileList.innerHTML = videos.map(v => {
    const active = v.id === data.current_id ? 'active' : '';
    return `<li class="${active}">
      <span class="badge ${v.status}">${COMPILE_FILE_BADGE[v.status] || v.status.toUpperCase()}</span>
      <span class="fname">${escapeHtml(v.filename)}</span>
    </li>`;
  }).join('');
}

function onCompileBatchFinished(data) {
  compileBatchCancelBtn.disabled = true;
  compileBatchDoneBtn.classList.remove('hidden');
  if (compileBatchBackToOverviewBtn) {
    compileBatchBackToOverviewBtn.classList.toggle('hidden', !compileBatchFromOverview);
  }
  compileBatchMessage.style.color = '';

  if (data.error) {
    compileBatchMessage.textContent = `Stopped early: ${data.error}`;
    return;
  }
  if (data.cancelled) {
    compileBatchMessage.textContent = `Cancelled - ${data.done_videos} video${data.done_videos === 1 ? '' : 's'} were already compiled before stopping.`;
    return;
  }
  let msg = `Done - ${data.done_videos} video${data.done_videos === 1 ? '' : 's'} processed.`;
  if (data.failed && data.failed.length) {
    msg += ` ${data.failed.length} file${data.failed.length === 1 ? '' : 's'} could not be compiled.`;
  }
  compileBatchMessage.style.color = 'var(--success)';
  compileBatchMessage.textContent = msg;
}

function renderOverviewScreen() {
  const active = overviewScanResults.filter(v => !deselectedVideoIds.has(v.id));
  const withOverview = active.filter(v => v.overview_path);
  const withoutOverview = active.filter(v => !v.overview_path);

  overviewStatusText.textContent = active.length
    ? `${withOverview.length} of ${active.length} video${active.length === 1 ? '' : 's'} already ${active.length === 1 ? 'has' : 'have'} a screenshot overview ready.` +
      (withoutOverview.length ? ` ${withoutOverview.length} still need one.` : '')
    : 'No videos are selected.';

  overviewReviewBtn.disabled = withOverview.length === 0;
  overviewGenerateBtn.disabled = withoutOverview.length === 0;

  overviewReviewDesc.textContent = withOverview.length
    ? `Sort the ${withOverview.length} video${withOverview.length === 1 ? '' : 's'} that already ${withOverview.length === 1 ? 'has' : 'have'} an overview.`
    : 'None yet - generate some first.';
  overviewGenerateDesc.textContent = withoutOverview.length
    ? `Create overviews for the ${withoutOverview.length} video${withoutOverview.length === 1 ? '' : 's'} missing one.`
    : 'Every selected video already has one.';

  overviewScanList.innerHTML = active.map(v => `<li>
      <span class="badge ${v.overview_path ? 'ready' : 'missing'}">${v.overview_path ? 'READY' : 'MISSING'}</span>
      <span class="fname">${escapeHtml(v.filename)}</span>
    </li>`).join('');
}

async function rescanOverviews() {
  overviewMessage.textContent = '';
  overviewRescanBtn.disabled = true;
  const idle = overviewRescanBtn.textContent;
  overviewRescanBtn.textContent = 'Checking…';
  try {
    const res = await fetch('/api/scan_overviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overview_dir: (overviewDirInput.value || '').trim() }),
    });
    const data = await res.json();
    if (!data.success) {
      overviewMessage.textContent = data.error || 'Could not check that folder.';
      return;
    }
    overviewScanResults = data.videos;
    scannedVideos = data.videos; // keep the main scan results in sync too
    renderOverviewScreen();
  } catch (e) {
    overviewMessage.textContent = 'Could not reach the local server.';
  } finally {
    overviewRescanBtn.disabled = false;
    overviewRescanBtn.textContent = idle;
  }
}

if (overviewRescanBtn) overviewRescanBtn.addEventListener('click', rescanOverviews);

if (overviewDirBrowseBtn) {
  overviewDirBrowseBtn.addEventListener('click', async () => {
    overviewMessage.textContent = '';
    const picked = await pickPath('output', overviewDirInput.value);
    if (picked) overviewDirInput.value = picked;
  });
}

if (overviewReviewBtn) {
  overviewReviewBtn.addEventListener('click', async () => {
    if (overviewReviewBtn.disabled) return;
    overviewMessage.textContent = '';

    const notReadyIds = overviewScanResults.filter(v => !v.overview_path).map(v => v.id);
    const excludeSet = new Set([...deselectedVideoIds, ...notReadyIds]);

    try {
      await fetch('/api/exclude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(excludeSet) }),
      });
      await fetch('/api/review_mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'overview' }),
      });
    } catch (e) {
      overviewMessage.textContent = 'Could not reach the local server.';
      return;
    }

    reviewMode = 'overview';
    showScreen(reviewScreen);
    refreshStatus();
  });
}

if (overviewGenerateBtn) {
  overviewGenerateBtn.addEventListener('click', async () => {
    if (overviewGenerateBtn.disabled) return;
    const readyIds = overviewScanResults.filter(v => v.overview_path).map(v => v.id);
    const excludedIds = Array.from(new Set([...deselectedVideoIds, ...readyIds]));
    // Note: no triggerBtn/idleLabel passed here - overviewGenerateBtn is a
    // card-style button with nested icon/title/desc spans, so swapping its
    // textContent for a "Starting…" label (as the plain compile-settings
    // button does) would wipe out that structure. Just disable it instead;
    // the screen navigates away almost immediately either way.
    overviewGenerateBtn.disabled = true;
    await launchCompileBatch({
      path: (pathInput.value || '').trim(),
      excludedIds,
      outputDir: (overviewDirInput.value || '').trim(),
      fromOverview: true,
      messageEl: overviewMessage,
    });
    overviewGenerateBtn.disabled = false; // harmless once already navigated to the progress screen
  });
}

async function enterReviewScreen() {
  if (deselectedVideoIds.size) {
    try {
      await fetch('/api/exclude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(deselectedVideoIds) }),
      });
    } catch (e) {
      // non-critical - worst case the deselected files still show up in the queue
    }
  }
  showScreen(reviewScreen);
  refreshStatus();
}

startBtn.addEventListener('click', () => {
  if (startBtn.disabled) return;
  enterReviewScreen();
});

restartBtn.addEventListener('click', () => location.reload());

stopBtn.addEventListener('click', async () => {
  stopSlideshow();
  stopBrokenPoll();
  releaseVideo();
  stopBtn.disabled = true;
  try {
    await fetch('/api/stop', { method: 'POST' });
  } catch (e) {
    // fall through - reload anyway so the user isn't stuck
  }
  location.reload();
});

/* ---------------- Review screen ---------------- */

async function refreshStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  if (data.num_snapshots) {
    NUM_SNAPSHOTS = data.num_snapshots;
    frameTotalEl.textContent = NUM_SNAPSHOTS;
    reviewSnapshotCountInput.value = NUM_SNAPSHOTS;
    const m = Array.from(reviewSnapshotPreset.options).find(o => o.value == NUM_SNAPSHOTS);
    reviewSnapshotPreset.value = m ? m.value : 'custom';
    updateReviewSnapshotLabel();
  }
  if (data.settings) {
    currentSettings = data.settings;
    renderLegend(currentSettings);
    if (data.settings.slideshow_interval_ms && !slideshowTimer) {
      // Only adopt the server value when nothing is actively playing, so we
      // never yank the speed out from under a slideshow mid-loop.
      const ms = clampSpeed(data.settings.slideshow_interval_ms);
      SLIDESHOW_INTERVAL_MS = ms;
      speedCountInput.value = ms;
      if (reviewSpeedCountInput) reviewSpeedCountInput.value = ms;
      syncSpeedPresets(ms);
      updateSpeedLabels(ms);
    }
  }
  reviewMode = data.review_mode || 'thumbnails';
  reviewScreen.classList.toggle('overview-mode', reviewMode === 'overview');
  reviewScreen.classList.toggle('video-mode', reviewMode === 'video');
  if (currentSettings) renderLegend(currentSettings); // legend lists the seek keys in video mode

  renderQueue(data);
  renderUnreadable(data);
  renderProgress(data);
  renderUndoButtons(data);

  if (data.total > 0 && data.current_index >= data.total) {
    showDone(data);
    return;
  }

  // In case we just undid our way back from the Done screen.
  showScreen(reviewScreen);

  const next = data.videos[data.current_index];
  if (!next) return;

  if (!currentVideo || currentVideo.id !== next.id) {
    currentVideo = next;
    loadPreview(next);
  }
}

function renderProgress(data) {
  progressFill.style.width = data.percent + '%';
  progressLabel.textContent = `${data.done} / ${data.total} · ${data.percent}%`;
}

function renderUndoButtons(data) {
  const canUndo = !!data.can_undo;
  const label = canUndo && data.undo_info
    ? `↶ Undo: ${data.undo_info.filename}`
    : '↶ Undo last action';
  [undoBtn, doneUndoBtn].forEach(btn => {
    if (!btn) return;
    btn.disabled = !canUndo;
    btn.innerHTML = btn === undoBtn
      ? `${escapeHtml(label)} <kbd style="margin-left:6px;">⌫</kbd>`
      : escapeHtml(label);
  });
}

function renderQueue(data) {
  queueList.innerHTML = data.videos.map((v, i) => {
    const active = i === data.current_index ? 'active' : '';
    const badgeText = v.status === 'moved' ? `→ ${v.destination}` :
      { pending: 'PENDING', deleted: 'DELETED', kept: 'KEPT', compiled: 'COMPILED', skipped: 'SKIPPED', auto_skipped: 'UNREADABLE' }[v.status] || v.status.toUpperCase();
    return `<li class="${active}">
      <span class="badge ${v.status}">${escapeHtml(badgeText)}</span>
      <span class="fname">${escapeHtml(v.filename)}</span>
    </li>`;
  }).join('');
}

function renderUnreadable(data) {
  const broken = data.videos.filter(v => v.status === 'auto_skipped');
  if (broken.length === 0) {
    unreadablePanel.classList.add('hidden');
    return;
  }
  unreadablePanel.classList.remove('hidden');
  unreadableList.innerHTML = broken.map(v =>
    `<li><span class="fname">${escapeHtml(v.filename)}</span></li>`
  ).join('');
}

function loadPreview(video) {
  if (reviewMode === 'overview') { loadOverviewPreview(video); return; }
  if (reviewMode === 'video') { loadVideoPreview(video); return; }

  stopSlideshow();
  stopBrokenPoll();
  currentImages = null;
  frameScrubber.disabled = true;
  previewLoading.classList.remove('hidden');
  previewLoading.textContent = 'Loading previews…';

  currentFilename.textContent = video.filename;
  currentFilemeta.textContent = fmtSize(video.size);

  const myToken = ++loadToken;

  const urls = [];
  for (let i = 0; i < NUM_SNAPSHOTS; i++) {
    urls.push(`/api/thumbnail/${video.id}/${i}?t=${Date.now()}`);
  }

  // Preload all frames before starting the loop for a smooth slideshow.
  let loaded = 0;
  const images = new Array(NUM_SNAPSHOTS);
  urls.forEach((url, i) => {
    const img = new Image();
    img.onload = img.onerror = () => {
      if (myToken !== loadToken) return; // user already moved on (e.g. hit Skip) - ignore
      loaded++;
      if (loaded === NUM_SNAPSHOTS) startSlideshow(images);
    };
    img.src = url;
    images[i] = img;
  });

  startBrokenPoll(video, myToken);
}

/* "Sort by screenshot overview" mode: skip video decoding entirely and just
   show the existing screenshot-overview grid image for this video. No
   slideshow timer, no scrubber, no per-frame requests - just one image. */
function loadOverviewPreview(video) {
  stopSlideshow();
  stopBrokenPoll();
  currentImages = null;
  frameScrubber.disabled = true;
  previewLoading.classList.remove('hidden');
  previewLoading.textContent = 'Loading screenshot overview…';

  currentFilename.textContent = video.filename;
  currentFilemeta.textContent = fmtSize(video.size);

  const myToken = ++loadToken;
  const img = new Image();
  img.onload = () => {
    if (myToken !== loadToken) return; // user already moved on - ignore
    previewLoading.classList.add('hidden');
    previewImg.src = img.src;
  };
  img.onerror = () => {
    if (myToken !== loadToken) return;
    previewLoading.textContent = 'No screenshot overview found for this video - Skip it, or press Compile to generate one now.';
  };
  img.src = `/api/overview_image/${video.id}?t=${Date.now()}`;
}

/* "Play the videos directly" mode: no snapshots and no overview images,
   just the video itself in a <video> element. The same element is reused
   for every video so volume and mute persist between videos. */
function loadVideoPreview(video, startAt = 0) {
  stopSlideshow();
  stopBrokenPoll();
  currentImages = null;
  frameScrubber.disabled = true;
  previewLoading.classList.remove('hidden');
  previewLoading.textContent = 'Loading video…';

  currentFilename.textContent = video.filename;
  currentFilemeta.textContent = fmtSize(video.size);

  // Drop focus from whatever was last clicked (a button, a slider) so the
  // arrow keys and Space always go to the video, not to that control.
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }

  const myToken = ++loadToken;
  previewVideo.onloadeddata = () => {
    if (myToken !== loadToken) return;
    previewLoading.classList.add('hidden');
  };
  previewVideo.onerror = () => {
    if (myToken !== loadToken) return;
    previewLoading.classList.remove('hidden');
    previewLoading.textContent = "This browser can't play this video format. Skip it (Esc), or sort it anyway with a key.";
  };

  previewVideo.src = `/api/video/${video.id}?t=${Date.now()}`;
  if (startAt > 0) {
    previewVideo.addEventListener('loadedmetadata', () => {
      if (myToken === loadToken) previewVideo.currentTime = startAt;
    }, { once: true });
  }
  const p = previewVideo.play();
  if (p && p.catch) p.catch(() => { /* autoplay blocked: the controls still work */ });
}

/* Stop playback and let go of the file. Required before a Delete / Sort
   moves it, since some systems refuse to move a file that is still open. */
function releaseVideo() {
  if (!previewVideo) return;
  previewVideo.onloadeddata = null;
  previewVideo.onerror = null;
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewVideo.load();
}

function seekVideo(deltaSeconds) {
  if (!previewVideo.getAttribute('src')) return;
  let t = previewVideo.currentTime + deltaSeconds;
  const dur = previewVideo.duration;
  if (Number.isFinite(dur)) t = Math.min(t, Math.max(0, dur - 0.1));
  previewVideo.currentTime = Math.max(0, t);
}

function toggleVideoPlayback() {
  if (!previewVideo.getAttribute('src')) return;
  if (previewVideo.paused) {
    const p = previewVideo.play();
    if (p && p.catch) p.catch(() => {});
  } else {
    previewVideo.pause();
  }
}

/* While a preview is loading, periodically check whether the backend has
   flagged this file as unreadable (every seek strategy AND the full
   sequential decode fallback failed on it) and, if so, skip it
   automatically instead of leaving the person staring at a stuck loader. */
function startBrokenPoll(video, myToken) {
  brokenPollTimer = setInterval(async () => {
    if (myToken !== loadToken) { stopBrokenPoll(); return; }
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      const v = data.videos.find(x => x.id === video.id);
      if (v && v.broken && v.status === 'pending' && myToken === loadToken) {
        stopBrokenPoll();
        await performAction('auto_skip');
      }
    } catch (e) {
      // non-critical - worst case the person can still hit Skip manually
    }
  }, 1500);
}

function stopBrokenPoll() {
  if (brokenPollTimer) { clearInterval(brokenPollTimer); brokenPollTimer = null; }
}

function startSlideshow(images, startIdx = 0) {
  stopBrokenPoll(); // it loaded fine - no need to keep checking for 'broken'
  previewLoading.classList.add('hidden');
  currentImages = images;
  slideshowIdx = startIdx;

  frameScrubber.max = NUM_SNAPSHOTS - 1;
  frameScrubber.value = slideshowIdx;
  frameScrubber.disabled = false;

  showFrame(images, slideshowIdx);
  restartSlideshowTimer();
}

function restartSlideshowTimer() {
  if (slideshowTimer) clearInterval(slideshowTimer);
  slideshowTimer = setInterval(() => {
    slideshowIdx = (slideshowIdx + 1) % NUM_SNAPSHOTS;
    showFrame(currentImages, slideshowIdx);
  }, SLIDESHOW_INTERVAL_MS);
}

function showFrame(images, i) {
  previewImg.src = images[i].src;
  frameIndexEl.textContent = i + 1;
  framePercentEl.textContent = `(${(i + 1) * (100 / NUM_SNAPSHOTS)}%)`;
  frameScrubber.value = i;
}

function stopSlideshow() {
  if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
}

/* Scrubbing: dragging pauses the auto-advance and shows the picked frame;
   releasing resumes the slideshow from that frame. */
frameScrubber.addEventListener('input', () => {
  if (!currentImages) return;
  if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
  slideshowIdx = parseInt(frameScrubber.value, 10);
  showFrame(currentImages, slideshowIdx);
});

frameScrubber.addEventListener('change', () => {
  if (!currentImages) return;
  restartSlideshowTimer();
});

function showDone(data) {
  stopSlideshow();
  stopBrokenPoll();
  releaseVideo();
  showScreen(doneScreen);
  const counts = {};
  data.videos.forEach(v => {
    const key = v.status === 'moved' ? `moved to /${v.destination}` : v.status;
    counts[key] = (counts[key] || 0) + 1;
  });
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
  doneSummary.textContent = `${data.total} video${data.total === 1 ? '' : 's'} processed - ${parts}`;
}

async function performAction(act) {
  if (busy || undoing || !currentVideo) return;
  busy = true;
  const body = { id: currentVideo.id, action: act };
  if (act === 'compile') body.num_shots = getCompilationShots();

  // Delete and sort-moves relocate the file, so in video mode the player
  // has to let go of it first. Keep/Skip/Compile don't touch it.
  const movesFile = !['keep', 'skip', 'compile', 'auto_skip'].includes(act);
  const releasedVideo = reviewMode === 'video' && movesFile;
  const resumeAt = releasedVideo ? previewVideo.currentTime : 0;
  if (releasedVideo) {
    releaseVideo();
    await new Promise(r => setTimeout(r, 150));
  }

  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.success) {
      stopSlideshow();
      stopBrokenPoll();
      currentImages = null;
      loadToken++; // invalidate any in-flight thumbnail loads for the video we just left
      currentVideo = null; // force next video to load
      await refreshStatus();
    } else {
      if (act === 'compile' && data.error) alert(data.error);
      // The action failed, so we're staying on this video: bring the player back.
      if (releasedVideo && currentVideo) loadVideoPreview(currentVideo, resumeAt);
    }
  } finally {
    busy = false;
  }
}

skipBtn.addEventListener('click', () => performAction('skip'));
if (compileBtn) compileBtn.addEventListener('click', () => performAction('compile'));

let undoing = false; // guard against double-firing, same idea as `busy` for performAction

async function performUndo() {
  if (undoing || busy) return;
  undoing = true;
  try {
    const res = await fetch('/api/undo', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      stopSlideshow();
      stopBrokenPoll();
      currentImages = null;
      loadToken++; // invalidate any in-flight thumbnail loads
      currentVideo = null; // force the (now-pending-again) video to reload
      await refreshStatus();
    }
    // On failure (nothing to undo) there's nothing to show - the button
    // is disabled in that state anyway, this just guards manual retries.
  } finally {
    undoing = false;
  }
}

if (undoBtn) undoBtn.addEventListener('click', performUndo);
if (doneUndoBtn) doneUndoBtn.addEventListener('click', performUndo);

document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  const isFormField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  const onReview = !reviewScreen.classList.contains('hidden');
  const onDone = !doneScreen.classList.contains('hidden');

  // Backspace undoes the previous action from either the review screen or
  // the done screen (so an accidental last action can still be reversed),
  // but never while the person is actually typing in a text field.
  if (e.key === 'Backspace' && !isFormField && (onReview || onDone)) {
    e.preventDefault();
    performUndo();
    return;
  }

  if (!onReview) return;

  // Skip always works, regardless of settings and even while a preview is
  // still (or forever) loading - it's the escape hatch for a stuck video.
  if (e.key === 'Escape') {
    performAction('skip');
    return;
  }

  // Video mode: arrow keys rewind / fast-forward, Space plays / pauses.
  // preventDefault also stops the native <video> controls from handling
  // the same key a second time when the player has focus.
  if (reviewMode === 'video' && !isFormField) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? VIDEO_SEEK_SECONDS_LONG : VIDEO_SEEK_SECONDS;
      seekVideo(e.key === 'ArrowLeft' ? -step : step);
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      toggleVideoPlayback();
      return;
    }
  }

  if (!currentSettings) return;
  const keyActions = buildKeyActionMap(currentSettings);
  const act = keyActions[e.key.toLowerCase()];
  if (!act) return;
  performAction(act);
});
