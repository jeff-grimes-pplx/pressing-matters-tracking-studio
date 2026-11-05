import json
import math
import struct
import subprocess
import wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT_DIR = Path("/home/user/workspace/pressing-matters-studio")
VIDEO_DIR = ROOT_DIR / "video"
RAW_DIR = VIDEO_DIR / "raw_scenes"
AUDIO_DIR = VIDEO_DIR / "audio"
CAP_DIR = VIDEO_DIR / "captions"
SCENE_OUT_DIR = VIDEO_DIR / "captioned_scenes"
CAP_DIR.mkdir(parents=True, exist_ok=True)
SCENE_OUT_DIR.mkdir(parents=True, exist_ok=True)

FINAL_MP4 = ROOT_DIR / "pressing_matters_showcase_v2.mp4"

scenes_meta = json.loads((AUDIO_DIR / "scenes_meta.json").read_text())

def load_font(size: int):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()

FONT_MAIN = load_font(22)
FONT_TAG = load_font(15)

def make_caption_png(scene_idx: int, total_scenes: int, caption_text: str, out_png: Path):
    img = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Measure caption text
    bbox = draw.textbbox((0, 0), caption_text, font=FONT_MAIN)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    tag_text = f"{scene_idx:02d}/{total_scenes:02d}"
    tbbox = draw.textbbox((0, 0), tag_text, font=FONT_TAG)
    tag_w = tbbox[2] - tbbox[0] + 20

    pad_x = 26
    pill_w = min(1840, tw + tag_w + pad_x * 2 + 18)
    pill_h = 46
    pill_x = (1920 - pill_w) // 2
    pill_y = 1025  # sits cleanly inside the bottom 64px gutter (y=1016..1080)

    # Subtle outer shadow
    draw.rounded_rectangle(
        [pill_x - 2, pill_y - 1, pill_x + pill_w + 2, pill_y + pill_h + 3],
        radius=12,
        fill=(0, 0, 0, 140),
    )
    # Opaque dark pill
    draw.rounded_rectangle(
        [pill_x, pill_y, pill_x + pill_w, pill_y + pill_h],
        radius=11,
        fill=(11, 16, 24, 245),
        outline=(44, 58, 78, 255),
        width=1,
    )
    # Scene badge on left of pill
    badge_x1 = pill_x + 10
    badge_y1 = pill_y + 8
    badge_x2 = badge_x1 + tag_w
    badge_y2 = pill_y + pill_h - 8
    draw.rounded_rectangle(
        [badge_x1, badge_y1, badge_x2, badge_y2],
        radius=6,
        fill=(244, 166, 41, 38),
        outline=(244, 166, 41, 160),
        width=1,
    )
    draw.text(
        (badge_x1 + 10, badge_y1 + 6),
        tag_text,
        font=FONT_TAG,
        fill=(244, 166, 41, 255),
    )

    # Caption text
    tx = badge_x2 + 16
    ty = pill_y + (pill_h - th) // 2 - 2
    draw.text((tx, ty), caption_text, font=FONT_MAIN, fill=(243, 246, 250, 255))
    img.save(out_png)

def generate_ambient_and_sfx_wav(total_dur: float, out_wav: Path):
    sr = 44100
    n_samples = int(total_dur * sr)
    # Build subtle click timestamps at scene transitions & interactions
    click_times = []
    t_acc = 0.0
    for idx, sc in enumerate(scenes_meta):
        if idx > 0:
            click_times.append(t_acc + 0.05)
        if sc["id"] in ("s02", "s05", "s06", "s07", "s08", "s11", "s12", "s13", "s14", "s15"):
            click_times.append(t_acc + 1.25)
        t_acc += sc["scene_dur"]

    click_samples = set(int(ct * sr) for ct in click_times)

    with wave.open(str(out_wav), "w") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)

        buf = bytearray()
        # Warm low-volume harmonic chord (D2 + A2 + F#3 + A3) with slow breathing LFO
        f1, f2, f3, f4 = 73.42, 110.00, 185.00, 220.00
        active_click = 0
        for i in range(n_samples):
            t = i / sr
            if i in click_samples:
                active_click = int(0.018 * sr)
            lfo = 0.75 + 0.25 * math.sin(2 * math.pi * 0.11 * t)
            pad = (
                0.45 * math.sin(2 * math.pi * f1 * t)
                + 0.30 * math.sin(2 * math.pi * f2 * t)
                + 0.15 * math.sin(2 * math.pi * f3 * t)
                + 0.10 * math.sin(2 * math.pi * f4 * t)
            ) * lfo * 0.022  # very subtle (-33 dBFS) under Chris VO

            # Fade in first 1.2s and fade out last 1.8s
            env = 1.0
            if t < 1.2:
                env = t / 1.2
            elif t > total_dur - 1.8:
                env = max(0.0, (total_dur - t) / 1.8)

            sfx = 0.0
            if active_click > 0:
                prog = 1.0 - (active_click / (0.018 * sr))
                sfx = math.sin(2 * math.pi * (880 - 420 * prog) * prog * 0.018) * math.exp(-prog * 6.0) * 0.065
                active_click -= 1

            val = max(-0.98, min(0.98, pad * env + sfx))
            s16 = int(val * 32767)
            buf.extend(struct.pack("<hh", s16, s16))
            if len(buf) >= 65536:
                wf.writeframes(buf)
                buf.clear()
        if buf:
            wf.writeframes(buf)

def main():
    total_scenes = len(scenes_meta)
    concat_entries = []

    for idx, sc in enumerate(scenes_meta, start=1):
        sid = sc["id"]
        dur = sc["scene_dur"]
        raw_mp4 = RAW_DIR / f"{sid}.mp4"
        vo_mp3 = AUDIO_DIR / f"{sid}.mp3"
        cap_png = CAP_DIR / f"{sid}.png"
        scene_mp4 = SCENE_OUT_DIR / f"{sid}.mp4"

        make_caption_png(idx, total_scenes, sc["caption"], cap_png)

        # Composite caption PNG onto raw scene video and pad/align scene VO to exact scene duration
        dur_ms = int(round(dur * 1000))
        cmd = [
            "ffmpeg",
            "-y",
            "-i", str(raw_mp4),
            "-i", str(cap_png),
            "-i", str(vo_mp3),
            "-filter_complex",
            f"[0:v][1:v]overlay=0:0:format=auto[vout];"
            f"[2:a]adelay=160|160,apad=whole_dur={dur:.3f},atrim=0:{dur:.3f},asetpts=PTS-STARTPTS[aout]",
            "-map", "[vout]",
            "-map", "[aout]",
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "17",
            "-pix_fmt", "yuv420p",
            "-r", "30",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ar", "44100",
            "-ac", "2",
            "-t", f"{dur:.3f}",
            str(scene_mp4),
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        concat_entries.append(f"file '{scene_mp4}'")
        print(f"Composited {sid} ({dur:.2f}s)")

    concat_list = VIDEO_DIR / "concat_list.txt"
    concat_list.write_text("\n".join(concat_entries) + "\n")

    concat_mp4 = VIDEO_DIR / "concat_vo.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list),
            "-c", "copy",
            str(concat_mp4),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    total_dur = float(
        subprocess.check_output(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(concat_mp4),
            ]
        )
        .decode()
        .strip()
    )
    print(f"Concatenated video duration: {total_dur:.2f}s")

    bed_wav = VIDEO_DIR / "ambient_bed.wav"
    generate_ambient_and_sfx_wav(total_dur, bed_wav)

    # Mix VO + ambient bed and normalize integrated loudness to -16 LUFS
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i", str(concat_mp4),
            "-i", str(bed_wav),
            "-filter_complex",
            "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:weights='1.0 0.28',loudnorm=I=-16:TP=-1.5:LRA=11[aout]",
            "-map", "0:v",
            "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ar", "44100",
            "-movflags", "+faststart",
            str(FINAL_MP4),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"Final master rendered: {FINAL_MP4} ({FINAL_MP4.stat().st_size / (1024*1024):.2f} MB)")

if __name__ == "__main__":
    main()
