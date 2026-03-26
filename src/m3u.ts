import type { MediaSourceItem } from './types';
import { createHlsPlaylistSource, createRemoteUrlSource, getSourceNameFromUrl } from './sourceUtils';

const M3U_COMMENT_PREFIX = '#';
const EXTINF_PREFIX = '#EXTINF:';
const HLS_TAG_PREFIX = '#EXT-X-';

export interface ParsedM3uPlaylist {
  kind: 'entries' | 'hls';
  entries: MediaSourceItem[];
}

function normalizeLine(value: string): string {
  return value.trim();
}

function resolvePlaylistEntry(rawValue: string, baseUrl?: string): string {
  if (!baseUrl) {
    return rawValue;
  }

  return new URL(rawValue, baseUrl).toString();
}

function parseExtInfName(line: string): string | null {
  if (!line.startsWith(EXTINF_PREFIX)) {
    return null;
  }

  const name = line.slice(EXTINF_PREFIX.length).split(',').slice(1).join(',').trim();
  return name || null;
}

export function isLikelyHlsManifest(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map(normalizeLine)
    .some((line) => line.startsWith(HLS_TAG_PREFIX));
}

export function parseM3uPlaylist(
  text: string,
  options?: {
    baseUrl?: string;
    playlistName?: string;
  },
): ParsedM3uPlaylist {
  if (options?.baseUrl && isLikelyHlsManifest(text)) {
    return {
      kind: 'hls',
      entries: [createHlsPlaylistSource(options.baseUrl, options.playlistName)],
    };
  }

  const entries: MediaSourceItem[] = [];
  let pendingName: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (!line) {
      continue;
    }

    const extInfName = parseExtInfName(line);
    if (extInfName) {
      pendingName = extInfName;
      continue;
    }

    if (line.startsWith(M3U_COMMENT_PREFIX)) {
      continue;
    }

    const resolvedUrl = resolvePlaylistEntry(line, options?.baseUrl);
    entries.push(createRemoteUrlSource(resolvedUrl, pendingName ?? getSourceNameFromUrl(resolvedUrl)));
    pendingName = null;
  }

  return {
    kind: 'entries',
    entries,
  };
}
