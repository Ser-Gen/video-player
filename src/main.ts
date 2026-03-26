import './styles.css';
import { BrowserMediaPlayerController } from './mediaController';
import type { PlaybackMode, PlayerState } from './types';
import { formatTime, timelineRatioFromClientX, timelineTimeFromRatio } from './uiHelpers';

function requireElement<T extends Element>(value: T | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function bindCopyButton(button: HTMLButtonElement, getText: () => string): void {
  let resetId: number | null = null;

  button.addEventListener('click', async () => {
    const originalLabel = button.dataset.label ?? button.textContent ?? 'Copy';

    try {
      await copyToClipboard(getText());
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Failed';
    }

    if (resetId !== null) {
      window.clearTimeout(resetId);
    }

    resetId = window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1400);
  });
}

function mount(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) {
    throw new Error('App root not found');
  }

  app.innerHTML = `
    <main class="app-shell">
      <input id="file-input" class="hidden-file-input" type="file" accept="audio/*,video/*,.mkv,.avi,.mov,.flac,.ts,.m2ts,.ogg,.opus" />

      <header class="menu-bar">
        <div class="menu-group">
          <div class="menu-item-wrap">
            <button id="file-menu-button" class="menu-trigger" type="button" aria-haspopup="true" aria-expanded="false">File</button>
            <div id="file-menu" class="menu-dropdown" hidden>
              <button id="open-file-button" class="menu-action" type="button">Open File</button>
            </div>
          </div>
          <div class="menu-item-wrap">
            <button id="help-menu-button" class="menu-trigger" type="button" aria-haspopup="true" aria-expanded="false">Help</button>
            <div id="help-menu" class="menu-dropdown" hidden>
              <button id="about-button" class="menu-action" type="button">About</button>
            </div>
          </div>
        </div>
        <div class="menu-status">
          <span id="header-file-name">No file loaded</span>
        </div>
      </header>

      <section class="workspace">
        <section class="viewer-section">
          <div class="viewer-stage">
            <video id="media-element" playsinline preload="metadata"></video>
            <div id="viewer-center-overlay" class="viewer-center-overlay" hidden>
              <button id="viewer-center-button" class="viewer-center-button" type="button" aria-label="Start playback">
                <span id="viewer-center-spinner" class="spinner" hidden aria-hidden="true"></span>
                <span id="viewer-center-icon" class="viewer-center-icon" aria-hidden="true">▶</span>
              </button>
            </div>

            <div class="viewer-overlay">
              <div class="control-strip">
                <div class="timeline-wrap">
                  <div id="timeline" class="timeline" role="slider" aria-label="Seek timeline" tabindex="0">
                    <div id="timeline-progress" class="timeline-progress"></div>
                    <div id="timeline-hover-marker" class="timeline-hover-marker" hidden></div>
                    <div id="timeline-tooltip" class="timeline-tooltip" hidden>00:00</div>
                  </div>
                </div>
                <div class="control-group control-group-left">
                  <button id="play-toggle-button" class="control-button accent icon-button" type="button" aria-label="Play">
                    <span id="play-toggle-icon" aria-hidden="true">▶</span>
                  </button>
                  <button id="stop-button" class="control-button icon-button" type="button" aria-label="Stop">
                    <span aria-hidden="true">■</span>
                  </button>
                </div>

                <div class="control-group control-group-center">
                  <span id="transport-time" class="transport-time">--:-- / --:--</span>
                </div>

                <div class="control-group control-group-right">
                  <button id="mute-button" class="control-button icon-button" type="button" aria-label="Mute">
                    <span id="mute-icon" aria-hidden="true">🔊</span>
                  </button>
                  <label class="volume-wrap" aria-label="Volume">
                    <input id="volume-input" type="range" min="0" max="100" step="1" value="100" />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside class="sidebar">
          <section class="sidebar-section">
            <div class="section-head">
              <h2>Session</h2>
            </div>
            <div class="stack-field">
              <label class="stack-label" for="mode-select">Playback mode</label>
              <select id="mode-select">
                <option value="auto">Auto</option>
                <option value="browser">Browser</option>
                <option value="ffmpeg">FFmpeg</option>
              </select>
            </div>
            <div id="session-grid" class="meta-grid"></div>
            <p id="support-hint" class="sidebar-note"></p>
            <p id="error-box" class="error-box" hidden></p>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <h2>Media Info</h2>
            </div>
            <dl id="media-info" class="meta-grid"></dl>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <h2>Playback Diagnostics</h2>
              <button id="copy-diag-button" class="copy-button" type="button" data-label="Copy">Copy</button>
            </div>
            <div id="diag-summary" class="meta-grid"></div>
            <pre id="diag-output" class="log-output"></pre>
          </section>

          <section class="sidebar-section">
            <div class="section-head">
              <h2>Raw FFmpeg Log</h2>
              <button id="copy-logs-button" class="copy-button" type="button" data-label="Copy">Copy</button>
            </div>
            <pre id="logs-output" class="log-output"></pre>
          </section>
        </aside>
      </section>

      <dialog id="about-dialog" class="about-dialog">
        <form method="dialog" class="about-dialog-form">
          <h2>About</h2>
          <p>This application plays local media in the browser with native playback when possible.</p>
          <p>When the browser cannot decode a format directly, it can fall back to FFmpeg WASM and transcode the media into a playable stream.</p>
          <button class="control-button accent" type="submit">Close</button>
        </form>
      </dialog>
    </main>
  `;

  const fileInput = requireElement(app.querySelector<HTMLInputElement>('#file-input'), 'File input not found');
  const mediaElement = requireElement(app.querySelector<HTMLVideoElement>('#media-element'), 'Media element not found');
  const viewerCenterOverlay = requireElement(
    app.querySelector<HTMLDivElement>('#viewer-center-overlay'),
    'Viewer center overlay not found',
  );
  const viewerCenterButton = requireElement(
    app.querySelector<HTMLButtonElement>('#viewer-center-button'),
    'Viewer center button not found',
  );
  const viewerCenterSpinner = requireElement(
    app.querySelector<HTMLElement>('#viewer-center-spinner'),
    'Viewer center spinner not found',
  );
  const viewerCenterIcon = requireElement(
    app.querySelector<HTMLElement>('#viewer-center-icon'),
    'Viewer center icon not found',
  );
  const fileMenuButton = requireElement(app.querySelector<HTMLButtonElement>('#file-menu-button'), 'File menu button not found');
  const helpMenuButton = requireElement(app.querySelector<HTMLButtonElement>('#help-menu-button'), 'Help menu button not found');
  const fileMenu = requireElement(app.querySelector<HTMLDivElement>('#file-menu'), 'File menu not found');
  const helpMenu = requireElement(app.querySelector<HTMLDivElement>('#help-menu'), 'Help menu not found');
  const openFileButton = requireElement(app.querySelector<HTMLButtonElement>('#open-file-button'), 'Open file button not found');
  const aboutButton = requireElement(app.querySelector<HTMLButtonElement>('#about-button'), 'About button not found');
  const aboutDialog = requireElement(app.querySelector<HTMLDialogElement>('#about-dialog'), 'About dialog not found');
  const playToggleButton = requireElement(app.querySelector<HTMLButtonElement>('#play-toggle-button'), 'Play toggle button not found');
  const playToggleIcon = requireElement(app.querySelector<HTMLElement>('#play-toggle-icon'), 'Play toggle icon not found');
  const stopButton = requireElement(app.querySelector<HTMLButtonElement>('#stop-button'), 'Stop button not found');
  const muteButton = requireElement(app.querySelector<HTMLButtonElement>('#mute-button'), 'Mute button not found');
  const muteIcon = requireElement(app.querySelector<HTMLElement>('#mute-icon'), 'Mute icon not found');
  const volumeInput = requireElement(app.querySelector<HTMLInputElement>('#volume-input'), 'Volume input not found');
  const modeSelect = requireElement(app.querySelector<HTMLSelectElement>('#mode-select'), 'Mode select not found');
  const timeline = requireElement(app.querySelector<HTMLDivElement>('#timeline'), 'Timeline not found');
  const timelineProgress = requireElement(app.querySelector<HTMLDivElement>('#timeline-progress'), 'Timeline progress not found');
  const timelineHoverMarker = requireElement(app.querySelector<HTMLDivElement>('#timeline-hover-marker'), 'Timeline hover marker not found');
  const timelineTooltip = requireElement(app.querySelector<HTMLDivElement>('#timeline-tooltip'), 'Timeline tooltip not found');
  const transportTime = requireElement(app.querySelector<HTMLElement>('#transport-time'), 'Transport time not found');
  const headerFileName = requireElement(app.querySelector<HTMLElement>('#header-file-name'), 'Header file name not found');
  const sessionGrid = requireElement(app.querySelector<HTMLDivElement>('#session-grid'), 'Session grid not found');
  const mediaInfo = requireElement(app.querySelector<HTMLDListElement>('#media-info'), 'Media info not found');
  const diagSummary = requireElement(app.querySelector<HTMLDivElement>('#diag-summary'), 'Diag summary not found');
  const diagOutput = requireElement(app.querySelector<HTMLElement>('#diag-output'), 'Diag output not found');
  const logsOutput = requireElement(app.querySelector<HTMLElement>('#logs-output'), 'Logs output not found');
  const copyDiagButton = requireElement(app.querySelector<HTMLButtonElement>('#copy-diag-button'), 'Copy diag button not found');
  const copyLogsButton = requireElement(app.querySelector<HTMLButtonElement>('#copy-logs-button'), 'Copy logs button not found');
  const supportHint = requireElement(app.querySelector<HTMLElement>('#support-hint'), 'Support hint not found');
  const errorBox = requireElement(app.querySelector<HTMLElement>('#error-box'), 'Error box not found');

  const controller = new BrowserMediaPlayerController(mediaElement);
  let currentState: PlayerState = controller.state;
  let activeMenu: 'file' | 'help' | null = null;
  let hoverTimeSec: number | null = null;
  let hoverRatio = 0;

  mediaElement.volume = 1;
  mediaElement.muted = false;
  bindCopyButton(copyDiagButton, () => diagOutput.textContent ?? '');
  bindCopyButton(copyLogsButton, () => logsOutput.textContent ?? '');

  function setMenu(menu: 'file' | 'help' | null): void {
    activeMenu = menu;
    fileMenu.hidden = menu !== 'file';
    helpMenu.hidden = menu !== 'help';
    fileMenuButton.setAttribute('aria-expanded', String(menu === 'file'));
    helpMenuButton.setAttribute('aria-expanded', String(menu === 'help'));
  }

  function renderMediaInfo(state: PlayerState): void {
    if (!state.mediaInfo && state.probeStatus === 'running') {
      mediaInfo.innerHTML = `<div><dt>FFmpeg info</dt><dd>Collecting in background...</dd></div>`;
      return;
    }

    const info = state.mediaInfo;
    const entries = [
      ['Container', info?.container ?? '-'],
      ['Duration', info?.durationSec !== null && info?.durationSec !== undefined ? formatTime(info.durationSec) : '-'],
      ['Bitrate', info?.bitrate ?? '-'],
      ['Video codec', info?.video?.codec ?? '-'],
      ['Resolution', info?.video?.width && info?.video?.height ? `${info.video.width}x${info.video.height}` : '-'],
      ['FPS', info?.video?.fps ? `${info.video.fps}` : '-'],
      ['Audio codec', info?.audio?.codec ?? '-'],
      ['Sample rate', info?.audio?.sampleRate ? `${info.audio.sampleRate} Hz` : '-'],
      ['Channel layout', info?.audio?.channelLayout ?? '-'],
    ];

    mediaInfo.innerHTML = entries.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
  }

  function renderSession(state: PlayerState): void {
    const entries = [
      ['File', state.file?.name ?? '-'],
      ['Engine', state.resolvedEngine ?? '-'],
      ['Status', state.status],
      ['Phase', state.playbackPhase],
      ['Probe', state.probeStatus],
      ['Current', formatTime(state.currentTimeSec)],
      ['Total', formatTime(state.durationSec)],
    ];

    sessionGrid.innerHTML = entries.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
  }

  function renderDiagnostics(state: PlayerState): void {
    const ffmpegMs = state.ffmpegTimings.durationMs ?? '-';
    const attachMs = state.attachTimings.durationMs ?? '-';
    const lastError = state.lastPlaybackError
      ? `${state.lastPlaybackError.code}: ${state.lastPlaybackError.message}`
      : 'none';
    const probeState =
      state.probeStatus === 'running'
        ? 'Collecting FFmpeg info...'
        : state.probeStatus === 'failed'
          ? 'Background probe failed'
          : state.probeStatus;

    diagSummary.innerHTML = `
      <div><dt>Last error</dt><dd>${lastError}</dd></div>
      <div><dt>Probe status</dt><dd>${probeState}</dd></div>
      <div><dt>FFmpeg timing</dt><dd>${ffmpegMs === '-' ? '-' : `${ffmpegMs} ms`}</dd></div>
      <div><dt>Attach timing</dt><dd>${attachMs === '-' ? '-' : `${attachMs} ms`}</dd></div>
      <div><dt>Delivery mode</dt><dd>${state.transcodeSession?.deliveryMode ?? '-'}</dd></div>
    `;

    diagOutput.textContent = state.diagnostics
      .slice(-12)
      .map((entry) => {
        const time = new Date(entry.at).toLocaleTimeString();
        return `[${time}] ${entry.stage}: ${entry.message}${entry.detail ? ` (${entry.detail})` : ''}`;
      })
      .join('\n');
  }

  function renderTimeline(state: PlayerState): void {
    const durationSec = state.durationSec ?? 0;
    const playedRatio = durationSec > 0 ? Math.min(1, state.currentTimeSec / durationSec) : 0;
    timelineProgress.style.width = `${playedRatio * 100}%`;
    transportTime.textContent = `${formatTime(state.currentTimeSec)} / ${formatTime(state.durationSec)}`;

    if (hoverTimeSec === null || durationSec <= 0) {
      timelineTooltip.hidden = true;
      timelineHoverMarker.hidden = true;
      return;
    }

    timelineTooltip.hidden = false;
    timelineHoverMarker.hidden = false;
    timelineTooltip.textContent = formatTime(hoverTimeSec);
    timelineTooltip.style.left = `${hoverRatio * 100}%`;
    timelineHoverMarker.style.left = `${hoverRatio * 100}%`;
  }

  function render(state: PlayerState): void {
    currentState = state;
    headerFileName.textContent = state.file?.name ?? 'No file loaded';
    modeSelect.value = state.playbackMode;
    logsOutput.textContent = state.logs.join('\n');
    const isPlaying = state.status === 'playing';
    playToggleButton.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    playToggleIcon.textContent = isPlaying ? '⏸' : '▶';
    const isMuted = mediaElement.muted || mediaElement.volume === 0;
    muteButton.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
    muteIcon.textContent = isMuted ? '🔇' : '🔊';
    const isLoadingPhase =
      (state.playbackPhase === 'probing' && state.resolvedEngine === 'ffmpeg') ||
      state.playbackPhase === 'transcoding' ||
      state.playbackPhase === 'attaching' ||
      state.playbackPhase === 'buffering' ||
      state.status === 'seeking';
    const showCenteredPlay =
      Boolean(state.file) &&
      !isLoadingPhase &&
      state.playbackPhase !== 'playing' &&
      state.status !== 'playing' &&
      !state.error;

    viewerCenterOverlay.hidden = !isLoadingPhase && !showCenteredPlay;
    viewerCenterSpinner.hidden = !isLoadingPhase;
    viewerCenterIcon.hidden = !showCenteredPlay;
    viewerCenterButton.disabled = isLoadingPhase;
    viewerCenterButton.setAttribute('aria-label', isLoadingPhase ? 'Loading media' : 'Start playback');

    supportHint.textContent =
      state.browserSupported === null
        ? 'Open a local file from File > Open File.'
        : state.browserSupported
          ? state.probeStatus === 'running'
            ? 'Native browser playback is ready. FFmpeg metadata is still being collected in the background.'
            : 'Native browser playback is available for this file. FFmpeg mode can still be forced.'
          : 'Native browser playback was not detected. FFmpeg fallback is active by default.';

    errorBox.textContent = state.error ?? '';
    errorBox.hidden = !state.error;

    renderSession(state);
    renderMediaInfo(state);
    renderDiagnostics(state);
    renderTimeline(state);
  }

  function updateHoverFromPointer(clientX: number): void {
    const rect = timeline.getBoundingClientRect();
    hoverRatio = timelineRatioFromClientX(clientX, rect.left, rect.width);
    hoverTimeSec = timelineTimeFromRatio(hoverRatio, currentState.durationSec);
    renderTimeline(currentState);
  }

  controller.subscribe(render);

  fileMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenu(activeMenu === 'file' ? null : 'file');
  });

  helpMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenu(activeMenu === 'help' ? null : 'help');
  });

  document.addEventListener('click', () => {
    setMenu(null);
  });

  openFileButton.addEventListener('click', () => {
    setMenu(null);
    fileInput.click();
  });

  aboutButton.addEventListener('click', () => {
    setMenu(null);
    aboutDialog.showModal();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) {
      return;
    }
    await controller.openFile(file);
  });

  modeSelect.addEventListener('change', async () => {
    await controller.setMode(modeSelect.value as PlaybackMode);
  });

  playToggleButton.addEventListener('click', async () => {
    if (currentState.status === 'playing') {
      controller.pause();
      return;
    }

    await controller.play();
  });

  stopButton.addEventListener('click', async () => {
    await controller.stop();
  });

  muteButton.addEventListener('click', () => {
    mediaElement.muted = !mediaElement.muted;
    render(currentState);
  });

  volumeInput.addEventListener('input', () => {
    const nextVolume = Number(volumeInput.value) / 100;
    mediaElement.volume = nextVolume;
    mediaElement.muted = nextVolume === 0;
    render(currentState);
  });

  timeline.addEventListener('mousemove', (event) => {
    updateHoverFromPointer(event.clientX);
  });

  timeline.addEventListener('mouseleave', () => {
    hoverTimeSec = null;
    renderTimeline(currentState);
  });

  timeline.addEventListener('click', async (event) => {
    updateHoverFromPointer(event.clientX);
    if (hoverTimeSec !== null) {
      await controller.seek(hoverTimeSec);
    }
  });

  timeline.addEventListener('keydown', async (event) => {
    const durationSec = currentState.durationSec ?? 0;
    if (durationSec <= 0) {
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      await controller.seek(Math.max(0, currentState.currentTimeSec - 5));
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      await controller.seek(Math.min(durationSec, currentState.currentTimeSec + 5));
    }
  });

  mediaElement.addEventListener('volumechange', () => {
    volumeInput.value = `${Math.round((mediaElement.muted ? 0 : mediaElement.volume) * 100)}`;
    render(currentState);
  });

  mediaElement.addEventListener('click', async () => {
    if (!currentState.file) {
      return;
    }

    if (mediaElement.paused) {
      await controller.play();
      return;
    }

    controller.pause();
  });

  viewerCenterButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!currentState.file || viewerCenterButton.disabled) {
      return;
    }

    await controller.play();
  });

  window.addEventListener('beforeunload', () => {
    controller.dispose();
  });
}

mount();
