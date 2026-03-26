import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { parseMediaInfoFromLogs } from './ffmpegLogParser';
import type { MediaInfo } from './types';

const INPUT_FILE = '/input';
const PROBE_OUTPUT = '/probe-null';
const OUTPUT_FILE = '/output.mp4';
const SEGMENT_LENGTH_SEC = 20;
const OUTPUT_MIME = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
const OUTPUT_AUDIO_MIME = 'audio/mp4; codecs="mp4a.40.2"';

export interface TranscodeResult {
  blob: Blob;
  mimeType: string;
  mediaInfo: MediaInfo;
  segmentDurationSec: number;
}

export class FFmpegService {
  private ffmpeg: FFmpeg | null = null;
  private loadPromise: Promise<void> | null = null;
  private logListeners = new Set<(message: string) => void>();
  private currentLogs: string[] = [];

  onLog(listener: (message: string) => void): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  async load(): Promise<void> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = this.init();
    return this.loadPromise;
  }

  private async init(): Promise<void> {
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

    ffmpeg.on('log', ({ message }) => {
      this.currentLogs.push(message);
      for (const listener of this.logListeners) {
        listener(message);
      }
    });

    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
    });

    this.ffmpeg = ffmpeg;
  }

  private get instance(): FFmpeg {
    if (!this.ffmpeg) {
      throw new Error('FFmpeg is not loaded');
    }
    return this.ffmpeg;
  }

  async probe(file: File): Promise<MediaInfo> {
    await this.load();
    this.resetLogs();
    const ffmpeg = this.instance;

    await this.writeInput(file);

    try {
      await ffmpeg.exec(['-hide_banner', '-i', INPUT_FILE, '-f', 'null', PROBE_OUTPUT]);
    } catch {
      // Probe via stderr is still usable even when ffmpeg exits with a decode error.
    }

    return parseMediaInfoFromLogs(this.currentLogs);
  }

  async transcodeFrom(file: File, startTimeSec: number, isAudioOnly: boolean): Promise<TranscodeResult> {
    await this.load();
    this.resetLogs();
    const ffmpeg = this.instance;

    await this.writeInput(file);
    await this.safeDelete(OUTPUT_FILE);

    const args = [
      '-hide_banner',
      '-ss',
      `${Math.max(0, startTimeSec)}`,
      '-i',
      INPUT_FILE,
      '-t',
      `${SEGMENT_LENGTH_SEC}`,
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-preset',
      'ultrafast',
    ];

    if (isAudioOnly) {
      args.push(
        '-vn',
        '-acodec',
        'aac',
        '-b:a',
        '192k',
        '-f',
        'mp4',
        OUTPUT_FILE,
      );
    } else {
      args.push(
        '-vcodec',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'baseline',
        '-level',
        '3.0',
        '-g',
        '48',
        '-keyint_min',
        '48',
        '-sc_threshold',
        '0',
        '-acodec',
        'aac',
        '-b:a',
        '192k',
        '-f',
        'mp4',
        OUTPUT_FILE,
      );
    }

    await ffmpeg.exec(args);
    const bytes = await ffmpeg.readFile(OUTPUT_FILE);
    const blobPayload =
      typeof bytes === 'string'
        ? new TextEncoder().encode(bytes)
        : (() => {
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            return copy.buffer;
          })();
    const mediaInfo = parseMediaInfoFromLogs(this.currentLogs);

    return {
      blob: new Blob([blobPayload], {
        type: isAudioOnly ? OUTPUT_AUDIO_MIME : OUTPUT_MIME,
      }),
      mimeType: isAudioOnly ? OUTPUT_AUDIO_MIME : OUTPUT_MIME,
      mediaInfo,
      segmentDurationSec: SEGMENT_LENGTH_SEC,
    };
  }

  private async writeInput(file: File): Promise<void> {
    const ffmpeg = this.instance;
    await this.safeDelete(INPUT_FILE);
    await ffmpeg.writeFile(INPUT_FILE, await fetchFile(file));
  }

  private resetLogs(): void {
    this.currentLogs = [];
  }

  private async safeDelete(path: string): Promise<void> {
    try {
      await this.instance.deleteFile(path);
    } catch {
      // Ignore missing files in the in-memory FS.
    }
  }
}
