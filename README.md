# Browser Media Player with FFmpeg WASM Fallback

Browser media player that supports local files, direct remote URLs, and HLS playlists. It prefers native playback when the browser supports the source and falls back to `ffmpeg.wasm` for unsupported local files, or when the user forces FFmpeg mode for local playback.

## Features

- Local file playback
- Direct remote URL playback for browser-supported formats
- `m3u` / `m3u8` playlist import from local files or remote URLs
- HLS playback via native browser support or `hls.js`
- `Auto / Browser / FFmpeg` playback mode switch
- Native playback when `canPlayType()` reports support
- FFmpeg fallback for unsupported local formats
- Seek support in both modes
- Structured media info extracted from FFmpeg logs
- Raw FFmpeg log viewer

## How FFmpeg mode works

- The app probes the file with FFmpeg and parses stream/container information from the emitted logs.
- For fallback playback, it transcodes from the requested timestamp into a browser-friendly MP4 fragment.
- Seeking in FFmpeg mode restarts transcoding from the chosen position.

This gives a practical browser-only fallback path, but it is still constrained by browser CPU, memory, and `ffmpeg.wasm` startup cost.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

## Notes and limitations

- FFmpeg core files are loaded from the jsDelivr CDN at runtime.
- FFmpeg mode is available only for local files in this version.
- Remote non-HLS URLs depend on browser codec support and server CORS/range behavior.
- HLS playback uses native browser support when available and falls back to `hls.js` elsewhere.
- FFmpeg mode is heavier than native playback and seek is not instant for unsupported local formats.
- Browser codec/container detection is intentionally conservative and based on MIME + `canPlayType()`.
