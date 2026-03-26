import type {
  HlsPlaylistMediaSource,
  LocalFileMediaSource,
  MediaSourceItem,
  RemoteUrlMediaSource,
} from './types';

const HLS_MIME_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
]);

export function createLocalFileSource(file: File): LocalFileMediaSource {
  return {
    kind: 'local-file',
    name: file.name,
    file,
  };
}

export function createRemoteUrlSource(url: string, name?: string, mimeType?: string | null): RemoteUrlMediaSource {
  return {
    kind: 'remote-url',
    url,
    name: name ?? getSourceNameFromUrl(url),
    mimeType: mimeType ?? null,
  };
}

export function createHlsPlaylistSource(url: string, name?: string): HlsPlaylistMediaSource {
  return {
    kind: 'hls-playlist',
    url,
    name: name ?? getSourceNameFromUrl(url),
  };
}

export function getSourceName(source: MediaSourceItem): string {
  return source.name;
}

export function getSourceNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastPathSegment = parsed.pathname.split('/').filter(Boolean).pop();
    if (lastPathSegment) {
      return decodeURIComponent(lastPathSegment);
    }
  } catch {
    // Fall back to the raw value for invalid URLs so validation can report it later.
  }

  return url;
}

export function isLocalFileSource(source: MediaSourceItem): source is LocalFileMediaSource {
  return source.kind === 'local-file';
}

export function isRemoteSource(source: MediaSourceItem): source is RemoteUrlMediaSource | HlsPlaylistMediaSource {
  return source.kind === 'remote-url' || source.kind === 'hls-playlist';
}

export function isHlsMimeType(value: string | null | undefined): boolean {
  return typeof value === 'string' && HLS_MIME_TYPES.has(value.toLowerCase());
}
