import './styles.css';
import { BrowserMediaPlayerController } from './mediaController';
import { getAdjacentIndexAfterRemoval, markPlaylistItemPlayed, movePlaylistItem, setCurrentPlaylistItem, type PlaylistItem } from './playlist';
import type {
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

function categorySubmenuId(categoryId: string): ViewSubmenu {
  return `preset-category:${categoryId}`;
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

      <header class="menu-bar">
        <div class="menu-group">
          <div class="menu-item-wrap">
            <button id="file-menu-button" class="menu-trigger" type="button" aria-haspopup="true" aria-expanded="false">File</button>
            <div id="file-menu" class="menu-dropdown" hidden>
              <button id="open-file-button" class="menu-action" type="button">Open File</button>
              <button id="add-files-button" class="menu-action" type="button">Add Files to Playlist</button>
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
          <span id="header-file-name">No file loaded</span>
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
          <p>This application plays local media in the browser with native playback when possible.</p>
          <p>When the browser cannot decode a format directly, it can fall back to FFmpeg WASM and transcode the media into a playable stream.</p>
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
    </main>
  `;

  const openFileInput = requireElement(app.querySelector<HTMLInputElement>('#open-file-input'), 'Open file input not found');
  const playlistFileInput = requireElement(app.querySelector<HTMLInputElement>('#playlist-file-input'), 'Playlist file input not found');
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
  const addFilesButton = requireElement(app.querySelector<HTMLButtonElement>('#add-files-button'), 'Add files button not found');
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
  const previousButton = requireElement(app.querySelector<HTMLButtonElement>('#previous-button'), 'Previous button not found');
  const playToggleButton = requireElement(app.querySelector<HTMLButtonElement>('#play-toggle-button'), 'Play toggle button not found');
  const playToggleIcon = requireElement(app.querySelector<HTMLElement>('#play-toggle-icon'), 'Play toggle icon not found');
  const nextButton = requireElement(app.querySelector<HTMLButtonElement>('#next-button'), 'Next button not found');
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
  const sidebar = requireElement(app.querySelector<HTMLElement>('#sidebar'), 'Sidebar not found');
  const rightPanelTabs = requireElement(app.querySelector<HTMLElement>('#right-panel-tabs'), 'Right panel tabs not found');
  const playlistTabButton = requireElement(app.querySelector<HTMLButtonElement>('#playlist-tab-button'), 'Playlist tab button not found');
  const debugTabButton = requireElement(app.querySelector<HTMLButtonElement>('#debug-tab-button'), 'Debug tab button not found');
  const playlistPanel = requireElement(app.querySelector<HTMLElement>('#playlist-panel'), 'Playlist panel not found');
  const debugPanel = requireElement(app.querySelector<HTMLElement>('#debug-panel'), 'Debug panel not found');
  const playlistEmpty = requireElement(app.querySelector<HTMLElement>('#playlist-empty'), 'Playlist empty state not found');
  const playlistList = requireElement(app.querySelector<HTMLDivElement>('#playlist-list'), 'Playlist list not found');
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
  let playlist: PlaylistItem[] = [];
  let playlistCounter = 0;
  let draggedPlaylistItemId: string | null = null;
  let autoAdvanceInProgress = false;
  let presetCycleTimeoutId: number | null = null;
  let presetCycleKey: string | null = null;
  let loadedPresetId: string | null = null;

  mediaElement.volume = storedVolumeSettings?.volume ?? 1;
  mediaElement.muted = storedVolumeSettings?.muted ?? false;
  volumeInput.value = `${Math.round((mediaElement.muted ? 0 : mediaElement.volume) * 100)}`;
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

  function createPlaylistItem(file: File): PlaylistItem {
    playlistCounter += 1;
    return {
      id: `playlist-${playlistCounter}`,
      file,
      name: file.name,
      status: 'pending',
    };
  }

  function getCurrentPlaylistItem(): PlaylistItem | null {
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
    if (!state.file) {
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
    const expectedFile = state.file;

    if (!shouldEnable) {
      visualizationCanvas.hidden = true;
      mediaElement.classList.remove('media-element--hidden');
      stopPresetCycleTimer();
      visualizer.stop();
      return;
    }

    void (async () => {
      await ensurePresetCatalogLoaded();
      if (currentState.file !== expectedFile || !isVisualizationEnabledForCurrentMedia(currentState)) {
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
      if (currentState.file !== expectedFile || !isVisualizationEnabledForCurrentMedia(currentState)) {
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
      state.file?.name ?? 'no-file',
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

    headerFileName.textContent = state.file?.name ?? getCurrentPlaylistItem()?.name ?? 'No file loaded';
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
    await controller.openFile(item.file);
    loadedPresetId = null;
    if (autoplay) {
      await controller.play();
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
    const nextFiles = Array.from(files);
    if (nextFiles.length === 0) {
      return;
    }

    const newItems = nextFiles.map((file) => createPlaylistItem(file));
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
    } else {
      render(currentState);
    }
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

  addFilesButton.addEventListener('click', () => {
    setMenu(null);
    playlistFileInput.click();
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
    if (!currentState.file) {
      return;
    }

    if (mediaElement.paused) {
      await controller.play();
      return;
    }

    controller.pause();
  });

  visualizationCanvas.addEventListener('click', async () => {
    if (!currentState.file) {
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
    if (!currentState.file || viewerCenterButton.disabled) {
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
