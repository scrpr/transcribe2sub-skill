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
- Remaining terms are reject forms: ASR mistakes, misspellings, wrong romanization, or other incorrect forms that must be normalized to the canonical spelling.
- Avoid overly generic reject forms such as `AI`; reject-form matching is literal.
- Do not include acceptable nicknames, honorifics, short names, relationship terms, titles, or in-universe spoken variants as reject forms.

## JSON Format

Accepted shapes:

```json
[
  "OpenAI",
  { "canonical": "Sam Altman", "reject_forms": ["Sam Alman"], "note": "CEO of OpenAI" }
]
```

or

```json
{
  "entries": [
    { "canonical": "OpenAI", "reject_forms": ["Open AI", "Open A.I."] }
  ]
}
```

## Review Usage

- `glossary.entries`: user-provided canonical terms and reject forms.
- `glossary.candidates`: candidate terms discovered by the review LLM while correcting ASR errors.
- `glossary.collected`: terms confirmed and locked during review.
- Promote reviewed candidates by copying them from `glossary.candidates` into `glossary.collected`.
- Before rendering to SRT, remove leftover `reject_forms` from subtitle text; final text should use canonical spellings only for those incorrect forms.
- If a nickname or short form is a legitimate spoken variant, keep it out of `reject_forms` and document it in `note` instead.
