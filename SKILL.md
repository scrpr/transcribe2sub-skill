---
name: transcribe2sub
description: "Subtitle production workflow for generating, rebuilding, reviewing, QAing, optimizing, or rendering SRT subtitles from audio/video files, raw ElevenLabs JSON, .review.json, .corrected.json, or existing SRT drafts. Use this skill for 音频/视频转字幕, mp4/wav/audio-to-SRT, 中文字幕 SRT, quick draft.srt, review JSON, corrected JSON, semantic subtitle segmentation, accurate timing, token-range editing, token coverage, zero_duration, ASR cleanup, glossary aliases, term consistency, and JSON-to-SRT round-tripping. Always prefer this skill for subtitle file work beyond a plain explanation or unrelated code task."
---

# transcribe2sub

Use this skill as a quality-first subtitle workflow, not as a raw ASR dump.

## Default Strategy

- Use two separate responsibilities for agentic runs:
  - Transcription/build: run the script, generate or rebuild `<stem>.review.json`, and preserve raw artifacts.
  - Review/QA: inspect `qa_flags`, fix segmentation/timing/text issues inside the editable JSON, and save `<stem>.corrected.json`.
- When subagents are available, use separate subagents for those responsibilities. In Codex or other environments without real subagents, simulate the separation as two explicit phases: finish and save the draft first, then reopen the draft for review in a separate pass.
- Prefer `json -> review -> corrected json -> srt`.
- Preserve the raw ElevenLabs response JSON on the first API run, then prefer `raw json -> review json -> corrected json -> srt` for later iterations.
- Use direct SRT output only when the user explicitly wants a fast draft or a raw first pass.
- Optimize in this order: transcript fidelity -> timing fidelity -> semantic segmentation -> readability polish.

## Required

- On the first run after the skill is installed, request approval if needed, enter the skill root directory, and run `pnpm install` before invoking the script.
- For agentic work, keep transcription/build separate from review/QA instead of letting one pass both generate and edit the transcript.
- Prefer the review workflow by default: generate editable JSON first, review it, save the reviewed file as `<stem>.corrected.json`, then render SRT.
- Name the machine draft `<stem>.review.json`; this keeps the generated review draft, reviewed output, and raw cache aligned.
- During review, inspect `subtitles[].qa_flags`, `review.normalization_diagnostics`, `glossary.entries`, `glossary.candidates`, and `glossary.collected` before exporting.
- During review, run a full QA sweep before and after edits; treat every error-level `qa_flag` as a must-fix item, not a suggestion.
- Keep every non-`spacing` token covered exactly once.
- Keep the spoken meaning faithful unless the user explicitly asks for condensation, cleanup, or translation.
- Use `subtitles[].text` for obvious ASR correction, punctuation cleanup, terminology unification, and line-break polish within the same token span.
- Correct names and terms only by replacing text that is already present in the current token span or adjacent cue being merged; do not insert a name, subject, object, or explanation that was not spoken in that span.
- Cue merging is allowed, but merged text must preserve the original token/cue order.
- Promote confirmed repeated terms into `glossary.collected`; keep uncertain terms in `glossary.candidates`.

## Optional

- Use `--glossary` when the user provides a term list or when terminology consistency matters.
- Use `--from-raw-json` when rerunning the same media with different segmentation or glossary settings.
- Emit direct SRT only when the user explicitly wants a draft and accepts lower review quality.
- Tune `--max-chars` and `--max-duration` per language or density when the defaults do not fit the material.

## Never

- Never skip review and jump straight to SRT unless the user explicitly prioritizes speed over quality.
- Never save the reviewed file as a generic `transcript.json`; reviewed outputs must end with `.corrected.json`.
- Never edit `tokens[].id`, `tokens[].start`, `tokens[].end`, `tokens[].type`, or `tokens[].speaker_id`.
- Never hand-edit `subtitles[].start`, `subtitles[].end`, `word_*`, or `speaker_ids`; they are derived preview fields.
- Never treat `glossary.candidates` as locked truth before they are promoted into `glossary.collected`.
- Never drop or duplicate timed tokens to make a subtitle read better.
- Never expand a generic form of address into a specific name unless the name is actually present in the current token span or user-provided reference for that exact line. `先輩...` must not become `XX先輩...` just because the referent is known.
- Never reorder words or clauses while correcting names or merging cues.

## Prepare

- Confirm `ffmpeg` is available.
- If dependencies are not installed, enter the skill root directory and run `pnpm install`. If the environment blocks installation, request approval and rerun with elevated permissions.
- Prefer `ELEVENLABS_API_KEY`; the script can fall back to unauthenticated mode when needed and now auto-enables diarization for that path.
- Read `references/subtitle-quality.md` before regrouping or polishing subtitles.
- Read `references/glossary-format.md` before creating or loading a user glossary.
- Read `references/elevenlabs-stt-api.md` only when API field details matter.

## Quality-First Workflow

1. Generate editable JSON instead of direct SRT.

   Ownership:

   - The transcription/build pass owns this step. It prepares inputs, runs the script, preserves `<basename>.elevenlabs.json`, and outputs `<stem>.review.json`.
   - This pass does not review or hand-edit subtitle content except for operational recovery steps explicitly requested by the user.

   Naming convention:

   - Machine draft: `<stem>.review.json`
   - Raw cache: `<basename>.elevenlabs.json`, derived from the main output path without its extension. For `episode.review.json`, the default cache is `episode.review.elevenlabs.json`.
   - Reviewed output: `<stem>.corrected.json`

   The script saves the raw ElevenLabs response alongside the main output by default as `<basename>.elevenlabs.json`, where `<basename>` is the main output filename without its extension.

   CJK baseline:

   ```bash
   pnpm tsx scripts/transcribe2sub.ts <audio> --format json --max-chars 22 --max-duration 8.0 -o episode.review.json
   ```

   Spaced-language baseline:

   ```bash
   pnpm tsx scripts/transcribe2sub.ts <audio> --format json --max-chars 38 --max-duration 4.0 -o episode.review.json
   ```

   If the user provides a term list, pass it in at generation time:

   ```bash
   pnpm tsx scripts/transcribe2sub.ts <audio> --format json --glossary glossary.txt -o episode.review.json
   ```

   Later, rebuild from the saved raw JSON without calling the API again:

   ```bash
   pnpm tsx scripts/transcribe2sub.ts --from-raw-json episode.review.elevenlabs.json --format json --glossary glossary.txt -o episode.review.json
   ```

2. Review `subtitles[]` against the quality rubric.

   Save the reviewed file as `<stem>.corrected.json`, for example `episode.corrected.json`.

   Ownership:

   - The review/QA pass owns this step. It reads `<stem>.review.json`, performs review and QA, and saves `<stem>.corrected.json`.
   - This pass must not re-run transcription or regenerate the draft unless the user explicitly asks to restart from raw audio or raw JSON.

   - Edit only `subtitles[].token_start`, `subtitles[].token_end`, `subtitles[].text`, `glossary.candidates`, and `glossary.collected`.
   - During correction, extract candidate terms into `glossary.candidates`, but do not let candidates authorize inserting new spoken content.
   - Use `subtitles[].text` to correct obvious ASR misrecognitions within the same timed span.
   - Use `glossary.entries` as locked canonical terms from the user.
   - Use `glossary.candidates` as review-stage staging data only; do not treat them as final until they are copied into `glossary.collected`.
   - Add newly discovered people names, products, brands, organizations, or domain terms to `glossary.collected`.
   - If a generic address was spoken, keep it generic. Knowing who it refers to is not enough to add their name to the line.
   - If cues are merged, preserve their original text order and only adjust punctuation/line breaks. Do not rewrite into a more natural or literary word order.
   - Prioritize `qa_flags` and `review.normalization_diagnostics` before spending time on fine-grained polish.
   - For `zero_duration`, `timing_span_mismatch`, `too_short`, `too_long`, `ends_mid_word`, and `starts_mid_word`, adjust token boundaries first; do not try to polish text around a broken span.
   - Even when `qa_flags` are sparse, actively inspect for flash cues, short text hanging too long, unnatural joins across full sentences, and cross-speaker merges.
   - Treat `subtitles[].start`, `subtitles[].end`, `word_*`, and `speaker_ids` as derived preview fields.
   - Never edit `tokens[].id`, `tokens[].start`, `tokens[].end`, `tokens[].type`, or `tokens[].speaker_id`.
   - Ensure every non-`spacing` token belongs to exactly one subtitle.
   - After all edits, do a second pass over the whole file and confirm no obvious QA issue remains before exporting.

3. Render the corrected JSON back to SRT.

   Ownership:

   - Render only after checking that the corrected JSON is the latest reviewed artifact.

   ```bash
   pnpm tsx scripts/transcribe2sub.ts --from-json episode.corrected.json -o final.srt
   ```

4. Generate a direct draft only when the user prioritizes speed over review quality.

   ```bash
   pnpm tsx scripts/transcribe2sub.ts <audio> -o draft.srt
   ```

5. When rerunning the same audio with different glossary or segmentation settings, prefer `--from-raw-json` over re-uploading audio.

## Editing Rules

- Keep spoken content faithful unless the user explicitly asks for condensation, cleanup, or translation.
- Correct obvious ASR lexical errors when the surrounding audio/timing span clearly supports the correction.
- Keep glossary terms consistent across the whole transcript; once a canonical form is chosen, reuse it everywhere.
- Extract glossary candidates while reviewing the transcript; use them to replace existing misrecognized terms, not to add unstated words.
- Break at complete sentences, clauses, pauses, and speaker changes; do not split inside a tightly bound phrase just to satisfy a char limit.
- Use `subtitles[].text` to fix wrong words, punctuation, casing, line breaks, and obvious ASR formatting issues.
- Preserve token order when merging cues or correcting text. Do not move a corrected name earlier or later in the sentence.
- Let token ranges determine timing; do not hand-edit preview timestamps to micro-adjust cue timing.
- Move token boundaries first when semantics and the default segmentation disagree.
- Prefer natural clause boundaries over perfectly even lengths when a subtitle runs too long.

## Final Checks

- Confirm the handoff between transcription/build and review/QA is clean: draft JSON preserved, corrected JSON written separately, and raw cache retained.
- Leave no empty subtitle.
- Drop or duplicate no timed token.
- Resolve obvious ASR errors before exporting.
- Confirm name corrections did not add an unstated name or change word order.
- Re-read the whole subtitle list once after edits instead of stopping after local fixes.
- Promote useful `glossary.candidates` into `glossary.collected` or delete them during review.
- Make person names, brand names, and domain terms consistent with `glossary.entries` and `glossary.collected`.
- Confirm no error-level `qa_flags` remain unaddressed and that warning-level flags were consciously reviewed.
- Make subtitle text read naturally in the target language.
- Confirm rendered timing matches the final token span.
- Return SRT unless the user explicitly asks to keep JSON.
