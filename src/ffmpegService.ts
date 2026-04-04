import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { parseMediaInfoFromLogs } from './ffmpegLogParser';
import type { AudioExtractOptions, ExportResult, MediaInfo, VideoExportOptions, VideoResolutionPreset } from './types';

const INPUT_FILE = '/input';
const OUTPUT_FILE = '/output.mp4';
const OUTPUT_AUDIO_MP3_FILE = '/output.mp3';
const OUTPUT_AUDIO_M4A_FILE = '/output.m4a';
const SEGMENT_LENGTH_SEC = 20;
const OUTPUT_MIME = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
const OUTPUT_AUDIO_MIME = 'audio/mp4; codecs="mp4a.40.2"';
const MP3_MIME = 'audio/mpeg';

const RESOLUTION_PRESET_SCALE: Record<Exclude<VideoResolutionPreset, 'original'>, { width: number; height: number }> = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
};

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
  private progressListeners = new Set<(progress: number) => void>();
  private currentLogs: string[] = [];
  private exportAbortController: AbortController | null = null;

  onLog(listener: (message: string) => void): () => void {
    this.logListeners.add(listener);
    return () => {
      this.logListeners.delete(listener);
    };
  }

  onProgress(listener: (progress: number) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
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
    ffmpeg.on('progress', ({ progress }) => {
      for (const listener of this.progressListeners) {
        listener(progress);
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
      await ffmpeg.exec(['-hide_banner', '-i', INPUT_FILE]);
    } catch {
      // We intentionally stop after input inspection. FFmpeg prints stream/container
      // metadata before exiting with "At least one output file must be specified".
    } finally {
      await this.cleanupTempFiles(INPUT_FILE);
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

    try {
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
    } finally {
      await this.cleanupTempFiles(INPUT_FILE, OUTPUT_FILE);
    }
  }

  async exportVideo(file: File, request: VideoExportOptions): Promise<ExportResult> {
    await this.load();
    this.resetLogs();
    const ffmpeg = this.instance;

    await this.writeInput(file);
    await this.safeDelete(OUTPUT_FILE);

    const durationSec = Math.max(0.1, request.trimRange.endSec - request.trimRange.startSec);
    const args = [
      '-hide_banner',
      '-ss',
      `${Math.max(0, request.trimRange.startSec)}`,
      '-i',
      INPUT_FILE,
      '-t',
      `${durationSec}`,
      '-max_muxing_queue_size',
      '4096',
      '-map',
      '0:v:0',
    ];

    if (request.includeAudio) {
      args.push('-map', '0:a?');
    }

    if (request.codecMode === 'copy-when-possible') {
      args.push('-c:v', 'copy');
      if (request.includeAudio) {
        args.push('-c:a', 'copy');
      } else {
        args.push('-an');
      }
      args.push('-movflags', '+faststart', OUTPUT_FILE);
    } else {
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        `${request.crf}`,
        '-pix_fmt',
        'yuv420p',
      );
      if (request.targetResolution !== 'original') {
        args.push(
          '-vf',
          this.buildScaleFilter(request.targetResolution),
        );
      }
      if (request.includeAudio) {
        args.push('-c:a', 'aac', '-b:a', '128k');
      } else {
        args.push('-an');
      }
      args.push('-movflags', 'faststart', OUTPUT_FILE);
    }

    try {
      const abortController = new AbortController();
      this.exportAbortController = abortController;
      await ffmpeg.exec(args, -1, { signal: abortController.signal });
      const blob = await this.readOutputBlob(OUTPUT_FILE, 'video/mp4');
      return {
        blob,
        mimeType: 'video/mp4',
        fileName: this.buildOutputFileName(file.name, request),
      };
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new Error('Export cancelled.');
      }
      throw error;
    } finally {
      this.exportAbortController = null;
      await this.cleanupTempFiles(INPUT_FILE, OUTPUT_FILE);
    }
  }

  async extractAudio(file: File, request: AudioExtractOptions): Promise<ExportResult> {
    await this.load();
    this.resetLogs();
    const ffmpeg = this.instance;

    const outputFile = request.kind === 'audio-mp3' ? OUTPUT_AUDIO_MP3_FILE : OUTPUT_AUDIO_M4A_FILE;
    const mimeType = request.kind === 'audio-mp3' ? MP3_MIME : 'audio/mp4';
    const durationSec = Math.max(0.1, request.trimRange.endSec - request.trimRange.startSec);

    await this.writeInput(file);
    await this.safeDelete(outputFile);

    const args = [
      '-hide_banner',
      '-ss',
      `${Math.max(0, request.trimRange.startSec)}`,
      '-i',
      INPUT_FILE,
      '-t',
      `${durationSec}`,
      '-vn',
      '-map',
      '0:a:0',
    ];

    if (request.kind === 'audio-mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', '192k', outputFile);
    } else {
      args.push('-c:a', 'aac', '-b:a', '192k', '-f', 'ipod', outputFile);
    }

    try {
      const abortController = new AbortController();
      this.exportAbortController = abortController;
      await ffmpeg.exec(args, -1, { signal: abortController.signal });
      const blob = await this.readOutputBlob(outputFile, mimeType);
      return {
        blob,
        mimeType,
        fileName: this.buildOutputFileName(file.name, request),
      };
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new Error('Export cancelled.');
      }
      throw error;
    } finally {
      this.exportAbortController = null;
      await this.cleanupTempFiles(INPUT_FILE, outputFile);
    }
  }

  cancelExport(): void {
    this.exportAbortController?.abort();

    if (this.ffmpeg) {
      this.ffmpeg.terminate();
    }

    this.ffmpeg = null;
    this.loadPromise = null;
    this.exportAbortController = null;
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
    if (!this.ffmpeg) {
      return;
    }

    try {
      await this.instance.deleteFile(path);
    } catch {
      // Ignore missing files in the in-memory FS.
    }
  }

  private async cleanupTempFiles(...paths: string[]): Promise<void> {
    await Promise.all(paths.map((path) => this.safeDelete(path)));
  }

  private async readOutputBlob(path: string, mimeType: string): Promise<Blob> {
    const bytes = await this.instance.readFile(path);
    const blobPayload =
      typeof bytes === 'string'
        ? new TextEncoder().encode(bytes)
        : (() => {
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            return copy.buffer;
          })();

    return new Blob([blobPayload], { type: mimeType });
  }

  private buildOutputFileName(sourceName: string, request: VideoExportOptions | AudioExtractOptions): string {
    const baseName = sourceName.replace(/\.[^.]+$/, '');

    if (request.kind === 'video-mp4') {
      return request.codecMode === 'copy-when-possible'
        ? `${baseName}.trim-copy.mp4`
        : `${baseName}.web.crf${request.crf}.mp4`;
    }

    return request.kind === 'audio-mp3' ? `${baseName}.audio.mp3` : `${baseName}.audio.m4a`;
  }

  private buildScaleFilter(preset: Exclude<VideoResolutionPreset, 'original'>): string {
    const target = RESOLUTION_PRESET_SCALE[preset];
    return `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException
      ? error.name === 'AbortError'
      : error instanceof Error &&
          (error.message.toLowerCase().includes('abort') || error.message.toLowerCase().includes('terminate'));
  }
}
