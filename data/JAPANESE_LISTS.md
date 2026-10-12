# Japanese built-in word lists

Inkstone Japanese builds its bundled vocabulary lists from the same JMdict data
used by Browse, so a spelling/reading pair has one stable `jmdict:<id>` study
identity across built-in lists and Personal vocabulary.

## JLPT N5–N1

JLPT vocabulary classifications are sourced from
[`stephenmk/yomitan-jlpt-vocab`](https://github.com/stephenmk/yomitan-jlpt-vocab),
which in turn attributes the lists to Jonathan Waller's JLPT Resources.
The redistribution project is CC BY-SA 4.0 and identifies Waller's underlying
list data as CC BY.

These are **community estimates, not official JLPT vocabulary lists**. The JLPT
no longer publishes a definitive vocabulary specification for the modern N5–N1
levels.

The build script matches each source row back to the local JMdict build using
the current exact written-form + kana-reading pair first. The source JMdict
sequence is treated as a disambiguation hint because JMdict entries can be
split or reorganized after the JLPT source was published. If the exact pair no
longer exists, the builder may conservatively use a same-reading spelling from
the still-valid source sequence. Definitions are taken from JMdict rather than
from the JLPT source CSV.

## Common Japanese

`Common Japanese` is a convenience subset derived from JMdict priority/common
markers. It keeps one representative spelling/reading pair per JMdict sequence
and sorts by the available JMdict priority evidence. It is not an official or
precise corpus-frequency ranking.

The default build limit is 10,000 entries and can be changed with
`--common-limit`.

## Build

After generating the sharded `data/jmdict/` dictionary, run:

```bash
python tools/build_japanese_lists.py
```

By default the script downloads and caches `n5.csv` through `n1.csv` from the
JLPT redistribution repository. To use files you downloaded yourself:

```bash
python tools/build_japanese_lists.py \
  --jlpt-dir /path/to/yomitan-jlpt-vocab/original_data
```

It writes:

- `data/lists/jlpt-n5.tsv` ... `data/lists/jlpt-n1.tsv`
- `data/lists/common-japanese.tsv`
- `data/lists/jlpt-unresolved.tsv` (diagnostic rows that were skipped)
- `data/lists.json`
- `data/lists/SOURCES.json`

`jlpt-unresolved.tsv` records the JLPT level, JMdict sequence, source spelling,
reading, source definition, and the reason the current JMdict build could not
resolve the row. Unresolved rows remain excluded rather than being guessed.

The generated TSV format is:

```text
jmdict:<entry-id>    written form    kana reading    definition
```
