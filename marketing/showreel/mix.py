"""Mixes looped music with SFX at the frame-exact times in sfx.json, then muxes onto reel_silent.mp4.
Env: MUSIC, SECONDS, OUT."""
import json, os, subprocess

MUSIC = os.environ.get("MUSIC", "audio/battle_music.mp3")
SECONDS = float(os.environ.get("SECONDS", "30"))
OUT = os.environ.get("OUT", "monicard-battle-ad-1080x1920-60fps.mp4")

events = json.load(open("sfx.json"))
args = ["ffmpeg", "-y", "-v", "error", "-i", "reel_silent.mp4", "-stream_loop", "1", "-i", MUSIC]
for e in events:
    args += ["-i", f"audio/{e['file']}.mp3"]
chains = [f"[1:a]atrim=0:{SECONDS},afade=t=in:d=0.02,afade=t=out:st={SECONDS - 1.2}:d=1.2,volume=0.5[m]"]
labels = ["[m]"]
for i, e in enumerate(events):
    ms = max(0, round(e["t"] * 1000))
    chains.append(f"[{i + 2}:a]volume={e['gain'] * 0.8:.3f},adelay={ms}|{ms}[s{i}]")
    labels.append(f"[s{i}]")
chains.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0:dropout_transition=0,"
              f"atrim=0:{SECONDS},alimiter=limit=0.89:level=false,loudnorm=I=-14:TP=-1:LRA=11[a]")
args += ["-filter_complex", ";".join(chains), "-map", "0:v", "-map", "[a]",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-movflags", "+faststart", "-t", str(SECONDS), OUT]
subprocess.run(args, check=True)
