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

## URL API

The player can preload the playlist from the page URL via the `initPlaylist` query parameter.

Supported shape:

```json
[
  {
    "url": "https://cdn.example.com/stream.mp3",
    "name": "Startup Stream"
  },
  {
    "url": "https://cdn.example.com/live",
    "name": "Live HLS",
    "mimeType": "application/vnd.apple.mpegurl"
  }
]
```

Rules:

- `initPlaylist` must be a JSON-encoded array
- each item must be an object with required `url`
- `url` must be an absolute URL
- `name` is optional and overrides the derived display name
- `mimeType` is optional and can help the player recognize streams without file extensions
- `.m3u8` URLs or entries with HLS MIME are treated as HLS playlist sources
- valid items are added to Playlist on startup
- startup import does not auto-open or autoplay the first item
- invalid items are skipped and reported in the sidebar/debug message area

Example:

```text
http://localhost:5173/?initPlaylist=%5B%7B%22url%22%3A%22https%3A%2F%2Fcdn.example.com%2Fstream.mp3%22%2C%22name%22%3A%22Startup%20Stream%22%7D%2C%7B%22url%22%3A%22https%3A%2F%2Fcdn.example.com%2Flive%22%2C%22name%22%3A%22Live%20HLS%22%2C%22mimeType%22%3A%22application%2Fvnd.apple.mpegurl%22%7D%5D
```

The decoded `initPlaylist` value in that example is the JSON array shown above.

## Keyboard Shortcuts

- `Space` or `K`: play / pause
- `ArrowLeft` or `J`: seek backward by `10` seconds
- `ArrowRight` or `L`: seek forward by `10` seconds
- `ArrowUp`: volume `+10%`
- `ArrowDown`: volume `-10%`
- `M`: mute / unmute
- `Alt + ArrowUp`: previous playlist item
- `Alt + ArrowDown`: next playlist item

Playlist navigation with `Alt + ArrowUp` / `Alt + ArrowDown` is cyclical: after the last item, the first item starts; before the first item, the last item starts.

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
