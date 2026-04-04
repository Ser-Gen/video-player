import { FFmpegService } from './ffmpegService';
import type { AudioExtractOptions, VideoExportOptions } from './types';

const mocks = vi.hoisted(() => ({
  fetchFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

vi.mock('@ffmpeg/util', () => ({
  fetchFile: mocks.fetchFile,
  toBlobURL: vi.fn(),
}));

type FakeFFmpeg = {
  exec: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function createServiceWithFakeInstance(fakeFfmpeg: FakeFFmpeg): FFmpegService {
  const service = new FFmpegService();
  const mutableService = service as any;

  mutableService.ffmpeg = fakeFfmpeg;
  mutableService.loadPromise = Promise.resolve();
  return service;
}

describe('FFmpegService temp file cleanup', () => {
  beforeEach(() => {
    mocks.fetchFile.mockClear();
  });

  it('deletes the input file after probe completes', async () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn().mockRejectedValue(new Error('At least one output file must be specified')),
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);

    await service.probe(new File(['x'], 'clip.mp4', { type: 'video/mp4' }));

    expect(fakeFfmpeg.writeFile).toHaveBeenCalledWith('/input', expect.any(Uint8Array));
    expect(fakeFfmpeg.deleteFile).toHaveBeenCalledWith('/input');
  });

  it('deletes temp files after a successful transcode', async () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(new Uint8Array([9, 8, 7])),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);

    const result = await service.transcodeFrom(new File(['x'], 'clip.mkv', { type: '' }), 5, false);

    expect(result.blob.size).toBeGreaterThan(0);
    expect(fakeFfmpeg.deleteFile).toHaveBeenCalledWith('/input');
    expect(fakeFfmpeg.deleteFile).toHaveBeenCalledWith('/output.mp4');
  });

  it('deletes temp files when transcode fails', async () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn().mockRejectedValue(new Error('Transcode failed')),
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);

    await expect(service.transcodeFrom(new File(['x'], 'clip.mkv', { type: '' }), 0, false)).rejects.toThrow(
      'Transcode failed',
    );

    expect(fakeFfmpeg.deleteFile).toHaveBeenCalledWith('/input');
    expect(fakeFfmpeg.deleteFile).toHaveBeenCalledWith('/output.mp4');
  });

  it('builds fast trim copy arguments for video export', async () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);
    const request: VideoExportOptions = {
      kind: 'video-mp4',
      trimRange: { startSec: 5, endSec: 25 },
      codecMode: 'copy-when-possible',
      includeAudio: true,
      crf: 34,
      targetResolution: 'original',
    };

    const result = await service.exportVideo(new File(['x'], 'clip.mov', { type: 'video/quicktime' }), request);

    expect(result.fileName).toBe('clip.trim-copy.mp4');
    expect(fakeFfmpeg.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['-ss', '5', '-t', '20', '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', '/output.mp4']),
      -1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('builds re-encode arguments with crf and no audio for video export', async () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);
    const request: VideoExportOptions = {
      kind: 'video-mp4',
      trimRange: { startSec: 0, endSec: 12 },
      codecMode: 'reencode',
      includeAudio: false,
      crf: 28,
      targetResolution: 'original',
    };

    const result = await service.exportVideo(new File(['x'], 'clip.mov', { type: 'video/quicktime' }), request);

    expect(result.fileName).toBe('clip.web.crf28.mp4');
    expect(fakeFfmpeg.exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-movflags',
        'faststart',
        '/output.mp4',
      ]),
      -1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('adds scale filter for video export resolution presets', async () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);
    const request: VideoExportOptions = {
      kind: 'video-mp4',
      trimRange: { startSec: 0, endSec: 12 },
      codecMode: 'reencode',
      includeAudio: true,
      crf: 34,
      targetResolution: '720p',
    };

    await service.exportVideo(new File(['x'], 'clip.mov', { type: 'video/quicktime' }), request);

    expect(fakeFfmpeg.exec).toHaveBeenCalledWith(
      expect.arrayContaining([
        '-vf',
        'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2',
      ]),
      -1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('builds mp3 audio extraction arguments', async () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);
    const request: AudioExtractOptions = {
      kind: 'audio-mp3',
      trimRange: { startSec: 2, endSec: 18 },
    };

    const result = await service.extractAudio(new File(['x'], 'clip.mp4', { type: 'video/mp4' }), request);

    expect(result.fileName).toBe('clip.audio.mp3');
    expect(fakeFfmpeg.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['-vn', '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '192k', '/output.mp3']),
      -1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('builds m4a audio extraction arguments', async () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);
    const request: AudioExtractOptions = {
      kind: 'audio-m4a',
      trimRange: { startSec: 1, endSec: 9 },
    };

    const result = await service.extractAudio(new File(['x'], 'clip.mp4', { type: 'video/mp4' }), request);

    expect(result.fileName).toBe('clip.audio.m4a');
    expect(fakeFfmpeg.exec).toHaveBeenCalledWith(
      expect.arrayContaining(['-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-f', 'ipod', '/output.m4a']),
      -1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('terminates the ffmpeg worker when export is cancelled', () => {
    const fakeFfmpeg: FakeFFmpeg = {
      exec: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      terminate: vi.fn(),
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);

    service.cancelExport();

    expect(fakeFfmpeg.terminate).toHaveBeenCalledTimes(1);
    expect((service as any).ffmpeg).toBeNull();
    expect((service as any).loadPromise).toBeNull();
  });
});
