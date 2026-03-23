# Subtitle Quality Rubric

## Priority Order

1. Keep the spoken meaning faithful.
2. Keep timing anchored to token ranges.
3. Correct obvious ASR errors and terminology mistakes.
4. Split at semantic boundaries.
5. Polish punctuation, casing, and line breaks.

## Allowed Edits

- `subtitles[].token_start`
- `subtitles[].token_end`
- `subtitles[].text`

## Read-Only Fields

- `tokens[].id`
- `tokens[].start`
- `tokens[].end`
- `tokens[].type`
- `tokens[].speaker_id`
- `subtitles[].start`
- `subtitles[].end`
- `subtitles[].word_start`
- `subtitles[].word_end`
- `subtitles[].speaker_ids`

Treat subtitle timing preview fields as informational only. Rendering recomputes them from the final token range.

## Good Segmentation

- Keep one subtitle focused on one complete idea, sentence, or natural clause.
- Split on sentence endings, clear clause endings, long pauses, and speaker changes.
- Keep modifiers, negation, and attached particles with the words they qualify.
- Avoid joining two unrelated clauses only because each clause is short on its own.
- Avoid one-word flash subtitles unless the audio itself is abrupt and isolated.

## Text Cleanup

- Correct obvious ASR errors when the intended wording is clear from the audio, context, or glossary.
- Fix punctuation and casing when the spoken meaning is unchanged.
- Reflow line breaks for readability.
- Preserve wording unless the user explicitly asks for condensation, translation, or editorial cleanup.
- Do not invent words to smooth over unclear audio.

## Terminology Consistency

- Extract and update `glossary.candidates` while reviewing the transcript; treat them as suggestions, not locked truth.
- Use glossary canonical forms for people, products, organizations, locations, and repeated domain terms.
- Record newly resolved terms in `glossary.collected` during review.
- Remove alias spellings from final subtitles before rendering.
- If a term is uncertain, keep the original wording and flag it instead of guessing.

## Working Presets

- CJK subtitles: start around `18-24` chars and `2.5-3.5` seconds.
- Spaced languages: start around `32-42` chars and `3.0-4.0` seconds.
- Dense dialogue: lower duration before aggressively lowering char count.
- Slow lectures: allow slightly longer cues when the clause remains semantically intact.

## Final QA

- Every non-`spacing` token appears exactly once.
- Obvious ASR misrecognitions have been corrected or intentionally left unchanged for lack of evidence.
- Canonical spellings from the glossary are used consistently.
- No subtitle crosses an obvious speaker change without a strong reason.
- No subtitle combines two full sentences when a punctuation boundary already exists.
- No subtitle ends before the final audible word in its token span.
- Readability improvements do not change meaning.
