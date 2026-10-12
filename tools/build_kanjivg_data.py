#!/usr/bin/env python3
"""
Build Inkstone Japanese stroke data from KanjiVG SVG files.

The converter is intentionally dependency-free: it uses only Python's standard
library. KanjiVG currently describes strokes with SVG M/m, C/c, and S/s path
commands. Each stroke is sampled and resampled into normalized top-left
coordinates for handwriting recognition while the original SVG path is retained
for rendering.

Examples:
    python tools/build_kanjivg_data.py /path/to/kanjivg/kanji data
    python tools/build_kanjivg_data.py test/fixtures/kanjivg/04eca.svg /tmp/inkstone-kanji

The output is one browser-friendly kanji.json file containing the complete converted
KanjiVG corpus. Inkstone is offline-first, so the service worker can cache this single
asset during installation and the browser can use the whole character set offline.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
import xml.etree.ElementTree as ET

try:
    from .data_revision import bump_data_revision
except ImportError:  # direct script execution / importlib fixture loading
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from data_revision import bump_data_revision
from typing import Any, Iterable, Iterator, Sequence

SCHEMA_VERSION = 1
KANJIVG_SOURCE = {
    "name": "KanjiVG",
    "url": "https://kanjivg.tagaini.net/",
    "license": "CC BY-SA 3.0",
    "licenseUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
}
KVG_FIELDS = (
    "element",
    "variant",
    "partial",
    "original",
    "part",
    "tradForm",
    "radicalForm",
    "position",
    "radical",
    "phon",
)
NUMBER_RE = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
PATH_TOKEN_RE = re.compile(rf"{NUMBER_RE}|[A-Za-z]")


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def kvg_attr(element: ET.Element, name: str) -> str | None:
    for key, value in element.attrib.items():
        if key == f"kvg:{name}" or key.endswith("}" + name):
            return value
    return None


def parse_view_box(root: ET.Element) -> list[float]:
    raw = root.attrib.get("viewBox")
    if not raw:
        width = float(root.attrib.get("width", 109))
        height = float(root.attrib.get("height", 109))
        return [0.0, 0.0, width, height]
    parts = [float(x) for x in re.split(r"[\s,]+", raw.strip()) if x]
    if len(parts) != 4 or parts[2] <= 0 or parts[3] <= 0:
        raise ValueError(f"invalid SVG viewBox: {raw!r}")
    return parts


def parse_style(style: str | None) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in (style or "").split(";"):
        if ":" not in item:
            continue
        key, value = item.split(":", 1)
        result[key.strip()] = value.strip()
    return result


def group_metadata(group: ET.Element) -> dict[str, str]:
    result: dict[str, str] = {}
    for field in KVG_FIELDS:
        value = kvg_attr(group, field)
        if value:
            result[field] = value
    return result


def _point(values: Sequence[float], relative: bool, current: Sequence[float]) -> list[float]:
    if relative:
        return [current[0] + values[0], current[1] + values[1]]
    return [values[0], values[1]]


def cubic_point(p0: Sequence[float], p1: Sequence[float], p2: Sequence[float], p3: Sequence[float], t: float) -> list[float]:
    u = 1.0 - t
    return [
        u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
        u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
    ]


def sample_svg_path(path_data: str, samples_per_curve: int = 12) -> list[list[float]]:
    """Sample a KanjiVG stroke path.

    KanjiVG documents its current corpus as using only M/m, C/c, and S/s.
    We reject other commands deliberately so a future upstream format change is
    visible during the build instead of silently producing incorrect medians.
    """
    tokens = PATH_TOKEN_RE.findall(path_data)
    if not tokens:
        raise ValueError("empty SVG path")

    points: list[list[float]] = []
    current = [0.0, 0.0]
    last_control: list[float] | None = None
    command: str | None = None
    i = 0

    def take(count: int) -> list[float]:
        nonlocal i
        if i + count > len(tokens):
            raise ValueError(f"incomplete SVG path near token {i}: {path_data!r}")
        values = [float(x) for x in tokens[i:i + count]]
        i += count
        return values

    while i < len(tokens):
        token = tokens[i]
        if len(token) == 1 and token.isalpha():
            command = token
            i += 1
        elif command is None:
            raise ValueError(f"SVG path is missing an initial command: {path_data!r}")

        if command not in {"M", "m", "C", "c", "S", "s"}:
            raise ValueError(f"unsupported KanjiVG SVG path command {command!r}")

        relative = command.islower()
        upper = command.upper()

        if upper == "M":
            values = take(2)
            current = _point(values, relative, current)
            points.append(current[:])
            last_control = None
            # A repeated moveto parameter pair would imply a line segment. KanjiVG
            # does not use that form, so require the next pair to have a command.
            if i < len(tokens) and not tokens[i].isalpha():
                raise ValueError("KanjiVG path contains implicit line coordinates after M/m")
            continue

        if upper == "C":
            values = take(6)
            c1 = _point(values[0:2], relative, current)
            c2 = _point(values[2:4], relative, current)
            end = _point(values[4:6], relative, current)
            start = current[:]
            for step in range(1, samples_per_curve + 1):
                points.append(cubic_point(start, c1, c2, end, step / samples_per_curve))
            current = end
            last_control = c2
            continue

        values = take(4)
        if last_control is None:
            c1 = current[:]
        else:
            c1 = [2 * current[0] - last_control[0], 2 * current[1] - last_control[1]]
        c2 = _point(values[0:2], relative, current)
        end = _point(values[2:4], relative, current)
        start = current[:]
        for step in range(1, samples_per_curve + 1):
            points.append(cubic_point(start, c1, c2, end, step / samples_per_curve))
        current = end
        last_control = c2

    if len(points) < 2:
        raise ValueError(f"stroke path has fewer than two sampled points: {path_data!r}")
    return points


def polyline_length(points: Sequence[Sequence[float]]) -> float:
    return sum(
        math.hypot(b[0] - a[0], b[1] - a[1])
        for a, b in zip(points, points[1:])
    )


def resample_polyline(points: Sequence[Sequence[float]], count: int) -> list[list[float]]:
    if count < 2:
        raise ValueError("median point count must be at least 2")
    if len(points) < 2:
        return [list(points[0])] * count if points else []

    lengths = [0.0]
    for a, b in zip(points, points[1:]):
        lengths.append(lengths[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = lengths[-1]
    if total <= 0:
        return [list(points[0])] * count

    result: list[list[float]] = []
    segment = 0
    for index in range(count):
        target = total * index / (count - 1)
        while segment + 1 < len(lengths) and lengths[segment + 1] < target:
            segment += 1
        if segment + 1 >= len(points):
            result.append(list(points[-1]))
            continue
        start_len = lengths[segment]
        end_len = lengths[segment + 1]
        span = end_len - start_len
        t = 0.0 if span <= 0 else (target - start_len) / span
        a, b = points[segment], points[segment + 1]
        result.append([
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
        ])
    return result


def normalize_points(points: Sequence[Sequence[float]], view_box: Sequence[float], precision: int = 6) -> list[list[float]]:
    min_x, min_y, width, height = view_box
    return [
        [
            round((point[0] - min_x) / width, precision),
            round((point[1] - min_y) / height, precision),
        ]
        for point in points
    ]


def find_stroke_paths_group(root: ET.Element) -> ET.Element:
    for node in root.iter():
        if local_name(node.tag) != "g":
            continue
        if node.attrib.get("id", "").startswith("kvg:StrokePaths_"):
            return node
    raise ValueError("KanjiVG SVG has no StrokePaths group")


def iter_strokes(node: ET.Element, ancestors: tuple[dict[str, str], ...] = ()) -> Iterator[tuple[ET.Element, tuple[dict[str, str], ...]]]:
    for child in node:
        name = local_name(child.tag)
        if name == "g":
            metadata = group_metadata(child)
            next_ancestors = ancestors + ((metadata,) if metadata else ())
            yield from iter_strokes(child, next_ancestors)
        elif name == "path":
            yield child, ancestors


def source_character(stroke_paths: ET.Element, source_id: str) -> str:
    for child in stroke_paths:
        if local_name(child.tag) != "g":
            continue
        element = kvg_attr(child, "element")
        if element:
            return element
    codepoint = source_id.split("-", 1)[0]
    try:
        return chr(int(codepoint, 16))
    except ValueError as exc:
        raise ValueError(f"cannot infer character from KanjiVG id {source_id!r}") from exc


def parse_kanjivg_svg(path: Path, median_points: int = 24, samples_per_curve: int = 12) -> dict[str, Any]:
    root = ET.parse(path).getroot()
    view_box = parse_view_box(root)
    stroke_paths = find_stroke_paths_group(root)
    source_id = stroke_paths.attrib.get("id", "").removeprefix("kvg:StrokePaths_") or path.stem
    character = source_character(stroke_paths, source_id)
    style = parse_style(stroke_paths.attrib.get("style"))

    strokes: list[dict[str, Any]] = []
    for stroke, ancestors in iter_strokes(stroke_paths):
        path_data = stroke.attrib.get("d")
        if not path_data:
            continue
        sampled = sample_svg_path(path_data, samples_per_curve=samples_per_curve)
        median = resample_polyline(sampled, median_points)
        row: dict[str, Any] = {
            "id": stroke.attrib.get("id") or f"{source_id}-s{len(strokes) + 1}",
            "path": path_data,
            "median": normalize_points(median, view_box),
        }
        stroke_type = kvg_attr(stroke, "type")
        if stroke_type:
            row["type"] = stroke_type
        if ancestors:
            row["components"] = [dict(item) for item in ancestors]
        strokes.append(row)

    if not strokes:
        raise ValueError(f"{path}: no stroke paths found")

    result: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "source": "KanjiVG",
        "sourceId": source_id,
        "character": character,
        "viewBox": [round(x, 6) for x in view_box],
        "coordinateSystem": "normalized-top-left",
        "strokeFormat": "svg-centerline",
        "strokes": strokes,
    }
    if "stroke-width" in style:
        try:
            result["strokeWidth"] = float(style["stroke-width"])
        except ValueError:
            pass
    if style.get("stroke-linecap"):
        result["strokeLinecap"] = style["stroke-linecap"]
    if style.get("stroke-linejoin"):
        result["strokeLinejoin"] = style["stroke-linejoin"]
    return result


def iter_svg_files(input_path: Path) -> Iterable[Path]:
    if input_path.is_file():
        if input_path.suffix.lower() != ".svg":
            raise SystemExit(f"Input file must be SVG: {input_path}")
        yield input_path
        return
    if not input_path.is_dir():
        raise SystemExit(f"Input path does not exist: {input_path}")
    for path in sorted(input_path.glob("*.svg")):
        # Variant SVGs (e.g. -Kaisho / alternate stroke order forms) are
        # intentionally out of scope for the first Japanese-port data model.
        if "-" in path.stem:
            continue
        yield path


def write_dataset(records: Sequence[dict[str, Any]], output_dir: Path, pretty: bool = False) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    characters: dict[str, dict[str, Any]] = {}

    for record in records:
        character = record["character"]
        if character in characters:
            raise ValueError(
                f"multiple KanjiVG records map to {character!r}; build non-variant data or handle variants explicitly"
            )
        characters[character] = record

    dataset = {
        "schemaVersion": SCHEMA_VERSION,
        "source": KANJIVG_SOURCE,
        "characters": characters,
    }
    destination = output_dir / "kanji.json"
    with destination.open("w", encoding="utf-8") as handle:
        json.dump(
            dataset,
            handle,
            ensure_ascii=False,
            indent=2 if pretty else None,
            separators=None if pretty else (",", ":"),
            sort_keys=pretty,
        )
        handle.write("\n")
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="KanjiVG kanji directory or one SVG file")
    parser.add_argument("output", type=Path, help="output directory, e.g. data")
    parser.add_argument("--median-points", type=int, default=24, help="normalized recognition points per stroke (default: 24)")
    parser.add_argument("--samples-per-curve", type=int, default=12, help="temporary cubic samples before arc-length resampling (default: 12)")
    parser.add_argument("--pretty", action="store_true", help="pretty-print generated JSON")
    args = parser.parse_args()

    if args.median_points < 2:
        parser.error("--median-points must be at least 2")
    if args.samples_per_curve < 2:
        parser.error("--samples-per-curve must be at least 2")

    files = list(iter_svg_files(args.input))
    if not files:
        raise SystemExit(f"No KanjiVG SVG files found in {args.input}")

    records = []
    for path in files:
        try:
            records.append(
                parse_kanjivg_svg(
                    path,
                    median_points=args.median_points,
                    samples_per_curve=args.samples_per_curve,
                )
            )
        except Exception as exc:
            raise SystemExit(f"Failed to convert {path}: {exc}") from exc

    destination = write_dataset(records, args.output, pretty=args.pretty)
    print(f"Wrote {len(records)} KanjiVG character(s) to {destination}")
    revision = bump_data_revision()
    print(f"Updated offline data cache revision to {revision}.")


if __name__ == "__main__":
    main()
