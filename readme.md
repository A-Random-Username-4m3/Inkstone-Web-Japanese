# Inkstone Japanese Web

This is a web application version of the [Inkstone project](https://github.com/skishore/inkstone), but for Japanese!

To be honest, I couldn't get the app to work on my phone so I couldn't even test it, so that's when I had the bright idea to port it to the web. 

We also added additional features, namely an FSRS scheduler algorithm.

Inkstone Web Version can work locally cached, and so you can learn Japanese on the go even when disconnected from the internet. Yes, **this works offline too!**

Currently, this project is in Alpha, **PLEASE EXPECT SAVES TO POSSIBLY BECOME BROKEN IN FUTURE/DIFFERENT VERSIONS**. Backwards compatibility is __not to be expected__ until the application is stable.

We hope that you have fun learning Japanese vocabulary with our program!

## Try it out yourself

```bash
python -m http.server 8080
```

Then open `http://localhost:8080/`.

## Stroke data generation

Character data comes from [KanjiVG](https://github.com/KanjiVG/kanjivg). If there any errors in stroke data, please make a pull request on their GitHub repo. 

Sometimes I may forget to update to update stroke data, in this case, generate them yourself, and then submit a pull request to me, titled "Update of stroke data"

Do this:
```bash
git pull https://github.com/KanjiVG/kanjivg.git
cd kanjivg
python tools/build_kanjivg_data.py /path/to/kanjivg/kanji data
```

This writes `data/kanji.json`.

## Japanese dictionary data generation

Vocabulary/readings/definitions come from JMdict and individual-kanji metadata comes from KANJIDIC2, maintained by EDRDG. 

Download `JMdict_e.gz` and `kanjidic2.xml.gz` from the [EDRDG Nihongo archive](https://ftp.edrdg.org/pub/Nihongo/),
then run:

```bash
python tools/build_japanese_dictionary.py \
  --jmdict /path/to/JMdict_e.gz \
  --kanjidic /path/to/kanjidic2.xml.gz
```

If the dictionary gets updated, please help me generate them yourself, and then submit a pull request to me, titled "Update of definition data"

See `data/JAPANESE_DICTIONARY.md` for details.

## Built-in vocabulary lists

After generating `data/jmdict/`, build the bundled Japanese word lists:

```bash
python tools/build_japanese_lists.py
```

By default this downloads the JLPT N5–N1 source CSVs from
[`stephenmk/yomitan-jlpt-vocab`](https://github.com/stephenmk/yomitan-jlpt-vocab)
and caches them under `.cache/jlpt-vocab/`. 

The builder creates JLPT N5–N1 lists plus a 10,000-entry JMdict Common Japanese list. It resolves current exact spelling/reading pairs before trusting the older source JMdict sequence IDs, so entries that JMdict later split into new sequences are recovered automatically. It also writes `data/lists/jlpt-unresolved.tsv` with every source row that still cannot be mapped confidently. The JLPT levels for each word is NOT official.

See `data/JAPANESE_LISTS.md` for more info.

## Plans/Todo

- find bugs
- make something to learn grammar