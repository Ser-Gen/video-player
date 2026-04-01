import { detectCapability, inferMimeType } from './capability';
import { FFmpegService } from './ffmpegService';
import { defaultHlsClientFactory, HLS_ERROR_EVENT, HLS_MEDIA_ATTACHED_EVENT, type HlsClient, type HlsClientFactory } from './hlsPlayback';
import { createLocalFileSource, getSourceName, isLocalFileSource } from './sourceUtils';
import type {
  DiagnosticTimings,
  MediaInfo,
  MediaSourceItem,
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
    source: null,
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
    probeStatus: 'idle',
    activeProbeRequestId: null,
  };
}

export class BrowserMediaPlayerController implements PlayerController {
  private listeners = new Set<(state: PlayerState) => void>();
  private probeElement: HTMLMediaElement;
  private ffmpegService: FFmpegAdapter;
  private hlsFactory: HlsClientFactory;
  private objectUrl: string | null = null;
  private mediaSource: MediaSource | null = null;
  private hlsClient: HlsClient | null = null;
  private transcodeToken = 0;
  private probeToken = 0;
  private pendingFfmpegSeek: number | null = null;
  private shouldAutoplayWhenReady = false;
  private disposed = false;
  state: PlayerState = createInitialState();

  constructor(
    public readonly mediaElement: HTMLMediaElement,
    options?: {
      ffmpegService?: FFmpegAdapter;
      hlsFactory?: HlsClientFactory;
      probeElement?: HTMLMediaElement;
    },
  ) {
    this.probeElement = options?.probeElement ?? document.createElement('video');
    this.ffmpegService = options?.ffmpegService ?? new FFmpegService();
    this.hlsFactory = options?.hlsFactory ?? defaultHlsClientFactory;
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
    await this.openSource(createLocalFileSource(file));
  }

  async openSource(source: MediaSourceItem): Promise<void> {
    this.revokeObjectUrl();
    this.destroyHlsClient();
    this.shouldAutoplayWhenReady = false;
    const requestProbeId = ++this.probeToken;
    const capability = detectCapability(source, this.probeElement);
    const canAttemptBrowserPlayback = this.canAttemptBrowserPlayback(source, capability.browserSupported);
    this.pauseMediaElement('openSource:reset-before-load');
    this.mediaElement.removeAttribute('src');
    this.mediaElement.load();
    const resolvedEngine = this.resolveEngineForSource(source, capability.browserSupported);

    this.setState(() => ({
      ...createInitialState(),
      source,
      playbackMode: this.state.playbackMode,
      resolvedEngine,
      browserSupported: capability.browserSupported,
      status:
        resolvedEngine === 'browser'
          ? canAttemptBrowserPlayback
            ? 'paused'
            : 'error'
          : 'probing',
      playbackPhase:
        resolvedEngine === 'browser'
          ? canAttemptBrowserPlayback
            ? 'ready'
            : 'failed'
          : 'probing',
      isAudioOnly: capability.isAudioOnly,
      probeStatus: isLocalFileSource(source) ? 'running' : 'idle',
      activeProbeRequestId: isLocalFileSource(source) ? requestProbeId : null,
    }));
    this.pushDiagnostic('session', 'Opened media source', getSourceName(source));
    this.pushDiagnostic(
      'capability',
      'Browser support detection complete',
      `browserSupported=${capability.browserSupported}; audioOnly=${capability.isAudioOnly}; kind=${source.kind}`,
    );

    if (!isLocalFileSource(source) && source.kind !== 'hls-playlist' && !canAttemptBrowserPlayback) {
      this.applyPlaybackError(
        'remote_unsupported',
        'This remote URL is not supported by the browser. Remote FFmpeg fallback is not available in this version.',
      );
      return;
    }

    if (source.kind === 'hls-playlist') {
      try {
        await this.loadHlsSource(source, 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to attach HLS playback';
        this.applyPlaybackError('hls_attach_failed', message);
      }
      return;
    }

    if (resolvedEngine === 'browser') {
      this.loadBrowserSource(source, 0);
      if (isLocalFileSource(source)) {
        void this.runBackgroundProbe(source, requestProbeId);
      }
      return;
    }

    if (!isLocalFileSource(source)) {
      this.applyPlaybackError('remote_unsupported', 'FFmpeg mode is only available for local files.');
      return;
    }

    const probeSucceeded = await this.runBlockingProbe(source, requestProbeId);
    if (!probeSucceeded) {
      return;
    }

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

    if (mode === 'ffmpeg') {
      this.probeToken += 1;
    }

    await this.applyCurrentMode(this.state.currentTimeSec, false);
  }

  async play(): Promise<void> {
    if (!this.state.source) {
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
    if (!this.state.source) {
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

  clear(): void {
    this.shouldAutoplayWhenReady = false;
    this.transcodeToken += 1;
    this.probeToken += 1;
    this.pendingFfmpegSeek = null;
    this.pauseMediaElement('public-clear');
    this.clearAttachedSource('clear:reset-all-sources');
    this.setState((prev) => ({
      ...createInitialState(),
      playbackMode: prev.playbackMode,
    }));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unbindMediaElementDiagnostics();
    this.destroyHlsClient();
    this.revokeObjectUrl();
  }

  private async applyCurrentMode(timeSec: number, autoplay: boolean): Promise<void> {
    if (!this.state.source) {
      return;
    }

    const resolvedEngine = this.resolveEngineForSource(this.state.source, this.state.browserSupported ?? false);

    this.setState((prev) => ({
      ...prev,
      resolvedEngine,
    }));

    if (resolvedEngine === 'browser') {
      if (this.state.source.kind === 'hls-playlist') {
        await this.loadHlsSource(this.state.source, timeSec);
      } else if (this.canAttemptBrowserPlayback(this.state.source, this.state.browserSupported ?? false)) {
        this.loadBrowserSource(this.state.source, timeSec);
      } else {
        this.applyPlaybackError(
          'remote_unsupported',
          'This remote URL is not supported by the browser. Remote FFmpeg fallback is not available in this version.',
        );
        return;
      }
      if (autoplay) {
        await this.play();
      }
      return;
    }

    await this.startFfmpegSeek(timeSec, autoplay);
  }

  private async startFfmpegSeek(timeSec: number, autoplay: boolean): Promise<void> {
    const source = this.state.source;
    if (!source || !isLocalFileSource(source)) {
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
      const result = await this.ffmpegService.transcodeFrom(source.file, timeSec, this.state.isAudioOnly);
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

  private loadBrowserSource(source: MediaSourceItem, timeSec: number): void {
    this.pauseMediaElement('loadBrowserSource:swap-source');
    this.destroyHlsClient();
    this.revokeObjectUrl();

    if (isLocalFileSource(source)) {
      this.objectUrl = URL.createObjectURL(source.file);
      this.mediaElement.src = this.objectUrl;
    } else {
      this.mediaElement.src = source.url;
    }

    this.mediaElement.load();
    this.mediaElement.currentTime = timeSec;
    this.pushDiagnostic('attach.browser', 'Browser source attached', getSourceName(source));

    this.setState((prev) => ({
      ...prev,
      status: 'paused',
      playbackPhase: 'ready',
      error: null,
    }));
  }

  private async loadHlsSource(source: Extract<MediaSourceItem, { kind: 'hls-playlist' }>, timeSec: number): Promise<void> {
    this.pauseMediaElement('loadHlsSource:swap-source');
    this.destroyHlsClient();
    this.revokeObjectUrl();

    const canPlayNatively = this.probeElement.canPlayType('application/vnd.apple.mpegurl');
    if (canPlayNatively === 'probably' || canPlayNatively === 'maybe') {
      this.mediaElement.src = source.url;
      this.mediaElement.load();
      this.mediaElement.currentTime = timeSec;
      this.pushDiagnostic('attach.hls.native', 'Native HLS source attached', source.url);
      this.setState((prev) => ({
        ...prev,
        browserSupported: true,
        status: 'paused',
        playbackPhase: 'ready',
        error: null,
      }));
      return;
    }

    if (!this.hlsFactory.isSupported()) {
      throw new Error('HLS playback is not supported in this browser.');
    }

    const hlsClient = this.hlsFactory.create();
    this.hlsClient = hlsClient;
    hlsClient.on(HLS_ERROR_EVENT, (_, data) => {
      const detail =
        typeof data === 'object' && data !== null && 'details' in data && typeof data.details === 'string'
          ? data.details
          : 'Unknown HLS error';
      this.applyPlaybackError('hls_attach_failed', `HLS playback failed: ${detail}`);
    });

    await new Promise<void>((resolve) => {
      hlsClient.on(HLS_MEDIA_ATTACHED_EVENT, () => resolve());
      hlsClient.attachMedia(this.mediaElement);
    });

    hlsClient.loadSource(source.url);
    this.pushDiagnostic('attach.hls', 'HLS.js source attached', source.url);
    this.setState((prev) => ({
      ...prev,
      browserSupported: true,
      status: 'paused',
      playbackPhase: 'ready',
      error: null,
    }));
  }

  private async runBlockingProbe(source: Extract<MediaSourceItem, { kind: 'local-file' }>, requestId: number): Promise<boolean> {
    const probeStartedAt = Date.now();
    this.setState((prev) => ({
      ...prev,
      probeStatus: 'running',
      activeProbeRequestId: requestId,
      ffmpegTimings: {
        startedAt: probeStartedAt,
        finishedAt: null,
        durationMs: null,
      },
    }));
    this.pushDiagnostic('ffmpeg.probe', 'Starting FFmpeg probe');

    try {
      const mediaInfo = await this.ffmpegService.probe(source.file);
      if (requestId !== this.probeToken) {
        return false;
      }

      const probeFinishedAt = Date.now();
      this.pushDiagnostic('ffmpeg.probe', 'FFmpeg probe completed', `${probeFinishedAt - probeStartedAt}ms`);
      this.setState((prev) => ({
        ...prev,
        mediaInfo,
        durationSec: mediaInfo.durationSec ?? prev.durationSec,
        error: null,
        probeStatus: 'completed',
        activeProbeRequestId: requestId,
        ffmpegTimings: {
          startedAt: probeStartedAt,
          finishedAt: probeFinishedAt,
          durationMs: probeFinishedAt - probeStartedAt,
        },
      }));
      return true;
    } catch (error) {
      if (requestId !== this.probeToken) {
        return false;
      }
      const message = error instanceof Error ? error.message : 'Failed to probe the media file';
      this.applyPlaybackError('attach_failed', message);
      this.setState((prev) => ({
        ...prev,
        probeStatus: 'failed',
        activeProbeRequestId: requestId,
      }));
      return false;
    }
  }

  private async runBackgroundProbe(source: Extract<MediaSourceItem, { kind: 'local-file' }>, requestId: number): Promise<void> {
    const probeStartedAt = Date.now();
    this.setState((prev) => ({
      ...prev,
      probeStatus: 'running',
      activeProbeRequestId: requestId,
      ffmpegTimings: {
        startedAt: probeStartedAt,
        finishedAt: null,
        durationMs: null,
      },
    }));
    this.pushDiagnostic('ffmpeg.probe.background', 'Starting background FFmpeg probe');

    try {
      const mediaInfo = await this.ffmpegService.probe(source.file);
      if (requestId !== this.probeToken || this.state.source !== source) {
        return;
      }

      const probeFinishedAt = Date.now();
      this.pushDiagnostic(
        'ffmpeg.probe.background',
        'Background FFmpeg probe completed',
        `${probeFinishedAt - probeStartedAt}ms`,
      );
      this.setState((prev) => ({
        ...prev,
        mediaInfo,
        durationSec: prev.durationSec ?? mediaInfo.durationSec,
        probeStatus: 'completed',
        activeProbeRequestId: requestId,
        ffmpegTimings: {
          startedAt: probeStartedAt,
          finishedAt: probeFinishedAt,
          durationMs: probeFinishedAt - probeStartedAt,
        },
      }));
    } catch (error) {
      if (requestId !== this.probeToken || this.state.source !== source) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Background FFmpeg probe failed';
      this.pushDiagnostic('ffmpeg.probe.background', 'Background FFmpeg probe failed', message);
      this.setState((prev) => ({
        ...prev,
        probeStatus: 'failed',
        activeProbeRequestId: requestId,
        ffmpegTimings: {
          startedAt: probeStartedAt,
          finishedAt: Date.now(),
          durationMs: Date.now() - probeStartedAt,
        },
      }));
    }
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
    if (normalized.includes('hls')) {
      return 'hls_attach_failed';
    }
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

  private resolveEngineForSource(source: MediaSourceItem, browserSupported: boolean): ResolvedEngine {
    if (!isLocalFileSource(source)) {
      return 'browser';
    }

    return resolvePlaybackEngine(this.state.playbackMode, browserSupported);
  }

  private canAttemptBrowserPlayback(source: MediaSourceItem, browserSupported: boolean): boolean {
    if (source.kind === 'hls-playlist') {
      return true;
    }

    if (browserSupported) {
      return true;
    }

    return !isLocalFileSource(source) && inferMimeType(source) === 'application/octet-stream';
  }

  private destroyHlsClient(): void {
    if (!this.hlsClient) {
      return;
    }

    this.hlsClient.destroy();
    this.hlsClient = null;
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
    this.destroyHlsClient();
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

    if (event.type === 'error') {
      const currentSource = this.state.source;
      const message =
        currentSource?.kind === 'remote-url'
          ? 'The browser could not play this remote URL.'
          : 'The browser could not play this source.';
      const code: PlaybackErrorCode = currentSource?.kind === 'remote-url' ? 'remote_unsupported' : 'attach_failed';
      this.setState((prev) => ({
        ...prev,
        status: 'error',
        playbackPhase: 'failed',
        error: message,
        lastPlaybackError: { code, message },
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
