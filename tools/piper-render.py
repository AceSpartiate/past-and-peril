"""piper-render.py — turn a job file into mp3s. Driven by tools/render-voices.mjs.

    python tools/piper-render.py <job.json>

The job file is a list of {id, text, voice, length, noiseW, out}. Jobs are
sorted by voice upstream so each ~63 MB model is loaded exactly once; loading
per line would take about forty minutes instead of about two.

Nothing here talks to the network. Piper is offline after the model is on disk.
"""

import io
import json
import os
import sys
import wave

from piper import PiperVoice, SynthesisConfig
import numpy as np
import soundfile as sf

if len(sys.argv) < 2:
    sys.exit("usage: python tools/piper-render.py <job.json>")

with io.open(sys.argv[1], encoding="utf-8") as fh:
    job = json.load(fh)

VOICES_DIR = job["voicesDir"]
BITRATE = job.get("bitrate", 48000)

# One model at a time, held only while its lines are being spoken.
loaded = None
loaded_id = None
done = 0
failed = []
bytes_out = 0

for i, line in enumerate(job["lines"]):
    if line["voice"] != loaded_id:
        model = os.path.join(VOICES_DIR, line["voice"] + ".onnx")
        if not os.path.exists(model):
            failed.append((line["id"], "no model: " + model))
            continue
        print("  loading %s" % line["voice"], flush=True)
        loaded = PiperVoice.load(model)
        loaded_id = line["voice"]

    cfg = SynthesisConfig(
        length_scale=line.get("length", 1.0),
        noise_w_scale=line.get("noiseW", 0.8),
        normalize_audio=True,
    )
    try:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            loaded.synthesize_wav(line["text"], wf, syn_config=cfg)
        buf.seek(0)
        pcm, rate = sf.read(buf, dtype="float32")

        # libsndfile writes MP3 directly, which is the whole reason this
        # pipeline needs no ffmpeg. compression_level 0.6 at 22 kHz mono is
        # about 48 kbps -- speech-transparent, and a fortieth of the WAV.
        sf.write(line["out"], pcm, rate, format="MP3", compression_level=0.6)
        bytes_out += os.path.getsize(line["out"])
        done += 1
        if done % 25 == 0:
            print("  %d/%d" % (done, len(job["lines"])), flush=True)
    except Exception as exc:                      # one bad line never stops the run
        failed.append((line["id"], repr(exc)))

print(json.dumps({"rendered": done, "bytes": bytes_out, "failed": failed}))
