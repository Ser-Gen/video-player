import './styles.css';
import { BrowserMediaPlayerController } from './mediaController';
import { getAdjacentIndexAfterRemoval, markPlaylistItemPlayed, movePlaylistItem, setCurrentPlaylistItem, type PlaylistItem } from './playlist';
import { parseM3uPlaylist } from './m3u';
import { createHlsPlaylistSource, createLocalFileSource, createRemoteUrlSource, getSourceName } from './sourceUtils';
import type {
  MediaSourceItem,
  PlaybackMode,
  PlayerState,
  PresetCycleIntervalSec,
  RightPanelTab,
  VisualizationSettings,
  VisualizationSupportState,
} from './types';
import { formatTime, timelineRatioFromClientX, timelineTimeFromRatio } from './uiHelpers';
import { loadVisualizationPresetCatalog } from './visualizationLoader';
import { pickRandomPresetId, type VisualizationPresetCategory, type VisualizationPresetEntry } from './visualizationPresets';
import { readStoredVisualizationSettings, writeStoredVisualizationSettings } from './visualizationStorage';
import { ButterchurnVisualizerAdapter } from './visualizer';

type MenuName = 'file' | 'view' | 'help' | null;
type ViewSubmenu = 'preset' | 'cycle' | `preset-category:${string}` | null;

const VOLUME_STORAGE_KEY = 'video-player:volume-settings';
const CYCLE_INTERVAL_OPTIONS: Array<{ value: PresetCycleIntervalSec; label: string }> = [
  { value: null, label: 'Off' },
  { value: 30, label: '30 sec' },
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
];
const PLAYBACK_RATE_OPTIONS = [
  { value: '0.5', label: '0.5x' },
  { value: '1', label: '1x' },
  { value: '1.25', label: '1.25x' },
  { value: '1.5', label: '1.5x' },
  { value: '2', label: '2x' },
] as const;

function requireElement<T extends Element>(value: T | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function readStoredVolumeSettings(): { volume: number; muted: boolean } | null {
  try {
    const rawValue = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue) as {
      volume?: unknown;
      muted?: unknown;
    };
    const volume =
      typeof parsedValue.volume === 'number' && Number.isFinite(parsedValue.volume)
        ? Math.min(1, Math.max(0, parsedValue.volume))
        : null;
    const muted = typeof parsedValue.muted === 'boolean' ? parsedValue.muted : null;

    if (volume === null || muted === null) {
      return null;
    }

    return { volume, muted };
  } catch {
    return null;
  }
}

function writeStoredVolumeSettings(volume: number, muted: boolean): void {
  try {
    window.localStorage.setItem(
      VOLUME_STORAGE_KEY,
      JSON.stringify({
        volume: Math.min(1, Math.max(0, volume)),
        muted,
      }),
    );
  } catch {
    // Ignore storage failures so media controls keep working in restricted contexts.
  }
}

function normalizeVisualizationSettings(
  settings: VisualizationSettings,
  availablePresetEntries: VisualizationPresetEntry[],
): VisualizationSettings {
  const fallbackPresetId = availablePresetEntries[0]?.id ?? settings.selectedPresetId ?? null;
  const selectedPresetId =
    settings.selectedPresetId && availablePresetEntries.some((entry) => entry.id === settings.selectedPresetId)
      ? settings.selectedPresetId
      : fallbackPresetId;

  return {
    ...settings,
    selectedPresetId,
  };
}

function intervalLabel(interval: PresetCycleIntervalSec): string {
  return CYCLE_INTERVAL_OPTIONS.find((option) => option.value === interval)?.label ?? '1 min';
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return '-';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function categorySubmenuId(categoryId: string): ViewSubmenu {
  return `preset-category:${categoryId}`;
}

function normalizeUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function normalizeMimeTypeInput(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

function isSameOriginRemoteSource(source: MediaSourceItem): boolean {
  if (source.kind === 'local-file') {
    return true;
  }

  try {
    return new URL(source.url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function mount(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) {
    throw new Error('App root not found');
  }

  app.innerHTML = `
    <main class="app-shell">
      <input id="open-file-input" class="hidden-file-input" type="file" accept="audio/*,video/*,.mkv,.avi,.mov,.flac,.ts,.m2ts,.ogg,.opus" />
      <input id="playlist-file-input" class="hidden-file-input" type="file" accept="audio/*,video/*,.mkv,.avi,.mov,.flac,.ts,.m2ts,.ogg,.opus" multiple />
      <input id="playlist-import-input" class="hidden-file-input" type="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,text/plain" />

      <header class="menu-bar">
        <div class="menu-group">
          <div class="menu-item-wrap">
            <button id="file-menu-button" class="menu-trigger" type="button" aria-haspopup="true" aria-expanded="false">File</button>
            <div id="file-menu" class="menu-dropdown" hidden>
              <button id="open-file-button" class="menu-action" type="button">Open File</button>
              <button id="open-url-button" class="menu-action" type="button">Open URL</button>
              <button id="add-files-button" class="menu-action" type="button">Add Files to Playlist</button>
              <button id="import-playlist-url-button" class="menu-action" type="button">Import Playlist URL</button>
              <button id="import-playlist-file-button" class="menu-action" type="button">Import Playlist File</button>
            </div>
          </div>
          <div class="menu-item-wrap">
            <button id="view-menu-button" class="menu-trigger" type="button" aria-haspopup="true" aria-expanded="false">View</button>
            <div id="view-menu" class="menu-dropdown" hidden>
              <button id="playlist-toggle-button" class="menu-action" type="button">Playlist</button>
              <button id="debug-toggle-button" class="menu-action" type="button">Debug</button>
              <button id="visualization-toggle-button" class="menu-action" type="button">Visualization for Video</button>
              <div class="menu-submenu-wrap">
                <button id="preset-menu-button" class="menu-action menu-action--submenu" type="button" aria-haspopup="true" aria-expanded="false">Preset</button>
                <div id="preset-menu" class="menu-dropdown menu-dropdown--submenu" hidden></div>
              </div>
              <div class="menu-submenu-wrap">
                <button id="cycle-menu-button" class="menu-action menu-action--submenu" type="button" aria-haspopup="true" aria-expanded="false">Auto Change Preset</button>
                <div id="cycle-menu" class="menu-dropdown menu-dropdown--submenu" hidden></div>
              </div>
              <button id="next-random-preset-button" class="menu-action" type="button">Next Random Preset</button>
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
          <span id="header-file-name">No source loaded</span>
        </div>
      </header>

      <section class="workspace">
        <section class="viewer-section">
          <div class="viewer-stage">
            <div class="viewer-media-surface">
              <video id="media-element" playsinline preload="metadata"></video>
              <canvas id="visualization-canvas" class="visualization-canvas" hidden aria-label="Audio visualization"></canvas>
              <div id="viewer-center-overlay" class="viewer-center-overlay" hidden>
                <button id="viewer-center-button" class="viewer-center-button" type="button" aria-label="Start playback">
                  <span id="viewer-center-spinner" class="spinner" hidden aria-hidden="true"></span>
                  <span id="viewer-center-icon" class="viewer-center-icon" aria-hidden="true">▶</span>
                </button>
              </div>
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
                  <button id="previous-button" class="control-button icon-button" type="button" aria-label="Previous track">
                    <span aria-hidden="true">⏮</span>
                  </button>
                  <button id="play-toggle-button" class="control-button accent icon-button" type="button" aria-label="Play">
                    <span id="play-toggle-icon" aria-hidden="true">▶</span>
                  </button>
                  <button id="next-button" class="control-button icon-button" type="button" aria-label="Next track">
                    <span aria-hidden="true">⏭</span>
                  </button>
                  <button id="stop-button" class="control-button icon-button" type="button" aria-label="Stop">
                    <span aria-hidden="true">■</span>
                  </button>
                  <label class="playback-rate-wrap" aria-label="Playback speed">
                    <span class="playback-rate-label">Speed</span>
                    <select id="playback-rate-select" class="playback-rate-select">
                      ${PLAYBACK_RATE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('')}
                    </select>
                  </label>
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

        <aside id="sidebar" class="sidebar" hidden>
          <div id="right-panel-tabs" class="right-panel-tabs" hidden>
            <button id="playlist-tab-button" class="panel-tab" type="button">Playlist</button>
            <button id="debug-tab-button" class="panel-tab" type="button">Debug</button>
          </div>

          <section id="playlist-panel" class="sidebar-panel" hidden>
            <div class="section-head">
              <h2>Playlist</h2>
              <div class="section-actions">
                <button id="playlist-save-button" class="copy-button" type="button">Save</button>
                <button id="playlist-clear-button" class="copy-button" type="button">Clear</button>
              </div>
            </div>
            <div id="playlist-empty" class="sidebar-note">Playlist is empty.</div>
            <div id="playlist-list" class="playlist-list"></div>
          </section>

          <section id="debug-panel" class="sidebar-panel" hidden>
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
          </section>
        </aside>
      </section>

      <dialog id="about-dialog" class="about-dialog">
        <form method="dialog" class="about-dialog-form">
          <h2>About</h2>
          <p>This application plays local files, direct media URLs, and HLS playlists in the browser.</p>
          <p>When a local file is not browser-playable, it can fall back to FFmpeg WASM and transcode the media into a playable stream.</p>
          <button class="control-button accent" type="submit">Close</button>
        </form>
      </dialog>

      <dialog id="visualization-dialog" class="about-dialog">
        <form method="dialog" class="about-dialog-form">
          <h2>Visualization Unavailable</h2>
          <p id="visualization-dialog-message">Visualization is unavailable.</p>
          <button class="control-button accent" type="submit">Close</button>
        </form>
      </dialog>

      <dialog id="url-dialog" class="about-dialog">
        <form id="url-dialog-form" class="about-dialog-form">
          <h2 id="url-dialog-title">Open URL</h2>
          <p id="url-dialog-description">Enter a direct media URL.</p>
          <label class="stack-field">
            <span class="stack-label">URL</span>
            <input id="url-dialog-input" class="dialog-input" type="url" placeholder="https://example.com/media.mp4" />
          </label>
          <label id="url-dialog-mime-field" class="stack-field">
            <span class="stack-label">MIME type</span>
            <input id="url-dialog-mime-input" class="dialog-input" type="text" placeholder="Optional, for example audio/aac" />
          </label>
          <p id="url-dialog-error" class="error-box" hidden></p>
          <div class="dialog-actions">
            <button id="url-dialog-cancel" class="control-button" type="button">Cancel</button>
            <button id="url-dialog-submit" class="control-button accent" type="submit">Open</button>
          </div>
        </form>
      </dialog>

      <dialog id="playlist-clear-dialog" class="about-dialog">
        <form class="about-dialog-form">
          <h2>Clear Playlist</h2>
          <p id="playlist-clear-message">Are you sure you want to clear the playlist?</p>
          <div class="dialog-actions">
            <button id="playlist-clear-cancel" class="control-button" type="button">Cancel</button>
            <button id="playlist-clear-confirm" class="control-button accent" type="button">Clear</button>
          </div>
        </form>
      </dialog>
    </main>
  `;

  const openFileInput = requireElement(app.querySelector<HTMLInputElement>('#open-file-input'), 'Open file input not found');
  const playlistFileInput = requireElement(app.querySelector<HTMLInputElement>('#playlist-file-input'), 'Playlist file input not found');
  const playlistImportInput = requireElement(app.querySelector<HTMLInputElement>('#playlist-import-input'), 'Playlist import input not found');
  const mediaElement = requireElement(app.querySelector<HTMLVideoElement>('#media-element'), 'Media element not found');
  const visualizationCanvas = requireElement(app.querySelector<HTMLCanvasElement>('#visualization-canvas'), 'Visualization canvas not found');
  const viewerCenterOverlay = requireElement(app.querySelector<HTMLDivElement>('#viewer-center-overlay'), 'Viewer center overlay not found');
  const viewerCenterButton = requireElement(app.querySelector<HTMLButtonElement>('#viewer-center-button'), 'Viewer center button not found');
  const viewerCenterSpinner = requireElement(app.querySelector<HTMLElement>('#viewer-center-spinner'), 'Viewer center spinner not found');
  const viewerCenterIcon = requireElement(app.querySelector<HTMLElement>('#viewer-center-icon'), 'Viewer center icon not found');
  const fileMenuButton = requireElement(app.querySelector<HTMLButtonElement>('#file-menu-button'), 'File menu button not found');
  const viewMenuButton = requireElement(app.querySelector<HTMLButtonElement>('#view-menu-button'), 'View menu button not found');
  const helpMenuButton = requireElement(app.querySelector<HTMLButtonElement>('#help-menu-button'), 'Help menu button not found');
  const fileMenu = requireElement(app.querySelector<HTMLDivElement>('#file-menu'), 'File menu not found');
  const viewMenu = requireElement(app.querySelector<HTMLDivElement>('#view-menu'), 'View menu not found');
  const helpMenu = requireElement(app.querySelector<HTMLDivElement>('#help-menu'), 'Help menu not found');
  const openFileButton = requireElement(app.querySelector<HTMLButtonElement>('#open-file-button'), 'Open file button not found');
  const openUrlButton = requireElement(app.querySelector<HTMLButtonElement>('#open-url-button'), 'Open URL button not found');
  const addFilesButton = requireElement(app.querySelector<HTMLButtonElement>('#add-files-button'), 'Add files button not found');
  const importPlaylistUrlButton = requireElement(
    app.querySelector<HTMLButtonElement>('#import-playlist-url-button'),
    'Import playlist URL button not found',
  );
  const importPlaylistFileButton = requireElement(
    app.querySelector<HTMLButtonElement>('#import-playlist-file-button'),
    'Import playlist file button not found',
  );
  const playlistToggleButton = requireElement(app.querySelector<HTMLButtonElement>('#playlist-toggle-button'), 'Playlist toggle button not found');
  const debugToggleButton = requireElement(app.querySelector<HTMLButtonElement>('#debug-toggle-button'), 'Debug toggle button not found');
  const visualizationToggleButton = requireElement(
    app.querySelector<HTMLButtonElement>('#visualization-toggle-button'),
    'Visualization toggle button not found',
  );
  const presetMenuButton = requireElement(app.querySelector<HTMLButtonElement>('#preset-menu-button'), 'Preset menu button not found');
  const presetMenu = requireElement(app.querySelector<HTMLDivElement>('#preset-menu'), 'Preset menu not found');
  const cycleMenuButton = requireElement(app.querySelector<HTMLButtonElement>('#cycle-menu-button'), 'Cycle menu button not found');
  const cycleMenu = requireElement(app.querySelector<HTMLDivElement>('#cycle-menu'), 'Cycle menu not found');
  const nextRandomPresetButton = requireElement(
    app.querySelector<HTMLButtonElement>('#next-random-preset-button'),
    'Next random preset button not found',
  );
  const aboutButton = requireElement(app.querySelector<HTMLButtonElement>('#about-button'), 'About button not found');
  const aboutDialog = requireElement(app.querySelector<HTMLDialogElement>('#about-dialog'), 'About dialog not found');
  const visualizationDialog = requireElement(
    app.querySelector<HTMLDialogElement>('#visualization-dialog'),
    'Visualization dialog not found',
  );
  const visualizationDialogMessage = requireElement(
    app.querySelector<HTMLElement>('#visualization-dialog-message'),
    'Visualization dialog message not found',
  );
  const urlDialog = requireElement(app.querySelector<HTMLDialogElement>('#url-dialog'), 'URL dialog not found');
  const urlDialogForm = requireElement(app.querySelector<HTMLFormElement>('#url-dialog-form'), 'URL dialog form not found');
  const urlDialogTitle = requireElement(app.querySelector<HTMLElement>('#url-dialog-title'), 'URL dialog title not found');
  const urlDialogDescription = requireElement(
    app.querySelector<HTMLElement>('#url-dialog-description'),
    'URL dialog description not found',
  );
  const urlDialogInput = requireElement(app.querySelector<HTMLInputElement>('#url-dialog-input'), 'URL dialog input not found');
  const urlDialogMimeField = requireElement(
    app.querySelector<HTMLElement>('#url-dialog-mime-field'),
    'URL dialog mime field not found',
  );
  const urlDialogMimeInput = requireElement(
    app.querySelector<HTMLInputElement>('#url-dialog-mime-input'),
    'URL dialog mime input not found',
  );
  const urlDialogError = requireElement(app.querySelector<HTMLElement>('#url-dialog-error'), 'URL dialog error not found');
  const urlDialogCancel = requireElement(app.querySelector<HTMLButtonElement>('#url-dialog-cancel'), 'URL dialog cancel not found');
  const urlDialogSubmit = requireElement(app.querySelector<HTMLButtonElement>('#url-dialog-submit'), 'URL dialog submit not found');
  const previousButton = requireElement(app.querySelector<HTMLButtonElement>('#previous-button'), 'Previous button not found');
  const playToggleButton = requireElement(app.querySelector<HTMLButtonElement>('#play-toggle-button'), 'Play toggle button not found');
  const playToggleIcon = requireElement(app.querySelector<HTMLElement>('#play-toggle-icon'), 'Play toggle icon not found');
  const nextButton = requireElement(app.querySelector<HTMLButtonElement>('#next-button'), 'Next button not found');
  const stopButton = requireElement(app.querySelector<HTMLButtonElement>('#stop-button'), 'Stop button not found');
  const playbackRateSelect = requireElement(
    app.querySelector<HTMLSelectElement>('#playback-rate-select'),
    'Playback rate select not found',
  );
  const muteButton = requireElement(app.querySelector<HTMLButtonElement>('#mute-button'), 'Mute button not found');
  const muteIcon = requireElement(app.querySelector<HTMLElement>('#mute-icon'), 'Mute icon not found');
  const volumeInput = requireElement(app.querySelector<HTMLInputElement>('#volume-input'), 'Volume input not found');
  const modeSelect = requireElement(app.querySelector<HTMLSelectElement>('#mode-select'), 'Mode select not found');
  const timeline = requireElement(app.querySelector<HTMLDivElement>('#timeline'), 'Timeline not found');
  const timelineProgress = requireElement(app.querySelector<HTMLDivElement>('#timeline-progress'), 'Timeline progress not found');
  const timelineHoverMarker = requireElement(app.querySelector<HTMLDivElement>('#timeline-hover-marker'), 'Timeline hover marker not found');
  const timelineTooltip = requireElement(app.querySelector<HTMLDivElement>('#timeline-tooltip'), 'Timeline tooltip not found');
  const transportTime = requireElement(app.querySelector<HTMLElement>('#transport-time'), 'Transport time not found');
  const headerFileName = requireElement(app.querySelector<HTMLElement>('#header-file-name'), 'Header source name not found');
  const sidebar = requireElement(app.querySelector<HTMLElement>('#sidebar'), 'Sidebar not found');
  const rightPanelTabs = requireElement(app.querySelector<HTMLElement>('#right-panel-tabs'), 'Right panel tabs not found');
  const playlistTabButton = requireElement(app.querySelector<HTMLButtonElement>('#playlist-tab-button'), 'Playlist tab button not found');
  const debugTabButton = requireElement(app.querySelector<HTMLButtonElement>('#debug-tab-button'), 'Debug tab button not found');
  const playlistPanel = requireElement(app.querySelector<HTMLElement>('#playlist-panel'), 'Playlist panel not found');
  const debugPanel = requireElement(app.querySelector<HTMLElement>('#debug-panel'), 'Debug panel not found');
  const playlistEmpty = requireElement(app.querySelector<HTMLElement>('#playlist-empty'), 'Playlist empty state not found');
  const playlistList = requireElement(app.querySelector<HTMLDivElement>('#playlist-list'), 'Playlist list not found');
  const playlistSaveButton = requireElement(
    app.querySelector<HTMLButtonElement>('#playlist-save-button'),
    'Playlist save button not found',
  );
  const playlistClearButton = requireElement(
    app.querySelector<HTMLButtonElement>('#playlist-clear-button'),
    'Playlist clear button not found',
  );
  const playlistClearDialog = requireElement(
    app.querySelector<HTMLDialogElement>('#playlist-clear-dialog'),
    'Playlist clear dialog not found',
  );
  const playlistClearMessage = requireElement(
    app.querySelector<HTMLElement>('#playlist-clear-message'),
    'Playlist clear message not found',
  );
  const playlistClearConfirm = requireElement(
    app.querySelector<HTMLButtonElement>('#playlist-clear-confirm'),
    'Playlist clear confirm button not found',
  );
  const playlistClearCancel = requireElement(
    app.querySelector<HTMLButtonElement>('#playlist-clear-cancel'),
    'Playlist clear cancel button not found',
  );
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
  const visualizer = new ButterchurnVisualizerAdapter(visualizationCanvas);
  const storedVolumeSettings = readStoredVolumeSettings();
  let presetEntries: VisualizationPresetEntry[] = [];
  let presetCategories: VisualizationPresetCategory[] = [];
  let presetCatalogStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  let presetCatalogError: string | null = null;
  let presetCatalogPromise: Promise<void> | null = null;
  let visualizationSettings = normalizeVisualizationSettings(readStoredVisualizationSettings(), presetEntries);
  let visualizationSupportState: VisualizationSupportState = visualizer.supportState;
  let currentState: PlayerState = controller.state;
  let activeMenu: MenuName = null;
  let activeViewSubmenu: ViewSubmenu = null;
  let hoverTimeSec: number | null = null;
  let hoverRatio = 0;
  let rightPanelTab: RightPanelTab = 'playlist';
  let playlistVisible = false;
  let debugVisible = false;
  let playlist: PlaylistItem<MediaSourceItem>[] = [];
  let playlistCounter = 0;
  let draggedPlaylistItemId: string | null = null;
  let autoAdvanceInProgress = false;
  let presetCycleTimeoutId: number | null = null;
  let presetCycleKey: string | null = null;
  let loadedPresetId: string | null = null;
  let sidebarMessage: string | null = null;
  let urlDialogMode: 'open-url' | 'import-playlist-url' = 'open-url';

  mediaElement.volume = storedVolumeSettings?.volume ?? 1;
  mediaElement.muted = storedVolumeSettings?.muted ?? false;
  mediaElement.playbackRate = 1;
  volumeInput.value = `${Math.round((mediaElement.muted ? 0 : mediaElement.volume) * 100)}`;
  playbackRateSelect.value = '1';
  bindCopyButton(copyDiagButton, () => diagOutput.textContent ?? '');
  bindCopyButton(copyLogsButton, () => logsOutput.textContent ?? '');

  function getSelectedPresetEntry(): VisualizationPresetEntry | null {
    return presetEntries.find((entry) => entry.id === visualizationSettings.selectedPresetId) ?? null;
  }

  function showDialog(dialog: HTMLDialogElement): void {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
      return;
    }

    dialog.setAttribute('open', 'true');
  }

  function showVisualizationUnavailableDialog(): void {
    visualizationDialogMessage.textContent = getVisualizationBlockedMessage();
    showDialog(visualizationDialog);
  }

  function getVisualizationBlockedMessage(): string {
    if (currentState.source && !isSameOriginRemoteSource(currentState.source)) {
      return 'Visualization is unavailable for this remote source because the server does not grant the CORS access required by the Web Audio API.';
    }

    if (!visualizationSupportState.supported) {
      return visualizationSupportState.message;
    }

    if (presetCatalogStatus === 'failed') {
      return presetCatalogError ?? 'Visualization presets could not be loaded.';
    }

    if (presetCatalogStatus === 'loading') {
      return 'Visualization presets are still loading.';
    }

    return 'Visualization is unavailable right now.';
  }

  function canUseVisualizationForSource(source: MediaSourceItem | null): boolean {
    if (!source) {
      return false;
    }

    return source.kind === 'local-file' || isSameOriginRemoteSource(source);
  }

  async function ensurePresetCatalogLoaded(): Promise<void> {
    if (presetCatalogStatus === 'ready') {
      return;
    }

    if (presetCatalogPromise) {
      return presetCatalogPromise;
    }

    presetCatalogStatus = 'loading';
    presetCatalogError = null;
    renderVisualizationMenu();

    presetCatalogPromise = loadVisualizationPresetCatalog()
      .then((catalog) => {
        presetEntries = catalog.presetEntries;
        presetCategories = catalog.presetCategories;
        presetCatalogStatus = 'ready';
        visualizationSettings = normalizeVisualizationSettings(visualizationSettings, presetEntries);
        persistVisualizationSettings();
      })
      .catch((error: unknown) => {
        presetCatalogStatus = 'failed';
        presetCatalogError =
          error instanceof Error ? error.message : 'Visualization presets could not be loaded.';
      })
      .finally(() => {
        presetCatalogPromise = null;
        render(currentState);
      });

    return presetCatalogPromise;
  }

  function createPlaylistItem(source: MediaSourceItem): PlaylistItem<MediaSourceItem> {
    playlistCounter += 1;
    return {
      id: `playlist-${playlistCounter}`,
      source,
      name: getSourceName(source),
      status: 'pending',
    };
  }

  function getCurrentPlaylistItem(): PlaylistItem<MediaSourceItem> | null {
    return playlist.find((item) => item.status === 'current') ?? null;
  }

  function hasVisibleRightPanel(): boolean {
    return playlistVisible || debugVisible;
  }

  function resolveRightPanelTab(): void {
    if (playlistVisible && !debugVisible) {
      rightPanelTab = 'playlist';
      return;
    }

    if (debugVisible && !playlistVisible) {
      rightPanelTab = 'debug';
      return;
    }

    if (!playlistVisible && !debugVisible) {
      rightPanelTab = 'playlist';
    }
  }

  function setViewSubmenu(submenu: ViewSubmenu): void {
    activeViewSubmenu = submenu;
    presetMenuButton.setAttribute('aria-expanded', String(submenu === 'preset' || submenu?.startsWith('preset-category:')));
    cycleMenuButton.setAttribute('aria-expanded', String(submenu === 'cycle'));
  }

  function setMenu(menu: MenuName): void {
    activeMenu = menu;
    fileMenu.hidden = menu !== 'file';
    viewMenu.hidden = menu !== 'view';
    helpMenu.hidden = menu !== 'help';
    fileMenuButton.setAttribute('aria-expanded', String(menu === 'file'));
    viewMenuButton.setAttribute('aria-expanded', String(menu === 'view'));
    helpMenuButton.setAttribute('aria-expanded', String(menu === 'help'));

    if (menu !== 'view') {
      setViewSubmenu(null);
    }
  }

  function persistVisualizationSettings(): void {
    writeStoredVisualizationSettings(visualizationSettings);
  }

  function isVisualizationEnabledForCurrentMedia(state: PlayerState = currentState): boolean {
    if (!state.source || !canUseVisualizationForSource(state.source)) {
      return false;
    }

    return state.isAudioOnly || visualizationSettings.visualizationEnabledForVideo;
  }

  function isVisualizationPlaying(state: PlayerState = currentState): boolean {
    return (
      isVisualizationEnabledForCurrentMedia(state) &&
      visualizationSupportState.supported &&
      state.status === 'playing' &&
      state.playbackPhase === 'playing' &&
      !state.error
    );
  }

  function stopPresetCycleTimer(): void {
    if (presetCycleTimeoutId !== null) {
      window.clearTimeout(presetCycleTimeoutId);
      presetCycleTimeoutId = null;
    }
    presetCycleKey = null;
  }

  function renderPresetMenu(): void {
    const selectedPreset = getSelectedPresetEntry();
    const nestedCategoryId = activeViewSubmenu?.startsWith('preset-category:')
      ? activeViewSubmenu.slice('preset-category:'.length)
      : null;

    if (presetCatalogStatus === 'loading') {
      presetMenu.innerHTML = `<div class="menu-action menu-action--static">Loading presets…</div>`;
      presetMenu.hidden = activeMenu !== 'view' || (activeViewSubmenu !== 'preset' && !activeViewSubmenu?.startsWith('preset-category:'));
      return;
    }

    if (presetCatalogStatus === 'failed') {
      presetMenu.innerHTML = `<div class="menu-action menu-action--static">Failed to load presets</div>`;
      presetMenu.hidden = activeMenu !== 'view' || (activeViewSubmenu !== 'preset' && !activeViewSubmenu?.startsWith('preset-category:'));
      return;
    }

    presetMenu.innerHTML = presetCategories
      .map((category) => {
        const submenuVisible = nestedCategoryId === category.id;
        return `
          <div class="menu-submenu-wrap menu-submenu-wrap--nested">
            <button
              class="menu-action menu-action--submenu"
              type="button"
              data-preset-category="${escapeHtml(category.id)}"
              aria-haspopup="true"
              aria-expanded="${submenuVisible ? 'true' : 'false'}"
            >${escapeHtml(category.label)}</button>
            <div class="menu-dropdown menu-dropdown--submenu menu-dropdown--nested" ${submenuVisible ? '' : 'hidden'}>
              ${category.presets
                .map(
                  (preset) => `
                    <button
                      class="menu-action"
                      type="button"
                      data-preset-id="${escapeHtml(preset.id)}"
                    >${escapeHtml(preset.label)}${selectedPreset?.id === preset.id ? ' ✓' : ''}</button>
                  `,
                )
                .join('')}
            </div>
          </div>
        `;
      })
      .join('');
    presetMenu.hidden = activeMenu !== 'view' || (activeViewSubmenu !== 'preset' && !activeViewSubmenu?.startsWith('preset-category:'));
  }

  function renderCycleMenu(): void {
    cycleMenu.innerHTML = CYCLE_INTERVAL_OPTIONS.map(
      (option) => `
        <button class="menu-action" type="button" data-cycle-interval="${option.value === null ? 'off' : option.value}">
          ${escapeHtml(option.label)}${visualizationSettings.autoCycleIntervalSec === option.value ? ' ✓' : ''}
        </button>
      `,
    ).join('');
    cycleMenu.hidden = activeMenu !== 'view' || activeViewSubmenu !== 'cycle';
  }

  function renderVisualizationMenu(): void {
    const selectedPreset = getSelectedPresetEntry();
    const presetActionsDisabled =
      !visualizationSupportState.supported || presetCatalogStatus === 'loading' || presetCatalogStatus === 'failed';

    visualizationToggleButton.textContent = visualizationSettings.visualizationEnabledForVideo
      ? 'Visualization for Video ✓'
      : 'Visualization for Video';
    presetMenuButton.textContent =
      presetCatalogStatus === 'loading'
        ? 'Preset (loading...)'
        : selectedPreset
          ? `Preset: ${selectedPreset.label}`
          : 'Preset';
    cycleMenuButton.textContent =
      presetCatalogStatus === 'loading'
        ? 'Auto Change Preset (loading...)'
        : `Auto Change Preset: ${intervalLabel(visualizationSettings.autoCycleIntervalSec)}`;

    visualizationToggleButton.classList.toggle('menu-action--disabled', !visualizationSupportState.supported);
    visualizationToggleButton.setAttribute('aria-disabled', String(!visualizationSupportState.supported));
    visualizationToggleButton.title = !visualizationSupportState.supported ? getVisualizationBlockedMessage() : '';

    for (const button of [presetMenuButton, cycleMenuButton, nextRandomPresetButton]) {
      button.classList.toggle('menu-action--disabled', presetActionsDisabled);
      button.setAttribute('aria-disabled', String(presetActionsDisabled));
      button.title = presetActionsDisabled ? getVisualizationBlockedMessage() : '';
    }

    renderPresetMenu();
    renderCycleMenu();
  }

  function renderMediaInfo(state: PlayerState): void {
    if (!state.mediaInfo && state.probeStatus === 'running') {
      mediaInfo.innerHTML = `<div><dt>FFmpeg info</dt><dd>Collecting in background...</dd></div>`;
      return;
    }

    const info = state.mediaInfo;
    const sourceSize =
      state.source?.kind === 'local-file'
        ? state.source.file.size
        : null;
    const entries = [
      ['File size', formatFileSize(sourceSize)],
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
      ['Source', state.source?.name ?? '-'],
      ['Kind', state.source?.kind ?? '-'],
      ['Engine', state.resolvedEngine ?? '-'],
      ['Status', state.status],
      ['Phase', state.playbackPhase],
      ['Probe', state.probeStatus],
      ['Current', formatTime(state.currentTimeSec)],
      ['Total', formatTime(state.durationSec)],
      ['Visualizer', isVisualizationEnabledForCurrentMedia(state) ? 'Enabled' : 'Off'],
      ['Preset Cycle', intervalLabel(visualizationSettings.autoCycleIntervalSec)],
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
      <div><dt>Visualization</dt><dd>${visualizationSupportState.supported ? 'ready' : visualizationSupportState.reason}</dd></div>
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

  function renderPlaylist(): void {
    playlistEmpty.hidden = playlist.length > 0;
    playlistList.innerHTML = playlist
      .map(
        (item) => `
          <div class="playlist-item playlist-item--${item.status}" data-playlist-id="${item.id}" draggable="true">
            <button class="playlist-handle" type="button" aria-label="Reorder item" data-playlist-drag="${item.id}">⋮⋮</button>
            <button class="playlist-entry" type="button" data-playlist-play="${item.id}">
              <span class="playlist-entry-name">${item.name}</span>
            </button>
            <button class="playlist-remove" type="button" aria-label="Remove item" data-playlist-remove="${item.id}">×</button>
          </div>
        `,
      )
      .join('');
  }

  function renderRightPanel(): void {
    resolveRightPanelTab();
    sidebar.hidden = !hasVisibleRightPanel();
    rightPanelTabs.hidden = !(playlistVisible && debugVisible);
    playlistPanel.hidden = !playlistVisible || rightPanelTab !== 'playlist';
    debugPanel.hidden = !debugVisible || rightPanelTab !== 'debug';
    playlistTabButton.classList.toggle('panel-tab--active', rightPanelTab === 'playlist');
    debugTabButton.classList.toggle('panel-tab--active', rightPanelTab === 'debug');
    playlistToggleButton.textContent = playlistVisible ? 'Playlist ✓' : 'Playlist';
    debugToggleButton.textContent = debugVisible ? 'Debug ✓' : 'Debug';
    playlistSaveButton.disabled = playlist.length === 0;
    playlistClearButton.disabled = playlist.length === 0;
    renderPlaylist();
  }

  function applySelectedPreset(blendTimeSec: number): void {
    const selectedPreset = getSelectedPresetEntry();
    if (!selectedPreset || !visualizationSupportState.supported) {
      return;
    }

    if (loadedPresetId === selectedPreset.id) {
      return;
    }

    visualizer.loadPreset(selectedPreset.preset, blendTimeSec);
    loadedPresetId = selectedPreset.id;
  }

  function syncVisualizationState(state: PlayerState): void {
    const shouldEnable = isVisualizationEnabledForCurrentMedia(state);
    const expectedSource = state.source;

    if (!shouldEnable) {
      visualizationCanvas.hidden = true;
      mediaElement.classList.remove('media-element--hidden');
      stopPresetCycleTimer();
      visualizer.stop();
      if (state.source && !canUseVisualizationForSource(state.source)) {
        visualizer.dispose();
        visualizationSupportState = visualizer.supportState;
      }
      return;
    }

    void (async () => {
      await ensurePresetCatalogLoaded();
      if (currentState.source !== expectedSource || !isVisualizationEnabledForCurrentMedia(currentState)) {
        return;
      }

      if (presetCatalogStatus !== 'ready') {
        visualizationCanvas.hidden = true;
        mediaElement.classList.remove('media-element--hidden');
        stopPresetCycleTimer();
        visualizer.stop();
        return;
      }

      visualizationSupportState = await visualizer.attachMediaElement(mediaElement);
      if (currentState.source !== expectedSource || !isVisualizationEnabledForCurrentMedia(currentState)) {
        return;
      }

      if (!visualizationSupportState.supported) {
        visualizationCanvas.hidden = true;
        mediaElement.classList.remove('media-element--hidden');
        stopPresetCycleTimer();
        visualizer.stop();
        render(currentState);
        return;
      }

      applySelectedPreset(2);
      visualizer.resize();
      visualizationCanvas.hidden = false;
      mediaElement.classList.add('media-element--hidden');

      if (isVisualizationPlaying(currentState)) {
        visualizer.start();
      } else {
        visualizer.stop();
      }

      renderVisualizationMenu();
    })();
  }

  function queuePresetCycleIfNeeded(state: PlayerState): void {
    if (presetCatalogStatus !== 'ready' || !isVisualizationPlaying(state) || visualizationSettings.autoCycleIntervalSec === null) {
      stopPresetCycleTimer();
      return;
    }

    const nextCycleKey = [
      state.source?.name ?? 'no-source',
      visualizationSettings.selectedPresetId ?? 'no-preset',
      visualizationSettings.autoCycleIntervalSec,
      state.status,
      state.playbackPhase,
    ].join('|');

    if (presetCycleTimeoutId !== null && presetCycleKey === nextCycleKey) {
      return;
    }

    stopPresetCycleTimer();
    presetCycleKey = nextCycleKey;
    presetCycleTimeoutId = window.setTimeout(() => {
      const nextPresetId = pickRandomPresetId(
        presetEntries.map((entry) => entry.id),
        visualizationSettings.selectedPresetId,
      );

      if (!nextPresetId) {
        return;
      }

      visualizationSettings = {
        ...visualizationSettings,
        selectedPresetId: nextPresetId,
      };
      persistVisualizationSettings();
      loadedPresetId = null;
      presetCycleKey = null;
      render(currentState);
    }, visualizationSettings.autoCycleIntervalSec * 1000);
  }

  function render(state: PlayerState): void {
    currentState = state;
    syncVisualizationState(state);
    queuePresetCycleIfNeeded(state);

    headerFileName.textContent = state.source?.name ?? getCurrentPlaylistItem()?.name ?? 'No source loaded';
    modeSelect.value = state.playbackMode;
    logsOutput.textContent = state.logs.join('\n');

    const isPlaying = state.status === 'playing';
    playbackRateSelect.value = `${mediaElement.playbackRate}`;
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
      Boolean(state.source) &&
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
      !state.source
        ? 'Open a local file or URL from the File menu.'
        : state.source.kind === 'hls-playlist'
          ? canUseVisualizationForSource(state.source)
            ? 'HLS playback is active for this source. Native HLS is used when available, otherwise HLS.js handles playback.'
            : 'HLS playback is active for this source. Visualization is disabled because remote audio analysis requires CORS access.'
          : state.source.kind === 'remote-url'
            ? state.browserSupported
              ? canUseVisualizationForSource(state.source)
                ? 'This remote URL is using browser playback. FFmpeg fallback is not available for remote sources.'
                : 'This remote URL is using browser playback. Visualization is disabled because remote audio analysis requires CORS access.'
              : state.error
                ? 'This remote URL failed in browser playback. Remote FFmpeg fallback is not available in this version.'
                : 'Browser MIME detection is inconclusive for this remote URL. Trying direct browser playback without FFmpeg fallback.'
            : state.browserSupported
              ? state.probeStatus === 'running'
                ? 'Native browser playback is ready. FFmpeg metadata is still being collected in the background.'
                : 'Native browser playback is available for this local file. FFmpeg mode can still be forced.'
              : 'Native browser playback was not detected. FFmpeg fallback is active by default for this local file.';

    errorBox.textContent = state.error ?? sidebarMessage ?? '';
    errorBox.hidden = !(state.error ?? sidebarMessage);

    renderSession(state);
    renderMediaInfo(state);
    renderDiagnostics(state);
    renderTimeline(state);
    renderRightPanel();
    renderVisualizationMenu();
  }

  function selectPresetById(presetId: string): void {
    if (presetCatalogStatus !== 'ready') {
      return;
    }

    if (!presetEntries.some((entry) => entry.id === presetId)) {
      return;
    }

    visualizationSettings = {
      ...visualizationSettings,
      selectedPresetId: presetId,
    };
    persistVisualizationSettings();
    loadedPresetId = null;
    render(currentState);
  }

  function selectRandomPreset(): void {
    if (!visualizationSupportState.supported || presetCatalogStatus !== 'ready') {
      showVisualizationUnavailableDialog();
      return;
    }

    const nextPresetId = pickRandomPresetId(
      presetEntries.map((entry) => entry.id),
      visualizationSettings.selectedPresetId,
    );
    if (!nextPresetId) {
      return;
    }

    selectPresetById(nextPresetId);
    setMenu(null);
  }

  function resetUrlDialog(): void {
    urlDialogInput.value = '';
    urlDialogMimeInput.value = '';
    urlDialogError.hidden = true;
    urlDialogError.textContent = '';
  }

  function openUrlDialog(mode: 'open-url' | 'import-playlist-url'): void {
    urlDialogMode = mode;
    resetUrlDialog();
    urlDialogTitle.textContent = mode === 'open-url' ? 'Open URL' : 'Import Playlist URL';
    urlDialogDescription.textContent =
      mode === 'open-url'
        ? 'Enter a direct media URL. Browser-playable formats open directly, and HLS playlists use native HLS or HLS.js.'
        : 'Enter a playlist URL (.m3u or .m3u8). Standard M3U entries are imported into the playlist, and HLS manifests are added as a single stream source.';
    urlDialogSubmit.textContent = mode === 'open-url' ? 'Open' : 'Import';
    urlDialogMimeField.hidden = mode !== 'open-url';
    showDialog(urlDialog);
    queueMicrotask(() => {
      urlDialogInput.focus();
    });
  }

  function showUrlDialogError(message: string): void {
    urlDialogError.hidden = false;
    urlDialogError.textContent = message;
  }

  function setSidebarMessage(message: string | null): void {
    sidebarMessage = message;
  }

  function serializePlaylistToM3u(items: PlaylistItem<MediaSourceItem>[]): { text: string; skippedLocalFiles: number } {
    const lines = ['#EXTM3U'];
    let skippedLocalFiles = 0;

    for (const item of items) {
      if (item.source.kind === 'local-file') {
        skippedLocalFiles += 1;
        continue;
      }

      lines.push(`#EXTINF:-1,${item.name}`);
      lines.push(item.source.url);
    }

    return {
      text: `${lines.join('\n')}\n`,
      skippedLocalFiles,
    };
  }

  function downloadPlaylist(): void {
    const { text, skippedLocalFiles } = serializePlaylistToM3u(playlist);
    if (playlist.length === 0) {
      setSidebarMessage('Playlist is empty.');
      render(currentState);
      return;
    }

    if (text.trim() === '#EXTM3U') {
      setSidebarMessage(
        'Only remote URLs and HLS streams can be saved to .m3u. Local files are omitted because browsers do not expose stable file paths.',
      );
      render(currentState);
      return;
    }

    const blob = new Blob([text], { type: 'audio/x-mpegurl' });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = 'playlist.m3u';
    link.click();
    URL.revokeObjectURL(downloadUrl);

    setSidebarMessage(
      skippedLocalFiles > 0
        ? `Playlist saved. ${skippedLocalFiles} local file${skippedLocalFiles === 1 ? '' : 's'} were skipped because browsers do not expose stable file paths.`
        : null,
    );
    render(currentState);
  }

  async function clearPlaylist(): Promise<void> {
    playlist = [];
    playlistCounter = 0;
    loadedPresetId = null;
    setSidebarMessage(null);
    controller.clear();
    render(controller.state);
  }

  function addSourcesToPlaylist(
    sources: MediaSourceItem[],
    options?: {
      autoplayFirst?: boolean;
      showPlaylist?: boolean;
      markPreviousAsPlayed?: boolean;
    },
  ): void {
    if (sources.length === 0) {
      return;
    }

    setSidebarMessage(null);
    const newItems = sources.map((source) => createPlaylistItem(source));
    playlist = [...playlist, ...newItems];
    if (options?.showPlaylist ?? true) {
      playlistVisible = true;
      rightPanelTab = 'playlist';
    }

    if (options?.autoplayFirst) {
      void playPlaylistItem(newItems[0].id, {
        autoplay: true,
        markPreviousAsPlayed: options?.markPreviousAsPlayed,
      });
      return;
    }

    render(currentState);
  }

  function addFilesToPlaylist(
    files: FileList | File[],
    options?: {
      autoplayFirst?: boolean;
      showPlaylist?: boolean;
      markPreviousAsPlayed?: boolean;
    },
  ): void {
    addSourcesToPlaylist(Array.from(files).map((file) => createLocalFileSource(file)), options);
  }

  async function importPlaylistText(
    text: string,
    options?: {
      baseUrl?: string;
      playlistName?: string;
      autoplayFirst?: boolean;
    },
  ): Promise<void> {
    const parsedPlaylist = parseM3uPlaylist(text, {
      baseUrl: options?.baseUrl,
      playlistName: options?.playlistName,
    });

    if (parsedPlaylist.entries.length === 0) {
      throw new Error('The playlist does not contain any playable entries.');
    }

    addSourcesToPlaylist(parsedPlaylist.entries, {
      autoplayFirst: options?.autoplayFirst ?? false,
      showPlaylist: true,
    });
  }

  async function importPlaylistFromUrl(url: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Playlist request failed with status ${response.status}.`);
    }

    const text = await response.text();
    await importPlaylistText(text, {
      baseUrl: url,
      playlistName: getSourceName(createRemoteUrlSource(url)),
      autoplayFirst: false,
    });
  }

  async function importPlaylistFromFile(file: File): Promise<void> {
    const text = await file.text();
    await importPlaylistText(text, {
      playlistName: file.name,
      autoplayFirst: false,
    });
  }

  async function playPlaylistItem(
    itemId: string,
    options?: {
      autoplay?: boolean;
      markPreviousAsPlayed?: boolean;
    },
  ): Promise<void> {
    const item = playlist.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    const autoplay = options?.autoplay ?? true;
    playlist = setCurrentPlaylistItem(playlist, itemId, {
      markPreviousAsPlayed: options?.markPreviousAsPlayed,
    });
    render(currentState);
    await controller.openSource(item.source);
    loadedPresetId = null;
    if (autoplay) {
      await controller.play();
    }
    render(currentState);
  }

  async function removePlaylistEntry(itemId: string): Promise<void> {
    const removedIndex = playlist.findIndex((item) => item.id === itemId);
    if (removedIndex < 0) {
      return;
    }

    const removingCurrent = playlist[removedIndex]?.status === 'current';
    playlist = playlist.filter((item) => item.id !== itemId);

    if (!removingCurrent) {
      render(currentState);
      return;
    }

    const nextIndex = getAdjacentIndexAfterRemoval(removedIndex, playlist.length);
    if (nextIndex === null) {
      await controller.stop();
      render(currentState);
      return;
    }

    await playPlaylistItem(playlist[nextIndex].id, { autoplay: true });
  }

  async function playNextPlaylistItem(): Promise<void> {
    const currentItem = getCurrentPlaylistItem();
    if (!currentItem) {
      return;
    }

    const currentIndex = playlist.findIndex((item) => item.id === currentItem.id);
    if (currentIndex < 0) {
      return;
    }

    playlist = markPlaylistItemPlayed(playlist, currentItem.id);
    const nextItem = playlist[currentIndex + 1];
    if (!nextItem) {
      render(currentState);
      return;
    }

    await playPlaylistItem(nextItem.id, { autoplay: true });
  }

  async function playPreviousPlaylistItem(): Promise<void> {
    const currentItem = getCurrentPlaylistItem();
    if (!currentItem) {
      return;
    }

    const currentIndex = playlist.findIndex((item) => item.id === currentItem.id);
    if (currentIndex <= 0) {
      return;
    }

    await playPlaylistItem(playlist[currentIndex - 1].id, {
      autoplay: true,
      markPreviousAsPlayed: false,
    });
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

  viewMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenu(activeMenu === 'view' ? null : 'view');
    if (activeMenu === 'view' && visualizationSupportState.supported) {
      void ensurePresetCatalogLoaded();
    }
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
    openFileInput.click();
  });

  openUrlButton.addEventListener('click', () => {
    setMenu(null);
    openUrlDialog('open-url');
  });

  addFilesButton.addEventListener('click', () => {
    setMenu(null);
    playlistFileInput.click();
  });

  importPlaylistUrlButton.addEventListener('click', () => {
    setMenu(null);
    openUrlDialog('import-playlist-url');
  });

  importPlaylistFileButton.addEventListener('click', () => {
    setMenu(null);
    playlistImportInput.click();
  });

  playlistToggleButton.addEventListener('click', () => {
    playlistVisible = !playlistVisible;
    if (playlistVisible) {
      rightPanelTab = 'playlist';
    }
    setMenu(null);
    render(currentState);
  });

  debugToggleButton.addEventListener('click', () => {
    debugVisible = !debugVisible;
    if (debugVisible && !playlistVisible) {
      rightPanelTab = 'debug';
    }
    setMenu(null);
    render(currentState);
  });

  visualizationToggleButton.addEventListener('click', () => {
    if (!visualizationSupportState.supported) {
      showVisualizationUnavailableDialog();
      return;
    }

    visualizationSettings = {
      ...visualizationSettings,
      visualizationEnabledForVideo: !visualizationSettings.visualizationEnabledForVideo,
    };
    persistVisualizationSettings();
    if (visualizationSettings.visualizationEnabledForVideo) {
      void ensurePresetCatalogLoaded();
    }
    setMenu(null);
    render(currentState);
  });

  presetMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!visualizationSupportState.supported) {
      showVisualizationUnavailableDialog();
      return;
    }

    if (presetCatalogStatus === 'failed') {
      showVisualizationUnavailableDialog();
      return;
    }

    if (presetCatalogStatus !== 'ready') {
      void ensurePresetCatalogLoaded();
    }

    setViewSubmenu(activeViewSubmenu === 'preset' || activeViewSubmenu?.startsWith('preset-category:') ? null : 'preset');
    renderVisualizationMenu();
  });

  cycleMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!visualizationSupportState.supported || presetCatalogStatus !== 'ready') {
      showVisualizationUnavailableDialog();
      return;
    }

    setViewSubmenu(activeViewSubmenu === 'cycle' ? null : 'cycle');
    renderVisualizationMenu();
  });

  nextRandomPresetButton.addEventListener('click', (event) => {
    event.stopPropagation();
    selectRandomPreset();
  });

  presetMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!visualizationSupportState.supported || presetCatalogStatus !== 'ready') {
      showVisualizationUnavailableDialog();
      return;
    }

    const target = event.target as HTMLElement;
    const categoryButton = target.closest<HTMLElement>('[data-preset-category]');
    if (categoryButton) {
      const categoryId = categoryButton.dataset.presetCategory ?? '';
      const nextSubmenu = categorySubmenuId(categoryId);
      setViewSubmenu(activeViewSubmenu === nextSubmenu ? 'preset' : nextSubmenu);
      renderVisualizationMenu();
      return;
    }

    const presetButton = target.closest<HTMLElement>('[data-preset-id]');
    if (presetButton?.dataset.presetId) {
      selectPresetById(presetButton.dataset.presetId);
      setMenu(null);
    }
  });

  cycleMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!visualizationSupportState.supported || presetCatalogStatus !== 'ready') {
      showVisualizationUnavailableDialog();
      return;
    }

    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-cycle-interval]');
    if (!button) {
      return;
    }

    const rawValue = button.dataset.cycleInterval ?? 'off';
    const nextInterval =
      rawValue === 'off'
        ? null
        : rawValue === '30' || rawValue === '60' || rawValue === '120' || rawValue === '300'
          ? Number(rawValue)
          : visualizationSettings.autoCycleIntervalSec;

    visualizationSettings = {
      ...visualizationSettings,
      autoCycleIntervalSec: nextInterval as PresetCycleIntervalSec,
    };
    persistVisualizationSettings();
    setMenu(null);
    render(currentState);
  });

  playlistTabButton.addEventListener('click', () => {
    rightPanelTab = 'playlist';
    render(currentState);
  });

  debugTabButton.addEventListener('click', () => {
    rightPanelTab = 'debug';
    render(currentState);
  });

  aboutButton.addEventListener('click', () => {
    setMenu(null);
    showDialog(aboutDialog);
  });

  playlistSaveButton.addEventListener('click', () => {
    downloadPlaylist();
  });

  playlistClearButton.addEventListener('click', () => {
    if (playlist.length === 0) {
      return;
    }

    playlistClearMessage.textContent = `Are you sure you want to clear the playlist? ${playlist.length} item${playlist.length === 1 ? '' : 's'} will be removed.`;
    showDialog(playlistClearDialog);
  });

  playlistClearCancel.addEventListener('click', () => {
    playlistClearDialog.close();
  });

  playlistClearConfirm.addEventListener('click', () => {
    playlistClearDialog.close();
    void clearPlaylist();
  });

  urlDialogCancel.addEventListener('click', () => {
    urlDialog.close();
  });

  urlDialog.addEventListener('close', () => {
    resetUrlDialog();
  });

  urlDialogForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const normalizedUrl = normalizeUrlInput(urlDialogInput.value);
    const normalizedMimeType = normalizeMimeTypeInput(urlDialogMimeInput.value);
    if (!normalizedUrl) {
      showUrlDialogError('Enter a valid absolute URL.');
      return;
    }

    try {
      if (urlDialogMode === 'open-url') {
        const isHlsUrl = /\.m3u8(?:$|[?#])/i.test(normalizedUrl);
        const isHlsMimeType =
          normalizedMimeType === 'application/vnd.apple.mpegurl' || normalizedMimeType === 'application/x-mpegurl';
        const source = isHlsUrl || isHlsMimeType
          ? createHlsPlaylistSource(normalizedUrl)
          : createRemoteUrlSource(normalizedUrl, undefined, normalizedMimeType);
        addSourcesToPlaylist([source], {
          autoplayFirst: true,
          showPlaylist: true,
          markPreviousAsPlayed: false,
        });
      } else {
        await importPlaylistFromUrl(normalizedUrl);
      }

      urlDialog.close();
    } catch (error) {
      showUrlDialogError(error instanceof Error ? error.message : 'The URL could not be processed.');
    }
  });

  openFileInput.addEventListener('change', async () => {
    const file = openFileInput.files?.[0];
    openFileInput.value = '';
    if (!file) {
      return;
    }

    addFilesToPlaylist([file], {
      autoplayFirst: true,
      showPlaylist: true,
      markPreviousAsPlayed: false,
    });
  });

  playlistFileInput.addEventListener('change', () => {
    const files = playlistFileInput.files;
    if (!files || files.length === 0) {
      playlistFileInput.value = '';
      return;
    }

    const selectedFiles = Array.from(files);
    playlistFileInput.value = '';

    addFilesToPlaylist(selectedFiles, {
      autoplayFirst: false,
      showPlaylist: true,
    });
  });

  playlistImportInput.addEventListener('change', async () => {
    const file = playlistImportInput.files?.[0];
    playlistImportInput.value = '';
    if (!file) {
      return;
    }

    try {
      await importPlaylistFromFile(file);
    } catch (error) {
      setSidebarMessage(error instanceof Error ? error.message : 'The playlist file could not be imported.');
      render(currentState);
    }
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

  previousButton.addEventListener('click', async () => {
    await playPreviousPlaylistItem();
  });

  nextButton.addEventListener('click', async () => {
    await playNextPlaylistItem();
  });

  stopButton.addEventListener('click', async () => {
    await controller.stop();
  });

  playbackRateSelect.addEventListener('change', () => {
    mediaElement.playbackRate = Number(playbackRateSelect.value);
    render(currentState);
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
    writeStoredVolumeSettings(mediaElement.volume, mediaElement.muted);
    render(currentState);
  });

  mediaElement.addEventListener('click', async () => {
    if (!currentState.source) {
      return;
    }

    if (mediaElement.paused) {
      await controller.play();
      return;
    }

    controller.pause();
  });

  visualizationCanvas.addEventListener('click', async () => {
    if (!currentState.source) {
      return;
    }

    if (mediaElement.paused) {
      await controller.play();
      return;
    }

    controller.pause();
  });

  mediaElement.addEventListener('ended', async () => {
    if (autoAdvanceInProgress) {
      return;
    }
    autoAdvanceInProgress = true;
    try {
      await playNextPlaylistItem();
    } finally {
      autoAdvanceInProgress = false;
    }
  });

  viewerCenterButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!currentState.source || viewerCenterButton.disabled) {
      return;
    }

    await controller.play();
  });

  playlistList.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const removeButton = target.closest<HTMLElement>('[data-playlist-remove]');
    if (removeButton) {
      await removePlaylistEntry(removeButton.dataset.playlistRemove ?? '');
      return;
    }

    const playButton = target.closest<HTMLElement>('[data-playlist-play]');
    if (playButton) {
      await playPlaylistItem(playButton.dataset.playlistPlay ?? '', { autoplay: true });
    }
  });

  playlistList.addEventListener('dragstart', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-playlist-id]');
    if (!target) {
      return;
    }
    draggedPlaylistItemId = target.dataset.playlistId ?? null;
    target.classList.add('playlist-item--dragging');
    event.dataTransfer?.setData('text/plain', draggedPlaylistItemId ?? '');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  });

  playlistList.addEventListener('dragend', () => {
    draggedPlaylistItemId = null;
    playlistList.querySelectorAll('.playlist-item--dragging').forEach((node) => {
      node.classList.remove('playlist-item--dragging');
    });
  });

  playlistList.addEventListener('dragover', (event) => {
    if (!draggedPlaylistItemId) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  });

  playlistList.addEventListener('drop', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-playlist-id]');
    if (!target || !draggedPlaylistItemId) {
      return;
    }

    event.preventDefault();
    const fromIndex = playlist.findIndex((item) => item.id === draggedPlaylistItemId);
    const toIndex = playlist.findIndex((item) => item.id === target.dataset.playlistId);
    playlist = movePlaylistItem(playlist, fromIndex, toIndex);
    render(currentState);
  });

  window.addEventListener('resize', () => {
    if (!visualizationCanvas.hidden && visualizationSupportState.supported) {
      visualizer.resize();
    }
  });

  window.addEventListener('beforeunload', () => {
    stopPresetCycleTimer();
    visualizer.dispose();
    controller.dispose();
  });

  render(currentState);
}

mount();
