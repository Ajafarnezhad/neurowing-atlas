# -*- coding: utf-8 -*-
"""Fast, resumable SWC LOD atlas builder for FlyBrain Research Simulator."""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import threading
import time
import zlib
from array import array
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from pathlib import Path
from typing import List

LONG_ID_RE = re.compile(r"\d{8,}")


def root_id_from_path(path: Path) -> str:
    nums = LONG_ID_RE.findall(path.stem)
    return max(nums, key=len) if nums else path.stem


def _pack_floats(values: List[float]) -> bytes:
    a = array("f", values)
    return zlib.compress(a.tobytes(), 1)


def _unpack_floats(blob: bytes) -> List[float]:
    raw = zlib.decompress(blob)
    a = array("f")
    a.frombytes(raw)
    return a.tolist()


def discover_swc_files(root: Path):
    """Faster than sorting Path.rglob on very large Windows trees."""
    out = []
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith(".swc"):
                out.append(Path(dirpath) / name)
    return out


def parse_swc_lod(path: Path, max_segments: int = 64):
    """
    One-pass SWC parser with deterministic reservoir sampling.

    It reads every line (needed for a representative whole-neuron LOD) but does
    NOT materialize every segment. At most `max_segments` segments are retained.
    Out-of-order parent references are handled through a small waiting map.
    """
    target = max(1, int(max_segments))
    nodes = {}
    waiting = {}
    reservoir = []
    seen_segments = 0
    minx = miny = minz = float("inf")
    maxx = maxy = maxz = float("-inf")

    # Deterministic cheap PRNG seeded from the filename.
    seed = 2166136261
    for ch in path.stem:
        seed ^= ord(ch)
        seed = (seed * 16777619) & 0xFFFFFFFF

    def rand_u32():
        nonlocal seed
        seed ^= (seed << 13) & 0xFFFFFFFF
        seed ^= (seed >> 17) & 0xFFFFFFFF
        seed ^= (seed << 5) & 0xFFFFFFFF
        seed &= 0xFFFFFFFF
        return seed

    def keep_segment(seg):
        nonlocal seen_segments
        seen_segments += 1
        if len(reservoir) < target:
            reservoir.append(seg)
            return
        j = rand_u32() % seen_segments
        if j < target:
            reservoir[j] = seg

    with open(path, "r", encoding="utf-8", errors="ignore", buffering=1024 * 256) as f:
        for line in f:
            if not line or line[0] == "#":
                continue
            p = line.split()
            if len(p) < 7:
                continue
            try:
                nid = int(float(p[0]))
                x, y, z = float(p[2]), float(p[3]), float(p[4])
                parent = int(float(p[6]))
            except Exception:
                continue

            nodes[nid] = (x, y, z)
            minx = min(minx, x); maxx = max(maxx, x)
            miny = min(miny, y); maxy = max(maxy, y)
            minz = min(minz, z); maxz = max(maxz, z)

            if parent >= 0:
                q = nodes.get(parent)
                if q is not None:
                    keep_segment((q[0], q[1], q[2], x, y, z))
                else:
                    waiting.setdefault(parent, []).append((x, y, z))

            # Resolve children that referenced this node before it appeared.
            children = waiting.pop(nid, None)
            if children:
                for cx, cy, cz in children:
                    keep_segment((x, y, z, cx, cy, cz))

    if seen_segments == 0:
        return [], 0, None

    flat = []
    for seg in reservoir:
        flat.extend(seg)
    return flat, seen_segments, [minx, miny, minz, maxx, maxy, maxz]


def _worker(args):
    path_s, root_s, max_segments = args
    path = Path(path_s)
    root = Path(root_s)
    rid = root_id_from_path(path)
    try:
        flat, raw_count, bbox = parse_swc_lod(path, max_segments)
        if not flat or not bbox:
            return (rid, None, None, None, None)
        rel = str(path.relative_to(root)).replace("\\", "/")
        return (rid, rel, raw_count, bbox, _pack_floats(flat))
    except Exception as e:
        return (rid, None, None, None, str(e))


class SWCAtlas:
    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.cache_dir / "swc_atlas.sqlite"
        self._lock = threading.Lock()
        self._thread = None
        self.progress = {
            "building": False, "done": 0, "total": 0, "percent": 0.0,
            "current": "", "error": None, "rate": 0.0, "eta_seconds": None,
            "phase": "idle"
        }
        self._init_db()

    def _con(self):
        con = sqlite3.connect(self.db_path, timeout=60)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        con.execute("PRAGMA temp_store=MEMORY")
        return con

    def _init_db(self):
        con = self._con()
        try:
            con.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
            con.execute("""CREATE TABLE IF NOT EXISTS neuron(
                root_id TEXT PRIMARY KEY, relpath TEXT NOT NULL,
                segment_count INTEGER NOT NULL, lod_count INTEGER NOT NULL,
                minx REAL,miny REAL,minz REAL,maxx REAL,maxy REAL,maxz REAL,
                vertices BLOB NOT NULL)""")
            con.commit()
        finally:
            con.close()

    def _meta(self, con, key, default=None):
        r = con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return r[0] if r else default

    def status(self):
        con = self._con()
        try:
            complete = self._meta(con, "complete", "0") == "1"
            count = con.execute("SELECT COUNT(*) FROM neuron").fetchone()[0]
            total_segments = con.execute("SELECT COALESCE(SUM(segment_count),0) FROM neuron").fetchone()[0]
            bbox_raw = self._meta(con, "global_bbox")
            bbox = json.loads(bbox_raw) if bbox_raw else None
            max_segments = int(self._meta(con, "max_segments", "0") or 0)
            built_at = self._meta(con, "built_at")
        finally:
            con.close()
        p = dict(self.progress)
        p.update({"exists": count > 0, "complete": complete, "neurons": int(count),
                  "raw_segments": int(total_segments), "bbox": bbox,
                  "max_segments": max_segments, "built_at": built_at,
                  "db": str(self.db_path)})
        return p

    def build(self, swc_dir: Path, max_segments=64, force=False, workers=4, verbose=True):
        swc_dir = Path(swc_dir)
        workers = max(1, min(int(workers), 16))
        t_discovery = time.time()
        with self._lock:
            self.progress.update({"building": True, "phase": "discover", "done": 0,
                                  "total": 0, "percent": 0.0, "error": None})
        if verbose:
            print(f"[atlas] Discovering SWC files under: {swc_dir}", flush=True)
        files = discover_swc_files(swc_dir)
        if verbose:
            print(f"[atlas] Found {len(files):,} SWC files in {time.time()-t_discovery:.1f}s", flush=True)
        total = len(files)
        with self._lock:
            self.progress.update({"phase": "build", "total": total})

        con = self._con()
        try:
            if force:
                con.execute("DELETE FROM neuron")
                con.execute("DELETE FROM meta")
                con.commit()
            con.execute("INSERT OR REPLACE INTO meta VALUES('complete','0')")
            con.execute("INSERT OR REPLACE INTO meta VALUES('max_segments',?)", (str(int(max_segments)),))
            con.commit()

            existing = set() if force else {r[0] for r in con.execute("SELECT root_id FROM neuron")}
            todo = [p for p in files if root_id_from_path(p) not in existing]
            resumed = total - len(todo)
            if verbose and resumed:
                print(f"[atlas] Resume: {resumed:,} neurons already cached; {len(todo):,} remain.", flush=True)

            gmin = [float("inf")] * 3; gmax = [float("-inf")] * 3
            for row in con.execute("SELECT minx,miny,minz,maxx,maxy,maxz FROM neuron"):
                if row[0] is None: continue
                for j in range(3):
                    gmin[j] = min(gmin[j], float(row[j])); gmax[j] = max(gmax[j], float(row[j+3]))

            pending = []
            done = resumed
            failed = 0
            started = time.time()
            last_print = started

            def consume(result):
                nonlocal done, failed, last_print
                rid, rel, raw_count, bbox, payload = result
                done += 1
                if rel is None:
                    failed += 1
                else:
                    for j in range(3):
                        gmin[j] = min(gmin[j], bbox[j]); gmax[j] = max(gmax[j], bbox[j+3])
                    flat_count = len(zlib.decompress(payload)) // 4
                    pending.append((rid, rel, int(raw_count), flat_count // 6, *bbox, payload))
                if len(pending) >= 250:
                    con.executemany("""INSERT OR REPLACE INTO neuron
                        (root_id,relpath,segment_count,lod_count,minx,miny,minz,maxx,maxy,maxz,vertices)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?)""", pending)
                    con.commit(); pending.clear()
                now = time.time(); elapsed = max(.001, now-started)
                processed_new = max(0, done-resumed)
                rate = processed_new/elapsed
                remain = max(0, total-done)
                eta = remain/rate if rate > 0 else None
                with self._lock:
                    self.progress.update({"done": done, "percent": done/max(1,total)*100,
                        "rate": rate, "eta_seconds": eta, "current": rid, "failed": failed})
                if verbose and (done == total or done % 500 == 0 or now-last_print >= 5):
                    eta_s = "?" if eta is None else time.strftime("%H:%M:%S", time.gmtime(eta))
                    print(f"[atlas] {done:,}/{total:,} ({done/max(1,total)*100:5.1f}%) | {rate:,.1f} neurons/s | ETA {eta_s} | failed {failed}", flush=True)
                    last_print = now

            if todo:
                if workers == 1:
                    for path in todo:
                        consume(_worker((str(path), str(swc_dir), int(max_segments))))
                else:
                    if verbose:
                        print(f"[atlas] Parsing with {workers} workers. Progress is resumable.", flush=True)
                    it = iter(todo)
                    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="swc") as ex:
                        active = set()
                        for _ in range(min(len(todo), workers*6)):
                            try:
                                p = next(it)
                            except StopIteration:
                                break
                            active.add(ex.submit(_worker, (str(p), str(swc_dir), int(max_segments))))
                        while active:
                            finished, active = wait(active, return_when=FIRST_COMPLETED)
                            for fut in finished:
                                consume(fut.result())
                                try:
                                    p = next(it)
                                except StopIteration:
                                    continue
                                active.add(ex.submit(_worker, (str(p), str(swc_dir), int(max_segments))))

            if pending:
                con.executemany("""INSERT OR REPLACE INTO neuron
                    (root_id,relpath,segment_count,lod_count,minx,miny,minz,maxx,maxy,maxz,vertices)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)""", pending)
                con.commit(); pending.clear()

            if all(math.isfinite(x) for x in gmin + gmax):
                con.execute("INSERT OR REPLACE INTO meta VALUES('global_bbox',?)", (json.dumps(gmin+gmax),))
            con.execute("INSERT OR REPLACE INTO meta VALUES('built_at',?)", (time.strftime("%Y-%m-%d %H:%M:%S"),))
            con.execute("INSERT OR REPLACE INTO meta VALUES('complete','1')")
            con.commit()
            with self._lock:
                self.progress.update({"building": False, "phase": "done", "done": total,
                                      "total": total, "percent": 100.0, "current": "",
                                      "eta_seconds": 0})
            if verbose:
                print(f"[atlas] DONE: {total:,} files indexed. Cache: {self.db_path}", flush=True)
        except Exception as e:
            with self._lock:
                self.progress.update({"building": False, "phase": "error", "error": str(e)})
            raise
        finally:
            con.close()

    def start_build(self, swc_dir: Path, max_segments=64, force=False, workers=4):
        with self._lock:
            if self._thread and self._thread.is_alive():
                return False
            self._thread = threading.Thread(target=self._build_thread,
                args=(Path(swc_dir), int(max_segments), bool(force), int(workers)), daemon=True)
            self._thread.start(); return True

    def _build_thread(self, swc_dir, max_segments, force, workers):
        try:
            self.build(swc_dir, max_segments=max_segments, force=force, workers=workers, verbose=False)
        except Exception:
            pass

    def batch(self, offset=0, limit=200):
        offset=max(0,int(offset)); limit=max(1,min(int(limit),1000))
        con=self._con()
        try:
            rows=con.execute("SELECT root_id,lod_count,vertices FROM neuron ORDER BY rowid LIMIT ? OFFSET ?",(limit,offset)).fetchall()
        finally:
            con.close()
        vertices=[]; ranges=[]
        for rid,count,blob in rows:
            vals=_unpack_floats(blob); start=len(vertices)//3; vertices.extend(vals)
            ranges.append({"id":rid,"start_vertex":start,"vertex_count":len(vals)//3,"segments":int(count)})
        return {"offset":offset,"limit":limit,"records":len(rows),"vertices":vertices,"ranges":ranges}

    def selection(self, ids: List[str], limit=300):
        ids=[str(x) for x in ids[:max(1,min(int(limit),1000))]]
        if not ids: return {"records":[]}
        con=self._con()
        try:
            ph=",".join(["?"]*len(ids))
            rows=con.execute(f"SELECT root_id,lod_count,vertices FROM neuron WHERE root_id IN ({ph})",ids).fetchall()
        finally:
            con.close()
        return {"records":[{"id":rid,"segments":int(count),"vertices":_unpack_floats(blob)} for rid,count,blob in rows]}
