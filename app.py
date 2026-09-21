# -*- coding: utf-8 -*-
"""
NeuroWing Atlas
================
Interactive explorer + structural simulator for large FlyWire/FAFB datasets.

Design goals
------------
* Reads your dataset folders automatically.
* Never loads the whole ~13GB dataset into browser RAM.
* Materializes only compact connection/label/coordinate indexes in DuckDB.
* Reads SWC morphology on demand.
* Reads synapse coordinates on demand from raw CSV partitions.
* Persian UI + Vazirmatn font in browser.
* Structural graph is data-driven; simulation is explicitly approximate.

Run:
    pip install -r requirements.txt
    python app.py run --data "D:\\path\\to\\dataset"

First run prepares a local cache DB under:
    <dataset>\\.flybrain_lab\\flybrain.duckdb
"""

from __future__ import annotations
import argparse
import csv
import json
import math
import os
import re
import sys
import time
import hashlib
import threading
import webbrowser
from collections import deque
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Iterable

import duckdb
from flask import Flask, jsonify, request, render_template, Response, send_file
from swc_atlas import SWCAtlas
from knowledge_fa import explain_neuron_fa

APP_VERSION = "3.2.0"

# ---------------------------------------------------------------------
# Dataset discovery
# ---------------------------------------------------------------------

ROLE_NAMES = {
    "connections_buhmann_no_threshold": "connections_buhmann_no_threshold.csv",
    "connections_princeton": "connections_princeton.csv",
    "connections_princeton_no_threshold": "connections_princeton_no_threshold.csv",
    "connectivity_tags": "connectivity_tags.csv",
    "coordinates": "coordinates.csv",
    "synapses_princeton": "fafb_v783_princeton_synapse_table.csv",
    "labels": "labels.csv",
    "neuropil_synapses": "neuropil_synapse_table.csv",
    "processed_labels": "processed_labels.csv",
    "skeletons": "sk_lod1_783_healed",
}

PRE_CANDS = [
    "pre_root_id","pre_pt_root_id","pre","source","source_id","upstream_root_id",
    "presynaptic_root_id","pre_root","pre_id"
]
POST_CANDS = [
    "post_root_id","post_pt_root_id","post","target","target_id","downstream_root_id",
    "postsynaptic_root_id","post_root","post_id"
]
WEIGHT_CANDS = [
    "syn_count","synapse_count","weight","n_synapses","count","synapses","n"
]
NT_CANDS = ["nt_type","neurotransmitter","predicted_nt","nt","transmitter"]
ID_CANDS = ["root_id","pt_root_id","neuron_id","id","root","cell_id"]
LABEL_CANDS = ["label","name","cell_type","type","hemibrain_type","community_label","processed_label"]
TAG_CANDS = ["tag","connectivity_tag","tags","label","value"]
X_CANDS = ["x","pt_x","x_nm","x_coord","x_position","pre_x","post_x"]
Y_CANDS = ["y","pt_y","y_nm","y_coord","y_position","pre_y","post_y"]
Z_CANDS = ["z","pt_z","z_nm","z_coord","z_position","pre_z","post_z"]

def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(s).strip().lower()).strip("_")

def qident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'

def sql_str(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"

def choose_col(cols: List[str], candidates: List[str], allow_prefix: bool = True) -> Optional[str]:
    """Conservative matcher: exact first; safe long-prefix second."""
    cmap = {norm(c): c for c in cols}
    for cand in candidates:
        nc = norm(cand)
        if nc in cmap:
            return cmap[nc]
    if not allow_prefix:
        return None
    for cand in candidates:
        nc = norm(cand)
        if len(nc) < 4:
            continue
        matches = [(k, original) for k, original in cmap.items()
                   if k.startswith(nc + "_")]
        if matches:
            matches.sort(key=lambda x: len(x[0]))
            return matches[0][1]
    return None

def list_csv_files(p: Path) -> List[Path]:
    if p.is_file() and p.suffix.lower() == ".csv":
        return [p]
    if p.is_dir():
        return sorted(x for x in p.rglob("*.csv") if x.is_file())
    return []

def discover_dataset(data_root: Path) -> Dict[str, dict]:
    data_root = data_root.resolve()
    out: Dict[str, dict] = {}

    # exact names first
    all_nodes = [data_root] + list(data_root.rglob("*"))
    by_name = {}
    for p in all_nodes:
        by_name.setdefault(p.name.lower(), []).append(p)

    for role, expected in ROLE_NAMES.items():
        matches = by_name.get(expected.lower(), [])
        if matches:
            p = matches[0]
            if role == "skeletons":
                out[role] = {"path": str(p), "kind": "swc_dir"}
            else:
                files = list_csv_files(p)
                if files:
                    out[role] = {"path": str(p), "kind": "csv", "files": [str(x) for x in files]}

    # fuzzy fallback for missing roles
    if "skeletons" not in out:
        swc_dirs = {}
        for p in data_root.rglob("*.swc"):
            swc_dirs[p.parent] = swc_dirs.get(p.parent, 0) + 1
        if swc_dirs:
            best = max(swc_dirs.items(), key=lambda kv: kv[1])[0]
            out["skeletons"] = {"path": str(best), "kind": "swc_dir"}

    return out

def duckdb_csv_expr(files: List[str]) -> str:
    """Return a safe DuckDB read_csv_auto expression for file(s)."""
    if not files:
        raise ValueError("No CSV files")
    quoted = "[" + ",".join(sql_str(str(Path(f).resolve()).replace("\\","/")) for f in files) + "]"
    return (
        f"read_csv_auto({quoted}, union_by_name=true, header=true, "
        f"sample_size=50000, ignore_errors=true, null_padding=true, "
        f"parallel=false)"
    )

def probe_columns(con, files: List[str]) -> List[str]:
    expr = duckdb_csv_expr(files[:min(len(files), 25)])
    rows = con.execute(f"DESCRIBE SELECT * FROM {expr}").fetchall()
    return [r[0] for r in rows]

# ---------------------------------------------------------------------
# Cache preparation
# ---------------------------------------------------------------------

class FlyDataset:
    def __init__(self, data_root: Path):
        self.data_root = data_root.resolve()
        self.cache_dir = self.data_root / ".flybrain_lab"
        self.cache_dir.mkdir(exist_ok=True)
        self.db_path = self.cache_dir / "flybrain.duckdb"
        self.catalog_path = self.cache_dir / "catalog.json"
        self.catalog: Dict[str, dict] = {}
        self._swc_index: Dict[str, str] = {}
        # Full-brain SWC LOD atlas cache. This must be initialized before
        # CLI/API code can call ds.atlas.build/status/batch/selection.
        self.atlas = SWCAtlas(self.cache_dir)
        self._processed_label_cache: Dict[str, List[str]] = {}
        self._neuropil_cache: Dict[str, dict] = {}
        self._neuron_full_cache: Dict[tuple, dict] = {}
        self._load_or_discover()

    def con(self):
        c = duckdb.connect(str(self.db_path))
        c.execute("PRAGMA threads=4")
        c.execute("PRAGMA enable_progress_bar=false")
        return c

    def _load_or_discover(self):
        if self.catalog_path.exists():
            try:
                self.catalog = json.loads(self.catalog_path.read_text(encoding="utf-8"))
            except Exception:
                self.catalog = {}
        fresh = discover_dataset(self.data_root)
        # Keep schema metadata if same role still exists.
        for role, info in fresh.items():
            old = self.catalog.get(role, {})
            old.update(info)
            fresh[role] = old
        self.catalog = fresh
        self.catalog_path.write_text(json.dumps(self.catalog, ensure_ascii=False, indent=2), encoding="utf-8")

    def status(self):
        prepared = self.db_path.exists()
        return {
            "version": APP_VERSION,
            "data_root": str(self.data_root),
            "prepared": prepared,
            "roles": {
                k: {
                    "path": v.get("path"),
                    "files": len(v.get("files", [])) if v.get("kind") == "csv" else None,
                    "schema": v.get("schema")
                } for k,v in self.catalog.items()
            }
        }

    def prepare(self, force=False, verbose=True):
        con = self.con()
        try:
            con.execute("""
                CREATE TABLE IF NOT EXISTS app_meta(
                    key VARCHAR PRIMARY KEY,
                    value VARCHAR
                )
            """)

            # Probe schemas
            for role, info in self.catalog.items():
                if info.get("kind") != "csv":
                    continue
                try:
                    cols = probe_columns(con, info["files"])
                    info["columns"] = cols
                    schema = {}
                    if role.startswith("connections_"):
                        schema["pre"] = choose_col(cols, PRE_CANDS)
                        schema["post"] = choose_col(cols, POST_CANDS)
                        schema["weight"] = choose_col(cols, WEIGHT_CANDS, allow_prefix=False)
                        schema["nt"] = choose_col(cols, NT_CANDS, allow_prefix=False)
                    elif role == "synapses_princeton":
                        schema["pre"] = choose_col(cols, PRE_CANDS)
                        schema["post"] = choose_col(cols, POST_CANDS)
                        schema["weight"] = choose_col(cols, WEIGHT_CANDS, allow_prefix=False)
                        schema["nt"] = choose_col(cols, NT_CANDS, allow_prefix=False)
                        schema["x"] = choose_col(cols, X_CANDS, allow_prefix=False)
                        schema["y"] = choose_col(cols, Y_CANDS, allow_prefix=False)
                        schema["z"] = choose_col(cols, Z_CANDS, allow_prefix=False)
                        schema["neuropil"] = choose_col(cols, ["neuropil","region","brain_region"], allow_prefix=False)
                    elif role == "neuropil_synapses":
                        schema["id"] = choose_col(cols, ID_CANDS)
                        schema["neuropil"] = choose_col(cols, ["neuropil","region","brain_region"], allow_prefix=False)
                        schema["input_synapses"] = choose_col(cols, ["input_synapses","input synapses","inputs"], allow_prefix=False)
                        schema["output_synapses"] = choose_col(cols, ["output_synapses","output synapses","outputs"], allow_prefix=False)

                    if role in ("labels","processed_labels","connectivity_tags","coordinates"):
                        schema["id"] = choose_col(cols, ID_CANDS)

                    if role in ("labels","processed_labels"):
                        schema["label"] = choose_col(cols, LABEL_CANDS, allow_prefix=False)
                        if role == "processed_labels" and not schema["label"]:
                            schema["label"] = choose_col(cols, ["processed_labels"], allow_prefix=False)
                        text_cols = []
                        for c in cols:
                            nc = norm(c)
                            if any(k in nc for k in ("label","name","type","class","side","flow","lineage")):
                                text_cols.append(c)
                        schema["display_cols"] = text_cols[:12]

                    if role == "connectivity_tags":
                        schema["tag"] = choose_col(cols, TAG_CANDS, allow_prefix=False)

                    if role == "coordinates":
                        schema["x"] = choose_col(cols, X_CANDS, allow_prefix=False)
                        schema["y"] = choose_col(cols, Y_CANDS, allow_prefix=False)
                        schema["z"] = choose_col(cols, Z_CANDS, allow_prefix=False)
                        schema["position"] = choose_col(cols, ["position","coordinate","coordinates","xyz"], allow_prefix=False)
                    info["schema"] = schema
                    if verbose:
                        print(f"[schema] {role}: {schema}")
                except Exception as e:
                    info["schema_error"] = str(e)
                    if verbose:
                        print(f"[warn] schema {role}: {e}")

            self.catalog_path.write_text(json.dumps(self.catalog, ensure_ascii=False, indent=2), encoding="utf-8")

            # Build compact standardized connection tables.
            conn_roles = [r for r in self.catalog if r.startswith("connections_")]
            for role in conn_roles:
                info = self.catalog[role]
                s = info.get("schema") or {}
                pre, post = s.get("pre"), s.get("post")
                if not pre or not post:
                    print(f"[skip] {role}: pre/post columns not detected")
                    continue
                table = "c_" + role
                exists = con.execute(
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name=?",
                    [table]
                ).fetchone()[0] > 0
                if exists and not force:
                    if verbose: print(f"[ok] {table} already prepared")
                    continue

                if verbose:
                    print(f"\n[build] {table} ... this may take time on first run.")
                con.execute(f"DROP TABLE IF EXISTS {qident(table)}")
                expr = duckdb_csv_expr(info["files"])
                weight_expr = f"TRY_CAST({qident(s['weight'])} AS DOUBLE)" if s.get("weight") else "1.0"
                nt_expr = f"CAST({qident(s['nt'])} AS VARCHAR)" if s.get("nt") else "NULL"
                query = f"""
                    CREATE TABLE {qident(table)} AS
                    SELECT
                        CAST({qident(pre)} AS VARCHAR) AS pre_id,
                        CAST({qident(post)} AS VARCHAR) AS post_id,
                        SUM(COALESCE({weight_expr},1.0))::DOUBLE AS syn_count,
                        any_value({nt_expr}) AS nt_type
                    FROM {expr}
                    WHERE {qident(pre)} IS NOT NULL AND {qident(post)} IS NOT NULL
                    GROUP BY 1,2
                """
                t0 = time.time()
                con.execute(query)
                con.execute(f"CREATE INDEX IF NOT EXISTS {qident('idx_'+table+'_pre')} ON {qident(table)}(pre_id)")
                con.execute(f"CREATE INDEX IF NOT EXISTS {qident('idx_'+table+'_post')} ON {qident(table)}(post_id)")
                n = con.execute(f"SELECT COUNT(*) FROM {qident(table)}").fetchone()[0]
                if verbose: print(f"[done] {table}: {n:,} edges in {time.time()-t0:.1f}s")

            self._prepare_labels(con, force, verbose)
            self._prepare_coordinates(con, force, verbose)
            self._prepare_tags(con, force, verbose)
            self._prepare_swc_index(force, verbose)

            con.execute("INSERT OR REPLACE INTO app_meta VALUES ('prepared_at', ?)", [str(time.time())])
            con.execute("INSERT OR REPLACE INTO app_meta VALUES ('version', ?)", [APP_VERSION])
        finally:
            con.close()

    def _meta_ready(self, con, key: str) -> bool:
        try:
            row = con.execute("SELECT value FROM app_meta WHERE key=?", [key]).fetchone()
            return bool(row and row[0] == "1")
        except Exception:
            return False

    def _set_meta_ready(self, con, key: str):
        con.execute("INSERT OR REPLACE INTO app_meta VALUES (?, '1')", [key])

    def _prepare_labels(self, con, force, verbose):
        sources = [r for r in ("processed_labels","labels") if r in self.catalog]
        if not sources:
            return
        exists = con.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_name='neuron_labels'").fetchone()[0] > 0
        if exists and not force and self._meta_ready(con, "neuron_labels_ready"):
            return
        con.execute("DROP TABLE IF EXISTS neuron_labels")
        con.execute("CREATE TABLE neuron_labels(root_id VARCHAR, label VARCHAR, source VARCHAR, details VARCHAR)")
        for role in sources:
            info = self.catalog[role]; s = info.get("schema") or {}
            rid = s.get("id")
            if not rid: continue
            expr = duckdb_csv_expr(info["files"])
            display_cols = s.get("display_cols") or ([s.get("label")] if s.get("label") else [])
            display_cols = [c for c in display_cols if c]
            if not display_cols:
                continue
            label_col = s.get("label") or display_cols[0]
            # DuckDB JSON object would be overkill; concatenate useful fields.
            pieces = []
            for c in display_cols[:8]:
                pieces.append(f"{sql_str(c+'=')} || COALESCE(CAST({qident(c)} AS VARCHAR),'')")
            details = " || ' | ' || ".join(pieces) if pieces else "''"
            con.execute(f"""
                INSERT INTO neuron_labels
                SELECT CAST({qident(rid)} AS VARCHAR),
                       COALESCE(CAST({qident(label_col)} AS VARCHAR),''),
                       {sql_str(role)},
                       {details}
                FROM {expr}
                WHERE {qident(rid)} IS NOT NULL
            """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_labels_root ON neuron_labels(root_id)")
        self._set_meta_ready(con, "neuron_labels_ready")
        if verbose:
            n = con.execute("SELECT COUNT(*) FROM neuron_labels").fetchone()[0]
            print(f"[done] neuron_labels: {n:,}")

    def _position_sql_expr(self, colname: str, axis: int) -> str:
        """
        Extract x/y/z from a generic position string such as:
        [123,456,789], (123, 456, 789), POINT(123 456 789),
        or other text containing at least three numbers.
        DuckDB regexp_extract_all returns a list of numeric-looking strings.
        """
        q = qident(colname)
        idx = axis + 1  # DuckDB list indexes are 1-based
        # numeric regex including optional sign/decimal/exponent
        rx = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
        return f"TRY_CAST(regexp_extract_all(CAST({q} AS VARCHAR), {sql_str(rx)})[{idx}] AS DOUBLE)"

    def _prepare_coordinates(self, con, force, verbose):
        if "coordinates" not in self.catalog:
            return
        info = self.catalog["coordinates"]; s = info.get("schema") or {}
        rid = s.get("id")
        x, y, z = s.get("x"), s.get("y"), s.get("z")
        pos = s.get("position")

        if not rid:
            if verbose:
                print("[skip] neuron_coords: root id column not detected")
            return

        # If explicit x/y/z are absent, parse the generic `position` column.
        if not all((x, y, z)) and not pos:
            if verbose:
                print("[skip] neuron_coords: neither explicit x/y/z nor a position column was detected; SWC geometry will be used.")
            return

        exists = con.execute(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='neuron_coords'"
        ).fetchone()[0] > 0
        if exists and not force and self._meta_ready(con, "neuron_coords_ready"):
            return

        con.execute("DROP TABLE IF EXISTS neuron_coords")
        expr = duckdb_csv_expr(info["files"])

        if all((x, y, z)):
            xexpr = f"TRY_CAST({qident(x)} AS DOUBLE)"
            yexpr = f"TRY_CAST({qident(y)} AS DOUBLE)"
            zexpr = f"TRY_CAST({qident(z)} AS DOUBLE)"
            mode = "explicit x/y/z"
        else:
            xexpr = self._position_sql_expr(pos, 0)
            yexpr = self._position_sql_expr(pos, 1)
            zexpr = self._position_sql_expr(pos, 2)
            mode = f"parsed from {pos}"

        con.execute(f"""
            CREATE TABLE neuron_coords AS
            SELECT
                CAST({qident(rid)} AS VARCHAR) root_id,
                AVG({xexpr}) x,
                AVG({yexpr}) y,
                AVG({zexpr}) z
            FROM {expr}
            WHERE {qident(rid)} IS NOT NULL
            GROUP BY 1
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_coords_root ON neuron_coords(root_id)")
        self._set_meta_ready(con, "neuron_coords_ready")
        if verbose:
            n = con.execute("SELECT COUNT(*) FROM neuron_coords").fetchone()[0]
            valid = con.execute("""
                SELECT COUNT(*) FROM neuron_coords
                WHERE x IS NOT NULL AND y IS NOT NULL AND z IS NOT NULL
            """).fetchone()[0]
            print(f"[done] neuron_coords: {n:,} rows, {valid:,} valid XYZ ({mode})")

    def _prepare_tags(self, con, force, verbose):
        if "connectivity_tags" not in self.catalog:
            return
        info = self.catalog["connectivity_tags"]; s = info.get("schema") or {}
        rid, tag = s.get("id"), s.get("tag")
        if not rid or not tag:
            return
        exists = con.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_name='neuron_tags'").fetchone()[0] > 0
        if exists and not force and self._meta_ready(con, "neuron_tags_ready"):
            return
        con.execute("DROP TABLE IF EXISTS neuron_tags")
        expr = duckdb_csv_expr(info["files"])
        con.execute(f"""
            CREATE TABLE neuron_tags AS
            SELECT CAST({qident(rid)} AS VARCHAR) root_id,
                   CAST({qident(tag)} AS VARCHAR) tag
            FROM {expr}
            WHERE {qident(rid)} IS NOT NULL
        """)
        con.execute("CREATE INDEX IF NOT EXISTS idx_tags_root ON neuron_tags(root_id)")
        self._set_meta_ready(con, "neuron_tags_ready")
        if verbose:
            n = con.execute("SELECT COUNT(*) FROM neuron_tags").fetchone()[0]
            print(f"[done] neuron_tags: {n:,}")

    def _prepare_swc_index(self, force=False, verbose=True):
        info = self.catalog.get("skeletons")
        if not info:
            return
        index_path = self.cache_dir / "swc_index.json"
        if index_path.exists() and not force:
            try:
                self._swc_index = json.loads(index_path.read_text(encoding="utf-8"))
                return
            except Exception:
                pass
        base = Path(info["path"])
        idx = {}
        count = 0
        for p in base.rglob("*.swc"):
            stem = p.stem
            # Exact stem + longest long integer token as aliases.
            idx.setdefault(stem, str(p))
            nums = re.findall(r"\d{8,}", stem)
            if nums:
                idx.setdefault(max(nums, key=len), str(p))
            count += 1
            if verbose and count % 20000 == 0:
                print(f"\r[swc] indexed {count:,}", end="", flush=True)
        if verbose and count:
            print(f"\r[swc] indexed {count:,} files")
        self._swc_index = idx
        index_path.write_text(json.dumps(idx), encoding="utf-8")

    def _ensure_swc_index(self):
        if self._swc_index:
            return
        p = self.cache_dir / "swc_index.json"
        if p.exists():
            self._swc_index = json.loads(p.read_text(encoding="utf-8"))
        else:
            self._prepare_swc_index(False, False)

    def available_sources(self):
        con = self.con()
        try:
            tabs = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables").fetchall()}
        finally:
            con.close()
        out = []
        for role in self.catalog:
            if role.startswith("connections_"):
                table = "c_" + role
                if table in tabs:
                    out.append(role)
        return out

    # -----------------------------------------------------------------
    # Queries
    # -----------------------------------------------------------------

    def search(self, q: str, limit=50):
        con = self.con()
        try:
            result = []
            q = (q or "").strip()
            if q:
                # exact/partial IDs + labels
                rows = con.execute("""
                    SELECT root_id, label, source, details
                    FROM neuron_labels
                    WHERE root_id LIKE ? OR lower(label) LIKE lower(?) OR lower(details) LIKE lower(?)
                    LIMIT ?
                """, [f"%{q}%", f"%{q}%", f"%{q}%", limit]).fetchall() if self._table_exists(con,"neuron_labels") else []
                seen=set()
                for r in rows:
                    if r[0] in seen: continue
                    seen.add(r[0])
                    result.append({"root_id":r[0],"label":r[1],"source":r[2],"details":r[3]})
                # If a numeric ID wasn't in labels, still return it.
                if re.fullmatch(r"\d{6,}", q) and q not in seen:
                    result.insert(0, {"root_id":q,"label":"","source":"id","details":""})
            else:
                if self._table_exists(con,"neuron_labels"):
                    rows=con.execute("SELECT root_id,label,source,details FROM neuron_labels WHERE root_id IS NOT NULL LIMIT ?",[limit]).fetchall()
                    result=[{"root_id":r[0],"label":r[1] or "","source":r[2],"details":r[3]} for r in rows]
                if not result:
                    sources = self.available_sources()
                    if sources:
                        table = "c_" + sources[0]
                        rows = con.execute(f"SELECT DISTINCT pre_id FROM {qident(table)} LIMIT ?", [limit]).fetchall()
                        result=[{"root_id":r[0],"label":"","source":sources[0],"details":""} for r in rows]
            return result[:limit]
        finally:
            con.close()

    def _table_exists(self, con, name):
        return con.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_name=?", [name]).fetchone()[0] > 0

    def neuron_info(self, root_id: str):
        con = self.con()
        try:
            labels=[]
            tags=[]
            coord=None
            if self._table_exists(con,"neuron_labels"):
                rows=con.execute("SELECT label,source,details FROM neuron_labels WHERE root_id=? LIMIT 20",[root_id]).fetchall()
                labels=[{"label":r[0],"source":r[1],"details":r[2]} for r in rows]
            if self._table_exists(con,"neuron_tags"):
                tags=[r[0] for r in con.execute("SELECT DISTINCT tag FROM neuron_tags WHERE root_id=? LIMIT 50",[root_id]).fetchall()]
            if self._table_exists(con,"neuron_coords"):
                r=con.execute("SELECT x,y,z FROM neuron_coords WHERE root_id=? LIMIT 1",[root_id]).fetchone()
                if r: coord={"x":r[0],"y":r[1],"z":r[2]}
            return {"root_id":root_id,"labels":labels,"tags":tags,"coord":coord,"has_swc":self.has_swc(root_id)}
        finally:
            con.close()

    def has_swc(self, root_id: str):
        self._ensure_swc_index()
        if root_id in self._swc_index:
            return True
        return any(root_id in k for k in list(self._swc_index.keys())[:2000]) if self._swc_index else False

    def _swc_path(self, root_id: str) -> Optional[Path]:
        self._ensure_swc_index()
        p = self._swc_index.get(root_id)
        if p:
            return Path(p)
        # fallback exact containment scan through keys
        for k,v in self._swc_index.items():
            if root_id == k or root_id in k:
                return Path(v)
        return None

    def skeleton(self, root_id: str, max_segments=80000):
        p = self._swc_path(root_id)
        if not p or not p.exists():
            return {"root_id":root_id,"found":False,"segments":[]}
        nodes={}
        segments=[]
        with open(p,"r",encoding="utf-8",errors="ignore") as f:
            for line in f:
                line=line.strip()
                if not line or line.startswith("#"):
                    continue
                parts=line.split()
                if len(parts)<7:
                    continue
                try:
                    nid=int(float(parts[0])); typ=int(float(parts[1]))
                    x=float(parts[2]); y=float(parts[3]); z=float(parts[4]); radius=float(parts[5]); parent=int(float(parts[6]))
                except Exception:
                    continue
                nodes[nid]=(x,y,z,radius,typ,parent)
        for nid,(x,y,z,radius,typ,parent) in nodes.items():
            if parent in nodes:
                px,py,pz,pr,pt,pp=nodes[parent]
                segments.append([px,py,pz,x,y,z,radius,typ])
        original=len(segments)
        if original>max_segments:
            step=original/max_segments
            segments=[segments[int(i*step)] for i in range(max_segments)]
        return {
            "root_id":root_id,"found":True,"file":p.name,
            "node_count":len(nodes),"segment_count":original,
            "rendered_segments":len(segments),"segments":segments
        }

    def neighbors(self, root_id: str, source: str, topk=50, min_syn=1):
        table="c_"+source
        con=self.con()
        try:
            if not self._table_exists(con,table):
                raise ValueError(f"Prepared source not found: {source}")
            ins=con.execute(f"""
                SELECT pre_id partner_id, syn_count, nt_type
                FROM {qident(table)}
                WHERE post_id=? AND syn_count>=?
                ORDER BY syn_count DESC LIMIT ?
            """,[root_id,min_syn,topk]).fetchall()
            outs=con.execute(f"""
                SELECT post_id partner_id, syn_count, nt_type
                FROM {qident(table)}
                WHERE pre_id=? AND syn_count>=?
                ORDER BY syn_count DESC LIMIT ?
            """,[root_id,min_syn,topk]).fetchall()
            return (
                [{"partner_id":r[0],"syn_count":float(r[1]),"nt_type":r[2],"direction":"in"} for r in ins],
                [{"partner_id":r[0],"syn_count":float(r[1]),"nt_type":r[2],"direction":"out"} for r in outs]
            )
        finally:
            con.close()

    def graph(self, center_id: str, source: str, topk=50, depth=1,
              min_syn=1, max_nodes=1500):
        """
        Scalable subgraph extraction.

        Unlike the original per-node neighbor loop, expansion is batched by BFS
        depth and uses SQL window functions. This allows thousands of neurons to
        be explored without opening a query for every node.
        """
        topk=max(1,min(int(topk),2000))
        depth=max(1,min(int(depth),3))
        min_syn=max(0,float(min_syn))
        max_nodes=max(10,min(int(max_nodes),10000))
        table="c_"+source

        con=self.con()
        try:
            if not self._table_exists(con,table):
                raise ValueError(f"Prepared source not found: {source}")

            nodes={str(center_id):{"id":str(center_id)}}
            edges=[]
            edge_seen=set()
            visited=set()
            frontier=[str(center_id)]

            def expand_chunk(ids, d):
                if not ids:
                    return []
                ph=",".join(["?"]*len(ids))
                # First hop can be broad; deeper hops are capped to control explosion.
                per_node=topk if d==0 else min(topk,40 if d==1 else 18)
                incoming=con.execute(f"""
                    SELECT partner_id, center_id, syn_count, nt_type FROM (
                      SELECT pre_id partner_id, post_id center_id, syn_count, nt_type,
                             row_number() OVER(PARTITION BY post_id ORDER BY syn_count DESC) rn
                      FROM {qident(table)}
                      WHERE post_id IN ({ph}) AND syn_count>=?
                    ) WHERE rn<=?
                """, ids+[min_syn,per_node]).fetchall()
                outgoing=con.execute(f"""
                    SELECT center_id, partner_id, syn_count, nt_type FROM (
                      SELECT pre_id center_id, post_id partner_id, syn_count, nt_type,
                             row_number() OVER(PARTITION BY pre_id ORDER BY syn_count DESC) rn
                      FROM {qident(table)}
                      WHERE pre_id IN ({ph}) AND syn_count>=?
                    ) WHERE rn<=?
                """, ids+[min_syn,per_node]).fetchall()
                return [(str(a),str(b),float(w),nt) for a,b,w,nt in incoming+outgoing]

            for d in range(depth):
                current=[x for x in frontier if x not in visited]
                if not current or len(nodes)>=max_nodes:
                    break
                visited.update(current)
                next_frontier=[]
                for c0 in range(0,len(current),250):
                    rows=expand_chunk(current[c0:c0+250],d)
                    for a,b,w,nt in rows:
                        key=(a,b)
                        if key not in edge_seen:
                            edge_seen.add(key)
                            edges.append({"source":a,"target":b,"weight":w,"nt_type":nt})
                        for nid in (a,b):
                            if nid not in nodes and len(nodes)<max_nodes:
                                nodes[nid]={"id":nid}
                                next_frontier.append(nid)
                        if len(nodes)>=max_nodes:
                            break
                    if len(nodes)>=max_nodes:
                        break
                frontier=next_frontier

            ids=list(nodes)
            # Enrich in chunks.
            if ids and self._table_exists(con,"neuron_coords"):
                for c0 in range(0,len(ids),500):
                    chunk=ids[c0:c0+500]; ph=",".join(["?"]*len(chunk))
                    for rid,x,y,z in con.execute(
                        f"SELECT root_id,x,y,z FROM neuron_coords WHERE root_id IN ({ph})",chunk
                    ).fetchall():
                        nodes[str(rid)]["coord"]={"x":x,"y":y,"z":z}
            if ids and self._table_exists(con,"neuron_labels"):
                for c0 in range(0,len(ids),500):
                    chunk=ids[c0:c0+500]; ph=",".join(["?"]*len(chunk))
                    for rid,label in con.execute(f"""
                        SELECT root_id, any_value(label) FROM neuron_labels
                        WHERE root_id IN ({ph}) AND label<>'' GROUP BY root_id
                    """,chunk).fetchall():
                        nodes[str(rid)]["label"]=label

            # Deterministic fallback position.
            for nid in ids:
                c=nodes[nid].get("coord")
                if not c or c.get("x") is None:
                    h=int(hashlib.md5(nid.encode()).hexdigest()[:12],16)
                    phi=(h%100000)/100000*math.pi*2
                    cost=((h//100000)%10000)/5000-1
                    cost=max(-1,min(1,cost)); sint=math.sqrt(max(0,1-cost*cost))
                    r=1.0+0.25*((h//1000000000)%1000)/1000
                    nodes[nid]["coord"]={
                        "x":r*sint*math.cos(phi),"y":r*sint*math.sin(phi),
                        "z":r*cost,"fallback":True
                    }

            return {
                "center_id":str(center_id),"source":source,
                "nodes":list(nodes.values()),"edges":edges,
                "limits":{"topk":topk,"depth":depth,"max_nodes":max_nodes,"min_syn":min_syn}
            }
        finally:
            con.close()

    def synapse_points(self, pre_id: str, post_id: str, limit=5000):
        """
        Read raw synapse tables on demand. We avoid materializing 13GB synapse data.
        Returns sampled/limited coordinates if detectable.
        """
        limit=max(10,min(int(limit),20000))
        role = "synapses_princeton" if "synapses_princeton" in self.catalog else ("neuropil_synapses" if "neuropil_synapses" in self.catalog else None)
        if not role:
            return {"found":False,"points":[],"reason":"synapse table not discovered"}
        info=self.catalog[role]; s=info.get("schema") or {}
        if not s.get("pre") or not s.get("post"):
            return {"found":False,"points":[],"reason":"pre/post columns not detected"}
        x,y,z=s.get("x"),s.get("y"),s.get("z")
        if not all((x,y,z)):
            return {"found":False,"points":[],"reason":"x/y/z columns not detected"}
        expr=duckdb_csv_expr(info["files"])
        con=self.con()
        try:
            rows=con.execute(f"""
                SELECT TRY_CAST({qident(x)} AS DOUBLE),
                       TRY_CAST({qident(y)} AS DOUBLE),
                       TRY_CAST({qident(z)} AS DOUBLE),
                       {qident(s['neuropil']) if s.get('neuropil') else 'NULL'}
                FROM {expr}
                WHERE CAST({qident(s['pre'])} AS VARCHAR)=?
                  AND CAST({qident(s['post'])} AS VARCHAR)=?
                LIMIT ?
            """,[pre_id,post_id,limit]).fetchall()
            return {
                "found":True,"role":role,
                "points":[{"x":r[0],"y":r[1],"z":r[2],"neuropil":r[3]} for r in rows if None not in r[:3]]
            }
        finally:
            con.close()


    # -----------------------------------------------------------------
    # Pro explorer / simulator support
    # -----------------------------------------------------------------

    def _label_map(self, ids, con=None):
        ids = [str(x) for x in ids if x is not None]
        if not ids:
            return {}
        own = con is None
        if own:
            con = self.con()
        try:
            if not self._table_exists(con, "neuron_labels"):
                return {}
            out = {}
            # Chunk so large path/neighbor requests do not create huge SQL.
            for start in range(0, len(ids), 500):
                chunk = ids[start:start+500]
                ph = ",".join(["?"] * len(chunk))
                rows = con.execute(f"""
                    SELECT root_id,
                           any_value(CASE WHEN label IS NULL THEN '' ELSE label END)
                    FROM neuron_labels
                    WHERE root_id IN ({ph})
                    GROUP BY root_id
                """, chunk).fetchall()
                for rid, label in rows:
                    out[str(rid)] = label or ""
            return out
        finally:
            if own:
                con.close()

    def _processed_labels_raw(self, root_id: str, limit=30):
        if root_id in self._processed_label_cache:
            return self._processed_label_cache[root_id][:limit]
        info = self.catalog.get("processed_labels")
        if not info:
            return []
        cols = info.get("columns") or []
        s = info.get("schema") or {}
        rid = s.get("id") or ("root_id" if "root_id" in cols else None)
        label_col = s.get("label")
        if not label_col and "processed_labels" in cols:
            label_col = "processed_labels"
        if not rid or not label_col:
            return []
        expr = duckdb_csv_expr(info["files"])
        con = self.con()
        try:
            rows = con.execute(f"""
                SELECT DISTINCT CAST({qident(label_col)} AS VARCHAR)
                FROM {expr}
                WHERE CAST({qident(rid)} AS VARCHAR)=?
                  AND {qident(label_col)} IS NOT NULL
                LIMIT ?
            """, [root_id, limit]).fetchall()
            result = [r[0] for r in rows if r and r[0]]
            self._processed_label_cache[root_id] = result
            return result[:limit]
        except Exception:
            return []
        finally:
            con.close()

    def neuropil_profile(self, root_id: str, top=20):
        cached = self._neuropil_cache.get(root_id)
        if cached:
            return {**cached, "inputs": cached.get("inputs", [])[:top], "outputs": cached.get("outputs", [])[:top]}
        info = self.catalog.get("neuropil_synapses")
        if not info:
            return {"found": False, "inputs": [], "outputs": []}
        s = info.get("schema") or {}
        rid = s.get("id")
        if not rid:
            return {"found": False, "inputs": [], "outputs": []}
        expr = duckdb_csv_expr(info["files"])
        con = self.con()
        try:
            cur = con.execute(f"""
                SELECT * FROM {expr}
                WHERE CAST({qident(rid)} AS VARCHAR)=?
                LIMIT 1
            """, [root_id])
            row = cur.fetchone()
            if not row:
                return {"found": False, "inputs": [], "outputs": []}
            cols = [d[0] for d in cur.description]
            inputs, outputs = [], []
            totals = {}
            for col, value in zip(cols, row):
                if value is None:
                    continue
                nc = str(col).strip()
                l = nc.lower()
                try:
                    val = float(value)
                except Exception:
                    continue
                if l == "input synapses":
                    totals["input_synapses"] = val
                elif l == "output synapses":
                    totals["output_synapses"] = val
                elif l == "input partners":
                    totals["input_partners"] = val
                elif l == "output partners":
                    totals["output_partners"] = val
                elif l.startswith("input synapses in ") and val > 0:
                    inputs.append({"neuropil": nc[len("input synapses in "):], "value": val})
                elif l.startswith("output synapses in ") and val > 0:
                    outputs.append({"neuropil": nc[len("output synapses in "):], "value": val})
            inputs.sort(key=lambda x: x["value"], reverse=True)
            outputs.sort(key=lambda x: x["value"], reverse=True)
            result = {
                "found": True,
                "totals": totals,
                "inputs": inputs,
                "outputs": outputs
            }
            self._neuropil_cache[root_id] = result
            return {**result, "inputs": inputs[:max(1, int(top))], "outputs": outputs[:max(1, int(top))]}
        except Exception as e:
            return {"found": False, "inputs": [], "outputs": [], "error": str(e)}
        finally:
            con.close()

    def neuron_connection_stats(self, root_id: str, source: str):
        table = "c_" + source
        con = self.con()
        try:
            if not self._table_exists(con, table):
                return {}
            r = con.execute(f"""
                SELECT
                    (SELECT COUNT(*) FROM {qident(table)} WHERE post_id=?) AS in_partners,
                    (SELECT COALESCE(SUM(syn_count),0) FROM {qident(table)} WHERE post_id=?) AS in_synapses,
                    (SELECT COUNT(*) FROM {qident(table)} WHERE pre_id=?) AS out_partners,
                    (SELECT COALESCE(SUM(syn_count),0) FROM {qident(table)} WHERE pre_id=?) AS out_synapses
            """, [root_id, root_id, root_id, root_id]).fetchone()
            return {
                "input_partners": int(r[0] or 0),
                "input_synapses": float(r[1] or 0),
                "output_partners": int(r[2] or 0),
                "output_synapses": float(r[3] or 0)
            }
        finally:
            con.close()

    def neurotransmitter_profile(self, root_id: str, source: str):
        table="c_"+source
        con=self.con()
        try:
            if not self._table_exists(con,table):
                return {}
            rows=con.execute(f"""
                SELECT COALESCE(nt_type,'unknown'), SUM(syn_count)
                FROM {qident(table)}
                WHERE pre_id=?
                GROUP BY 1 ORDER BY 2 DESC
            """,[root_id]).fetchall()
            return {str(k):float(v or 0) for k,v in rows}
        finally:
            con.close()

    def neuron_full(self, root_id: str, source: Optional[str] = None):
        if not source:
            sources=self.available_sources()
            source=sources[0] if sources else ""
        basic=self.neuron_info(root_id)
        basic["source"]=source
        basic["connection_stats"]=self.neuron_connection_stats(root_id,source) if source else {}
        basic["processed_labels"]=self._processed_labels_raw(root_id)
        basic["neuropils"]=self.neuropil_profile(root_id,top=16)
        basic["nt_profile"]=self.neurotransmitter_profile(root_id,source) if source else {}
        basic["explanation_fa"]=explain_neuron_fa(
            root_id,
            labels=basic.get("labels",[]),
            processed=basic.get("processed_labels",[]),
            tags=basic.get("tags",[]),
            neuropils=basic.get("neuropils",{}),
            stats=basic.get("connection_stats",{}),
            nt_profile=basic.get("nt_profile",{})
        )
        return basic

    def neighbors_page(self, root_id: str, source: str, direction="in",
                       limit=100, offset=0, min_syn=0):
        table = "c_" + source
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        min_syn = max(0.0, float(min_syn))
        direction = "out" if direction == "out" else "in"

        con = self.con()
        try:
            if not self._table_exists(con, table):
                raise ValueError(f"Unknown connection source: {source}")
            if direction == "in":
                condition = "post_id=? AND syn_count>=?"
                partner_col = "pre_id"
            else:
                condition = "pre_id=? AND syn_count>=?"
                partner_col = "post_id"
            total = con.execute(
                f"SELECT COUNT(*) FROM {qident(table)} WHERE {condition}",
                [root_id, min_syn]
            ).fetchone()[0]
            rows = con.execute(f"""
                SELECT {partner_col}, syn_count, nt_type
                FROM {qident(table)}
                WHERE {condition}
                ORDER BY syn_count DESC
                LIMIT ? OFFSET ?
            """, [root_id, min_syn, limit, offset]).fetchall()
            labels = self._label_map([r[0] for r in rows], con)
            items = [{
                "partner_id": str(r[0]),
                "syn_count": float(r[1] or 0),
                "nt_type": r[2],
                "label": labels.get(str(r[0]), "")
            } for r in rows]
            return {
                "root_id": root_id, "source": source, "direction": direction,
                "total": int(total), "limit": limit, "offset": offset,
                "items": items
            }
        finally:
            con.close()

    def edge_detail(self, pre_id: str, post_id: str, source: str):
        table = "c_" + source
        con = self.con()
        try:
            if not self._table_exists(con, table):
                raise ValueError(f"Unknown connection source: {source}")
            row = con.execute(f"""
                SELECT syn_count, nt_type
                FROM {qident(table)}
                WHERE pre_id=? AND post_id=?
                LIMIT 1
            """, [pre_id, post_id]).fetchone()
            reverse = con.execute(f"""
                SELECT syn_count, nt_type
                FROM {qident(table)}
                WHERE pre_id=? AND post_id=?
                LIMIT 1
            """, [post_id, pre_id]).fetchone()
            labels = self._label_map([pre_id, post_id], con)
            return {
                "found": bool(row),
                "source_id": pre_id, "target_id": post_id,
                "source_label": labels.get(pre_id, ""),
                "target_label": labels.get(post_id, ""),
                "syn_count": float(row[0]) if row else 0,
                "nt_type": row[1] if row else None,
                "reciprocal": bool(reverse),
                "reverse_syn_count": float(reverse[0]) if reverse else 0,
                "reverse_nt_type": reverse[1] if reverse else None,
                "connection_source": source
            }
        finally:
            con.close()

    def path_search(self, source_id: str, target_id: str, source: str,
                    max_depth=5, branch=10, beam=80, min_syn=1):
        """
        Beam-limited directed path search over the real structural graph.
        It prefers higher-synapse routes at the first depth where a path exists.
        This is not a proof that the route is functionally active in vivo.
        """
        max_depth = max(1, min(int(max_depth), 8))
        branch = max(1, min(int(branch), 30))
        beam = max(10, min(int(beam), 300))
        min_syn = max(0.0, float(min_syn))
        table = "c_" + source

        if source_id == target_id:
            return {"found": True, "nodes": [source_id], "edges": [], "depth": 0, "score": 0}

        con = self.con()
        try:
            if not self._table_exists(con, table):
                raise ValueError(f"Unknown connection source: {source}")

            frontier = {
                source_id: {"score": 0.0, "nodes": [source_id], "edges": []}
            }
            best_score = {source_id: 0.0}
            expanded = 0

            for depth in range(1, max_depth + 1):
                ids = list(frontier.keys())
                if not ids:
                    break
                ph = ",".join(["?"] * len(ids))
                rows = con.execute(f"""
                    SELECT pre_id, post_id, syn_count, nt_type
                    FROM (
                        SELECT pre_id, post_id, syn_count, nt_type,
                               row_number() OVER(
                                   PARTITION BY pre_id ORDER BY syn_count DESC
                               ) AS rn
                        FROM {qident(table)}
                        WHERE pre_id IN ({ph}) AND syn_count>=?
                    )
                    WHERE rn<=?
                """, ids + [min_syn, branch]).fetchall()

                expanded += len(rows)
                next_frontier = {}
                found_candidates = []

                for pre, post, weight, nt in rows:
                    pre, post = str(pre), str(post)
                    parent = frontier.get(pre)
                    if not parent:
                        continue
                    if post in parent["nodes"]:
                        continue
                    w = float(weight or 0)
                    score = parent["score"] + math.log1p(max(0.0, w))
                    edge = {"source": pre, "target": post, "weight": w, "nt_type": nt}
                    rec = {
                        "score": score,
                        "nodes": parent["nodes"] + [post],
                        "edges": parent["edges"] + [edge]
                    }
                    if post == target_id:
                        found_candidates.append(rec)
                        continue
                    if score <= best_score.get(post, -1e100):
                        continue
                    best_score[post] = score
                    old = next_frontier.get(post)
                    if not old or score > old["score"]:
                        next_frontier[post] = rec

                if found_candidates:
                    best = max(found_candidates, key=lambda x: x["score"])
                    labels = self._label_map(best["nodes"], con)
                    return {
                        "found": True,
                        "nodes": [{"id": n, "label": labels.get(n, "")} for n in best["nodes"]],
                        "edges": best["edges"], "depth": depth,
                        "score": best["score"], "expanded_edges": expanded,
                        "source": source
                    }

                ranked = sorted(next_frontier.items(),
                                key=lambda kv: kv[1]["score"], reverse=True)[:beam]
                frontier = dict(ranked)

            return {
                "found": False, "nodes": [], "edges": [],
                "depth": max_depth, "expanded_edges": expanded, "source": source
            }
        finally:
            con.close()

    def candidate_neurons(self, kind: str, limit=40):
        kind = (kind or "").lower()
        groups = {
            "visual": ["visual", "photoreceptor", "optic", "lobula", "medulla", "lamina"],
            "odor": ["olfactory", "orn", "antennal", "projection neuron"],
            "touch": ["mechanosensory", "touch", "bristle", "chordotonal"],
            "reward": ["dopamin", "reward", "dan", "pam", "ppl"],
            "motor": ["motor", "descending", "dng", "steering", "wing", "leg"],
            "memory": ["kenyon", "mushroom", "mbon", "kc", "memory"]
        }
        words = groups.get(kind, [kind] if kind else [])
        con = self.con()
        try:
            if not words or not self._table_exists(con, "neuron_labels"):
                return []
            clauses, params = [], []
            for w in words:
                clauses.append("(lower(label) LIKE ? OR lower(details) LIKE ?)")
                params += [f"%{w}%", f"%{w}%"]
            params.append(max(1, min(int(limit), 200)))
            rows = con.execute(f"""
                SELECT root_id, any_value(label), any_value(details)
                FROM neuron_labels
                WHERE {" OR ".join(clauses)}
                GROUP BY root_id
                LIMIT ?
            """, params).fetchall()
            return [{"root_id": str(r[0]), "label": r[1] or "", "details": r[2] or ""} for r in rows]
        finally:
            con.close()

# ---------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------

def create_app(ds: FlyDataset):
    app=Flask(__name__, template_folder="templates", static_folder="static")
    app.config["TEMPLATES_AUTO_RELOAD"] = True

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/api/status")
    def api_status():
        s=ds.status()
        s["sources"]=ds.available_sources()
        return jsonify(s)

    @app.get("/api/search")
    def api_search():
        return jsonify({"results":ds.search(request.args.get("q",""), int(request.args.get("limit",50)))})

    @app.get("/api/neuron/<root_id>")
    def api_neuron(root_id):
        return jsonify(ds.neuron_info(root_id))

    @app.get("/api/graph/<root_id>")
    def api_graph(root_id):
        source=request.args.get("source") or (ds.available_sources()[0] if ds.available_sources() else "")
        if not source:
            return jsonify({"error":"No prepared connection source"}),400
        try:
            g=ds.graph(
                root_id,source,
                topk=int(request.args.get("topk",50)),
                depth=int(request.args.get("depth",1)),
                min_syn=float(request.args.get("min_syn",1)),
                max_nodes=int(request.args.get("max_nodes",1500))
            )
            return jsonify(g)
        except Exception as e:
            return jsonify({"error":str(e)}),500

    @app.get("/api/skeleton/<root_id>")
    def api_skeleton(root_id):
        return jsonify(ds.skeleton(root_id,int(request.args.get("max_segments",80000))))

    @app.get("/api/synapses")
    def api_synapses():
        pre=request.args.get("pre",""); post=request.args.get("post","")
        if not pre or not post:
            return jsonify({"error":"pre and post are required"}),400
        try:
            return jsonify(ds.synapse_points(pre,post,int(request.args.get("limit",5000))))
        except Exception as e:
            return jsonify({"error":str(e)}),500

    @app.get("/api/catalog")
    def api_catalog():
        return jsonify(ds.catalog)

    @app.get("/api/health")
    def api_health():
        con = ds.con()
        try:
            tables = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables").fetchall()}
            sources = ds.available_sources()
            counts = {}
            for source in sources:
                table = "c_" + source
                try:
                    counts[source] = con.execute(f"SELECT COUNT(*) FROM {qident(table)}").fetchone()[0]
                except Exception:
                    counts[source] = None
            label_count = None
            if "neuron_labels" in tables:
                try: label_count = con.execute("SELECT COUNT(*) FROM neuron_labels").fetchone()[0]
                except Exception: pass
            tag_count = None
            if "neuron_tags" in tables:
                try: tag_count = con.execute("SELECT COUNT(*) FROM neuron_tags").fetchone()[0]
                except Exception: pass
            swc_count = None
            try:
                ds._ensure_swc_index(); swc_count = len(ds._swc_index)
            except Exception:
                pass
            return jsonify({
                "ok": True, "version": APP_VERSION, "sources": sources,
                "edge_rows": counts, "labels": label_count, "tags": tag_count,
                "swc_index_entries": swc_count, "data_root": str(ds.data_root)
            })
        finally:
            con.close()

    @app.get("/api/sample")
    def api_sample():
        source = request.args.get("source") or (ds.available_sources()[0] if ds.available_sources() else "")
        con = ds.con()
        try:
            # Prefer an annotated neuron.
            if ds._table_exists(con, "neuron_labels"):
                row = con.execute("""
                    SELECT root_id, label FROM neuron_labels
                    WHERE root_id IS NOT NULL AND root_id<>''
                    ORDER BY CASE WHEN label IS NULL OR label='' THEN 1 ELSE 0 END
                    LIMIT 1
                """).fetchone()
                if row:
                    return jsonify({"root_id": str(row[0]), "label": row[1] or "", "source": "labels"})
            if source:
                table = "c_" + source
                row = con.execute(f"SELECT pre_id FROM {qident(table)} LIMIT 1").fetchone()
                if row:
                    return jsonify({"root_id": str(row[0]), "label": "", "source": source})
            return jsonify({"error":"No sample neuron found"}), 404
        finally:
            con.close()


    @app.get("/api/neuron-full/<root_id>")
    def api_neuron_full(root_id):
        source = request.args.get("source") or (ds.available_sources()[0] if ds.available_sources() else "")
        try:
            return jsonify(ds.neuron_full(root_id, source))
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/connections/<root_id>")
    def api_connections(root_id):
        source = request.args.get("source") or (ds.available_sources()[0] if ds.available_sources() else "")
        try:
            return jsonify(ds.neighbors_page(
                root_id, source,
                direction=request.args.get("direction", "in"),
                limit=int(request.args.get("limit", 100)),
                offset=int(request.args.get("offset", 0)),
                min_syn=float(request.args.get("min_syn", 0))
            ))
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/edge-detail")
    def api_edge_detail():
        pre = request.args.get("pre", "")
        post = request.args.get("post", "")
        source = request.args.get("source") or (ds.available_sources()[0] if ds.available_sources() else "")
        if not pre or not post:
            return jsonify({"error": "pre and post are required"}), 400
        try:
            return jsonify(ds.edge_detail(pre, post, source))
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/path")
    def api_path():
        a = request.args.get("from", "")
        b = request.args.get("to", "")
        source = request.args.get("source") or (ds.available_sources()[0] if ds.available_sources() else "")
        if not a or not b:
            return jsonify({"error": "from and to are required"}), 400
        try:
            return jsonify(ds.path_search(
                a, b, source,
                max_depth=int(request.args.get("max_depth", 5)),
                branch=int(request.args.get("branch", 10)),
                beam=int(request.args.get("beam", 80)),
                min_syn=float(request.args.get("min_syn", 1))
            ))
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/candidates")
    def api_candidates():
        try:
            return jsonify({"results": ds.candidate_neurons(
                request.args.get("kind", ""),
                int(request.args.get("limit", 40))
            )})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.get("/api/neuropils/<root_id>")
    def api_neuropils(root_id):
        try:
            return jsonify(ds.neuropil_profile(root_id, int(request.args.get("top", 20))))
        except Exception as e:
            return jsonify({"error": str(e)}), 500


    @app.get("/api/atlas/status")
    def api_atlas_status():
        st=ds.atlas.status()
        sk=ds.catalog.get("skeletons")
        st["swc_dir"]=sk.get("path") if sk else None
        return jsonify(st)

    @app.post("/api/atlas/build")
    def api_atlas_build():
        sk=ds.catalog.get("skeletons")
        if not sk:
            return jsonify({"error":"SWC directory not discovered"}),400
        body=request.get_json(silent=True) or {}
        max_segments=max(8,min(int(body.get("max_segments",64)),256))
        force=bool(body.get("force",False))
        workers=max(1,min(int(body.get("workers",4)),16))
        started=ds.atlas.start_build(Path(sk["path"]),max_segments=max_segments,force=force,workers=workers)
        return jsonify({"started":started,"status":ds.atlas.status()})

    @app.get("/api/atlas/batch")
    def api_atlas_batch():
        try:
            return jsonify(ds.atlas.batch(
                offset=int(request.args.get("offset",0)),
                limit=int(request.args.get("limit",200))
            ))
        except Exception as e:
            return jsonify({"error":str(e)}),500

    @app.post("/api/atlas/selection")
    def api_atlas_selection():
        body=request.get_json(silent=True) or {}
        ids=[str(x) for x in body.get("ids",[])]
        try:
            return jsonify(ds.atlas.selection(ids,limit=int(body.get("limit",300))))
        except Exception as e:
            return jsonify({"error":str(e)}),500

    return app

def main():
    ap=argparse.ArgumentParser()
    sub=ap.add_subparsers(dest="cmd",required=True)

    p=sub.add_parser("prepare")
    p.add_argument("--data",required=True,type=Path)
    p.add_argument("--force",action="store_true")

    r=sub.add_parser("run")
    r.add_argument("--data",required=True,type=Path)
    r.add_argument("--host",default="127.0.0.1")
    r.add_argument("--port",type=int,default=8090)
    r.add_argument("--no-prepare",action="store_true")
    r.add_argument("--force",action="store_true")

    i=sub.add_parser("inspect")
    i.add_argument("--data",required=True,type=Path)

    a=sub.add_parser("atlas")
    a.add_argument("--data",required=True,type=Path)
    a.add_argument("--max-segments",type=int,default=64)
    a.add_argument("--workers",type=int,default=4,help="parallel SWC readers; 2-4 for HDD, 4-8 for SSD")
    a.add_argument("--force",action="store_true")

    args=ap.parse_args()
    ds=FlyDataset(args.data)

    if args.cmd=="inspect":
        print(json.dumps(ds.status(),ensure_ascii=False,indent=2))
        return

    if args.cmd=="atlas":
        sk=ds.catalog.get("skeletons")
        if not sk:
            raise SystemExit("SWC directory not found in dataset.")
        print("Building full-brain SWC LOD atlas...", flush=True)
        print("Tip: this is resumable. Ctrl+C is safe; run the same command again to continue.", flush=True)
        ds.atlas.build(Path(sk["path"]),max_segments=args.max_segments,force=args.force,workers=args.workers,verbose=True)
        print(json.dumps(ds.atlas.status(),ensure_ascii=False,indent=2))
        return

    if args.cmd=="prepare":
        ds.prepare(force=args.force,verbose=True)
        return

    if args.cmd=="run":
        if not args.no_prepare:
            print("Preparing/validating local index...")
            ds.prepare(force=args.force,verbose=True)
        app=create_app(ds)
        url=f"http://{args.host}:{args.port}"
        print(f"\nNeuroWing Atlas: {url}\n")
        if args.host in ("127.0.0.1","localhost"):
            threading.Timer(1.25, lambda: webbrowser.open(url)).start()
        app.run(host=args.host,port=args.port,debug=False,threaded=True)

if __name__=="__main__":
    main()
