import { detectCapability } from './capability';
import { FFmpegService } from './ffmpegService';
import type {
  DiagnosticTimings,
  MediaInfo,
  PlaybackDiagnosticEvent,
  PlaybackErrorCode,
  PlaybackMode,
  PlayerController,
  PlayerState,
  ResolvedEngine,
  TranscodeSession,
} from './types';

const MEDIA_READY_TIMEOUT_MS = 3000;
const MAX_DIAGNOSTICS = 120;
const DEFAULT_FFMPEG_DELIVERY_MODE: 'blob-url' | 'media-source' = 'blob-url';

export interface FFmpegAdapter {
  onLog(listener: (message: string) => void): () => void;
  probe(file: File): Promise<MediaInfo>;
  transcodeFrom(
    file: File,
    startTimeSec: number,
    isAudioOnly: boolean,
  ): Promise<{
    blob: Blob;
    mimeType: string;
    mediaInfo: MediaInfo;
    segmentDurationSec: number;
  }>;
}

function emptyTimings(): DiagnosticTimings {
  return {
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  };
}

function createInitialState(): PlayerState {
  return {
    file: null,
    playbackMode: 'auto',
    resolvedEngine: null,
    status: 'idle',
    currentTimeSec: 0,
    durationSec: null,
    pendingSeekSec: null,
    browserSupported: null,
    mediaInfo: null,
    logs: [],
    error: null,
    transcodeSession: null,
    isAudioOnly: false,
    diagnostics: [],
    playbackPhase: 'idle',
    lastPlaybackError: null,
    ffmpegTimings: emptyTimings(),
    attachTimings: emptyTimings(),
  };
}

export class BrowserMediaPlayerController implements PlayerController {
  private listeners = new Set<(state: PlayerState) => void>();
  private probeElement: HTMLMediaElement;
  private ffmpegService: FFmpegAdapter;
  private objectUrl: string | null = null;
  private mediaSource: MediaSource | null = null;
  private transcodeToken = 0;
  private pendingFfmpegSeek: number | null = null;
  private shouldAutoplayWhenReady = false;
  private disposed = false;
  state: PlayerState = createInitialState();

  constructor(
    public readonly mediaElement: HTMLMediaElement,
    options?: {
      ffmpegService?: FFmpegAdapter;
      probeElement?: HTMLMediaElement;
    },
  ) {
    this.probeElement = options?.probeElement ?? document.createElement('video');
    this.ffmpegService = options?.ffmpegService ?? new FFmpegService();
    this.ffmpegService.onLog((message) => {
      this.setState((prev) => ({ ...prev, logs: [...prev.logs, message] }));
    });

    this.bindMediaElementDiagnostics();
  }

  subscribe(listener: (state: PlayerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async openFile(file: File): Promise<void> {
    this.revokeObjectUrl();
    this.shouldAutoplayWhenReady = false;
    const capability = detectCapability(file, this.probeElement);
    this.pauseMediaElement('openFile:reset-before-load');
    this.mediaElement.removeAttribute('src');
    this.mediaElement.load();

    this.setState(() => ({
      ...createInitialState(),
      file,
      playbackMode: this.state.playbackMode,
      browserSupported: capability.browserSupported,
      status: 'probing',
      playbackPhase: 'probing',
      isAudioOnly: capability.isAudioOnly,
    }));
    this.pushDiagnostic('session', 'Opened media file', file.name);
    this.pushDiagnostic(
      'capability',
      'Browser support detection complete',
      `browserSupported=${capability.browserSupported}; audioOnly=${capability.isAudioOnly}`,
    );

    const probeStartedAt = Date.now();
    this.setState((prev) => ({
      ...prev,
      ffmpegTimings: {
        startedAt: probeStartedAt,
        finishedAt: null,
        durationMs: null,
      },
    }));
    this.pushDiagnostic('ffmpeg.probe', 'Starting FFmpeg probe');

    let mediaInfo = null;
    try {
      mediaInfo = await this.ffmpegService.probe(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to probe the media file';
      this.applyPlaybackError('attach_failed', message);
      throw error;
    }

    const probeFinishedAt = Date.now();
    this.pushDiagnostic('ffmpeg.probe', 'FFmpeg probe completed', `${probeFinishedAt - probeStartedAt}ms`);
    const resolvedEngine = resolvePlaybackEngine(this.state.playbackMode, capability.browserSupported);
    this.setState((prev) => ({
      ...prev,
      mediaInfo,
      durationSec: mediaInfo.durationSec,
      resolvedEngine,
      status: 'probing',
      playbackPhase: 'probing',
      error: null,
      ffmpegTimings: {
        startedAt: probeStartedAt,
        finishedAt: probeFinishedAt,
        durationMs: probeFinishedAt - probeStartedAt,
      },
    }));

    await this.applyCurrentMode(0, false);
  }

  async setMode(mode: PlaybackMode): Promise<void> {
    this.setState((prev) => ({
      ...prev,
      playbackMode: mode,
      error: null,
      lastPlaybackError: null,
    }));
    this.pushDiagnostic('session', 'Playback mode changed', mode);

    await this.applyCurrentMode(this.state.currentTimeSec, false);
  }

  async play(): Promise<void> {
    if (!this.state.file) {
      return;
    }

    this.shouldAutoplayWhenReady = true;
    this.setState((prev) => ({
      ...prev,
      error: prev.lastPlaybackError?.code === 'play_rejected' ? null : prev.error,
      lastPlaybackError: prev.lastPlaybackError?.code === 'play_rejected' ? null : prev.lastPlaybackError,
    }));

    if (
      (this.state.resolvedEngine === 'ffmpeg' || this.state.resolvedEngine === null) &&
      (this.state.status === 'probing' ||
        this.state.status === 'transcoding' ||
        this.state.status === 'seeking' ||
        this.state.playbackPhase === 'attaching' ||
        this.state.playbackPhase === 'buffering' ||
        this.state.playbackPhase === 'probing')
    ) {
      this.pushDiagnostic(
        'media.play',
        'Play requested while FFmpeg output is still preparing; autoplay will start when ready',
      );
      return;
    }

    if (this.state.resolvedEngine === 'ffmpeg' && !this.hasAttachedSource()) {
      await this.applyCurrentMode(this.state.currentTimeSec, true);
      return;
    }

    try {
      await this.mediaElement.play();
      this.pushDiagnostic('media.play', 'mediaElement.play() resolved');
      this.shouldAutoplayWhenReady = false;
      this.setState((prev) => ({
        ...prev,
        status: 'playing',
        playbackPhase: 'playing',
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Playback promise was rejected';
      this.applyPlaybackError('play_rejected', message);
    }
  }

  pause(): void {
    this.shouldAutoplayWhenReady = false;
    this.pauseMediaElement('public-pause');
    this.pushDiagnostic('media.play', 'Playback paused');
    this.setState((prev) => ({
      ...prev,
      status: prev.status === 'error' ? prev.status : 'paused',
      playbackPhase: prev.status === 'error' ? prev.playbackPhase : 'ready',
    }));
  }

  async stop(): Promise<void> {
    this.shouldAutoplayWhenReady = false;
    this.pauseMediaElement('public-stop');

    if (this.state.resolvedEngine === 'ffmpeg') {
      this.clearAttachedSource('stop:clear-ffmpeg-source');
      this.setState((prev) => ({
        ...prev,
        currentTimeSec: 0,
        pendingSeekSec: null,
        status: 'paused',
        playbackPhase: 'ready',
        error: null,
      }));
      return;
    }

    this.mediaElement.currentTime = 0;
    this.setState((prev) => ({
      ...prev,
      currentTimeSec: 0,
      pendingSeekSec: null,
      status: 'paused',
      playbackPhase: 'ready',
      error: null,
    }));
  }

  async seek(timeSec: number): Promise<void> {
    if (!this.state.file) {
      return;
    }

    if (this.state.resolvedEngine === 'browser') {
      this.mediaElement.currentTime = Math.max(0, timeSec);
      this.pushDiagnostic('seek', 'Browser seek applied', `${this.mediaElement.currentTime}s`);
      this.setState((prev) => ({
        ...prev,
        currentTimeSec: this.mediaElement.currentTime,
        pendingSeekSec: null,
      }));
      return;
    }

    this.pendingFfmpegSeek = timeSec;
    this.pushDiagnostic('seek', 'Queued FFmpeg seek request', `${timeSec}s`);
    if (this.state.status === 'transcoding' || this.state.status === 'seeking') {
      this.setState((prev) => ({
        ...prev,
        pendingSeekSec: timeSec,
        status: 'seeking',
        playbackPhase: 'transcoding',
      }));
      return;
    }

    await this.startFfmpegSeek(timeSec, true);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unbindMediaElementDiagnostics();
    this.revokeObjectUrl();
  }

  private async applyCurrentMode(timeSec: number, autoplay: boolean): Promise<void> {
    if (!this.state.file) {
      return;
    }

    const resolvedEngine = resolvePlaybackEngine(this.state.playbackMode, this.state.browserSupported);

    this.setState((prev) => ({
      ...prev,
      resolvedEngine,
    }));

    if (resolvedEngine === 'browser') {
      this.loadBrowserSource(this.state.file, timeSec);
      if (autoplay) {
        await this.play();
      }
      return;
    }

    await this.startFfmpegSeek(timeSec, autoplay);
  }

  private async startFfmpegSeek(timeSec: number, autoplay: boolean): Promise<void> {
    const file = this.state.file;
    if (!file) {
      return;
    }

    const requestId = ++this.transcodeToken;
    const sessionStartedAt = Date.now();
    const session: TranscodeSession = {
      requestId,
      requestedTimeSec: timeSec,
      startedAt: sessionStartedAt,
      finishedAt: null,
      status: 'running',
      outputBytes: null,
      deliveryMode: null,
    };

    this.pendingFfmpegSeek = null;
    this.pauseMediaElement('startFfmpegSeek:prepare-next-source');
    this.revokeObjectUrl();

    this.setState((prev) => ({
      ...prev,
      status: prev.resolvedEngine === 'ffmpeg' ? 'seeking' : 'transcoding',
      playbackPhase: 'transcoding',
      transcodeSession: session,
      pendingSeekSec: null,
      error: null,
      lastPlaybackError: null,
      currentTimeSec: timeSec,
      logs: [],
      attachTimings: emptyTimings(),
      ffmpegTimings: {
        startedAt: sessionStartedAt,
        finishedAt: null,
        durationMs: null,
      },
    }));
    this.pushDiagnostic('ffmpeg.transcode', 'Starting full-segment transcode', `${timeSec}s`);

    try {
      const result = await this.ffmpegService.transcodeFrom(file, timeSec, this.state.isAudioOnly);
      if (requestId !== this.transcodeToken) {
        return;
      }

      const transcodeFinishedAt = Date.now();
      const outputBytes = result.blob.size;
      this.pushDiagnostic(
        'ffmpeg.transcode',
        'Transcode completed',
        `${transcodeFinishedAt - sessionStartedAt}ms; ${outputBytes} bytes; mime=${result.mimeType}`,
      );

      const attachResult = await this.attachTranscodedMedia(result.blob, result.mimeType, requestId);

      const shouldAutoplay = autoplay || this.shouldAutoplayWhenReady;

      this.setState((prev) => ({
        ...prev,
        mediaInfo: result.mediaInfo.rawLog ? result.mediaInfo : prev.mediaInfo,
        durationSec: prev.mediaInfo?.durationSec ?? result.mediaInfo.durationSec,
        transcodeSession: {
          ...session,
          status: 'completed',
          finishedAt: Date.now(),
          outputBytes,
          deliveryMode: attachResult.deliveryMode,
        },
        playbackPhase: shouldAutoplay ? 'buffering' : 'ready',
        status: shouldAutoplay ? 'playing' : 'paused',
        ffmpegTimings: {
          startedAt: sessionStartedAt,
          finishedAt: transcodeFinishedAt,
          durationMs: transcodeFinishedAt - sessionStartedAt,
        },
      }));

      await this.waitForMediaReady(requestId);
      this.setState((prev) => ({
        ...prev,
        playbackPhase: shouldAutoplay ? 'buffering' : 'ready',
      }));

      if (shouldAutoplay) {
        try {
          await this.mediaElement.play();
          this.pushDiagnostic('media.play', 'FFmpeg delivery playback started', attachResult.deliveryMode);
          this.shouldAutoplayWhenReady = false;
          this.setState((prev) => ({
            ...prev,
            status: 'playing',
            playbackPhase: 'playing',
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Playback promise was rejected';
          this.applyPlaybackError('play_rejected', message);
        }
      }
    } catch (error) {
      if (requestId !== this.transcodeToken) {
        return;
      }

      const message = error instanceof Error ? error.message : 'FFmpeg transcoding failed';
      const code = this.classifyPlaybackError(message);
      this.applyPlaybackError(code, message, session);
    } finally {
      if (requestId !== this.transcodeToken) {
        return;
      }

      const nextSeek = this.pendingFfmpegSeek;
      if (nextSeek !== null && Math.abs(nextSeek - timeSec) > 0.25) {
        this.pendingFfmpegSeek = null;
        await this.startFfmpegSeek(nextSeek, autoplay);
      }
    }
  }

  private loadBrowserSource(file: File, timeSec: number): void {
    this.pauseMediaElement('loadBrowserSource:swap-source');
    this.revokeObjectUrl();
    this.objectUrl = URL.createObjectURL(file);
    this.mediaElement.src = this.objectUrl;
    this.mediaElement.load();
    this.mediaElement.currentTime = timeSec;
    this.pushDiagnostic('attach.browser', 'Browser source attached', file.name);

    this.setState((prev) => ({
      ...prev,
      status: 'paused',
      playbackPhase: 'ready',
      error: null,
    }));
  }

  private setState(updater: (state: PlayerState) => PlayerState): void {
    this.state = updater(this.state);
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private pushDiagnostic(stage: string, message: string, detail?: string): void {
    const event: PlaybackDiagnosticEvent = {
      at: Date.now(),
      stage,
      message,
      detail,
    };

    this.setState((prev) => ({
      ...prev,
      diagnostics: [...prev.diagnostics, event].slice(-MAX_DIAGNOSTICS),
    }));
  }

  private applyPlaybackError(
    code: PlaybackErrorCode,
    message: string,
    session?: TranscodeSession,
  ): void {
    this.pushDiagnostic('failure', `Playback failure: ${code}`, message);
    this.setState((prev) => ({
      ...prev,
      status: 'error',
      playbackPhase: 'failed',
      error: message,
      lastPlaybackError: { code, message },
      transcodeSession: session
        ? {
            ...session,
            status: 'failed',
            finishedAt: Date.now(),
          }
        : prev.transcodeSession,
    }));
  }

  private classifyPlaybackError(message: string): PlaybackErrorCode {
    const normalized = message.toLowerCase();
    if (normalized.includes('type unsupported') || normalized.includes('codec')) {
      return 'codec_unsupported';
    }
    if (normalized.includes('timed out') || normalized.includes('not ready')) {
      return 'media_not_ready';
    }
    if (normalized.includes('sourcebuffer') || normalized.includes('mediasource') || normalized.includes('attach')) {
      return 'attach_failed';
    }
    if (normalized.includes('play')) {
      return 'play_rejected';
    }
    return 'transcode_slow';
  }

  private revokeObjectUrl(): void {
    this.mediaSource = null;
    if (!this.objectUrl) {
      return;
    }

    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  private pauseMediaElement(reason: string): void {
    this.pushDiagnostic('media.pause', 'Calling mediaElement.pause()', `${reason}; ${this.collectMediaSnapshot()}`);
    this.mediaElement.pause();
  }

  private clearAttachedSource(reason: string): void {
    this.pushDiagnostic('attach.clear', 'Clearing current media source', reason);
    this.revokeObjectUrl();
    this.mediaElement.removeAttribute('src');
    this.mediaElement.load();
  }

  private async attachTranscodedMedia(
    blob: Blob,
    mimeType: string,
    requestId: number,
  ): Promise<{ deliveryMode: 'blob-url' | 'media-source' }> {
    const attachStartedAt = Date.now();
    this.setState((prev) => ({
      ...prev,
      playbackPhase: 'attaching',
      attachTimings: {
        startedAt: attachStartedAt,
        finishedAt: null,
        durationMs: null,
      },
    }));

    this.pushDiagnostic('attach', 'Preparing FFmpeg output attachment', `requested mime=${mimeType}`);

    const shouldUseMediaSource =
      DEFAULT_FFMPEG_DELIVERY_MODE === 'media-source' &&
      'MediaSource' in window &&
      MediaSource.isTypeSupported(mimeType);

    if (!shouldUseMediaSource) {
      const reason =
        !('MediaSource' in window)
          ? 'MediaSource API unavailable'
          : `MediaSource disabled or type unsupported for ${mimeType}`;
      this.pushDiagnostic('attach', 'Falling back to blob URL delivery', reason);
      this.objectUrl = URL.createObjectURL(blob);
      this.mediaElement.src = this.objectUrl;
      this.mediaElement.load();
      const attachFinishedAt = Date.now();
      this.setState((prev) => ({
        ...prev,
        attachTimings: {
          startedAt: attachStartedAt,
          finishedAt: attachFinishedAt,
          durationMs: attachFinishedAt - attachStartedAt,
        },
      }));
      return { deliveryMode: 'blob-url' };
    }

    const bytesStartedAt = Date.now();
    const bytes = await blob.arrayBuffer();
    this.pushDiagnostic('attach.media-source', 'Blob converted to ArrayBuffer', `${Date.now() - bytesStartedAt}ms`);
    if (requestId !== this.transcodeToken) {
      return { deliveryMode: 'media-source' };
    }

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.mediaElement.src = this.objectUrl;
    this.mediaElement.load();

    await new Promise<void>((resolve, reject) => {
      const mediaSource = this.mediaSource;
      if (!mediaSource) {
        reject(new Error('MediaSource was disposed before attaching data'));
        return;
      }

      const handleSourceOpen = (): void => {
        this.pushDiagnostic('attach.media-source', 'MediaSource opened', `readyState=${mediaSource.readyState}`);
        mediaSource.removeEventListener('sourceopen', handleSourceOpen);

        try {
          const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
          this.pushDiagnostic('attach.media-source', 'SourceBuffer created', mimeType);
          sourceBuffer.addEventListener('updatestart', this.handleSourceBufferUpdateStart);
          sourceBuffer.addEventListener('update', this.handleSourceBufferUpdate);
          sourceBuffer.addEventListener('updateend', () => {
            this.handleSourceBufferUpdateEnd();
            if (mediaSource.readyState === 'open') {
              mediaSource.endOfStream();
              this.pushDiagnostic('attach.media-source', 'MediaSource endOfStream() called');
            }
            resolve();
          }, { once: true });
          sourceBuffer.appendBuffer(bytes);
          this.pushDiagnostic('attach.media-source', 'appendBuffer() invoked', `${bytes.byteLength} bytes`);
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Failed to append transcoded media'));
        }
      };

      mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });
      mediaSource.addEventListener('sourceended', this.handleMediaSourceEnded, { once: true });
    });

    const attachFinishedAt = Date.now();
    this.setState((prev) => ({
      ...prev,
      attachTimings: {
        startedAt: attachStartedAt,
        finishedAt: attachFinishedAt,
        durationMs: attachFinishedAt - attachStartedAt,
      },
    }));
    return { deliveryMode: 'media-source' };
  }

  private async waitForMediaReady(requestId: number): Promise<void> {
    this.pushDiagnostic('media.ready', 'Waiting for playback readiness');

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const events = ['loadeddata', 'canplay', 'playing'] as const;

      const cleanup = (): void => {
        for (const eventName of events) {
          this.mediaElement.removeEventListener(eventName, handleReady);
        }
        this.mediaElement.removeEventListener('error', handleError);
        window.clearTimeout(timeoutId);
      };

      const settle = (callback: () => void): void => {
        if (settled || requestId !== this.transcodeToken) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const handleReady = (event: Event): void => {
        this.pushDiagnostic(
          'media.ready',
          `Playback readiness event: ${event.type}`,
          this.collectMediaSnapshot(),
        );
        settle(resolve);
      };

      const handleError = (): void => {
        const mediaErrorCode = this.mediaElement.error?.code ?? 'unknown';
        settle(() => reject(new Error(`Media element error while waiting for readiness (code=${mediaErrorCode})`)));
      };

      const timeoutId = window.setTimeout(() => {
        settle(() => reject(new Error(`Media element not ready within ${MEDIA_READY_TIMEOUT_MS}ms`)));
      }, MEDIA_READY_TIMEOUT_MS);

      for (const eventName of events) {
        this.mediaElement.addEventListener(eventName, handleReady, { once: true });
      }
      this.mediaElement.addEventListener('error', handleError, { once: true });

      if (this.mediaElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        settle(resolve);
      }
    });
  }

  private collectMediaSnapshot(): string {
    return [
      `readyState=${this.mediaElement.readyState}`,
      `networkState=${this.mediaElement.networkState}`,
      `paused=${this.mediaElement.paused}`,
      `currentTime=${this.mediaElement.currentTime.toFixed(3)}`,
      `currentSrc=${this.mediaElement.currentSrc || 'none'}`,
      `errorCode=${this.mediaElement.error?.code ?? 'none'}`,
    ].join('; ');
  }

  private hasAttachedSource(): boolean {
    return Boolean(this.mediaElement.currentSrc || this.mediaElement.getAttribute('src'));
  }

  private bindMediaElementDiagnostics(): void {
    const events = [
      'loadstart',
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'canplaythrough',
      'playing',
      'waiting',
      'stalled',
      'seeking',
      'seeked',
      'error',
      'ended',
    ] as const;

    for (const eventName of events) {
      this.mediaElement.addEventListener(eventName, this.handleMediaDiagnosticEvent);
    }
    this.mediaElement.addEventListener('timeupdate', this.handleTimeUpdate);
  }

  private unbindMediaElementDiagnostics(): void {
    const events = [
      'loadstart',
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'canplaythrough',
      'playing',
      'waiting',
      'stalled',
      'seeking',
      'seeked',
      'error',
      'ended',
    ] as const;

    for (const eventName of events) {
      this.mediaElement.removeEventListener(eventName, this.handleMediaDiagnosticEvent);
    }
    this.mediaElement.removeEventListener('timeupdate', this.handleTimeUpdate);
  }

  private handleMediaDiagnosticEvent = (event: Event): void => {
    this.pushDiagnostic(`media.${event.type}`, 'HTMLMediaElement event', this.collectMediaSnapshot());

    if (event.type === 'loadedmetadata') {
      const duration = Number.isFinite(this.mediaElement.duration) ? this.mediaElement.duration : null;
      this.setState((prev) => ({
        ...prev,
        durationSec: prev.durationSec ?? duration,
      }));
    }

    if (event.type === 'playing') {
      this.setState((prev) => ({
        ...prev,
        status: 'playing',
        playbackPhase: 'playing',
      }));
    }

    if (event.type === 'ended') {
      this.setState((prev) => ({
        ...prev,
        status: 'paused',
        playbackPhase: 'ready',
      }));
    }
  };

  private handleMediaSourceEnded = (): void => {
    this.pushDiagnostic('attach.media-source', 'MediaSource sourceended event');
  };

  private handleSourceBufferUpdateStart = (): void => {
    this.pushDiagnostic('attach.media-source', 'SourceBuffer updatestart');
  };

  private handleSourceBufferUpdate = (): void => {
    this.pushDiagnostic('attach.media-source', 'SourceBuffer update');
  };

  private handleSourceBufferUpdateEnd = (): void => {
    this.pushDiagnostic('attach.media-source', 'SourceBuffer updateend');
  };

  private handleTimeUpdate = (): void => {
    this.setState((prev) => ({
      ...prev,
      currentTimeSec: this.mediaElement.currentTime,
    }));
  };
}

export function resolvePlaybackEngine(
  mode: PlaybackMode,
  browserSupported: boolean | null,
): ResolvedEngine {
  if (mode === 'browser') {
    return 'browser';
  }
  if (mode === 'ffmpeg') {
    return 'ffmpeg';
  }
  return browserSupported ? 'browser' : 'ffmpeg';
}
