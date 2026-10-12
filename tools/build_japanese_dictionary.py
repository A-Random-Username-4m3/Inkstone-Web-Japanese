#!/usr/bin/env python3
"""Build compact Japanese dictionary data for Inkstone.

This script uses only Python's standard library. It can:

1. Convert the English JMdict XML distribution into a compact exact-lookup
   JSON file for Japanese vocabulary.
2. Enrich the existing KanjiVG ``data/kanji.json`` with Japanese readings,
   meanings, grade/frequency metadata, and radical information from
   KANJIDIC2.

Both plain XML and ``.gz`` inputs are accepted.
"""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
import sys
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET

try:
    from .data_revision import bump_data_revision
except ImportError:  # direct script execution / importlib fixture loading
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from data_revision import bump_data_revision


JMDICT_SCHEMA_VERSION = 2
JMDICT_RUNTIME_SCHEMA_VERSION = 3
DEFAULT_JMDICT_SHARD_COUNT = 32
KANJIDIC_SOURCE_NAME = "KANJIDIC2"
EDRDG_LICENSE_URL = "https://www.edrdg.org/edrdg/licence.html"
JMDICT_PROJECT_URL = "https://www.edrdg.org/jmdict/j_jmdict.html"
KANJIDIC_PROJECT_URL = "https://www.edrdg.org/wiki/index.php/KANJIDIC_Project"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"

# These are the priority tags JMdict/EDICT treats as the familiar (P) marker.
COMMON_PRIORITY_TAGS = {"news1", "ichi1", "spec1", "spec2", "gai1"}


def open_xml(path: Path):
    """Open an XML or XML.gz input as a binary stream."""
    if path.suffix.lower() == ".gz":
        return gzip.open(path, "rb")
    return path.open("rb")


def text_children(parent: ET.Element, tag: str) -> list[str]:
    values: list[str] = []
    for child in parent.findall(tag):
        value = (child.text or "").strip()
        if value:
            values.append(value)
    return values


def unique(values):
    seen = set()
    output = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def maybe_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None



def stable_jmdict_record_id(sequence: int, written: str, reading: str) -> str:
    written = unicodedata.normalize("NFKC", str(written).strip())
    reading = unicodedata.normalize("NFKC", str(reading).strip())
    if sequence <= 0 or not written or not reading:
        raise ValueError("JMdict identity requires sequence, written form, and reading")
    safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    return (
        f"{sequence}:"
        f"{urllib.parse.quote(written, safe=safe)}:"
        f"{urllib.parse.quote(reading, safe=safe)}"
    )

def english_glosses(sense: ET.Element) -> list[str]:
    output: list[str] = []
    for gloss in sense.findall("gloss"):
        language = gloss.attrib.get(XML_LANG) or gloss.attrib.get("lang")
        if language not in (None, "eng"):
            continue
        value = (gloss.text or "").strip()
        if value:
            output.append(value)
    return output


def sense_applies(sense: ET.Element, written: str, reading: str, kana_only: bool) -> bool:
    restricted_writings = set(text_children(sense, "stagk"))
    restricted_readings = set(text_children(sense, "stagr"))
    if restricted_readings and reading not in restricted_readings:
        return False
    if restricted_writings:
        if kana_only or written not in restricted_writings:
            return False
    return True


def parse_jmdict(path: Path) -> dict:
    """Parse JMdict_e into Inkstone's compact spelling+reading records."""
    entries: dict[str, dict] = {}
    lookup: dict[str, list[str]] = {}
    root_attrs: dict[str, str] = {}
    source_entries = 0

    with open_xml(path) as stream:
        context = ET.iterparse(stream, events=("start", "end"))
        for event, elem in context:
            if event == "start" and elem.tag == "JMdict" and not root_attrs:
                root_attrs = dict(elem.attrib)
                continue
            if event != "end" or elem.tag != "entry":
                continue

            source_entries += 1
            seq = maybe_int(elem.findtext("ent_seq"))
            if seq is None:
                elem.clear()
                continue

            writings = []
            for k_ele in elem.findall("k_ele"):
                text = (k_ele.findtext("keb") or "").strip()
                if not text:
                    continue
                writings.append({
                    "text": text,
                    "priority": unique(text_children(k_ele, "ke_pri")),
                })

            readings = []
            for r_ele in elem.findall("r_ele"):
                text = (r_ele.findtext("reb") or "").strip()
                if not text:
                    continue
                readings.append({
                    "text": text,
                    "noKanji": r_ele.find("re_nokanji") is not None,
                    "restrict": unique(text_children(r_ele, "re_restr")),
                    "priority": unique(text_children(r_ele, "re_pri")),
                })

            senses = elem.findall("sense")
            seen_pairs = set()

            for reading_data in readings:
                reading = reading_data["text"]
                if reading_data["noKanji"] or not writings:
                    pair_writings = [None]
                elif reading_data["restrict"]:
                    allowed = set(reading_data["restrict"])
                    pair_writings = [item for item in writings if item["text"] in allowed]
                else:
                    pair_writings = writings

                for writing_data in pair_writings:
                    kana_only = writing_data is None
                    written = reading if kana_only else writing_data["text"]
                    pair_key = (written, reading)
                    if pair_key in seen_pairs:
                        continue
                    seen_pairs.add(pair_key)

                    definitions = []
                    for sense in senses:
                        if sense_applies(sense, written, reading, kana_only):
                            definitions.extend(english_glosses(sense))
                    definitions = unique(definitions)
                    if not definitions:
                        continue

                    priorities = unique(
                        ([] if kana_only else writing_data["priority"])
                        + reading_data["priority"]
                    )
                    entry_id = stable_jmdict_record_id(seq, written, reading)
                    record = {
                        "id": entry_id,
                        "sequence": seq,
                        "written": written,
                        "reading": reading,
                        "definitions": definitions,
                    }
                    if priorities:
                        record["priority"] = priorities
                    if any(tag in COMMON_PRIORITY_TAGS for tag in priorities):
                        record["common"] = True

                    entries[entry_id] = record
                    for key in unique([written, reading]):
                        lookup.setdefault(key, []).append(entry_id)

            elem.clear()

    source = {
        "name": "JMdict",
        "edition": "English",
        "projectUrl": JMDICT_PROJECT_URL,
        "licenseUrl": EDRDG_LICENSE_URL,
        "inputFile": path.name,
    }
    if root_attrs.get("created"):
        source["created"] = root_attrs["created"]
    if root_attrs.get("version"):
        source["version"] = root_attrs["version"]

    return {
        "schemaVersion": JMDICT_SCHEMA_VERSION,
        "source": source,
        "entryCount": len(entries),
        "sourceEntryCount": source_entries,
        "entries": entries,
        "lookup": lookup,
    }



def jmdict_lookup_shard_index(text: str, shard_count: int) -> int:
    if shard_count <= 0:
        raise ValueError("shard_count must be positive")
    value = 0x811C9DC5
    for character in str(text):
        value ^= ord(character)
        value = (value * 0x01000193) & 0xFFFFFFFF
    return value % shard_count


def jmdict_entry_shard_index(entry_id: str, shard_count: int) -> int:
    if shard_count <= 0:
        raise ValueError("shard_count must be positive")
    try:
        sequence_text = str(entry_id).split(":", 1)[0]
        sequence = int(sequence_text)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid JMdict entry id: {entry_id}") from None
    if sequence <= 0 or str(entry_id).count(":") < 2:
        raise ValueError(f"Invalid JMdict entry id: {entry_id}")
    return sequence % shard_count


def load_previous_runtime_entries(output_dir: Path) -> tuple[dict[str, dict], dict[str, str]]:
    manifest_path = output_dir / "manifest.json"
    if not manifest_path.exists():
        return {}, {}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, {}
    # Schema 2 used positional IDs. Those can be migrated directly from the
    # spelling/reading stored in local state, so do not emit a huge alias map.
    if manifest.get("schemaVersion") != JMDICT_RUNTIME_SCHEMA_VERSION:
        return {}, {}
    entries: dict[str, dict] = {}
    for filename in manifest.get("entryShards") or []:
        try:
            shard = json.loads((output_dir / filename).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}, {}
        if shard.get("schemaVersion") != JMDICT_RUNTIME_SCHEMA_VERSION:
            return {}, {}
        entries.update(shard.get("entries") or {})
    aliases = manifest.get("idAliases")
    if not isinstance(aliases, dict):
        aliases = {}
    return entries, {
        str(old): str(new)
        for old, new in aliases.items()
        if old and new and old != new
    }


def build_jmdict_id_aliases(
    previous_entries: dict[str, dict],
    previous_aliases: dict[str, str],
    current_entries: dict[str, dict],
) -> dict[str, str]:
    by_pair: dict[tuple[str, str], list[dict]] = {}
    for record in current_entries.values():
        key = (
            unicodedata.normalize("NFKC", str(record.get("written") or "")),
            unicodedata.normalize("NFKC", str(record.get("reading") or "")),
        )
        if all(key):
            by_pair.setdefault(key, []).append(record)

    direct: dict[str, str] = {}
    for old_id, old in previous_entries.items():
        if old_id in current_entries:
            continue
        key = (
            unicodedata.normalize("NFKC", str(old.get("written") or "")),
            unicodedata.normalize("NFKC", str(old.get("reading") or "")),
        )
        candidates = by_pair.get(key, [])
        if len(candidates) == 1:
            direct[old_id] = candidates[0]["id"]
            continue
        old_sequence = maybe_int(old.get("sequence"))
        same_sequence = [
            record for record in candidates
            if maybe_int(record.get("sequence")) == old_sequence
        ]
        if len(same_sequence) == 1:
            direct[old_id] = same_sequence[0]["id"]

    aliases = dict(direct)
    for ancient_id, previous_id in previous_aliases.items():
        current_id = direct.get(previous_id, previous_id)
        if current_id in current_entries and ancient_id != current_id:
            aliases[ancient_id] = current_id
    return dict(sorted(aliases.items()))


def write_jmdict_shards(dataset: dict, output_dir: Path, shard_count: int = DEFAULT_JMDICT_SHARD_COUNT, pretty: bool = False) -> dict:
    """Write the compact JMdict dataset as offline-cached runtime shards."""
    if shard_count <= 0:
        raise ValueError("shard_count must be positive")
    previous_entries, previous_aliases = load_previous_runtime_entries(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    entry_buckets = [dict() for _ in range(shard_count)]
    lookup_buckets = [dict() for _ in range(shard_count)]
    for entry_id, record in dataset["entries"].items():
        entry_buckets[jmdict_entry_shard_index(entry_id, shard_count)][entry_id] = record
    for text, ids in dataset["lookup"].items():
        lookup_buckets[jmdict_lookup_shard_index(text, shard_count)][text] = ids

    entry_names = []
    lookup_names = []
    width = max(2, len(str(shard_count - 1)))
    for index in range(shard_count):
        entry_name = f"entries-{index:0{width}d}.json"
        lookup_name = f"lookup-{index:0{width}d}.json"
        entry_names.append(entry_name)
        lookup_names.append(lookup_name)
        write_json(output_dir / entry_name, {
            "schemaVersion": JMDICT_RUNTIME_SCHEMA_VERSION,
            "kind": "entries",
            "shard": index,
            "entries": entry_buckets[index],
        }, pretty=pretty)
        write_json(output_dir / lookup_name, {
            "schemaVersion": JMDICT_RUNTIME_SCHEMA_VERSION,
            "kind": "lookup",
            "shard": index,
            "lookup": lookup_buckets[index],
        }, pretty=pretty)

    expected = {"manifest.json", *entry_names, *lookup_names}
    for old in output_dir.glob("*.json"):
        if old.name not in expected:
            old.unlink()

    manifest = {
        "schemaVersion": JMDICT_RUNTIME_SCHEMA_VERSION,
        "source": dataset["source"],
        "entryCount": dataset["entryCount"],
        "sourceEntryCount": dataset["sourceEntryCount"],
        "shardCount": shard_count,
        "hashAlgorithm": "fnv1a-codepoint-v1",
        "entryShardRule": "sequence-modulo-v1",
        "entryShards": entry_names,
        "lookupShards": lookup_names,
    }
    aliases = build_jmdict_id_aliases(
        previous_entries, previous_aliases, dataset["entries"]
    )
    if aliases:
        manifest["idAliases"] = aliases
    write_json(output_dir / "manifest.json", manifest, pretty=pretty)
    return manifest

def parse_kanjidic2(path: Path) -> tuple[dict[str, dict], dict]:
    """Return Japanese kanji metadata keyed by literal plus source metadata."""
    records: dict[str, dict] = {}
    header: dict[str, str] = {}

    with open_xml(path) as stream:
        context = ET.iterparse(stream, events=("end",))
        for _, elem in context:
            if elem.tag == "header":
                for key in ("file_version", "database_version", "date_of_creation"):
                    value = (elem.findtext(key) or "").strip()
                    if value:
                        header[key] = value
                elem.clear()
                continue
            if elem.tag != "character":
                continue

            literal = (elem.findtext("literal") or "").strip()
            if not literal:
                elem.clear()
                continue

            misc = elem.find("misc")
            grade = maybe_int(misc.findtext("grade")) if misc is not None else None
            frequency = maybe_int(misc.findtext("freq")) if misc is not None else None
            legacy_jlpt = maybe_int(misc.findtext("jlpt")) if misc is not None else None
            stroke_counts = text_children(misc, "stroke_count") if misc is not None else []
            stroke_count = maybe_int(stroke_counts[0]) if stroke_counts else None

            classical_radical = None
            radical = elem.find("radical")
            if radical is not None:
                for rad_value in radical.findall("rad_value"):
                    if rad_value.attrib.get("rad_type") == "classical":
                        classical_radical = maybe_int((rad_value.text or "").strip())
                        break

            on_readings = []
            kun_readings = []
            meanings = []
            reading_meaning = elem.find("reading_meaning")
            if reading_meaning is not None:
                for rmgroup in reading_meaning.findall("rmgroup"):
                    for reading in rmgroup.findall("reading"):
                        value = (reading.text or "").strip()
                        if not value:
                            continue
                        reading_type = reading.attrib.get("r_type")
                        if reading_type == "ja_on":
                            on_readings.append(value)
                        elif reading_type == "ja_kun":
                            kun_readings.append(value)
                    for meaning in rmgroup.findall("meaning"):
                        language = meaning.attrib.get("m_lang")
                        if language not in (None, "en"):
                            continue
                        value = (meaning.text or "").strip()
                        if value:
                            meanings.append(value)

            record = {
                "on": unique(on_readings),
                "kun": unique(kun_readings),
                "meanings": unique(meanings),
            }
            nanori = unique(text_children(reading_meaning, "nanori")) if reading_meaning is not None else []
            if nanori:
                record["nameReadings"] = nanori
            if grade is not None:
                record["grade"] = grade
            if stroke_count is not None:
                record["strokeCount"] = stroke_count
            if frequency is not None:
                record["frequency"] = frequency
            if legacy_jlpt is not None:
                # KANJIDIC2's JLPT field is the pre-2010 four-level classification.
                record["legacyJlpt"] = legacy_jlpt
            if classical_radical is not None:
                record["classicalRadical"] = classical_radical

            records[literal] = record
            elem.clear()

    source = {
        "name": KANJIDIC_SOURCE_NAME,
        "projectUrl": KANJIDIC_PROJECT_URL,
        "licenseUrl": EDRDG_LICENSE_URL,
        "inputFile": path.name,
    }
    source.update(header)
    return records, source


def enrich_kanjivg(path: Path, dictionary: dict[str, dict], source: dict, pretty: bool = False) -> tuple[int, int]:
    """Add KANJIDIC2 metadata to matching records in data/kanji.json."""
    dataset = json.loads(path.read_text(encoding="utf-8"))
    if dataset.get("source", {}).get("name") != "KanjiVG":
        raise ValueError(f"{path} does not look like an Inkstone KanjiVG dataset")
    characters = dataset.get("characters")
    if not isinstance(characters, dict):
        raise ValueError(f"{path} has no characters object")

    matched = 0
    stroke_mismatches = 0
    for character, record in characters.items():
        metadata = dictionary.get(character)
        if metadata is None:
            record.pop("dictionary", None)
            continue
        record["dictionary"] = metadata
        matched += 1
        expected_strokes = metadata.get("strokeCount")
        actual_strokes = len(record.get("strokes", []))
        if expected_strokes is not None and actual_strokes != expected_strokes:
            stroke_mismatches += 1

    dataset["dictionarySource"] = source
    write_json(path, dataset, pretty=pretty)
    return matched, stroke_mismatches


def write_json(path: Path, payload: dict, pretty: bool = False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if pretty:
        text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    else:
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    path.write_text(text, encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build Inkstone Japanese dictionary data from official EDRDG XML files."
    )
    parser.add_argument("--jmdict", type=Path, help="Path to JMdict_e XML or JMdict_e.gz")
    parser.add_argument("--kanjidic", type=Path, help="Path to kanjidic2.xml or kanjidic2.xml.gz")
    parser.add_argument(
        "--jmdict-output",
        type=Path,
        default=Path("data/jmdict"),
        help="Output directory for sharded JMdict runtime data (default: data/jmdict)",
    )
    parser.add_argument(
        "--jmdict-shards",
        type=int,
        default=DEFAULT_JMDICT_SHARD_COUNT,
        help=f"Number of JMdict runtime shards (default: {DEFAULT_JMDICT_SHARD_COUNT})",
    )
    parser.add_argument(
        "--kanji",
        type=Path,
        default=Path("data/kanji.json"),
        help="KanjiVG JSON to enrich in place (default: data/kanji.json)",
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print generated JSON")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.jmdict is None and args.kanjidic is None:
        print("At least one of --jmdict or --kanjidic is required.", file=sys.stderr)
        return 2

    if args.jmdict is not None:
        dataset = parse_jmdict(args.jmdict)
        manifest = write_jmdict_shards(
            dataset,
            args.jmdict_output,
            shard_count=args.jmdict_shards,
            pretty=args.pretty,
        )
        print(
            f"Wrote {dataset['entryCount']} JMdict spelling/reading record(s) "
            f"across {manifest['shardCount']} runtime shard(s) in {args.jmdict_output}"
        )
        legacy = Path("data/jmdict.json")
        if args.jmdict_output == Path("data/jmdict") and legacy.exists():
            print(
                f"Note: legacy {legacy} is no longer used by the web app or list builder; "
                "you may delete it after confirming the sharded build."
            )

    if args.kanjidic is not None:
        dictionary, source = parse_kanjidic2(args.kanjidic)
        matched, mismatches = enrich_kanjivg(
            args.kanji,
            dictionary,
            source,
            pretty=args.pretty,
        )
        print(
            f"Added KANJIDIC2 metadata to {matched} KanjiVG character(s) in {args.kanji}"
        )
        if mismatches:
            print(
                f"Note: {mismatches} character(s) have a KANJIDIC2 stroke count "
                "that differs from the KanjiVG path count. KanjiVG remains "
                "authoritative for handwriting strokes."
            )

    revision = bump_data_revision()
    print(f"Updated offline data cache revision to {revision}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
