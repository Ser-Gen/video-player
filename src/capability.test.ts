import { detectCapability, inferMimeType } from './capability';

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
});
