import type { CapabilityDetection, MediaSourceItem } from './types';
import { isHlsMimeType } from './sourceUtils';

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  m2ts: 'video/mp2t',
  ts: 'video/mp2t',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m3u8: 'application/vnd.apple.mpegurl',
  m3u: 'audio/x-mpegurl',
};

export function inferMimeTypeFromName(name: string, declaredMimeType?: string | null): string {
  if (declaredMimeType) {
    return declaredMimeType;
  }

  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

export function inferMimeType(source: File | MediaSourceItem): string {
  if (source instanceof File) {
    return inferMimeTypeFromName(source.name, source.type);
  }

  if (source.kind === 'local-file') {
    return inferMimeTypeFromName(source.name, source.file.type);
  }

  if (source.kind === 'hls-playlist') {
    return 'application/vnd.apple.mpegurl';
  }

  if (isHlsMimeType(source.mimeType)) {
    return source.mimeType ?? 'application/vnd.apple.mpegurl';
  }

  return inferMimeTypeFromName(source.name, source.mimeType);
}

export function detectCapability(source: File | MediaSourceItem, probeEl: HTMLMediaElement): CapabilityDetection {
  const mimeType = inferMimeType(source);
  const isAudioOnly = mimeType.startsWith('audio/');
  const playability = probeEl.canPlayType(mimeType);

  return {
    mimeType,
    browserSupported: playability === 'probably' || playability === 'maybe',
    isAudioOnly,
  };
}
