import { parseMediaInfoFromLogs } from './ffmpegLogParser';

describe('parseMediaInfoFromLogs', () => {
  it('extracts structured data from ffmpeg logs', () => {
    const info = parseMediaInfoFromLogs([
      'Input #0, matroska,webm, from /input:',
      '  Duration: 00:01:12.50, start: 0.000000, bitrate: 1536 kb/s',
      '  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps',
      '  Stream #0:1: Audio: aac, 48000 Hz, stereo, fltp',
    ]);

    expect(info.container).toBe('matroska');
    expect(info.durationSec).toBeCloseTo(72.5);
    expect(info.video?.codec).toBe('h264');
    expect(info.video?.width).toBe(1920);
    expect(info.audio?.codec).toBe('aac');
    expect(info.audio?.sampleRate).toBe(48000);
    expect(info.audio?.channelLayout).toBe('stereo');
  });
});
