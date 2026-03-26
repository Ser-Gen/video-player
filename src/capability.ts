import type { CapabilityDetection } from './types';

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
};

export function inferMimeType(file: File): string {
  if (file.type) {
    return file.type;
  }

  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

export function detectCapability(file: File, probeEl: HTMLMediaElement): CapabilityDetection {
  const mimeType = inferMimeType(file);
  const isAudioOnly = mimeType.startsWith('audio/');
  const playability = probeEl.canPlayType(mimeType);

  return {
    mimeType,
    browserSupported: playability === 'probably' || playability === 'maybe',
    isAudioOnly,
  };
}
