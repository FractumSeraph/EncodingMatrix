#!/usr/bin/env python3
"""
Batch video encoder matrix for FFmpeg quality comparison.

How to use:
1) Put your source file at: source.mp4 (same folder as this script)
2) Ensure FFmpeg is installed and available in PATH
3) Run: python batch_encode.py

Useful optimization options:
- Non-linear schedule (default):
  python batch_encode.py --schedule interleave
- Fast-first schedule:
  python batch_encode.py --schedule fast-first
- Parallel CPU + GPU lanes (example):
  python batch_encode.py --cpu-workers 2 --gpu-workers 1

Pip dependencies:
- None (uses Python standard library only)

Outputs:
- Encoded files in ./encodes/
- Progress/state in manifest.json

Resumability:
- The script reads manifest.json before each encode.
- If an entry for (codec_name, preset, crf_value) already exists, it skips that job.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Dict, List, Tuple


@dataclass(frozen=True)
class CodecSpec:
    codec_name: str
    ffmpeg_encoder: str
    presets: List[str]
    qmin: int
    qmax: int
    qflag: str
    extension: str


@dataclass(frozen=True)
class EncodeJob:
    codec: CodecSpec
    preset: str
    qvalue: int
    output_path: Path


SSIM_ALL_RE = re.compile(r"All:([0-9]+(?:\.[0-9]+)?)")
PSNR_AVG_RE = re.compile(r"average:([0-9]+(?:\.[0-9]+)?)")
SUPPORTED_QUALITY_METRICS = ("ssim", "psnr", "vmaf")

STOP_REQUESTED = threading.Event()
ACTIVE_PROCESSES_LOCK = threading.Lock()
ACTIVE_PROCESSES: set[subprocess.Popen] = set()
STATUS_LOCK = threading.Lock()
STATUS_STATE = {
    "started_at": 0.0,
    "submitted": 0,
    "completed": 0,
    "failed": 0,
    "active": {},
}


CODECS: List[CodecSpec] = [
    CodecSpec(
        codec_name="H.264 CPU",
        ffmpeg_encoder="libx264",
        presets=[
            "ultrafast",
            "superfast",
            "veryfast",
            "faster",
            "fast",
            "medium",
            "slow",
            "slower",
            "veryslow",
            "placebo",
        ],
        qmin=0,
        qmax=51,
        qflag="crf",
        extension="mp4",
    ),
    CodecSpec(
        codec_name="H.264 Nvidia",
        ffmpeg_encoder="h264_nvenc",
        presets=["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
        # NVENC treats cq=0 as "auto", which produces broken output; start at 1.
        qmin=1,
        qmax=51,
        qflag="cq",
        extension="mp4",
    ),
    CodecSpec(
        codec_name="H.265 CPU",
        ffmpeg_encoder="libx265",
        presets=[
            "ultrafast",
            "superfast",
            "veryfast",
            "faster",
            "fast",
            "medium",
            "slow",
            "slower",
            "veryslow",
            "placebo",
        ],
        qmin=0,
        qmax=51,
        qflag="crf",
        extension="mp4",
    ),
    CodecSpec(
        codec_name="H.265 Nvidia",
        ffmpeg_encoder="hevc_nvenc",
        presets=["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
        # NVENC treats cq=0 as "auto", which produces broken output; start at 1.
        qmin=1,
        qmax=51,
        qflag="cq",
        extension="mp4",
    ),
    CodecSpec(
        codec_name="AV1",
        ffmpeg_encoder="libsvtav1",
        # Presets above 9 produced byte-identical output to preset 9 (the
        # encoder clamps/aliases the fastest presets), so they are excluded
        # to avoid redundant encodes. Range is -1..9.
        presets=[str(i) for i in range(-1, 10)],
        qmin=0,
        qmax=63,
        qflag="crf",
        extension="mp4",
    ),
    CodecSpec(
        codec_name="VP9",
        ffmpeg_encoder="libvpx-vp9",
        presets=["best", "good", "realtime"],
        qmin=0,
        qmax=63,
        qflag="crf",
        extension="webm",
    ),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resumable FFmpeg encode matrix runner with non-linear scheduling.")
    parser.add_argument("--source", default="source.mp4", help="Path to source video (default: source.mp4)")
    parser.add_argument("--output-dir", default="encodes", help="Output directory for encoded files")
    parser.add_argument("--manifest", default="manifest.json", help="Path to manifest JSON")
    parser.add_argument(
        "--schedule",
        choices=["linear", "interleave", "fast-first"],
        default="interleave",
        help="Job order strategy (default: interleave)",
    )
    parser.add_argument("--cpu-workers", type=int, default=1, help="Concurrent workers for CPU codecs")
    parser.add_argument("--gpu-workers", type=int, default=1, help="Concurrent workers for GPU codecs (NVENC)")
    parser.add_argument("--max-jobs", type=int, default=0, help="Optional cap on number of queued jobs after filtering (0 = no cap)")
    parser.add_argument(
        "--quality-metric",
        choices=list(SUPPORTED_QUALITY_METRICS),
        default="ssim",
        help="Primary quality metric used for quality_metric/quality_score fields (default: ssim)",
    )
    parser.add_argument(
        "--quality-metrics",
        default="all",
        help="Comma-separated list of metrics to compute (ssim,psnr,vmaf) or 'all' (default). "
        "Metrics whose FFmpeg filter is unavailable are skipped (the primary --quality-metric is required).",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print plan without running FFmpeg")
    return parser.parse_args()


def ensure_ffmpeg_available() -> None:
    if shutil.which("ffmpeg") is None:
        print("ERROR: ffmpeg was not found in PATH.")
        print("Install ffmpeg and try again.")
        sys.exit(1)


def ffmpeg_supported_encoders() -> set[str]:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-encoders"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    encoders = set()
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("--"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("V"):
            encoders.add(parts[1])
    return encoders


def ffmpeg_supported_filters() -> set[str]:
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    filters = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith(("T", ".", "|")):
            filters.add(parts[1])
    return filters


def probe_source_frame_rate(source_video: Path) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=avg_frame_rate,r_frame_rate",
                "-of",
                "json",
                str(source_video),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
    except OSError:
        return 30.0

    try:
        data = json.loads(result.stdout)
    except Exception:
        return 30.0

    streams = data.get("streams") if isinstance(data, dict) else None
    if not isinstance(streams, list) or not streams:
        return 30.0

    stream = streams[0]
    for key in ("avg_frame_rate", "r_frame_rate"):
        rate_text = str(stream.get(key) or "")
        if not rate_text or rate_text == "0/0":
            continue
        try:
            rate = float(Fraction(rate_text))
        except Exception:
            continue
        if rate > 0:
            return rate

    return 30.0


def parse_quality_metrics(raw: str, primary_metric: str) -> List[str]:
    text = (raw or "").strip().lower()
    if not text:
        return [primary_metric]
    if text == "all":
        return list(SUPPORTED_QUALITY_METRICS)

    items = []
    for part in text.split(","):
        metric = part.strip().lower()
        if not metric:
            continue
        if metric not in SUPPORTED_QUALITY_METRICS:
            raise ValueError(f"Unsupported quality metric: {metric}")
        if metric not in items:
            items.append(metric)

    if not items:
        return [primary_metric]
    return items


def get_entry_metric_score(entry: Dict, metric: str) -> float | None:
    scores = entry.get("quality_scores")
    if isinstance(scores, dict) and isinstance(scores.get(metric), (int, float)):
        return float(scores[metric])

    if entry.get("quality_metric") == metric and isinstance(entry.get("quality_score"), (int, float)):
        return float(entry["quality_score"])

    return None


def generate_quality_points(min_value: int, max_value: int, count: int = 10) -> List[int]:
    if count < 2:
        raise ValueError("count must be >= 2")
    if min_value > max_value:
        raise ValueError("min_value must be <= max_value")

    step = (max_value - min_value) / (count - 1)
    values = [int(round(min_value + step * i)) for i in range(count)]
    values[0] = min_value
    values[-1] = max_value

    seen = set()
    out: List[int] = []
    for idx, value in enumerate(values):
        if value not in seen:
            out.append(value)
            seen.add(value)
            continue

        if idx == 0:
            out.append(min_value)
            continue
        if idx == len(values) - 1:
            out.append(max_value)
            continue

        for candidate in range(value + 1, max_value):
            if candidate not in seen:
                value = candidate
                break
        else:
            for candidate in range(value - 1, min_value, -1):
                if candidate not in seen:
                    value = candidate
                    break

        out.append(value)
        seen.add(value)

    if len(out) != count or len(set(out)) != count:
        out = sorted({min_value, max_value})
        cursor = min_value + 1
        while len(out) < count and cursor < max_value:
            out.append(cursor)
            cursor += 1
        out = sorted(out)[: count - 1] + [max_value]
        out[0] = min_value

    return out


def center_out(values: List[int]) -> List[int]:
    if not values:
        return []
    ordered = sorted(values)
    mid = len(ordered) // 2
    out = [ordered[mid]]
    left = mid - 1
    right = mid + 1
    while left >= 0 or right < len(ordered):
        if left >= 0:
            out.append(ordered[left])
            left -= 1
        if right < len(ordered):
            out.append(ordered[right])
            right += 1
    return out


def slugify(value: str) -> str:
    # Preserve a leading minus sign so signed presets (e.g. AV1 "-1") do not
    # collapse onto their positive counterparts: "-1" -> "neg1", "1" -> "1".
    text = value.strip().lower()
    sign = ""
    if text.startswith("-"):
        sign = "neg"
        text = text[1:]
    slug = "".join(ch if ch.isalnum() else "_" for ch in text).strip("_")
    return f"{sign}{slug}" if sign else slug


def load_manifest(manifest_path: Path, source_video: Path) -> Dict:
    if not manifest_path.exists():
        return {"source_video": str(source_video), "results": []}

    with manifest_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if "results" not in data or not isinstance(data["results"], list):
        if isinstance(data.get("encodes"), list):
            data["results"] = data["encodes"]
        else:
            data["results"] = []

    if "source_video" not in data:
        data["source_video"] = str(source_video)

    return data


def save_manifest(manifest_path: Path, manifest: Dict) -> None:
    tmp_path = manifest_path.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    tmp_path.replace(manifest_path)


def has_quality_score(entry: Dict, quality_metric: str) -> bool:
    return get_entry_metric_score(entry, quality_metric) is not None


def resolve_output_path(entry: Dict, manifest_path: Path) -> Path:
    output_filename = str(entry.get("output_filename", ""))
    path = Path(output_filename)
    if path.is_absolute():
        return path
    return manifest_path.parent / path


def backfill_missing_quality(
    manifest: Dict,
    manifest_path: Path,
    source_video: Path,
    primary_metric: str,
    metrics_to_compute: List[str],
) -> int:
    updated = 0
    for entry in manifest["results"]:
        missing_metrics = [m for m in metrics_to_compute if not has_quality_score(entry, m)]
        if not missing_metrics:
            continue

        output_path = resolve_output_path(entry, manifest_path)
        if not output_path.exists():
            continue

        scores = entry.get("quality_scores")
        if not isinstance(scores, dict):
            scores = {}

        changed = False
        for metric in missing_metrics:
            quality_score, _ = measure_quality(source_video, output_path, metric)
            if quality_score is None:
                continue
            scores[metric] = round(quality_score, 6)
            changed = True

        if not changed:
            continue

        entry["quality_scores"] = scores
        primary_score = get_entry_metric_score(entry, primary_metric)
        if primary_score is not None:
            entry["quality_metric"] = primary_metric
            entry["quality_score"] = round(primary_score, 6)
        elif isinstance(entry.get("quality_metric"), str):
            fallback_score = get_entry_metric_score(entry, str(entry["quality_metric"]))
            if fallback_score is not None:
                entry["quality_score"] = round(fallback_score, 6)

        updated += 1

    if updated > 0:
        save_manifest(manifest_path, manifest)

    return updated


def build_completed_index(results: List[Dict]) -> Dict[Tuple[str, str, int], Dict]:
    index: Dict[Tuple[str, str, int], Dict] = {}
    for item in results:
        try:
            key = (item["codec_name"], item["preset"], int(item["crf_value"]))
            index[key] = item
        except Exception:
            continue
    return index


def output_filename_for(codec: CodecSpec, preset: str, qvalue: int) -> str:
    codec_slug = slugify(codec.codec_name)
    preset_slug = slugify(preset)
    return f"{codec_slug}__{preset_slug}__q{qvalue}.{codec.extension}"


def is_gpu_codec(codec: CodecSpec) -> bool:
    return codec.ffmpeg_encoder in {"h264_nvenc", "hevc_nvenc"}


def preset_speed_rank(codec: CodecSpec, preset: str) -> float:
    if codec.ffmpeg_encoder in {"libx264", "libx265"}:
        order = [
            "ultrafast",
            "superfast",
            "veryfast",
            "faster",
            "fast",
            "medium",
            "slow",
            "slower",
            "veryslow",
            "placebo",
        ]
        return float(order.index(preset)) if preset in order else 5.0

    if codec.ffmpeg_encoder in {"h264_nvenc", "hevc_nvenc"}:
        if preset.startswith("p") and preset[1:].isdigit():
            return float(int(preset[1:]) - 1)
        return 3.0

    if codec.ffmpeg_encoder == "libsvtav1":
        # Lower SVT preset numbers are slower; higher are faster.
        try:
            p = int(preset)
            return float(max(0, 13 - p))
        except ValueError:
            return 7.0

    if codec.ffmpeg_encoder == "libvpx-vp9":
        mapping = {"realtime": 0.0, "good": 1.0, "best": 2.0}
        return mapping.get(preset, 1.0)

    return 1.0


def codec_cost(codec: CodecSpec) -> float:
    mapping = {
        "h264_nvenc": 1.0,
        "hevc_nvenc": 1.4,
        "libx264": 2.0,
        "libx265": 3.2,
        "libvpx-vp9": 4.0,
        "libsvtav1": 5.0,
    }
    return mapping.get(codec.ffmpeg_encoder, 3.0)


def job_cost(job: EncodeJob) -> float:
    codec = job.codec
    q_span = max(1, codec.qmax - codec.qmin)
    quality_bias = (codec.qmax - job.qvalue) / q_span
    return codec_cost(codec) + preset_speed_rank(codec, job.preset) * 0.25 + quality_bias * 0.2


def build_ffmpeg_command(source_video: Path, codec: CodecSpec, preset: str, qvalue: int, output_path: Path) -> List[str]:
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-stats",
        "-i",
        str(source_video),
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        codec.ffmpeg_encoder,
    ]

    if codec.ffmpeg_encoder in {"libx264", "libx265", "libsvtav1", "h264_nvenc", "hevc_nvenc"}:
        cmd.extend(["-preset", preset])

    if codec.ffmpeg_encoder in {"libx264", "libx265"}:
        cmd.extend(["-crf", str(qvalue), "-pix_fmt", "yuv420p"])
    elif codec.ffmpeg_encoder in {"h264_nvenc", "hevc_nvenc"}:
        # -b:v 0 makes -cq the sole rate controller. With a non-zero target
        # bitrate, VBR targets that bitrate and treats -cq as a mere ceiling,
        # so low cq values all collapse to the same bitrate-bound output.
        cmd.extend(["-rc:v", "vbr", "-cq", str(qvalue), "-b:v", "0"])
    elif codec.ffmpeg_encoder == "libsvtav1":
        cmd.extend(["-crf", str(qvalue), "-pix_fmt", "yuv420p"])
    elif codec.ffmpeg_encoder == "libvpx-vp9":
        cmd.extend(["-deadline", preset, "-crf", str(qvalue), "-b:v", "0"])
    else:
        raise ValueError(f"Unsupported codec mapping: {codec.ffmpeg_encoder}")

    cmd.append(str(output_path))
    return cmd


def register_process(process: subprocess.Popen) -> None:
    with ACTIVE_PROCESSES_LOCK:
        ACTIVE_PROCESSES.add(process)


def unregister_process(process: subprocess.Popen) -> None:
    with ACTIVE_PROCESSES_LOCK:
        ACTIVE_PROCESSES.discard(process)


def terminate_active_processes() -> None:
    with ACTIVE_PROCESSES_LOCK:
        processes = list(ACTIVE_PROCESSES)
    for process in processes:
        try:
            process.terminate()
        except Exception:
            continue


def handle_sigint(signum: int, frame: object) -> None:
    if STOP_REQUESTED.is_set():
        return
    STOP_REQUESTED.set()
    print("\n[STOP] Ctrl+C received. Stopping active ffmpeg processes...", flush=True)
    terminate_active_processes()


def format_elapsed(seconds: float) -> str:
    total = int(max(0.0, seconds))
    minutes, sec = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h{minutes:02d}m{sec:02d}s"
    if minutes:
        return f"{minutes}m{sec:02d}s"
    return f"{sec}s"


def job_label(job: EncodeJob) -> str:
    return f"{job.codec.codec_name} | preset={job.preset} | q={job.qvalue}"


def record_status_start(total_jobs: int) -> None:
    with STATUS_LOCK:
        STATUS_STATE["started_at"] = time.time()
        STATUS_STATE["submitted"] = total_jobs
        STATUS_STATE["completed"] = 0
        STATUS_STATE["failed"] = 0
        STATUS_STATE["active"] = {}


def record_job_running(job: EncodeJob) -> None:
    with STATUS_LOCK:
        STATUS_STATE["active"][job_label(job)] = {
            "started_at": time.time(),
            "lane": "GPU" if is_gpu_codec(job.codec) else "CPU",
        }


def record_job_finished(job: EncodeJob) -> None:
    with STATUS_LOCK:
        STATUS_STATE["active"].pop(job_label(job), None)
        STATUS_STATE["completed"] += 1


def record_job_failed(job: EncodeJob) -> None:
    with STATUS_LOCK:
        STATUS_STATE["active"].pop(job_label(job), None)
        STATUS_STATE["failed"] += 1


def progress_reporter() -> None:
    while not STOP_REQUESTED.is_set():
        time.sleep(60)
        with STATUS_LOCK:
            started_at = STATUS_STATE["started_at"]
            submitted = STATUS_STATE["submitted"]
            completed = STATUS_STATE["completed"]
            failed = STATUS_STATE["failed"]
            active = dict(STATUS_STATE["active"])

        if started_at <= 0.0:
            continue

        elapsed = time.time() - started_at
        remaining = max(0, submitted - completed - failed - len(active))
        print(
            f"[PROGRESS] elapsed={format_elapsed(elapsed)} | submitted={submitted} | "
            f"done={completed} | failed={failed} | active={len(active)} | queued={remaining}",
            flush=True,
        )
        if active:
            for label, info in list(active.items())[:5]:
                active_elapsed = time.time() - float(info.get("started_at", time.time()))
                print(
                    f"[PROGRESS] running={info.get('lane', '?')} | {label} | active_for={format_elapsed(active_elapsed)}",
                    flush=True,
                )


def run_command_capture(cmd: List[str]) -> Tuple[int, str]:
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    register_process(process)
    try:
        output, _ = process.communicate()
        return process.returncode or 0, output
    finally:
        unregister_process(process)


def discard_temp_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def run_encode(source_video: Path, job: EncodeJob) -> Tuple[bool, float, int, str]:
    if STOP_REQUESTED.is_set():
        return False, 0.0, 0, "Stopped before start."
    record_job_running(job)
    print(f"[START] {job_label(job)}", flush=True)

    # Encode into a git-ignored ".partial" folder first, then move the finished
    # file into place atomically. This keeps the output folder free of partial
    # or corrupt files when an encode is interrupted (e.g. Ctrl+C).
    temp_dir = job.output_path.parent / ".partial"
    temp_dir.mkdir(parents=True, exist_ok=True)
    temp_path = temp_dir / job.output_path.name

    cmd = build_ffmpeg_command(source_video, job.codec, job.preset, job.qvalue, temp_path)
    start = time.perf_counter()
    returncode, output = run_command_capture(cmd)
    elapsed = time.perf_counter() - start

    if returncode != 0:
        discard_temp_file(temp_path)
        record_job_failed(job)
        return False, elapsed, 0, output

    if not temp_path.exists():
        record_job_failed(job)
        return False, elapsed, 0, "FFmpeg reported success but output file was not created."

    try:
        job.output_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(temp_path, job.output_path)
    except OSError as exc:
        discard_temp_file(temp_path)
        record_job_failed(job)
        return False, elapsed, 0, f"Failed to move completed encode into place: {exc}"

    record_job_finished(job)
    return True, elapsed, job.output_path.stat().st_size, output


def measure_quality(source_video: Path, encoded_video: Path, quality_metric: str) -> Tuple[float | None, str]:
    if STOP_REQUESTED.is_set():
        return None, "Stopped before quality analysis."

    if quality_metric == "ssim":
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "info",
            "-i",
            str(source_video),
            "-i",
            str(encoded_video),
            "-lavfi",
            "ssim",
            "-f",
            "null",
            "-",
        ]
        _, output = run_command_capture(cmd)
        match = SSIM_ALL_RE.search(output)
        return (float(match.group(1)), output) if match else (None, output)

    if quality_metric == "psnr":
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "info",
            "-i",
            str(source_video),
            "-i",
            str(encoded_video),
            "-lavfi",
            "psnr",
            "-f",
            "null",
            "-",
        ]
        _, output = run_command_capture(cmd)
        match = PSNR_AVG_RE.search(output)
        return (float(match.group(1)), output) if match else (None, output)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as tmp:
        vmaf_log_path = Path(tmp.name)
    try:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "info",
            "-i",
            str(source_video),
            "-i",
            str(encoded_video),
            "-lavfi",
            f"libvmaf=log_fmt=json:log_path={vmaf_log_path.as_posix()}",
            "-f",
            "null",
            "-",
        ]
        _, output = run_command_capture(cmd)
        if not vmaf_log_path.exists():
            return None, output
        try:
            with vmaf_log_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            pooled = data.get("pooled_metrics", {}).get("vmaf", {})
            if isinstance(pooled.get("mean"), (int, float)):
                return float(pooled["mean"]), output
        except Exception:
            return None, output
        return None, output
    finally:
        try:
            vmaf_log_path.unlink(missing_ok=True)
        except Exception:
            pass


def build_unscheduled_jobs(codecs: List[CodecSpec], output_dir: Path) -> Dict[Tuple[str, str], List[EncodeJob]]:
    by_bucket: Dict[Tuple[str, str], List[EncodeJob]] = {}
    for codec in codecs:
        qvalues = generate_quality_points(codec.qmin, codec.qmax, count=10)
        q_order = center_out(qvalues)
        for preset in codec.presets:
            jobs = []
            for qvalue in q_order:
                output_name = output_filename_for(codec, preset, qvalue)
                jobs.append(EncodeJob(codec=codec, preset=preset, qvalue=qvalue, output_path=output_dir / output_name))
            by_bucket[(codec.codec_name, preset)] = jobs
    return by_bucket


def apply_schedule(buckets: Dict[Tuple[str, str], List[EncodeJob]], strategy: str) -> List[EncodeJob]:
    if strategy == "linear":
        ordered = []
        for key in sorted(buckets.keys()):
            ordered.extend(buckets[key])
        return ordered

    if strategy == "fast-first":
        all_jobs: List[EncodeJob] = []
        for jobs in buckets.values():
            all_jobs.extend(jobs)
        return sorted(all_jobs, key=job_cost)

    # interleave: round-robin across (codec,preset) buckets, center-out quality within each bucket.
    ordered = []
    work = {k: list(v) for k, v in buckets.items()}
    keys = sorted(work.keys())
    remaining = True
    while remaining:
        remaining = False
        for key in keys:
            if work[key]:
                ordered.append(work[key].pop(0))
                remaining = True
    return ordered


def filter_new_jobs(jobs: List[EncodeJob], completed: Dict[Tuple[str, str, int], Dict]) -> Tuple[List[EncodeJob], int]:
    out = []
    skipped = 0
    for job in jobs:
        key = (job.codec.codec_name, job.preset, job.qvalue)
        if key in completed:
            skipped += 1
            continue
        out.append(job)
    return out, skipped


def choose_executor(
    job: EncodeJob,
    cpu_executor: concurrent.futures.Executor | None,
    gpu_executor: concurrent.futures.Executor | None,
) -> concurrent.futures.Executor:
    if is_gpu_codec(job.codec):
        return gpu_executor or cpu_executor  # type: ignore[return-value]
    return cpu_executor or gpu_executor  # type: ignore[return-value]


def main() -> None:
    args = parse_args()
    signal.signal(signal.SIGINT, handle_sigint)

    try:
        metrics_to_compute = parse_quality_metrics(args.quality_metrics, args.quality_metric)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        sys.exit(1)

    source_video = Path(args.source)
    output_dir = Path(args.output_dir)
    manifest_path = Path(args.manifest)

    ensure_ffmpeg_available()

    if not source_video.exists():
        print(f"ERROR: Source video not found: {source_video}")
        sys.exit(1)

    if args.cpu_workers < 0 or args.gpu_workers < 0:
        print("ERROR: worker counts must be >= 0")
        sys.exit(1)

    if args.cpu_workers == 0 and args.gpu_workers == 0:
        print("ERROR: both --cpu-workers and --gpu-workers are 0. Nothing can run.")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    supported = ffmpeg_supported_encoders()
    supported_filters = ffmpeg_supported_filters()
    metric_filters = {"ssim": "ssim", "psnr": "psnr", "vmaf": "libvmaf"}
    available_metrics = []
    for metric in metrics_to_compute:
        if metric_filters[metric] in supported_filters:
            available_metrics.append(metric)
        elif metric == args.quality_metric:
            print(
                f"ERROR: FFmpeg filter '{metric_filters[metric]}' is not available, "
                f"so the primary metric '{metric}' cannot be used."
            )
            sys.exit(1)
        else:
            print(f"[SKIP METRIC] {metric}: FFmpeg filter '{metric_filters[metric]}' is not available in this build")
    metrics_to_compute = available_metrics

    manifest = load_manifest(manifest_path, source_video)
    source_frame_rate = probe_source_frame_rate(source_video)
    manifest["source_frame_rate"] = round(source_frame_rate, 6)
    save_manifest(manifest_path, manifest)
    backfilled = backfill_missing_quality(manifest, manifest_path, source_video, args.quality_metric, metrics_to_compute)
    completed = build_completed_index(manifest["results"])

    active_codecs = []
    for codec in CODECS:
        if codec.ffmpeg_encoder in supported:
            active_codecs.append(codec)
        else:
            print(f"[SKIP CODEC] {codec.codec_name}: encoder '{codec.ffmpeg_encoder}' is not available in this FFmpeg build")

    buckets = build_unscheduled_jobs(active_codecs, output_dir)
    scheduled = apply_schedule(buckets, args.schedule)
    scheduled, skipped_jobs = filter_new_jobs(scheduled, completed)

    if args.max_jobs > 0:
        scheduled = scheduled[: args.max_jobs]

    total_jobs = len(scheduled)
    print(
        f"[PLAN] schedule={args.schedule} | total_new_jobs={total_jobs} | already_skipped={skipped_jobs} | "
        f"cpu_workers={args.cpu_workers} | gpu_workers={args.gpu_workers} | quality_metrics={','.join(metrics_to_compute)}"
    )
    if backfilled > 0:
        print(f"[QUALITY] Backfilled {args.quality_metric} for {backfilled} existing manifest entries")

    if args.dry_run:
        for idx, job in enumerate(scheduled[:50], start=1):
            lane = "GPU" if is_gpu_codec(job.codec) else "CPU"
            print(f"[{idx:04d}] {lane} | {job.codec.codec_name} | preset={job.preset} | q={job.qvalue}")
        if len(scheduled) > 50:
            print(f"... ({len(scheduled) - 50} more jobs)")
        return

    record_status_start(total_jobs)
    reporter_thread = threading.Thread(target=progress_reporter, name="progress-reporter", daemon=True)
    reporter_thread.start()

    success_jobs = 0
    failed_jobs = 0

    cpu_executor = (
        concurrent.futures.ThreadPoolExecutor(max_workers=args.cpu_workers, thread_name_prefix="cpu")
        if args.cpu_workers > 0
        else None
    )
    gpu_executor = (
        concurrent.futures.ThreadPoolExecutor(max_workers=args.gpu_workers, thread_name_prefix="gpu")
        if args.gpu_workers > 0
        else None
    )

    try:
        future_to_job: Dict[concurrent.futures.Future, EncodeJob] = {}
        for job in scheduled:
            if STOP_REQUESTED.is_set():
                break
            executor = choose_executor(job, cpu_executor, gpu_executor)
            future = executor.submit(run_encode, source_video, job)
            future_to_job[future] = job

        done_count = 0
        for future in concurrent.futures.as_completed(future_to_job):
            if STOP_REQUESTED.is_set():
                future.cancel()
                continue
            done_count += 1
            job = future_to_job[future]

            try:
                ok, elapsed, file_size, output_log = future.result()
            except Exception as exc:
                ok = False
                elapsed = 0.0
                file_size = 0
                output_log = str(exc)

            if not ok:
                if STOP_REQUESTED.is_set() and "Stopped before start." in output_log:
                    continue
                failed_jobs += 1
                print(
                    f"[FAIL {done_count}/{total_jobs}] {job.codec.codec_name} | preset={job.preset} | q={job.qvalue}"
                )
                log_tail = "\n".join(output_log.splitlines()[-12:])
                if log_tail:
                    print(log_tail)
                continue

            success_jobs += 1
            quality_scores: Dict[str, float] = {}
            quality_log = ""
            for metric in metrics_to_compute:
                metric_score, metric_log = measure_quality(source_video, job.output_path, metric)
                if metric_score is not None:
                    quality_scores[metric] = round(metric_score, 6)
                else:
                    quality_log += f"\n[{metric}]\n{metric_log}"

            primary_score = quality_scores.get(args.quality_metric)
            entry = {
                "codec_name": job.codec.codec_name,
                "preset": job.preset,
                "crf_value": job.qvalue,
                "encode_time_seconds": round(elapsed, 3),
                "file_size_bytes": int(file_size),
                "source_frame_rate": round(source_frame_rate, 6),
                "quality_metric": args.quality_metric,
                "quality_score": None if primary_score is None else round(primary_score, 6),
                "quality_scores": quality_scores,
                "output_filename": str(job.output_path).replace("\\", "/"),
            }

            key = (job.codec.codec_name, job.preset, job.qvalue)
            existing = completed.get(key)
            if existing is not None:
                idx = manifest["results"].index(existing)
                manifest["results"][idx] = entry
            else:
                manifest["results"].append(entry)

            completed[key] = entry
            save_manifest(manifest_path, manifest)

            lane = "GPU" if is_gpu_codec(job.codec) else "CPU"
            quality_display = ", ".join(
                [f"{metric}={value:.6f}" for metric, value in sorted(quality_scores.items())]
            ) or "n/a"
            print(
                f"[DONE {done_count}/{total_jobs}] {lane} | {job.codec.codec_name} | preset={job.preset} | "
                f"q={job.qvalue} | {elapsed:.2f}s | {file_size} bytes | {quality_display}"
            )
            if primary_score is None:
                log_tail = "\n".join(quality_log.splitlines()[-8:])
                if log_tail:
                    print(f"[WARN] Could not parse primary metric {args.quality_metric} for {job.output_path.name}\n{log_tail}")
    finally:
        if cpu_executor is not None:
            cpu_executor.shutdown(wait=not STOP_REQUESTED.is_set(), cancel_futures=True)
        if gpu_executor is not None:
            gpu_executor.shutdown(wait=not STOP_REQUESTED.is_set(), cancel_futures=True)

    print("\nDone.")
    print(f"Total new jobs planned: {total_jobs}")
    print(f"Skipped (already encoded): {skipped_jobs}")
    print(f"Succeeded this run: {success_jobs}")
    print(f"Failed this run: {failed_jobs}")
    if STOP_REQUESTED.is_set():
        print("Stopped early by user request (Ctrl+C). Incomplete jobs will be retried next run.")
    print(f"Manifest: {manifest_path}")
    print(f"Output folder: {output_dir}")


if __name__ == "__main__":
    main()
