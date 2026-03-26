import { FFmpegService } from './ffmpegService';

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
    };
    const service = createServiceWithFakeInstance(fakeFfmpeg);

    await expect(service.transcodeFrom(new File(['x'], 'clip.mkv', { type: '' }), 0, false)).rejects.toThrow(
      'Transcode failed',
    );

    expect(fakeFfmpeg.deleteFile).toHaveBeenCalledWith('/input');
    expect(fakeFfmpeg.deleteFile).toHaveBeenCalledWith('/output.mp4');
  });
});
