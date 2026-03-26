import { isLikelyHlsManifest, parseM3uPlaylist } from './m3u';

describe('m3u playlist parsing', () => {
  it('parses local m3u8 files with absolute urls', () => {
    const parsed = parseM3uPlaylist(`#EXTM3U
#EXTINF:-1,Sample One
https://cdn.example.com/video-one.mp4
https://cdn.example.com/video-two.mp3`);

    expect(parsed.kind).toBe('entries');
    expect(parsed.entries.map((entry) => entry.name)).toEqual(['Sample One', 'video-two.mp3']);
    expect(parsed.entries.every((entry) => entry.kind === 'remote-url')).toBe(true);
  });

  it('resolves relative urls against the playlist url', () => {
    const parsed = parseM3uPlaylist(`#EXTM3U
tracks/song.mp3
../video/clip.mp4`, {
      baseUrl: 'https://example.com/playlists/list.m3u',
    });

    expect(parsed.entries.map((entry) => (entry.kind === 'remote-url' ? entry.url : null))).toEqual([
      'https://example.com/playlists/tracks/song.mp3',
      'https://example.com/video/clip.mp4',
    ]);
  });

  it('ignores blank lines and comments', () => {
    const parsed = parseM3uPlaylist(`#EXTM3U

# Comment
https://example.com/a.mp4

# Another comment
https://example.com/b.mp4`);

    expect(parsed.entries).toHaveLength(2);
  });

  it('detects remote hls manifests as a single hls source', () => {
    const text = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6,
segment-1.ts`;

    expect(isLikelyHlsManifest(text)).toBe(true);

    const parsed = parseM3uPlaylist(text, {
      baseUrl: 'https://example.com/live/index.m3u8',
      playlistName: 'Live Stream',
    });

    expect(parsed.kind).toBe('hls');
    expect(parsed.entries).toEqual([
      {
        kind: 'hls-playlist',
        name: 'Live Stream',
        url: 'https://example.com/live/index.m3u8',
      },
    ]);
  });
});
