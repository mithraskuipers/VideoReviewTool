"""
VideoReviewTool
------------------
A local web app for quickly triaging a folder of videos: shows a rotating
set of 20 evenly-spaced thumbnails per video and lets you Delete / Keep /
Sort with single key presses.

Run with: python app.py   (or use start.bat / start.sh)
Then open: http://127.0.0.1:5000
"""

import os
import time
import json
import uuid
import shutil
import hashlib
import threading
import webbrowser
import concurrent.futures
from pathlib import Path

# Must be set before `import cv2` to take effect. Some videos (variable frame
# rate, odd container/codec combos, lots of audio packets between video
# packets) make ffmpeg's demuxer need far more read attempts than OpenCV's
# default (4096) to find the next video packet after a seek, which otherwise
# surfaces as "packet read max attempts exceeded" and a failed grab.
#
# IMPORTANT: use direct assignment, not setdefault(). If this variable is
# already set in the shell/system environment (e.g. someone tried the value
# the warning message itself suggests setting), setdefault() would silently
# do nothing and the override would never actually take effect.
os.environ["OPENCV_FFMPEG_READ_ATTEMPTS"] = "1000000"
os.environ["OPENCV_LOG_LEVEL"] = "SILENT"
os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "-8"
os.environ["OPENCV_VIDEOIO_DEBUG"] = "0"

from flask import Flask, request, jsonify, send_file, render_template
import cv2
import numpy as np
from send2trash import send2trash

# Belt-and-suspenders log silencing — different cv2 builds expose this
# differently, so try every form rather than relying on just one.
# Belt-and-suspenders log silencing — different cv2 builds expose this
# differently, so try every form rather than relying on just one.
try:
    cv2.setLogLevel(cv2.LOG_LEVEL_SILENT)
except Exception:
    try:
        cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_SILENT)
    except Exception:
        pass  # older/newer cv2 builds may not expose either; env vars above still apply

app = Flask(__name__)

VIDEO_EXTENSIONS = {
    ".mp4", ".avi", ".mov", ".mkv", ".webm",
    ".flv", ".wmv", ".m4v", ".mpg", ".mpeg", ".ts",
}
DEFAULT_NUM_SNAPSHOTS = 20
MIN_NUM_SNAPSHOTS = 2
MAX_NUM_SNAPSHOTS = 100

DEFAULT_SLIDESHOW_MS = 225  # 2x faster than the original 450ms default
MIN_SLIDESHOW_MS = 50
MAX_SLIDESHOW_MS = 3000

# --------------------------------------------------------------------------
# Per-folder cache & trash directories.
#
# Snapshots (and, briefly, deleted-but-undoable files) are stashed in hidden
# subdirectories created *inside the folder being reviewed* rather than in
# one big directory under the user's home folder. That way:
#   - snapshots for a video disappear as soon as that video is processed
#     (see cleanup_video_cache), so the cache directory shrinks steadily
#     as you work through a folder instead of growing forever;
#   - the cache directory is removed entirely once every video in the
#     folder has been processed;
#   - nothing is left behind in an unrelated, ever-growing home-folder
#     cache that the user never sees and has to remember to clear.
# --------------------------------------------------------------------------

CACHE_DIRNAME = ".videoreviewtool_cache"
TRASH_DIRNAME = ".videoreviewtool_trash"


def _hide_on_windows(path):
    """Best-effort: mark a directory hidden on Windows so it doesn't clutter
    Explorer. Dot-prefixed names already hide it everywhere else."""
    if os.name == "nt":
        try:
            import ctypes
            FILE_ATTRIBUTE_HIDDEN = 0x02
            ctypes.windll.kernel32.SetFileAttributesW(str(path), FILE_ATTRIBUTE_HIDDEN)
        except Exception:
            pass


def _cache_dir_path(folder):
    return Path(folder) / CACHE_DIRNAME


def _trash_dir_path(folder):
    return Path(folder) / TRASH_DIRNAME


def get_cache_dir(folder):
    """Return the snapshot cache directory for `folder`, creating it if
    needed."""
    d = _cache_dir_path(folder)
    d.mkdir(exist_ok=True)
    _hide_on_windows(d)
    return d


def get_trash_dir(folder):
    """Return the holding directory used to make the most recent Delete
    undoable, creating it if needed."""
    d = _trash_dir_path(folder)
    d.mkdir(exist_ok=True)
    _hide_on_windows(d)
    return d


def _rmdir_if_empty(path):
    path = Path(path)
    try:
        if path.exists() and not any(path.iterdir()):
            path.rmdir()
    except OSError:
        pass


def remove_folder_dirs(folder):
    """Tear down both hidden subdirectories for a folder we're done with
    (or leaving) — used when a folder finishes review, and when the person
    stops/switches folders."""
    if not folder:
        return
    shutil.rmtree(_cache_dir_path(folder), ignore_errors=True)
    _rmdir_if_empty(_trash_dir_path(folder))


# --------------------------------------------------------------------------
# Thumbnail cache naming.
#
# Cache filenames are keyed on the video's id (a stable hash of its path,
# assigned once at scan time and never changed even if the file is later
# moved/renamed by a sort action) plus mtime/idx/num_snapshots, rather than
# hashing all four fields together into one opaque name. Using the video id
# as a *prefix* means every cache file that belongs to a given video can be
# found and removed with a single glob, regardless of which mtime or
# snapshot-count it was generated under. That matters for two features:
# "prepare" mode, which fills the cache ahead of time (possibly at a
# different snapshot count than review ends up using), and post-action
# cleanup, which needs to reliably delete everything for a video once it's
# been processed without knowing exactly which combinations were ever
# generated for it.
# --------------------------------------------------------------------------

def cache_filename(video_id, mtime, idx, num_snapshots):
    mtime_key = str(mtime).replace(".", "_")
    return f"{video_id}__{mtime_key}__{idx}__{num_snapshots}.jpg"


def cache_path(cache_dir, video_id, mtime, idx, num_snapshots):
    return Path(cache_dir) / cache_filename(video_id, mtime, idx, num_snapshots)


def cleanup_video_cache(cache_dir, video_id):
    """Delete every cached snapshot image for this video, no matter which
    mtime/snapshot-count combination produced it. Called once a video has
    been processed (deleted/kept/moved/skipped) so the cache doesn't sit
    around holding thumbnails for files we're already done with. Also
    shrinks away the cache directory itself once it's empty."""
    cache_dir = Path(cache_dir)
    for f in cache_dir.glob(f"{video_id}__*.jpg"):
        try:
            f.unlink()
        except OSError:
            pass
    _rmdir_if_empty(cache_dir)

# --------------------------------------------------------------------------
# Hard per-frame timeout.
#
# cv2/ffmpeg calls on a broken file don't just fail slowly, they can hang
# outright with no exception ever raised. Nothing in Python can forcibly
# kill a stuck native call, so instead we run each grab in a worker thread
# and simply stop *waiting* on it after FRAME_TIMEOUT_SECONDS. The stray
# thread may keep running in the background and dies on its own once the
# native call eventually returns (or the process exits), but the request
# that asked for it is never blocked longer than the timeout, and the pool
# below caps how many stuck workers can pile up at once.
# --------------------------------------------------------------------------
FRAME_TIMEOUT_SECONDS = 3
SEQUENTIAL_BATCH_TIMEOUT_SECONDS = 45  # generous, but this only ever runs once per problem video
_frame_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="frame-grab")


def run_with_timeout(fn, timeout=FRAME_TIMEOUT_SECONDS):
    future = _frame_executor.submit(fn)
    try:
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        return None
    except Exception:
        return None


# --------------------------------------------------------------------------
# Per-video decode lock.
#
# The browser requests all N thumbnails for a video in parallel (~6 at once).
# With the server now threaded, that means several threads could call
# cv2.VideoCapture() on the *same file* at the same time. OpenCV's ffmpeg
# backend is not safe for that: concurrent decodes of one file corrupt each
# other's frame state, which is exactly what "sps_id out of range" /
# "missing picture in access unit" / "error while decoding MB" are — and it
# gets worse (hangs, garbage frames) the more requests pile up at once.
# A lock per file path keeps decoding of any single video serialized, while
# still letting unrelated requests (status, actions, other videos) run
# freely on other threads.
# --------------------------------------------------------------------------
_video_locks_guard = threading.Lock()
_video_locks = {}


def _get_video_lock(path):
    with _video_locks_guard:
        lock = _video_locks.get(path)
        if lock is None:
            lock = threading.Lock()
            _video_locks[path] = lock
        return lock

SETTINGS_FILE = Path.home() / ".video_review_tool_settings.json"

DEFAULT_SETTINGS = {
    "delete_key": "d",
    "keep_key": "k",
    "default_num_snapshots": DEFAULT_NUM_SNAPSHOTS,
    "slideshow_interval_ms": DEFAULT_SLIDESHOW_MS,
    "sort_buttons": [
        {"id": "sort_1", "key": "1", "folder": "1"},
        {"id": "sort_2", "key": "2", "folder": "2"},
        {"id": "sort_3", "key": "3", "folder": "3"},
    ],
}


def sanitize_key(value, fallback):
    value = str(value or "").strip().lower()
    return value[0] if value else fallback


def sanitize_folder_name(name):
    name = str(name or "").strip()
    for bad in ("/", "\\", ".."):
        name = name.replace(bad, "")
    return name[:60].strip()


def normalize_settings(data):
    data = data or {}
    settings = {
        "delete_key": sanitize_key(data.get("delete_key"), "d"),
        "keep_key": sanitize_key(data.get("keep_key"), "k"),
        "default_num_snapshots": DEFAULT_NUM_SNAPSHOTS,
        "slideshow_interval_ms": DEFAULT_SLIDESHOW_MS,
        "sort_buttons": [],
    }

    try:
        n = int(data.get("default_num_snapshots", DEFAULT_NUM_SNAPSHOTS))
        settings["default_num_snapshots"] = max(MIN_NUM_SNAPSHOTS, min(MAX_NUM_SNAPSHOTS, n))
    except (TypeError, ValueError):
        pass

    try:
        ms = int(data.get("slideshow_interval_ms", DEFAULT_SLIDESHOW_MS))
        settings["slideshow_interval_ms"] = max(MIN_SLIDESHOW_MS, min(MAX_SLIDESHOW_MS, ms))
    except (TypeError, ValueError):
        pass

    for b in data.get("sort_buttons", []):
        key = sanitize_key(b.get("key"), "")
        folder = sanitize_folder_name(b.get("folder"))
        if not key or not folder:
            continue
        bid = b.get("id") or f"sort_{uuid.uuid4().hex[:8]}"
        settings["sort_buttons"].append({"id": bid, "key": key, "folder": folder})

    return settings


def settings_are_valid(settings):
    keys = [settings["delete_key"], settings["keep_key"]] + [b["key"] for b in settings["sort_buttons"]]
    if any(not k or not k.isalnum() for k in keys):
        return False, "Every button needs a single letter or number as its key."
    if len(keys) != len(set(keys)):
        return False, "Each key can only be assigned to one button."
    return True, None


def load_settings():
    if SETTINGS_FILE.exists():
        try:
            return normalize_settings(json.loads(SETTINGS_FILE.read_text()))
        except Exception:
            pass
    return normalize_settings(DEFAULT_SETTINGS)


def persist_settings(settings):
    try:
        SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
    except Exception:
        pass  # keep working in-memory even if the disk write fails


state_lock = threading.Lock()
state = {
    "folder": None,
    "videos": [],       # list of dicts: id, filename, path, size, status, destination
    "current_index": 0,
    "num_snapshots": DEFAULT_NUM_SNAPSHOTS,
    "settings": load_settings(),
    "last_action": None,  # the most recent action, kept around so it can be undone (see /api/undo)
}
state["num_snapshots"] = state["settings"]["default_num_snapshots"]


def _unique_dest(dest_path):
    """If dest_path already exists, append a timestamp so we never clobber
    an existing file when moving something onto it."""
    dest_path = Path(dest_path)
    if not dest_path.exists():
        return dest_path
    return dest_path.with_name(f"{dest_path.stem}_{int(time.time())}{dest_path.suffix}")


def finalize_pending_delete():
    """If the previous action was a Delete, the file has been sitting in
    the folder's hidden trash-holding directory (not the real OS Recycle
    Bin / Trash yet) purely so it could still be undone. Once it's no
    longer the most recent action — because another action happened, or
    the session is ending — actually send it to the OS trash for real.
    Must be called with state_lock held; safe to call unconditionally."""
    record = state.get("last_action")
    state["last_action"] = None
    if not record or record.get("type") != "delete":
        return
    held_path = record.get("held_path")
    if held_path and os.path.exists(held_path):
        try:
            send2trash(held_path)
        except Exception:
            pass
        _rmdir_if_empty(Path(held_path).parent)


def make_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]


def find_video(vid: str):
    for v in state["videos"]:
        if v["id"] == vid:
            return v
    return None


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

@app.route("/api/browse", methods=["POST"])
def browse():
    """Open a native folder picker on the machine running the server."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory(title="Select folder with videos")
        root.destroy()

        if not folder:
            return jsonify({"success": False, "error": "No folder selected"})
        return jsonify({"success": True, "path": folder})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)})


@app.route("/api/settings", methods=["GET"])
def get_settings():
    with state_lock:
        return jsonify({"success": True, "settings": state["settings"]})


@app.route("/api/settings", methods=["POST"])
def save_settings():
    data = request.get_json(force=True)
    normalized = normalize_settings(data.get("settings"))

    valid, error = settings_are_valid(normalized)
    if not valid:
        return jsonify({"success": False, "error": error})

    with state_lock:
        # keep whichever snapshot count / speed is currently in use unless explicitly provided
        normalized["default_num_snapshots"] = data.get("settings", {}).get(
            "default_num_snapshots", state["settings"]["default_num_snapshots"]
        )
        normalized["slideshow_interval_ms"] = data.get("settings", {}).get(
            "slideshow_interval_ms", state["settings"]["slideshow_interval_ms"]
        )
        normalized = normalize_settings(normalized)
        state["settings"] = normalized

    persist_settings(normalized)
    return jsonify({"success": True, "settings": normalized})


@app.route("/api/speed", methods=["POST"])
def set_speed():
    data = request.get_json(force=True)
    try:
        ms = int(data.get("slideshow_interval_ms"))
    except (TypeError, ValueError):
        return jsonify({"success": False, "error": "Invalid speed value"})

    ms = max(MIN_SLIDESHOW_MS, min(MAX_SLIDESHOW_MS, ms))

    with state_lock:
        state["settings"]["slideshow_interval_ms"] = ms
        settings_snapshot = dict(state["settings"])

    persist_settings(settings_snapshot)
    return jsonify({"success": True, "slideshow_interval_ms": ms})


@app.route("/api/num_snapshots", methods=["POST"])
def set_num_snapshots():
    """Change how many snapshots are used for the folder currently being
    reviewed (as opposed to /api/scan, which sets it for a brand-new scan)."""
    data = request.get_json(force=True)
    try:
        n = int(data.get("num_snapshots"))
    except (TypeError, ValueError):
        return jsonify({"success": False, "error": "Invalid snapshot count"})

    n = max(MIN_NUM_SNAPSHOTS, min(MAX_NUM_SNAPSHOTS, n))

    with state_lock:
        state["num_snapshots"] = n
        state["settings"]["default_num_snapshots"] = n
        settings_snapshot = dict(state["settings"])

    persist_settings(settings_snapshot)
    return jsonify({"success": True, "num_snapshots": n})


@app.route("/api/stop", methods=["POST"])
def stop():
    """Abandon the current folder/queue and go back to the folder picker."""
    with state_lock:
        finalize_pending_delete()
        folder = state["folder"]
        state["folder"] = None
        state["videos"] = []
        state["current_index"] = 0
    remove_folder_dirs(folder)
    return jsonify({"success": True})


def clamp_num_snapshots(value, default=DEFAULT_NUM_SNAPSHOTS):
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = default
    return max(MIN_NUM_SNAPSHOTS, min(MAX_NUM_SNAPSHOTS, n))


def list_videos_in_folder(folder):
    """Scan a folder for supported video files and build the same video-dict
    shape used everywhere else (id/filename/path/size/status/...). Shared by
    /api/scan, /api/prepare, and the --prepare CLI path so there's exactly
    one definition of what counts as a video and how its id is derived."""
    cache_dir = str(get_cache_dir(folder))
    videos = []
    with os.scandir(folder) as it:
        for entry in it:
            if entry.is_file():
                ext = os.path.splitext(entry.name)[1].lower()
                if ext in VIDEO_EXTENSIONS:
                    videos.append({
                        "id": make_id(entry.path),
                        "filename": entry.name,
                        "path": entry.path,
                        "size": entry.stat().st_size,
                        "status": "pending",
                        "destination": None,
                        "broken": False,  # set True once every read strategy has been tried and failed
                        "cache_dir": cache_dir,  # where this video's snapshots live (inside `folder`)
                    })
    videos.sort(key=lambda v: v["filename"].lower())
    return videos


@app.route("/api/scan", methods=["POST"])
def scan():
    data = request.get_json(force=True)
    folder = (data.get("path") or "").strip().strip('"')

    if not folder or not os.path.isdir(folder):
        return jsonify({"success": False, "error": "That folder path could not be found."})

    num_snapshots = clamp_num_snapshots(
        data.get("num_snapshots", state["settings"]["default_num_snapshots"])
    )

    videos = list_videos_in_folder(folder)

    with state_lock:
        finalize_pending_delete()
        prev_folder = state["folder"]
        state["folder"] = folder
        state["videos"] = videos
        state["current_index"] = 0
        state["num_snapshots"] = num_snapshots
        state["settings"]["default_num_snapshots"] = num_snapshots
        settings_snapshot = dict(state["settings"])

    if prev_folder and prev_folder != folder:
        remove_folder_dirs(prev_folder)

    persist_settings(settings_snapshot)  # remember this snapshot count for next time

    return jsonify({
        "success": True,
        "count": len(videos),
        "videos": videos,
        "num_snapshots": num_snapshots,
        "settings": settings_snapshot,
    })


@app.route("/api/status")
def status():
    with state_lock:
        total = len(state["videos"])
        done = sum(1 for v in state["videos"] if v["status"] != "pending")
        last_action = state.get("last_action")
        undo_info = None
        if last_action:
            v = find_video(last_action["video_id"])
            if v:
                undo_info = {"filename": v["filename"], "type": last_action["type"]}
        return jsonify({
            "folder": state["folder"],
            "videos": state["videos"],
            "current_index": state["current_index"],
            "total": total,
            "done": done,
            "percent": round((done / total) * 100, 1) if total else 0,
            "num_snapshots": state["num_snapshots"],
            "settings": state["settings"],
            "can_undo": undo_info is not None,
            "undo_info": undo_info,
        })


def _probe_video(path):
    """Read frame count / fps once so seek strategies below don't each reopen blind."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return 0, 0.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    return frame_count, fps


def _try_seek_and_read(path, seek_fn):
    """Open a fresh capture, apply one seek strategy, and try to read a frame.
    A fresh VideoCapture per attempt matters: once ffmpeg's demuxer gets confused
    on a bad seek (the 'packet read max attempts exceeded' case) the same capture
    object tends to keep failing, so retrying on a clean handle is what actually
    recovers instead of just spamming the same warning."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return None
    try:
        seek_fn(cap)
        ok, frame = cap.read()
        if ok and frame is not None:
            return frame
    except Exception:
        pass
    finally:
        cap.release()
    return None


def _try_sequential_read(path, target_frame, max_frames_scanned=4000):
    """Very last resort before giving up: read frames one at a time from the
    very start instead of seeking anywhere. Slower, but it never asks the
    demuxer to jump — which is what trips up files with a badly broken
    keyframe index even after raising the read-attempts limit. Capped so a
    huge file can't stall a request for too long."""
    if target_frame <= 0:
        target_frame = 0
    scan_limit = min(target_frame, max_frames_scanned)

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return None
    frame = None
    try:
        for _ in range(scan_limit + 1):
            ok, f = cap.read()
            if not ok or f is None:
                break
            frame = f
    except Exception:
        pass
    finally:
        cap.release()
    return frame


def grab_frame(path, ratio):
    """Try several ways to grab a frame near `ratio` (0..1) through the video.
    Different containers/codecs (VFR footage, extra audio streams, odd
    keyframe spacing, etc.) respond reliably to different seek methods, so we
    fall through several before giving up."""
    frame_count, fps = _probe_video(path)
    duration_ms = (frame_count / fps) * 1000.0 if frame_count > 0 and fps and fps > 0 else None
    ratio = min(max(ratio, 0.0), 1.0)

    strategies = []

    if duration_ms:
        target_ms = max(0.0, min(duration_ms * ratio, duration_ms - 1))
        strategies.append(lambda cap, ms=target_ms: cap.set(cv2.CAP_PROP_POS_MSEC, ms))

    if frame_count > 0:
        target_frame = max(0, min(int(frame_count * ratio), frame_count - 1))
        strategies.append(lambda cap, f=target_frame: cap.set(cv2.CAP_PROP_POS_FRAMES, f))

    strategies.append(lambda cap, r=ratio: cap.set(cv2.CAP_PROP_POS_AVI_RATIO, min(r, 0.999)))
    # Last resort among the seek-based strategies: just grab whatever frame
    # comes first, rather than showing nothing.
    strategies.append(lambda cap: cap.set(cv2.CAP_PROP_POS_FRAMES, 0))

    for seek_fn in strategies:
        frame = _try_seek_and_read(path, seek_fn)
        if frame is not None:
            return frame

    # Every seek-based attempt failed — fall back to reading sequentially
    # from the start, which sidesteps seeking entirely.
    target_frame = int(frame_count * ratio) if frame_count > 0 else 0
    return _try_sequential_read(path, target_frame)


def make_placeholder_frame(width=640, height=360):
    """A small dark 'preview unavailable' frame, used for the rare video that
    fails every seek strategy AND the sequential fallback, so the slideshow
    shows something clean instead of a broken image and can still move on."""
    frame = np.full((height, width, 3), 24, dtype=np.uint8)
    text = "Preview unavailable"
    font = cv2.FONT_HERSHEY_SIMPLEX
    (tw, th), _ = cv2.getTextSize(text, font, 0.7, 2)
    x = max(0, (width - tw) // 2)
    y = (height + th) // 2
    cv2.putText(frame, text, (x, y), font, 0.7, (140, 140, 140), 2, cv2.LINE_AA)
    return frame


def _encode_and_cache(cache_dir, video_id, mtime, idx, num_snapshots, frame):
    """Resize, JPEG-encode, and write one frame to its cache slot. Returns
    True if it wrote (or already had) a cache file for this idx."""
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(exist_ok=True)  # may have been shrunk away since we started
    cache_file = cache_path(cache_dir, video_id, mtime, idx, num_snapshots)
    if cache_file.exists():
        return True
    h, w = frame.shape[:2]
    max_w = 640
    if w > max_w:
        scale = max_w / w
        frame = cv2.resize(frame, (max_w, int(h * scale)))
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        return False
    cache_file.write_bytes(buf.tobytes())
    return True


COUNT_TIMEOUT_SECONDS = 30


def _count_frames_sequential(path, safety_cap=500000):
    """Fast real frame count via grab() only (skips the decode/color-convert
    that read() does) — used when the container's own metadata
    (CAP_PROP_FRAME_COUNT) is missing or zero, which is common on exactly
    the broken-seek-index files this whole fallback exists for."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return 0
    count = 0
    try:
        while count <= safety_cap:
            if not cap.grab():
                break
            count += 1
    except Exception:
        pass
    finally:
        cap.release()
    return count


def _sequential_batch_fill(video, num_snapshots, want_idx):
    """Last-resort fallback for files where every *seek* fails or times out
    (broken keyframe index, odd VFR footage, etc.) — the "packet read max
    attempts exceeded" case. cv2's seek-based reads keep failing on these
    because seeking is what's broken, not decoding: the file plays back just
    fine start-to-finish (which is why it works in VLC). So instead of
    seeking, this opens the file once and reads forward from frame 0,
    grabbing every snapshot frame as playback passes its target position —
    exactly what a normal player does. One linear pass fills in every
    snapshot for the video at once, so this expensive path only ever runs
    once per problem video, not once per thumbnail.
    Returns True if it managed to produce (and cache) at least `want_idx`.
    """
    path = video["path"]
    frame_count, _fps = _probe_video(path)

    if frame_count <= 0:
        # Container metadata didn't give us a usable total (common on
        # exactly these broken files) — count for real instead of giving up.
        frame_count = run_with_timeout(
            lambda: _count_frames_sequential(path), timeout=COUNT_TIMEOUT_SECONDS
        ) or 0

    if frame_count <= 0:
        return False

    targets = {
        i: max(0, min(int(frame_count * ((i + 1) / num_snapshots)), frame_count - 1))
        for i in range(num_snapshots)
    }

    def _decode_all():
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            return {}
        results = {}
        remaining = dict(targets)
        last_frame = None
        frame_no = 0
        # Hard cap so a file with corrupted metadata (frame_count wildly
        # wrong, or a stream that never signals EOF) can't scan forever.
        max_frames_scanned = max(frame_count, 1) + 1000
        try:
            while remaining and frame_no <= max_frames_scanned:
                ok, frame = cap.read()
                if not ok or frame is None:
                    break
                last_frame = frame
                hit = [i for i, t in remaining.items() if frame_no >= t]
                for i in hit:
                    results[i] = frame.copy()
                    del remaining[i]
                frame_no += 1
        except Exception:
            pass
        finally:
            cap.release()
        # Whatever targets we never technically reached (e.g. frame_count
        # was an overestimate) just get the last real frame we decoded,
        # rather than being left missing.
        if last_frame is not None:
            for i in remaining:
                results[i] = last_frame
        return results

    results = run_with_timeout(_decode_all, timeout=SEQUENTIAL_BATCH_TIMEOUT_SECONDS)
    if not results:
        return False

    mtime = os.path.getmtime(path)
    for i, frame in results.items():
        _encode_and_cache(video["cache_dir"], video["id"], mtime, i, num_snapshots, frame)

    return want_idx in results


def ensure_thumbnail_cached(video, idx, num_snapshots):
    """Make sure a cache file exists on disk for this (video, idx,
    num_snapshots) combination, generating and writing it if it doesn't.

    This is the one shared code path for "produce a thumbnail" — used both
    by the live /api/thumbnail route (one frame at a time, as the browser
    asks for it) and by prepare mode, which calls this for every index of
    every video in a folder ahead of time so review never has to decode
    anything itself.

    Returns the cache Path on success. Returns None if this file couldn't
    be read by any strategy we have (or a single attempt timed out) — the
    caller decides what to do about it (the live route falls back to a
    placeholder; prepare just logs it and moves on to the next video). On a
    definitive failure this also marks the video "broken" in shared state,
    so nobody keeps re-trying a file we already know can't be read.
    """
    if not os.path.isfile(video["path"]):
        return None
    if video.get("broken"):
        return None

    mtime = os.path.getmtime(video["path"])
    cache_dir = Path(video["cache_dir"])
    cache_dir.mkdir(exist_ok=True)  # may have been shrunk away since we started
    _hide_on_windows(cache_dir)
    cache_file = cache_path(cache_dir, video["id"], mtime, idx, num_snapshots)
    if cache_file.exists():
        return cache_file

    ratio = (idx + 1) / num_snapshots  # e.g. 5%, 10%, ... 100% for 20 snapshots

    # Only one thread may decode this particular file at a time (see
    # _get_video_lock) — this is what actually fixes the corruption/hang
    # from concurrent decodes, and also means only one thread will ever
    # trigger the sequential fallback below for a given video.
    with _get_video_lock(video["path"]):
        # Another thread may have just filled the cache (via the sequential
        # fallback) while we were waiting for the lock.
        if cache_file.exists():
            return cache_file

        frame = run_with_timeout(lambda: grab_frame(video["path"], ratio))

        if frame is None:
            # Seeking is unreliable for this file — fall back to one
            # sequential decode pass that fills in every snapshot at once.
            if _sequential_batch_fill(video, num_snapshots, idx) and cache_file.exists():
                return cache_file

        if frame is None:
            # Both the fast seek-based path AND the full sequential decode
            # (which counts real frames itself when metadata is bad) failed
            # to produce anything at all for this file. That's not a
            # transient hiccup — this file genuinely can't be read by any
            # strategy we have, so mark it and stop retrying it.
            with state_lock:
                v = find_video(video["id"])
                if v:
                    v["broken"] = True
            return None

        if _encode_and_cache(cache_dir, video["id"], mtime, idx, num_snapshots, frame):
            return cache_file
        return None


@app.route("/api/thumbnail/<vid>/<int:idx>")
def thumbnail(vid, idx):
    from flask import Response

    with state_lock:
        video = find_video(vid)
        num_snapshots = state["num_snapshots"]

    if not video:
        return "", 404
    if idx < 0 or idx >= num_snapshots:
        return "", 400
    if not os.path.isfile(video["path"]):
        return "", 404

    # Already established this file can't be read by any strategy we have —
    # don't burn time (or spam warnings) retrying it on every single
    # thumbnail index. Just hand back the placeholder immediately.
    if video.get("broken"):
        ok, buf = cv2.imencode(".jpg", make_placeholder_frame(), [cv2.IMWRITE_JPEG_QUALITY, 82])
        return Response(buf.tobytes(), mimetype="image/jpeg") if ok else ("", 500)

    cache_file = ensure_thumbnail_cached(video, idx, num_snapshots)
    if cache_file is not None:
        return send_file(cache_file, mimetype="image/jpeg", max_age=3600)

    # Couldn't produce this frame just now — either it was just marked
    # broken above, or a single attempt timed out transiently. Either way,
    # hand back a placeholder without caching it, so a transient failure
    # still gets a fresh chance on the next request.
    ok, buf = cv2.imencode(".jpg", make_placeholder_frame(), [cv2.IMWRITE_JPEG_QUALITY, 82])
    return Response(buf.tobytes(), mimetype="image/jpeg") if ok else ("", 500)


@app.route("/api/action", methods=["POST"])
def action():
    data = request.get_json(force=True)
    vid = data.get("id")
    act = data.get("action")  # 'delete', 'keep', or a sort button's id

    with state_lock:
        video = find_video(vid)
        if not video:
            return jsonify({"success": False, "error": "Video not found"})
        if video["status"] != "pending":
            return jsonify({"success": False, "error": "Video already processed"})

        # The action we're about to record becomes the new "last action";
        # whatever *was* last is no longer undoable, so if it was a Delete
        # being held for that purpose, send it to the real OS trash now.
        finalize_pending_delete()

        settings = state["settings"]
        orig_path = video["path"]
        record = {"video_id": video["id"], "type": act if act in ("delete", "keep", "skip", "auto_skip") else "move"}

        try:
            if act == "delete":
                # Held in a hidden per-folder trash dir (not the OS trash
                # yet) so this can still be undone with Backspace. It's
                # finalized for real the next time finalize_pending_delete()
                # runs — i.e. on the next action, or when the session ends.
                trash_dir = get_trash_dir(state["folder"])
                held_path = _unique_dest(trash_dir / video["filename"])
                shutil.move(orig_path, str(held_path))
                video["path"] = str(held_path)
                video["status"] = "deleted"
                record["orig_path"] = orig_path
                record["held_path"] = str(held_path)

            elif act == "keep":
                video["status"] = "kept"

            elif act == "skip":
                # Just move past it — no file operation at all. Used as the
                # escape hatch for a video that's hanging or won't preview.
                video["status"] = "skipped"

            elif act == "auto_skip":
                # Same as skip (no file operation) but only ever sent by the
                # frontend after the backend has already marked this file
                # unreadable — kept as a distinct status so it shows up in
                # its own "couldn't be read" list instead of blending in
                # with videos the person chose to skip themselves.
                video["status"] = "auto_skipped"

            else:
                button = next((b for b in settings["sort_buttons"] if b["id"] == act), None)
                if not button:
                    return jsonify({"success": False, "error": "Unknown action"})

                folder = button["folder"]
                subdir = os.path.join(state["folder"], folder)
                os.makedirs(subdir, exist_ok=True)
                dest = str(_unique_dest(Path(subdir) / video["filename"]))
                shutil.move(orig_path, dest)
                video["path"] = dest
                video["status"] = "moved"
                video["destination"] = folder
                record["orig_path"] = orig_path
                record["dest_path"] = dest

        except Exception as e:
            return jsonify({"success": False, "error": str(e)})

        state["current_index"] += 1
        state["last_action"] = record
        cache_dir = video["cache_dir"]
        folder = state["folder"]

    # Done with this video one way or another — its cached snapshot images
    # (whether generated live during review, or ahead of time by prepare
    # mode) are no longer needed, regardless of which snapshot count(s)
    # they were generated at. This also shrinks the cache directory away
    # once nothing remains inside it.
    cleanup_video_cache(cache_dir, video["id"])

    with state_lock:
        all_done = folder == state["folder"] and not any(v["status"] == "pending" for v in state["videos"])

    if all_done:
        # The whole folder has been processed — remove the cache subdir
        # outright (it should already be empty from per-video cleanup, but
        # this catches any stragglers, e.g. from prepare-mode runs at a
        # different snapshot count).
        shutil.rmtree(_cache_dir_path(folder), ignore_errors=True)

    return jsonify({"success": True})


@app.route("/api/undo", methods=["POST"])
def undo():
    """Reverse the single most recent action. Only one level of undo is
    kept — performing (or undoing) an action clears it, so Backspace always
    means "undo whatever I just did", not a full history stack."""
    with state_lock:
        record = state.get("last_action")
        if not record:
            return jsonify({"success": False, "error": "Nothing to undo."})

        video = find_video(record["video_id"])
        if not video:
            state["last_action"] = None
            return jsonify({"success": False, "error": "That video is no longer in the queue."})

        try:
            if record["type"] == "delete":
                orig_path = record["orig_path"]
                held_path = record["held_path"]
                if os.path.exists(held_path):
                    shutil.move(held_path, orig_path)
                video["path"] = orig_path

            elif record["type"] == "move":
                orig_path = record["orig_path"]
                dest_path = record["dest_path"]
                if os.path.exists(dest_path):
                    shutil.move(dest_path, orig_path)
                video["path"] = orig_path
                video["destination"] = None

            # keep / skip / auto_skip performed no file operation, so there's
            # nothing to reverse beyond resetting status below.

        except Exception as e:
            return jsonify({"success": False, "error": str(e)})

        video["status"] = "pending"
        video["broken"] = False
        if state["current_index"] > 0:
            state["current_index"] -= 1
        state["last_action"] = None

    return jsonify({"success": True})


# --------------------------------------------------------------------------
# Prepare mode.
#
# Reviewing a folder over a slow network means every thumbnail has to be
# decoded on the machine running the server (often the NAS/remote box) and
# then streamed to the browser, one frame at a time, right as the person
# scrubs to it — normally hidden behind the "loading previews" spinner for
# each video. Prepare mode does that same decoding work ahead of time for
# an entire folder, so a later review session finds every thumbnail already
# sitting in the cache and never waits on a decode. It's just the existing
# ensure_thumbnail_cached() pipeline, run for every index of every video in
# a folder up front, in a background thread so the request that kicks it
# off can return immediately and the setup screen can poll for progress.
# --------------------------------------------------------------------------

_prepare_lock = threading.Lock()
_prepare_state = {
    "running": False,
    "folder": None,
    "num_snapshots": None,
    "total_videos": 0,
    "done_videos": 0,
    "current_filename": None,
    "unreadable": [],   # filenames that couldn't be read by any strategy
    "cancelled": False,
    "error": None,
    "finished": False,  # set once a run completes (or is cancelled), cleared on the next start
}


def _prepare_worker(num_snapshots, videos):
    try:
        for video in videos:
            with _prepare_lock:
                if _prepare_state["cancelled"]:
                    break
                _prepare_state["current_filename"] = video["filename"]

            if os.path.isfile(video["path"]):
                for idx in range(num_snapshots):
                    with _prepare_lock:
                        if _prepare_state["cancelled"]:
                            break
                    if ensure_thumbnail_cached(video, idx, num_snapshots) is None:
                        # This video can't be read by any strategy we have —
                        # no point burning time on its remaining indices too.
                        with _prepare_lock:
                            _prepare_state["unreadable"].append(video["filename"])
                        break

            with _prepare_lock:
                _prepare_state["done_videos"] += 1
    except Exception as e:
        with _prepare_lock:
            _prepare_state["error"] = str(e)
    finally:
        with _prepare_lock:
            _prepare_state["running"] = False
            _prepare_state["finished"] = True
            _prepare_state["current_filename"] = None


@app.route("/api/prepare", methods=["POST"])
def start_prepare():
    data = request.get_json(force=True)
    folder = (data.get("path") or "").strip().strip('"')

    if not folder or not os.path.isdir(folder):
        return jsonify({"success": False, "error": "That folder path could not be found."})

    with _prepare_lock:
        if _prepare_state["running"]:
            return jsonify({"success": False, "error": "A prepare job is already running."})

    num_snapshots = clamp_num_snapshots(
        data.get("num_snapshots", state["settings"]["default_num_snapshots"])
    )

    videos = list_videos_in_folder(folder)
    if not videos:
        return jsonify({"success": False, "error": "No supported video files were found in that folder."})

    with _prepare_lock:
        _prepare_state.update({
            "running": True,
            "folder": folder,
            "num_snapshots": num_snapshots,
            "total_videos": len(videos),
            "done_videos": 0,
            "current_filename": None,
            "unreadable": [],
            "cancelled": False,
            "error": None,
            "finished": False,
        })

    threading.Thread(target=_prepare_worker, args=(num_snapshots, videos), daemon=True).start()

    return jsonify({"success": True, "total": len(videos), "num_snapshots": num_snapshots})


@app.route("/api/prepare/status")
def prepare_status():
    with _prepare_lock:
        return jsonify({"success": True, **_prepare_state})


@app.route("/api/prepare/cancel", methods=["POST"])
def prepare_cancel():
    with _prepare_lock:
        if not _prepare_state["running"]:
            return jsonify({"success": False, "error": "No prepare job is running."})
        _prepare_state["cancelled"] = True
    return jsonify({"success": True})


def run_prepare_cli(folder, num_snapshots):
    """Synchronous, print-as-it-goes version of prepare mode for the
    command line: `python app.py --prepare <folder> [--snapshots N]`."""
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        print(f"Folder not found: {folder}")
        raise SystemExit(1)

    num_snapshots = clamp_num_snapshots(num_snapshots)
    videos = list_videos_in_folder(folder)
    if not videos:
        print(f"No supported video files were found in: {folder}")
        raise SystemExit(1)

    print(f"Preparing {len(videos)} video(s) in {folder} at {num_snapshots} snapshots each...")
    unreadable = []
    for i, video in enumerate(videos, start=1):
        print(f"  [{i}/{len(videos)}] {video['filename']}", end="", flush=True)
        ok_count = 0
        if os.path.isfile(video["path"]):
            for idx in range(num_snapshots):
                if ensure_thumbnail_cached(video, idx, num_snapshots) is None:
                    unreadable.append(video["filename"])
                    break
                ok_count += 1
        status = "done" if ok_count == num_snapshots else f"stopped early ({ok_count}/{num_snapshots} — unreadable)"
        print(f" — {status}")

    print(f"\nPrepared {len(videos) - len(unreadable)}/{len(videos)} video(s).")
    if unreadable:
        print(f"{len(unreadable)} file(s) could not be read and were skipped:")
        for name in unreadable:
            print(f"  - {name}")
    print("\nYou can now run the tool normally (python app.py / start.sh / start.bat) and "
          "reviewing this folder will load instantly from the cache.")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="VideoReviewTool")
    parser.add_argument("--prepare", metavar="FOLDER",
                         help="Pre-generate and cache snapshot thumbnails for every video in "
                              "FOLDER, then exit without starting the web server. Useful for "
                              "priming the cache ahead of time over a slow network.")
    parser.add_argument("--snapshots", type=int, default=None,
                         help="Number of snapshots per video for --prepare "
                              f"(default: the saved setting, currently {state['settings']['default_num_snapshots']}).")
    args = parser.parse_args()

    if args.prepare:
        run_prepare_cli(args.prepare, args.snapshots if args.snapshots is not None
                         else state["settings"]["default_num_snapshots"])
        raise SystemExit(0)

    PORT = 5000
    url = f"http://127.0.0.1:{PORT}"
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"\n  VideoReviewTool running at {url}\n  Press CTRL+C to stop.\n")
    # threaded=True is the actual fix for the "app stops registering
    # keypresses" freeze: Flask's dev server is single-threaded by default,
    # so one thumbnail request stuck on a broken video queues up every other
    # request (including Delete/Keep/Skip) behind it. With threading on,
    # a stuck request can no longer block the rest of the app.
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
