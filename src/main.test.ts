import { waitFor } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

interface MainMockOptions {
  supported?: boolean;
  message?: string;
}

async function loadMain(options?: MainMockOptions) {
  const supported = options?.supported ?? true;
  const message =
    options?.message ?? 'Visualization is unavailable because WebGL 2 is not supported in this browser.';

  vi.doMock('./visualizationLoader', () => ({
    loadVisualizationPresetCatalog: () =>
      Promise.resolve({
        presetEntries: [
          { id: 'Author A - Pulse', label: 'Author A - Pulse', category: 'Author A', preset: { id: 'pulse' } },
          { id: 'Author A - Wave', label: 'Author A - Wave', category: 'Author A', preset: { id: 'wave' } },
          { id: 'Artist B: Bloom', label: 'Artist B: Bloom', category: 'Artist B', preset: { id: 'bloom' } },
        ],
        presetCategories: [
          {
            id: 'artist-b',
            label: 'Artist B',
            presets: [{ id: 'Artist B: Bloom', label: 'Artist B: Bloom', category: 'Artist B', preset: { id: 'bloom' } }],
          },
          {
            id: 'author-a',
            label: 'Author A',
            presets: [
              { id: 'Author A - Pulse', label: 'Author A - Pulse', category: 'Author A', preset: { id: 'pulse' } },
              { id: 'Author A - Wave', label: 'Author A - Wave', category: 'Author A', preset: { id: 'wave' } },
            ],
          },
        ],
      }),
  }));

  vi.doMock('./visualizer', () => ({
    ButterchurnVisualizerAdapter: class {
      supportState = {
        supported,
        reason: supported ? 'supported' : 'webgl2_unavailable',
        message: supported ? 'Visualization is available.' : message,
      };

      initialize() {
        return this.supportState;
      }

      attachMediaElement() {
        return this.supportState;
      }

      loadPreset() {
        return undefined;
      }

      resize() {
        return undefined;
      }

      start() {
        return undefined;
      }

      stop() {
        return undefined;
      }

      dispose() {
        return undefined;
      }
    },
  }));

  await import('./main');
}

describe('main ui', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('restores saved volume settings on mount', async () => {
    localStorage.setItem(
      'video-player:volume-settings',
      JSON.stringify({
        volume: 0.35,
        muted: false,
      }),
    );

    await loadMain();

    const mediaElement = document.querySelector<HTMLVideoElement>('#media-element');
    const volumeInput = document.querySelector<HTMLInputElement>('#volume-input');

    expect(mediaElement).not.toBeNull();
    expect(volumeInput).not.toBeNull();
    expect(mediaElement!.volume).toBeCloseTo(0.35);
    expect(mediaElement!.muted).toBe(false);
    expect(volumeInput!.value).toBe('35');
  });

  it('stores volume changes in localStorage', async () => {
    await loadMain();

    const mediaElement = document.querySelector<HTMLVideoElement>('#media-element');
    const volumeInput = document.querySelector<HTMLInputElement>('#volume-input');

    expect(mediaElement).not.toBeNull();
    expect(volumeInput).not.toBeNull();

    volumeInput!.value = '27';
    volumeInput!.dispatchEvent(new Event('input', { bubbles: true }));

    expect(mediaElement!.volume).toBeCloseTo(0.27);
    expect(localStorage.getItem('video-player:volume-settings')).toBe('{"volume":0.27,"muted":false}');
  });

  it('restores visualization settings on mount', async () => {
    localStorage.setItem(
      'video-player:visualization-settings',
      JSON.stringify({
        visualizationEnabledForVideo: true,
        selectedPresetId: 'Artist B: Bloom',
        autoCycleIntervalSec: 120,
      }),
    );

    await loadMain();

    await userEvent.click(document.querySelector<HTMLButtonElement>('#view-menu-button')!);
    await waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('#preset-menu-button')?.textContent).not.toContain('loading');
    });

    expect(document.querySelector<HTMLButtonElement>('#visualization-toggle-button')?.textContent).toContain('✓');
    expect(document.querySelector<HTMLButtonElement>('#preset-menu-button')?.textContent).toContain('Artist B: Bloom');
    expect(document.querySelector<HTMLButtonElement>('#cycle-menu-button')?.textContent).toContain('2 min');
  });

  it('stores visualization settings after menu changes', async () => {
    await loadMain();

    await userEvent.click(document.querySelector<HTMLButtonElement>('#view-menu-button')!);
    await waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('#preset-menu-button')?.textContent).not.toContain('loading');
    });
    await userEvent.click(document.querySelector<HTMLButtonElement>('#visualization-toggle-button')!);
    await userEvent.click(document.querySelector<HTMLButtonElement>('#cycle-menu-button')!);
    await userEvent.click(document.querySelector<HTMLElement>('[data-cycle-interval="120"]')!);

    await userEvent.click(document.querySelector<HTMLButtonElement>('#view-menu-button')!);
    await userEvent.click(document.querySelector<HTMLButtonElement>('#preset-menu-button')!);
    await userEvent.click(document.querySelector<HTMLElement>('[data-preset-category="author-a"]')!);
    await userEvent.click(document.querySelector<HTMLElement>('[data-preset-id="Author A - Wave"]')!);

    expect(localStorage.getItem('video-player:visualization-settings')).toBe(
      '{"visualizationEnabledForVideo":true,"selectedPresetId":"Author A - Wave","autoCycleIntervalSec":120}',
    );
  });

  it('opens a dialog with the unavailability reason when visualization controls are not supported', async () => {
    await loadMain({
      supported: false,
      message: 'Visualization is unavailable because WebGL 2 is not supported in this browser.',
    });

    await userEvent.click(document.querySelector<HTMLButtonElement>('#view-menu-button')!);
    await userEvent.click(document.querySelector<HTMLButtonElement>('#preset-menu-button')!);

    expect(document.querySelector<HTMLDialogElement>('#visualization-dialog')?.hasAttribute('open')).toBe(true);
    expect(document.querySelector<HTMLElement>('#visualization-dialog-message')?.textContent).toContain('WebGL 2');
    expect(document.querySelector<HTMLButtonElement>('#preset-menu-button')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('shows visualization automatically for audio files and keeps it off for video until enabled', async () => {
    await loadMain();

    const audioInput = document.querySelector<HTMLInputElement>('#open-file-input')!;
    const visualizationCanvas = document.querySelector<HTMLCanvasElement>('#visualization-canvas')!;
    const mediaElement = document.querySelector<HTMLVideoElement>('#media-element')!;

    await userEvent.upload(audioInput, new File(['audio'], 'track.mp3', { type: 'audio/mpeg' }));
    await waitFor(() => {
      expect(visualizationCanvas.hidden).toBe(false);
      expect(mediaElement.classList.contains('media-element--hidden')).toBe(true);
    });

    await userEvent.upload(audioInput, new File(['video'], 'clip.mp4', { type: 'video/mp4' }));
    expect(visualizationCanvas.hidden).toBe(true);
    expect(mediaElement.classList.contains('media-element--hidden')).toBe(false);

    await userEvent.click(document.querySelector<HTMLButtonElement>('#view-menu-button')!);
    await waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('#preset-menu-button')?.textContent).not.toContain('loading');
    });
    await userEvent.click(document.querySelector<HTMLButtonElement>('#visualization-toggle-button')!);

    await waitFor(() => {
      expect(visualizationCanvas.hidden).toBe(false);
      expect(mediaElement.classList.contains('media-element--hidden')).toBe(true);
    });
  }, 15000);

  it('toggles playback when the visualization canvas is clicked', async () => {
    await loadMain();

    const audioInput = document.querySelector<HTMLInputElement>('#open-file-input')!;
    const visualizationCanvas = document.querySelector<HTMLCanvasElement>('#visualization-canvas')!;
    const mediaElement = document.querySelector<HTMLVideoElement>('#media-element')!;
    const pauseSpy = vi.spyOn(mediaElement, 'pause');

    await userEvent.upload(audioInput, new File(['audio'], 'track.mp3', { type: 'audio/mpeg' }));
    await waitFor(() => {
      expect(visualizationCanvas.hidden).toBe(false);
    });

    Object.defineProperty(mediaElement, 'paused', {
      configurable: true,
      get: () => false,
    });

    await userEvent.click(visualizationCanvas);
    await waitFor(() => {
      expect(pauseSpy).toHaveBeenCalled();
    });
  });
});
