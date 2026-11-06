# Design note: the 1.3 voice release

This note explains how 1.3 adds pronunciation control, a pronunciation check, delivery markup and a more natural
voice without breaking 1.x scene files. The user-facing reference is
[`skill/references/scene-format.md`](../skill/references/scene-format.md).

## One rule: the script's words stay the script's words

Captions, cue matching, the scheduler and the audit all count the narration's whitespace-separated words. Every new
feature changes only what the voice is told to say, never the words it is timed against. So:

1. On load, the narration is parsed once (`packages/core/src/speech.ts`). Markup (`[pause 0.6]`,
   `{speed 0.85}…{/speed}`, `*word*`, `[word](/phonemes/)`, `[word](say: text)`) is removed, which gives the
   **clean narration**. `scene.narration` holds the clean text from then on, so the scheduler, captions and audit
   never see markup. The markup becomes per-word marks: a pause before a word, a speed, a stress, or a pronunciation
   span.
2. The video-level and scene-level `say:` maps add more pronunciation spans. A scene's map overrides the video's map
   key by key. Keys match the clean words case-sensitively, on word boundaries (edge punctuation ignored), longest
   key first. Inline markup wins over the map.
3. The voice stage gets each phrase as its clean text plus its spans. For each phrase, Python builds two texts:
   - the **TTS text** that Kokoro hears: replacements in place, phonemes as misaki's `[word](/ps/)` links, stressed
     words as `[word](+2)`, and acronyms as `[word](/letters/)`;
   - the **spoken text** that the forced aligner hears: replacement words in place of the script words they stand
     for, and every other script word as it is.

   The aligner returns one time for each spoken word. A span's script words then take their times from that span's
   spoken words: the first script word starts with the first spoken word, the last script word ends with the last,
   and the words in between are spread by character position. The timeline's `words` are the script words, so cues
   and captions keep working as before.

## Automatic acronyms

misaki already spells most all-caps words it doesn't know letter by letter, but the decision is hidden inside it
and depends on the part-of-speech tag. 1.3 makes the decision explicit. A word made of 2 to 6 capital letters, with
an optional trailing `s`, is spelled out (with misaki's own letter phonemes, plus `z`/`ᵻz` for the `s`) unless misaki's
dictionaries know it as a word (NASA, SCUBA) or its lowercase form. `say: { YAML: YAML }` reads one word as a word, and
`voice.acronyms: false` turns the feature off. The audit treats a spelled-out acronym and the heard letters as the
same thing.

## Delivery markup

- `[pause 0.6]` ends the phrase at that point, and the gap before the next phrase is exactly 0.6 s. The pause
  belongs to the timeline like any other gap, so cues after it stay on their words. A pause at the very start or end
  of a narration is an error.
- `{speed 0.85}…{/speed}`: Kokoro has one speed per call, so a speed change ends the phrase. The two phrases are
  joined with a short 0.05 s gap.
- `*word*`: misaki's stress mark. Kokoro has no emphasis control. Measured on `af_heart`: `[your](+2)` lengthens an
  unstressed function word by 30 to 50 % and stresses it, but a content word that already has primary stress
  (`*save*`) does not change at all. 1.3 implements the stress mark and documents that limit. It does not pretend
  to give true emphasis.
- `voice.speed` on a scene overrides the video's speed for that scene.

## A more natural voice (on by default)

- **flow** (`voice.flow: sentence | scene`). Kokoro voices a group of phrases in one call, so the intonation runs on
  across clause and sentence breaks. The group is then force-aligned. Each phrase boundary is cut at the quietest
  10 ms point between the last word of one phrase and the first word of the next. The pieces are trimmed like
  ordinary phrase clips and joined with the designed gaps. The rest of the pipeline (per-phrase alignment, onsets,
  schedule) runs on these clips exactly as before, so phrase starts and cue times are honoured. A group that can't
  be cut safely (the alignment fails, or the cut point is not quiet) falls back to phrase-by-phrase synthesis, and a
  log line says so.
- **room tone** (`voice.roomTone: true | <dBFS>`). The mix adds seeded brown noise, low-passed, at about −60 dBFS,
  under the whole voice track. It is deterministic (ffmpeg `anoisesrc` with a fixed seed).
- **polish** (`voice.polish: true`). Applied to each scene's voice clip after alignment, with numpy only: a
  zero-phase 80 Hz high-pass, a gentle de-esser (it dips 5 to 10 kHz while that band is loud against the rest), and
  light RMS compression (2:1 above −24 dBFS, slow attack). The mix's loudness target (−16 LUFS) is unchanged.

All three are on by default, with `flow: sentence`. In a listen test of the demo the natural voice sounded better
than phrase-by-phrase, but `flow: scene` rushed the short opening line ("Welcome to Demo Co.") into the next
sentence, because the voice never stops at the full stop. `sentence` keeps each full stop and runs on only across
clause breaks, so it is the default; `scene` stays available. `flow: phrase, roomTone: false, polish: false` gives
the 1.2 sound back.

## Pronunciation check (audit)

The audit already aligns the script with the free transcript. For each word the transcript replaced, the
pronunciation check compares the expected and the heard words:

- Both sides are normalised: case and punctuation are dropped, numbers are spelled out, and words are joined across
  splits ("work list" = "worklist", "S K U" = "SKU").
- It ignores filler ("um", "uh"), allow-listed names, and homophones (the same misaki phonemes once stress is
  removed).
- It keeps only words where the heard phonemes are similar enough to the expected ones (similarity ≥ 0.5) to be the
  same word said differently, rather than a recognition slip.

Each flagged word is listed with its time, what was expected, what was heard, and a suggested `say:` entry: letters
for an acronym, a spaced respelling for a run-together word, or misaki's phonemes for the expected word, ready to
edit. It is a WARN by default. `audit.pronunciation: fail` makes it a FAIL, and `off` skips it.

## Versions and caches

The voice stage's cache version goes from 3 to 4, because the TTS input and the alignment now go through spans.
The mix stage's cache key includes the room tone. A 1.2 scene file with no markup, no `say:` and default voice
options sends Kokoro the same text as before, apart from the explicit acronym rule. That rule matches misaki's own
spelling for the common cases (tested). Its timing passes through the same code paths.
