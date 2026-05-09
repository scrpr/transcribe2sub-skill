---
name: transcribe2sub
description: "Subagent-based subtitle production workflow for generating, rebuilding, structurally QAing, text-reviewing, and rendering high-quality SRT subtitles from audio/video files, ElevenLabs raw JSON, .review.json, .segmented.json, .corrected.json, or existing SRT drafts. Use this skill for audio/video-to-SRT, Chinese/Japanese/English subtitles, review JSON, corrected JSON, semantic segmentation, token-range editing, qa_flags, zero_duration, ASR cleanup, homophone fixes, proper nouns, glossary aliases, terminology consistency, and JSON-to-SRT round-tripping. Always prefer this skill for subtitle file work beyond plain explanation or unrelated code tasks."
---

# transcribe2sub

Use this skill as a quality-first subtitle production pipeline, not as a one-pass ASR dump. The default handoff is `review json -> segmented json -> corrected json -> srt`: build the machine draft first, fix structural/timing issues second, fix text quality third, then render and validate.

## Subagent Operating Model

- Use separate responsibilities for `Coordinator`, `Transcription Builder`, `Structural QA`, `Text QA`, and `Render Validate`.
- `Coordinator` is a planning role inside the current agent session, not a subagent role. Never spawn a dedicated Coordinator subagent.
- When real subagents are available, only `Transcription Builder`, `Structural QA`, `Text QA`, and `Render Validate` may be assigned to separate subagents.
- When real subagents are unavailable, simulate separation as explicit passes: finish and save one artifact before starting the next pass.
- Each execution role edits only its owned artifact and fields. If a problem belongs to another role, hand it back through the Coordinator logic in the current agent instead of guessing across boundaries.
- Optimize in this order: transcript fidelity -> timing fidelity -> segmentation -> text consistency -> readability polish.

## Artifact Contract

- Machine draft: `<stem>.review.json`.
- Structurally adjusted draft: `<stem>.segmented.json`.
- Text-reviewed output: `<stem>.corrected.json`.
- Raw cache: `<basename>.elevenlabs.json`, derived from the main output path without its extension. For `episode.review.json`, the default cache is `episode.review.elevenlabs.json`.
- Final delivery: `.srt`, rendered from `<stem>.corrected.json` unless the user explicitly requests a lower-quality fast draft.

## Role: Coordinator (Main agent)

The Coordinator routes inputs and enforces clean handoffs inside the current top-level agent. It is orchestration logic, not a spawned worker. It does not directly edit subtitle content, token ranges, timestamps, or glossary data.

- Classify the user input: audio/video, ElevenLabs raw JSON, `.review.json`, `.segmented.json`, `.corrected.json`, existing SRT draft, or fast-draft request.
- Choose the route and, when subagents are used, assign only these worker roles in this order: `Transcription Builder -> Structural QA -> Text QA -> Render Validate`.
- Confirm input paths, output names, glossary path, segmentation settings, and whether the user explicitly accepts fast-draft quality.
- Ensure every handoff artifact exists and follows the naming contract.
- Route failures back to the owning role: structural/timing/token issues go to Structural QA; ASR/text/glossary issues go to Text QA; command/render failures go to Render Validate or Transcription Builder as appropriate.
- In Codex or any environment that already has a top-level agent, treat that top-level agent as the Coordinator. Do not create a nested Coordinator subagent.

## Role: Transcription Builder

The Transcription Builder only generates or rebuilds machine-reviewable JSON.

- Confirm `ffmpeg` is available.
- On first practical use after installation, run `pnpm install` from the skill root if dependencies are missing. Request approval first when the environment blocks installation.
- For first-time audio/video processing, run ElevenLabs STT and preserve the raw response JSON.
- For repeated processing of the same media, prefer `--from-raw-json` instead of re-uploading audio.
- Output `<stem>.review.json` and preserve `<basename>.elevenlabs.json`.
- Pass `--glossary` during generation when the user provides a glossary, so `glossary.entries` is present in the review JSON.
- Do not review, polish, resegment manually, or edit `subtitles[]`. Only handle operational recovery such as missing paths, command failures, or dependency issues.

CJK baseline:

```bash
pnpm tsx scripts/transcribe2sub.ts <audio> --format json --max-chars 22 --max-duration 8.0 -o episode.review.json
```

Spaced-language baseline:

```bash
pnpm tsx scripts/transcribe2sub.ts <audio> --format json --max-chars 38 --max-duration 4.0 -o episode.review.json
```

With a user glossary:

```bash
pnpm tsx scripts/transcribe2sub.ts <audio> --format json --glossary glossary.txt -o episode.review.json
```

Rebuild from saved raw JSON:

```bash
pnpm tsx scripts/transcribe2sub.ts --from-raw-json episode.review.elevenlabs.json --format json --glossary glossary.txt -o episode.review.json
```

## Role: Structural QA

Structural QA owns non-text subtitle correctness: token coverage, timing, segmentation, and script-generated QA flags. Its output is `<stem>.segmented.json`.

- Input `<stem>.review.json`; output `<stem>.segmented.json`.
- Inspect `subtitles[].qa_flags` and `review.normalization_diagnostics` before editing.
- Treat every error-level `qa_flag` as a must-fix issue. Review warning-level flags deliberately instead of ignoring them.
- Fix `zero_duration`, `timing_span_mismatch`, `too_short`, `too_long`, `ends_mid_word`, `starts_mid_word`, and `contains_mixed_raw_token` before text polish begins.
- Actively inspect for flash cues, short text held too long, oversized cues, unnatural joins across complete sentences, cross-speaker merges, and abnormal pauses even when no flag is present.
- Prefer token-boundary changes for structural defects. Let token ranges determine timing; never hand-edit preview timestamps.
- Break at complete sentences, clauses, pauses, and speaker changes. Do not split inside a tightly bound phrase only to satisfy a character limit.
- Merge adjacent cues only when speaker continuity, pause length, duration, and character limits remain acceptable.
- If cues are merged, preserve original token/cue order. Do not rewrite the text into a more natural or literary word order.
- Edit only `subtitles[].token_start`, `subtitles[].token_end`, and the minimum `subtitles[].text` synchronization needed after range changes.
- Do not correct ASR mistakes, homophones, proper nouns, spelling, punctuation style, casing, line breaks, or glossary consistency unless required to keep text aligned after a range change.
- Never edit `tokens[].id`, `tokens[].start`, `tokens[].end`, `tokens[].type`, or `tokens[].speaker_id`.
- Never hand-edit `subtitles[].start`, `subtitles[].end`, `word_*`, or `speaker_ids`; they are derived preview fields.
- Ensure every non-`spacing` token belongs to exactly one subtitle.
- If a structural fix requires semantic judgment about wording, hand off to Text QA after preserving a valid token range.

## Role: Text QA

Text QA owns transcript fidelity and subtitle text quality after structural boundaries are stable. Its output is `<stem>.corrected.json`.

- Input `<stem>.segmented.json`; output `<stem>.corrected.json`.
- Review `subtitles[].text`, `glossary.entries`, `glossary.candidates`, and `glossary.collected` across the whole transcript.
- Keep spoken meaning faithful unless the user explicitly asks for condensation, cleanup, or translation.
- Correct obvious ASR lexical errors, homophone errors, proper nouns, domain terms, spelling, punctuation, casing, and line breaks when the current token span supports the correction.
- Use `glossary.entries` as locked canonical terms from the user.
- When the source video is a film, TV episode, drama, anime, or other narrative work, use web search when needed to confirm official character names, cast names, titles, organizations, locations, and proper-noun spellings before promoting canonical forms.
- Extract names, brands, products, organizations, locations, and domain terms while reviewing. Put uncertain terms in `glossary.candidates`; promote confirmed canonical forms into `glossary.collected`.
- Keep repeated people names, team names, work titles, product names, and domain terms consistent with `glossary.entries` and `glossary.collected`.
- Proper noun and terminology corrections may only replace content already spoken inside the current token span or inside adjacent cues that were already merged by Structural QA.
- Do not add an unstated name, subject, object, title, or explanation. If the spoken line only uses a generic form of address, keep it generic.
- Do not reorder words or clauses while correcting names or merging punctuation. Preserve the original token/cue order.
- Edit only `subtitles[].text`, `glossary.candidates`, and `glossary.collected`.
- Do not adjust token ranges. If the current token range prevents a faithful text correction, return the file to Structural QA with the exact cue and reason.
- Do not edit `tokens[]`, derived timestamp preview fields, `word_*`, or `speaker_ids`.

## Role: Render Validate

Render Validate only renders the final reviewed JSON and checks delivery risk.

- Input the latest `<stem>.corrected.json`; never render final SRT directly from `<stem>.review.json` or `<stem>.segmented.json`.
- Run JSON-to-SRT rendering.
- If validation fails, route the issue back by type: token/timing/coverage failures to Structural QA; text/glossary failures to Text QA; command or dependency failures to the operational owner.
- Confirm the final SRT came from corrected JSON, not from a direct draft.
- Confirm no empty subtitle, obvious timing inversion, duplicated token coverage, or unresolved error-level QA issue remains.

```bash
pnpm tsx scripts/transcribe2sub.ts --from-json episode.corrected.json -o final.srt
```

## Workflow Routes

### First Audio Or Video Processing

1. Coordinator confirms input, output stem, glossary, segmentation settings, and quality target.
2. Transcription Builder creates `<stem>.review.json` and `<basename>.elevenlabs.json`.
3. Structural QA creates `<stem>.segmented.json`.
4. Text QA creates `<stem>.corrected.json`.
5. Render Validate creates the final SRT.

### Rebuild From Raw ElevenLabs JSON

1. Coordinator confirms the reusable `<basename>.elevenlabs.json`, glossary, and segmentation settings.
2. Transcription Builder uses `--from-raw-json` to create a new `<stem>.review.json`.
3. Structural QA creates `<stem>.segmented.json`.
4. Text QA creates `<stem>.corrected.json`.
5. Render Validate creates the final SRT.

### Continue From Existing Review JSON

1. Coordinator confirms the input is `.review.json`.
2. Structural QA creates `.segmented.json`.
3. Text QA creates `.corrected.json`.
4. Render Validate renders from `.corrected.json`.

### Continue From Existing Segmented JSON

1. Coordinator confirms the input is `.segmented.json` and structural QA does not need to be repeated.
2. Text QA creates `.corrected.json`.
3. Render Validate renders from `.corrected.json`.

### Render Existing Corrected JSON

1. Coordinator confirms the input is `.corrected.json` and the user is not asking for further review.
2. Render Validate runs `--from-json`.

### Fast Draft Exception

Only when the user explicitly prioritizes speed and accepts lower review quality, direct SRT output is allowed:

```bash
pnpm tsx scripts/transcribe2sub.ts <audio> -o draft.srt
```

## Field Ownership

- Transcription Builder owns generated raw artifacts and `<stem>.review.json` creation.
- Structural QA owns `subtitles[].token_start`, `subtitles[].token_end`, and minimal text synchronization caused by range changes.
- Text QA owns `subtitles[].text`, `glossary.candidates`, and `glossary.collected`.
- Render Validate owns SRT rendering and final delivery checks.
- No worker subagent may edit `tokens[].id`, `tokens[].start`, `tokens[].end`, `tokens[].type`, `tokens[].speaker_id`, `subtitles[].start`, `subtitles[].end`, `word_*`, or `speaker_ids`.

## Required

- Prefer the review pipeline over direct SRT for quality work.
- Keep structural QA and text QA separate. Stabilize token ranges before text polish.
- Preserve every non-`spacing` token exactly once across subtitles.
- Preserve raw ElevenLabs JSON after first API processing and reuse it for later rebuilds.
- Read `references/subtitle-quality.md` before regrouping, splitting, merging, or polishing subtitles.
- Read `references/glossary-format.md` before creating or loading a user glossary.
- Read `references/elevenlabs-stt-api.md` only when API field details matter.

## Never

- Never skip review and produce final SRT directly unless the user explicitly asks for a fast draft.
- Never save reviewed output as a generic `transcript.json`.
- Never edit token identity, token timestamps, speaker IDs, or derived preview fields.
- Never treat `glossary.candidates` as confirmed truth before promotion into `glossary.collected`.
- Never drop or duplicate timed tokens to make a subtitle read better.
- Never expand a generic form of address into a specific name unless that name is actually present in the current token span.
- Never reorder words or clauses while correcting names, punctuation, or merged cue text.

## Final Checks

- The artifact chain is complete: review JSON, segmented JSON, corrected JSON, raw cache when applicable, and final SRT.
- The final SRT was rendered from `.corrected.json`.
- No empty subtitle remains.
- No non-`spacing` token is missing or duplicated.
- No obvious ASR error, unresolved term inconsistency, or error-level `qa_flag` remains.
- Name and term corrections did not add unstated content or change word order.
- Structural QA ran before Text QA, and Text QA did not change token ranges.
- Return SRT by default unless the user explicitly asks to keep JSON as the final artifact.
