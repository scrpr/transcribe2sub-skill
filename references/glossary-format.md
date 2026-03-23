# Glossary Format

Use a glossary when the transcript contains names, brands, products, places, or domain terms that must stay consistent.

## Plain Text Format

One entry per line. Ignore empty lines and lines starting with `#`.

Accepted forms:

```text
OpenAI
OpenAI | Open AI | Open A.I.
Sam Altman => Sam Alman, Sam Altmann
```

- First term is the canonical spelling to keep.
- Remaining terms are aliases or common misrecognitions that should be normalized to the canonical spelling.
- Avoid overly generic aliases such as `AI`; alias matching is literal.

## JSON Format

Accepted shapes:

```json
[
  "OpenAI",
  { "canonical": "Sam Altman", "aliases": ["Sam Alman"], "note": "CEO of OpenAI" }
]
```

or

```json
{
  "entries": [
    { "canonical": "OpenAI", "aliases": ["Open AI", "Open A.I."] }
  ]
}
```

## Review Usage

- `glossary.entries`: user-provided canonical terms.
- `glossary.candidates`: candidate terms discovered by the review LLM while correcting ASR errors.
- `glossary.collected`: terms confirmed and locked during review.
- Promote reviewed candidates by copying them from `glossary.candidates` into `glossary.collected`.
- Before rendering to SRT, remove leftover aliases from subtitle text; final text should use canonical spellings only.
