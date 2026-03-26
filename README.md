# Browser Media Player with FFmpeg WASM Fallback

Local-first browser player that prefers native playback when the browser supports the file and falls back to `ffmpeg.wasm` when it does not, or when the user forces FFmpeg mode.

## Features

- Local file input only for v1
- `Auto / Browser / FFmpeg` playback mode switch
- Native playback when `canPlayType()` reports support
- FFmpeg fallback for unsupported formats
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
- v1 is designed for local files only, not remote URLs.
- FFmpeg mode is heavier than native playback and seek is not instant for unsupported formats.
- Browser codec/container detection is intentionally conservative and based on MIME + `canPlayType()`.
