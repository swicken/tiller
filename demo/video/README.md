# Tiller demo video

A Remotion project that cuts the capture clips (demo/capture) into a 78-second demo:
a title card, one scene per beat inside a macOS-style window with a caption and highlights, and an
end card, with a music track underneath.

```sh
npm install
./render.sh        # writes tiller-demo.mp4 and contact-sheet.png to $DEMO_DIR/out
npm test           # the timing arithmetic
```

`render.sh` reads the clips from `$DEMO_DIR/clips` (or `CLIPS_DIR`; `DEMO_DIR` defaults to
`~/.tiller-demo`, as in `demo/capture/run.mjs`) and the music from
`$DEMO_DIR/music` (or `MUSIC`); neither is committed. The beats, trims, speed-ups and highlight
regions are in `src/beats.js`; the regions are rectangles in page pixels (the 1280x720 capture),
measured from the clip frames, so they need re-measuring after a new capture. Playwright records
the page unscaled in the top-left of each 1920x1080 clip frame; `src/Demo.jsx` (PAGE_IN_FRAME)
draws the clip at 1.5x and clips it to the page.

## Music

"Meditating Beat" by Kevin MacLeod, released to the public domain (CC0) through FreePD.
Original URL: https://freepd.com/music/Meditating%20Beat.mp3. FreePD closed in 2025, so the file
was downloaded from the Internet Archive's capture of that URL:
https://web.archive.org/web/20190403144058id_/https://freepd.com/music/Meditating%20Beat.mp3
(157 s, 320 kbps). Save it as `$DEMO_DIR/music/Meditating Beat.mp3`.
