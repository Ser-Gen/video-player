export type PlaybackMode = 'auto' | 'browser' | 'ffmpeg';
export type ResolvedEngine = 'browser' | 'ffmpeg';
export type PlaybackPhase =
  | 'idle'
  | 'probing'
  | 'transcoding'
  | 'attaching'
  | 'buffering'
  | 'ready'
  | 'playing'
  | 'failed';
export type PlaybackErrorCode =
  | 'transcode_slow'
  | 'attach_failed'
  | 'codec_unsupported'
  | 'media_not_ready'
  | 'play_rejected';
export type SessionStatus =
  | 'idle'
  | 'probing'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'transcoding'
  | 'seeking'
  | 'error';

export interface VideoStreamInfo {
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface AudioStreamInfo {
  codec: string | null;
  sampleRate: number | null;
  channelLayout: string | null;
}

export interface MediaInfo {
  container: string | null;
  durationSec: number | null;
  bitrate: string | null;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
  rawLog: string;
}

export interface TranscodeSession {
  requestedTimeSec: number;
  startedAt: number;
  finishedAt: number | null;
  status: 'pending' | 'running' | 'completed' | 'aborted' | 'failed';
  requestId: number;
  outputBytes: number | null;
  deliveryMode: 'blob-url' | 'media-source' | null;
}

export interface PlaybackDiagnosticEvent {
  at: number;
  stage: string;
  message: string;
  detail?: string;
}

export interface DiagnosticTimings {
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
}

export interface PlaybackErrorInfo {
  code: PlaybackErrorCode;
  message: string;
}

export interface PlayerState {
  file: File | null;
  playbackMode: PlaybackMode;
  resolvedEngine: ResolvedEngine | null;
  status: SessionStatus;
  currentTimeSec: number;
  durationSec: number | null;
  pendingSeekSec: number | null;
  browserSupported: boolean | null;
  mediaInfo: MediaInfo | null;
  logs: string[];
  error: string | null;
  transcodeSession: TranscodeSession | null;
  isAudioOnly: boolean;
  diagnostics: PlaybackDiagnosticEvent[];
  playbackPhase: PlaybackPhase;
  lastPlaybackError: PlaybackErrorInfo | null;
  ffmpegTimings: DiagnosticTimings;
  attachTimings: DiagnosticTimings;
}

export interface CapabilityDetection {
  mimeType: string;
  browserSupported: boolean;
  isAudioOnly: boolean;
}

export interface PlayerController {
  readonly state: PlayerState;
  readonly mediaElement: HTMLMediaElement;
  subscribe(listener: (state: PlayerState) => void): () => void;
  openFile(file: File): Promise<void>;
  setMode(mode: PlaybackMode): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): Promise<void>;
  seek(timeSec: number): Promise<void>;
  dispose(): void;
}
