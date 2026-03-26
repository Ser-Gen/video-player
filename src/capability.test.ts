import { detectCapability, inferMimeType } from './capability';
import { createHlsPlaylistSource, createRemoteUrlSource } from './sourceUtils';

describe('capability detection', () => {
  it('infers mime type from extension when file type is empty', () => {
    const file = new File(['x'], 'movie.mkv', { type: '' });
    expect(inferMimeType(file)).toBe('video/x-matroska');
  });

  it('marks browser support when canPlayType returns maybe', () => {
    const file = new File(['x'], 'song.mp3', { type: '' });
    const element = document.createElement('audio');
    vi.spyOn(element, 'canPlayType').mockReturnValue('maybe');

    expect(detectCapability(file, element)).toEqual({
      mimeType: 'audio/mpeg',
      browserSupported: true,
      isAudioOnly: true,
    });
  });

  it('detects HLS playlist mime type from source kind', () => {
    const element = document.createElement('video');
    vi.spyOn(element, 'canPlayType').mockReturnValue('');

    expect(detectCapability(createHlsPlaylistSource('https://example.com/live.m3u8'), element)).toEqual({
      mimeType: 'application/vnd.apple.mpegurl',
      browserSupported: false,
      isAudioOnly: false,
    });
  });

  it('infers remote url mime type from extension', () => {
    expect(inferMimeType(createRemoteUrlSource('https://example.com/track.mp3'))).toBe('audio/mpeg');
  });
});
