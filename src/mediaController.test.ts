import { BrowserMediaPlayerController, resolvePlaybackEngine, type FFmpegAdapter } from './mediaController';
import type { HlsClient, HlsClientFactory } from './hlsPlayback';
import { createHlsPlaylistSource, createRemoteUrlSource } from './sourceUtils';
import type { MediaInfo } from './types';

function createMediaInfo(): MediaInfo {
  return {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSec: 120,
    bitrate: '256 kb/s',
    video: {
      codec: 'h264',
      width: 1280,
      height: 720,
      fps: 30,
    },
    audio: {
      codec: 'aac',
      sampleRate: 48000,
      channelLayout: 'stereo',
    },
    rawLog: 'sample log',
  };
}

class MockFFmpegService implements FFmpegAdapter {
  probeCalls = 0;
  transcodeCalls: number[] = [];
  private listeners = new Set<(message: string) => void>();

  onLog(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async probe(): Promise<MediaInfo> {
    this.probeCalls += 1;
    for (const listener of this.listeners) {
      listener('probe log');
    }
    return createMediaInfo();
  }

  async transcodeFrom(_: File, startTimeSec: number): Promise<{
    blob: Blob;
    mimeType: string;
    mediaInfo: MediaInfo;
    segmentDurationSec: number;
  }> {
    this.transcodeCalls.push(startTimeSec);
    for (const listener of this.listeners) {
      listener(`transcode ${startTimeSec}`);
    }

    return {
      blob: new Blob(['fake'], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      mediaInfo: createMediaInfo(),
      segmentDurationSec: 20,
    };
  }
}

class DeferredFFmpegService extends MockFFmpegService {
  private pendingResolve: ((value: {
    blob: Blob;
    mimeType: string;
    mediaInfo: MediaInfo;
    segmentDurationSec: number;
  }) => void) | null = null;

  override transcodeFrom(_: File, startTimeSec: number): Promise<{
    blob: Blob;
    mimeType: string;
    mediaInfo: MediaInfo;
    segmentDurationSec: number;
  }> {
    this.transcodeCalls.push(startTimeSec);
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  resolveTranscode(): void {
    this.pendingResolve?.({
      blob: new Blob(['fake'], { type: 'video/mp4' }),
      mimeType: 'video/mp4',
      mediaInfo: createMediaInfo(),
      segmentDurationSec: 20,
    });
  }
}

class DeferredProbeFFmpegService extends MockFFmpegService {
  private pendingProbeResolve: ((value: MediaInfo) => void) | null = null;

  override probe(): Promise<MediaInfo> {
    this.probeCalls += 1;
    return new Promise((resolve) => {
      this.pendingProbeResolve = resolve;
    });
  }

  resolveProbe(): void {
    this.pendingProbeResolve?.(createMediaInfo());
  }
}

class FailingProbeFFmpegService extends MockFFmpegService {
  override async probe(): Promise<MediaInfo> {
    this.probeCalls += 1;
    throw new Error('Probe crashed');
  }
}

class MockHlsClient implements HlsClient {
  attachedMedia: HTMLMediaElement | null = null;
  loadedSource: string | null = null;
  destroyed = false;
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  attachMedia(media: HTMLMediaElement): void {
    this.attachedMedia = media;
    this.emit('hlsMediaAttached');
  }

  loadSource(url: string): void {
    this.loadedSource = url;
  }

  destroy(): void {
    this.destroyed = true;
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

class MockHlsFactory implements HlsClientFactory {
  createdClients: MockHlsClient[] = [];

  create(): HlsClient {
    const client = new MockHlsClient();
    this.createdClients.push(client);
    return client;
  }

  isSupported(): boolean {
    return true;
  }
}

describe('resolvePlaybackEngine', () => {
  it('prefers browser in auto mode when supported', () => {
    expect(resolvePlaybackEngine('auto', true)).toBe('browser');
  });

  it('falls back to ffmpeg in auto mode when unsupported', () => {
    expect(resolvePlaybackEngine('auto', false)).toBe('ffmpeg');
  });

  it('honors forced ffmpeg mode', () => {
    expect(resolvePlaybackEngine('ffmpeg', true)).toBe('ffmpeg');
  });
});

describe('BrowserMediaPlayerController', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      value: vi.fn(() => 'blob:mock'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get() {
        return HTMLMediaElement.HAVE_ENOUGH_DATA;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'networkState', {
      configurable: true,
      get() {
        return HTMLMediaElement.NETWORK_IDLE;
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get() {
        return 120;
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function mockLoad(this: HTMLMediaElement) {
      queueMicrotask(() => {
        this.dispatchEvent(new Event('loadstart'));
        this.dispatchEvent(new Event('loadedmetadata'));
        this.dispatchEvent(new Event('loadeddata'));
        this.dispatchEvent(new Event('canplay'));
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chooses browser playback for supported files in auto mode', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    const ffmpegService = new DeferredProbeFFmpegService();
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('probably');

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService,
      probeElement,
    });

    await controller.openFile(new File(['x'], 'clip.mp4', { type: 'video/mp4' }));

    expect(controller.state.resolvedEngine).toBe('browser');
    expect(controller.state.browserSupported).toBe(true);
    expect(controller.state.playbackPhase).toBe('ready');
    expect(controller.state.probeStatus).toBe('running');

    ffmpegService.resolveProbe();
    await Promise.resolve();

    expect(controller.state.probeStatus).toBe('completed');
  });

  it('uses ffmpeg fallback for unsupported files and reruns transcode on seek', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    const ffmpegService = new MockFFmpegService();
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('');

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService,
      probeElement,
    });

    await controller.openFile(new File(['x'], 'clip.mkv', { type: '' }));
    await controller.seek(42);

    expect(controller.state.resolvedEngine).toBe('ffmpeg');
    expect(ffmpegService.transcodeCalls).toEqual([0, 42]);
    expect(controller.state.transcodeSession?.deliveryMode).toBe('blob-url');
    expect(controller.state.diagnostics.some((entry) => entry.stage === 'attach')).toBe(true);
  });

  it('can reopen the same file object after prior ffmpeg playback', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    const ffmpegService = new MockFFmpegService();
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('');
    const file = new File(['x'], 'clip.mkv', { type: '' });

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService,
      probeElement,
    });

    await controller.openFile(file);
    await controller.openFile(file);

    expect(ffmpegService.transcodeCalls).toEqual([0, 0]);
    expect(controller.state.source?.kind).toBe('local-file');
    expect(controller.state.source?.kind === 'local-file' ? controller.state.source.file : null).toBe(file);
    expect(controller.state.resolvedEngine).toBe('ffmpeg');
  });

  it('rejects unsupported remote urls without invoking ffmpeg', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    const ffmpegService = new MockFFmpegService();
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('');

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService,
      probeElement,
    });

    await controller.openSource(createRemoteUrlSource('https://example.com/movie.mkv'));

    expect(controller.state.error).toContain('Remote FFmpeg fallback is not available');
    expect(controller.state.lastPlaybackError?.code).toBe('remote_unsupported');
    expect(ffmpegService.probeCalls).toBe(0);
    expect(ffmpegService.transcodeCalls).toEqual([]);
  });

  it('allows browser playback for remote audio streams inferred from url suffixes', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    vi.spyOn(probeElement, 'canPlayType').mockImplementation((mimeType: string) =>
      mimeType === 'audio/aac' ? 'probably' : '',
    );

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService: new MockFFmpegService(),
      probeElement,
    });

    await controller.openSource(createRemoteUrlSource('https://ice6.somafm.com/groovesalad-64-aac'));

    expect(controller.state.error).toBeNull();
    expect(controller.state.browserSupported).toBe(true);
    expect(controller.state.resolvedEngine).toBe('browser');
    expect(mediaElement.src).toContain('https://ice6.somafm.com/groovesalad-64-aac');
  });

  it('attaches hls.js playback when native hls is unavailable', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    const hlsFactory = new MockHlsFactory();
    vi.spyOn(probeElement, 'canPlayType').mockImplementation((mimeType: string) =>
      mimeType === 'application/vnd.apple.mpegurl' ? '' : 'probably',
    );

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService: new MockFFmpegService(),
      probeElement,
      hlsFactory,
    });

    await controller.openSource(createHlsPlaylistSource('https://example.com/live.m3u8'));

    expect(hlsFactory.createdClients).toHaveLength(1);
    expect(hlsFactory.createdClients[0].attachedMedia).toBe(mediaElement);
    expect(hlsFactory.createdClients[0].loadedSource).toBe('https://example.com/live.m3u8');
    expect(controller.state.resolvedEngine).toBe('browser');
    expect(controller.state.error).toBeNull();
  });

  it('destroys hls instance when switching away from hls playback', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    const hlsFactory = new MockHlsFactory();
    vi.spyOn(probeElement, 'canPlayType').mockImplementation((mimeType: string) =>
      mimeType === 'application/vnd.apple.mpegurl' ? '' : 'probably',
    );

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService: new MockFFmpegService(),
      probeElement,
      hlsFactory,
    });

    await controller.openSource(createHlsPlaylistSource('https://example.com/live.m3u8'));
    const hlsClient = hlsFactory.createdClients[0];

    await controller.openSource(createRemoteUrlSource('https://example.com/clip.mp4'));

    expect(hlsClient.destroyed).toBe(true);
    expect(mediaElement.src).toContain('https://example.com/clip.mp4');
  });

  it('stops browser playback and resets time to zero', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('probably');

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService: new MockFFmpegService(),
      probeElement,
    });

    await controller.openFile(new File(['x'], 'clip.mp4', { type: 'video/mp4' }));
    mediaElement.currentTime = 35;
    await controller.stop();

    expect(controller.state.currentTimeSec).toBe(0);
    expect(controller.state.status).toBe('paused');
    expect(controller.state.playbackPhase).toBe('ready');
  });

  it('classifies rejected play() as play_rejected', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(new Error('Autoplay blocked'));
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('probably');

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService: new MockFFmpegService(),
      probeElement,
    });

    await controller.openFile(new File(['x'], 'clip.mp4', { type: 'video/mp4' }));
    await controller.play();

    expect(controller.state.lastPlaybackError?.code).toBe('play_rejected');
    expect(controller.state.playbackPhase).toBe('failed');
  });

  it('remembers play intent while ffmpeg transcode is still running', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    const ffmpegService = new DeferredFFmpegService();
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('');

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService,
      probeElement,
    });

    const openPromise = controller.openFile(new File(['x'], 'clip.mkv', { type: '' }));
    await Promise.resolve();
    expect(['probing', 'transcoding', 'seeking']).toContain(controller.state.status);

    await controller.play();
    expect(playSpy).not.toHaveBeenCalled();

    ffmpegService.resolveTranscode();
    await openPromise;

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(controller.state.playbackPhase).toBe('playing');
    expect(
      controller.state.diagnostics.some(
        (entry) => entry.message === 'Play requested while FFmpeg output is still preparing; autoplay will start when ready',
      ),
    ).toBe(true);
  });

  it('does not call play prematurely while file probing is still in progress', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    const ffmpegService = new DeferredProbeFFmpegService();
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('');

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService,
      probeElement,
    });

    const openPromise = controller.openFile(new File(['x'], 'clip.mkv', { type: '' }));
    await Promise.resolve();
    expect(controller.state.status).toBe('probing');

    await controller.play();
    expect(playSpy).not.toHaveBeenCalled();

    ffmpegService.resolveProbe();
    await openPromise;

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(controller.state.playbackPhase).toBe('playing');
    expect(controller.state.diagnostics.some((entry) => entry.stage === 'media.pause')).toBe(true);
  });

  it('keeps browser playback usable when background probe fails', async () => {
    const mediaElement = document.createElement('video');
    const probeElement = document.createElement('video');
    vi.spyOn(probeElement, 'canPlayType').mockReturnValue('probably');

    const controller = new BrowserMediaPlayerController(mediaElement, {
      ffmpegService: new FailingProbeFFmpegService(),
      probeElement,
    });

    await controller.openFile(new File(['x'], 'clip.mp4', { type: 'video/mp4' }));
    await Promise.resolve();

    expect(controller.state.resolvedEngine).toBe('browser');
    expect(controller.state.playbackPhase).toBe('ready');
    expect(controller.state.status).toBe('paused');
    expect(controller.state.error).toBeNull();
    expect(controller.state.probeStatus).toBe('failed');
  });
});
