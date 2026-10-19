# videosplit

A small Electron desktop app for trimming MP4s: open a video, mark an In and Out point, and export that range as a new MP4.

## Run

```
npm install
npm start
```

Open a file with **Open…** / `Ctrl+O`, or drag an MP4 onto the window.

## Shortcuts

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / pause |
| `L` / `J` | Play forward / reverse (press again for 2×, 4×, 8×) |
| `←` / `→` | Step one frame |
| `Shift+←/→` | Jump 1 second |
| `Ctrl+←/→` | Jump 10 seconds |
| `Home` / `End` | Go to start / end |
| `I` / `O` | Set In / Out at the playhead |
| `Shift+I` / `Shift+O` | Go to In / Out |
| `P` | Play the selection |
| `X` | Clear In / Out |
| `M` | Mute |
| `+` / `-`, `Ctrl+wheel` | Zoom the timeline |
| `Ctrl+E` | Export |
| `?` | Show shortcuts |

## Export

Export uses FFmpeg (bundled via `ffmpeg-static`) with stream copy, so it is fast and lossless. The trade-off is that the clip starts at the keyframe at or before the In point, so it can begin a little earlier than marked.
