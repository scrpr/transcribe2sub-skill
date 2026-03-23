---
name: transcribe2sub
description: "Generate or refine high-quality transcription subtitles from audio or video with ElevenLabs STT, word-level timestamps, token-range editing, ASR error correction, terminology consistency, optional user-provided glossaries, and SRT/JSON round-tripping. Use when the user needs 音频/视频转字幕, 高质量转写字幕, 合理语义分段, 准确时间轴, 错词纠正, 专有名词统一, glossary-driven review, punctuation or casing cleanup, or an agent-editable transcript that must render back to SRT without losing token coverage."
---

# transcribe2sub

Use this skill as a quality-first subtitle workflow, not a raw ASR dump.

## Default Strategy

- Prefer `json -> review -> srt`.
- Preserve the raw ElevenLabs response JSON on the first API run, then prefer `raw json -> review json -> srt` for later iterations.
- Use direct SRT output only when the user explicitly wants a fast draft or a raw first pass.
- Optimize in this order: transcript fidelity -> timing fidelity -> semantic segmentation -> readability polish.

## Prepare

- Confirm `ffmpeg` is available and `cd skills/transcribe2sub && pnpm install` has already been run.
- Prefer `ELEVENLABS_API_KEY`; the script can fall back to unauthenticated mode when needed and now auto-enables diarization for that path.
- Read `references/subtitle-quality.md` before regrouping or polishing subtitles.
- Read `references/glossary-format.md` before creating or loading a user glossary.
- Read `references/elevenlabs-stt-api.md` only when API field details matter.

## Quality-First Workflow

1. Generate editable JSON instead of direct SRT.

   The script saves the raw ElevenLabs response alongside the main output by default as `<output_basename>.elevenlabs.json`.

   CJK baseline:

   ```bash
   cd skills/transcribe2sub
   pnpm tsx scripts/transcribe2sub.ts <audio> --format json --max-chars 22 --max-duration 6.0 -o transcript.json
   ```

   Spaced-language baseline:

   ```bash
   cd skills/transcribe2sub
   pnpm tsx scripts/transcribe2sub.ts <audio> --format json --max-chars 38 --max-duration 8.0 -o transcript.json
   ```

   If the user provides a term list, pass it in at generation time:

   ```bash
   cd skills/transcribe2sub
   pnpm tsx scripts/transcribe2sub.ts <audio> --format json --glossary glossary.txt -o transcript.json
   ```

   Later, rebuild from the saved raw JSON without calling the API again:

   ```bash
   cd skills/transcribe2sub
   pnpm tsx scripts/transcribe2sub.ts --from-raw-json transcript.elevenlabs.json --format json --glossary glossary.txt -o transcript.json
   ```

2. Review `subtitles[]` against the quality rubric.

   - Edit only `subtitles[].token_start`, `subtitles[].token_end`, and `subtitles[].text`.
   - During correction, let the review LLM extract candidate terms into `glossary.candidates`.
   - Use `subtitles[].text` to correct obvious ASR misrecognitions within the same timed span.
   - Use `glossary.entries` as locked canonical terms from the user.
   - Use `glossary.candidates` as review-stage staging data only; do not treat them as final until they are copied into `glossary.collected`.
   - Add newly discovered people names, products, brands, organizations, or domain terms to `glossary.collected`.
   - Treat `subtitles[].start`, `subtitles[].end`, `word_*`, and `speaker_ids` as derived preview fields.
   - Never edit `tokens[].id`, `tokens[].start`, `tokens[].end`, `tokens[].type`, or `tokens[].speaker_id`.
   - Ensure every non-`spacing` token belongs to exactly one subtitle.

3. Render the corrected JSON back to SRT.

   ```bash
   cd skills/transcribe2sub
   pnpm tsx scripts/transcribe2sub.ts --from-json transcript.corrected.json -o final.srt
   ```

4. Generate a direct draft only when the user prioritizes speed over review quality.

   ```bash
   cd skills/transcribe2sub
   pnpm tsx scripts/transcribe2sub.ts <audio> -o draft.srt
   ```

5. When rerunning the same audio with different glossary or segmentation settings, prefer `--from-raw-json` over re-uploading audio.

## Editing Rules

- Keep spoken content faithful unless the user explicitly asks for condensation, cleanup, or translation.
- Correct obvious ASR lexical errors when the surrounding audio/timing span clearly supports the correction.
- Keep glossary terms consistent across the whole transcript; once a canonical form is chosen, reuse it everywhere.
- Extract glossary candidates while reviewing the transcript; do not rely on token-level heuristics to guess terms.
- Break at complete sentences, clauses, pauses, and speaker changes; do not split inside a tightly bound phrase just to satisfy a char limit.
- Use `subtitles[].text` to fix wrong words, punctuation, casing, line breaks, and obvious ASR formatting issues.
- Let token ranges determine timing; do not hand-edit preview timestamps to micro-adjust cue timing.
- Move token boundaries first when semantics and the default segmentation disagree.
- Prefer natural clause boundaries over perfectly even lengths when a subtitle runs too long.

## Final Checks

- Leave no empty subtitle.
- Drop or duplicate no timed token.
- Resolve obvious ASR errors before exporting.
- Promote useful `glossary.candidates` into `glossary.collected` or delete them during review.
- Make person names, brand names, and domain terms consistent with `glossary.entries` and `glossary.collected`.
- Make subtitle text read naturally in the target language.
- Confirm rendered timing matches the final token span.
- Return SRT unless the user explicitly asks to keep JSON.
