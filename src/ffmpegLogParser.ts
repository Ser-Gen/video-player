import type { AudioStreamInfo, MediaInfo, VideoStreamInfo } from './types';

function parseDuration(rawLog: string): number | null {
  const match = rawLog.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
  if (!match) {
    return null;
  }

  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseContainer(rawLog: string): string | null {
  const match = rawLog.match(/Input #0,\s*([^,]+),/);
  return match?.[1]?.trim() ?? null;
}

function parseBitrate(rawLog: string): string | null {
  const match = rawLog.match(/bitrate:\s*([^\r\n]+)/);
  return match?.[1]?.trim() ?? null;
}

function parseVideo(rawLog: string): VideoStreamInfo | null {
  const line = rawLog
    .split('\n')
    .find((entry) => entry.includes('Video:'));

  if (!line) {
    return null;
  }

  const codec = line.match(/Video:\s*([^,\s]+)/)?.[1] ?? null;
  const size = line.match(/(\d{2,5})x(\d{2,5})/);
  const fps = line.match(/(\d+(?:\.\d+)?)\s*fps/);

  return {
    codec,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
  };
}

function parseAudio(rawLog: string): AudioStreamInfo | null {
  const line = rawLog
    .split('\n')
    .find((entry) => entry.includes('Audio:'));

  if (!line) {
    return null;
  }

  const codec = line.match(/Audio:\s*([^,\s]+)/)?.[1] ?? null;
  const sampleRate = line.match(/(\d+)\s*Hz/)?.[1] ?? null;
  const channels = line.match(/(?:Hz,\s*)([^,]+)(?:,|$)/)?.[1]?.trim() ?? null;

  return {
    codec,
    sampleRate: sampleRate ? Number(sampleRate) : null,
    channelLayout: channels,
  };
}

export function parseMediaInfoFromLogs(logs: string[]): MediaInfo {
  const rawLog = logs.join('\n');

  return {
    container: parseContainer(rawLog),
    durationSec: parseDuration(rawLog),
    bitrate: parseBitrate(rawLog),
    video: parseVideo(rawLog),
    audio: parseAudio(rawLog),
    rawLog,
  };
}
