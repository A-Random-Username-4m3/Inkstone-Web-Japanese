# Japanese dictionary data

Inkstone's Japanese dictionary data is built from the Electronic Dictionary
Research and Development Group (EDRDG) projects:

- **JMdict** for vocabulary spellings, kana readings, and English definitions.
- **KANJIDIC2** for individual-kanji readings, meanings, school grade,
  frequency, radical, and reference stroke-count metadata.

The generated data is derived from EDRDG material and must retain the
applicable attribution/share-alike terms. See:

- https://www.edrdg.org/edrdg/licence.html
- https://www.edrdg.org/jmdict/j_jmdict.html
- https://www.edrdg.org/wiki/index.php/KANJIDIC_Project

## Source files

Use the English JMdict distribution (`JMdict_e` or `JMdict_e.gz`) and
`kanjidic2.xml` or `kanjidic2.xml.gz` from the EDRDG Nihongo archive:

https://ftp.edrdg.org/pub/Nihongo/

JMdict's 2026 "New Generation" files are being distributed in parallel with
the legacy files. Inkstone currently targets the long-standing JMdict entry
structure used by `JMdict_e`; the fields consumed by the builder are limited
to spellings, readings, restrictions, priority markers, senses, and English
glosses.

## Build

After `data/kanji.json` has been generated from KanjiVG, run:

```bash
python tools/build_japanese_dictionary.py \
  --jmdict /path/to/JMdict_e.gz \
  --kanjidic /path/to/kanjidic2.xml.gz
```

This writes:

- `data/jmdict/manifest.json` — runtime shard manifest.
- `data/jmdict/entries-*.json` — compact vocabulary records partitioned by JMdict sequence.
- `data/jmdict/lookup-*.json` — exact spelling/reading indexes partitioned by lookup text.
- additional `dictionary` metadata inside each matching character in
  `data/kanji.json`.

No third-party Python packages are required. The default build uses 32 shards.
All shards are pre-cached by the service worker for offline use, while Browse
parses only the lookup and entry shards required by the current query.

The old monolithic `data/jmdict.json` is no longer used by the web runtime. If
one remains from an earlier build, it can be deleted after the sharded build
and list generation have been verified.

The generated JMdict record identity is a stable combination of the JMdict
sequence number and spelling/reading pair. Kana-only vocabulary uses the kana
reading as its written form.

KANJIDIC2's `jlpt` value, when present, is deliberately stored as
`legacyJlpt`: it refers to the pre-2010 four-level JLPT classification and
must not be presented as modern N5–N1 data.
