#!/bin/sh
# Renders the cut to $DEMO_DIR/out/tiller-demo.mp4 plus a contact sheet, from the capture
# worker's clips in $DEMO_DIR/clips (CLIPS_DIR overrides), with the music track mixed in
# (MUSIC overrides; see README.md).
set -eu
cd "$(dirname "$0")"
demo=${DEMO_DIR:-$HOME/.tiller-demo}
clips=${CLIPS_DIR:-$demo/clips}
music=${MUSIC:-$demo/music/Meditating Beat.mp3}
out=$demo/out
[ -f "$clips/clips.json" ] || { echo "no clips.json in $clips" >&2; exit 1; }
[ -f "$music" ] || { echo "no music at $music; see README.md" >&2; exit 1; }

# public/ is generated: the brand assets and a link to the clips (Remotion's bundle forwards
# a linked directory).
mkdir -p public "$out"
cp ../../docs/assets/logo-dark.png ../../src-tauri/icons/icon.png public/
ln -sfn "$clips" public/clips

npx remotion render src/index.jsx TillerDemo "$out/tiller-demo.video.mp4" \
  --codec=h264 --concurrency="${CONCURRENCY:-12}" --log=error

# Music under the whole cut: looped or trimmed to length, normalised to -18 LUFS, a 1 s fade
# in and a 2 s fade out.
len=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/tiller-demo.video.mp4")
fade_at=$(echo "$len - 2" | bc)
ffmpeg -y -loglevel error -i "$out/tiller-demo.video.mp4" -stream_loop -1 -i "$music" \
  -filter_complex "[1:a]atrim=0:$len,asetpts=PTS-STARTPTS,loudnorm=I=-18:TP=-2,aresample=48000,afade=t=in:d=1,afade=t=out:st=$fade_at:d=2[a]" \
  -map 0:v -map '[a]' -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$out/tiller-demo.mp4"
rm "$out/tiller-demo.video.mp4"

node contact-sheet.mjs "$out/tiller-demo.mp4" "$out/contact-sheet.png"
