# ElevenLabs Speech-to-Text API Reference

## Endpoint

```
POST https://api.elevenlabs.io/v1/speech-to-text
```

## Authentication

- Header: `xi-api-key: <ELEVENLABS_API_KEY>`
- Unauthenticated: append `?allow_unauthenticated=1` query parameter (no header needed)
- The script now enables `diarize=true` by default for all STT requests, including unauthenticated mode.

## Request

Content-Type: `multipart/form-data`

### Required Fields

| Field | Type | Description |
|---|---|---|
| `model_id` | string | `scribe_v2` |
| `file` | binary | Audio file (WAV, MP3, M4A, etc.) |

### Optional Fields

| Field | Type | Description |
|---|---|---|
| `language_code` | string | ISO language code (e.g. `en`, `zh`, `ja`) |
| `timestamps_granularity` | string | `word` or `sentence` |
| `diarize` | boolean | Enable speaker diarization |
| `num_speakers` | integer | Expected speaker count |
| `tag_audio_events` | boolean | Tag non-speech sounds |

## Response (200 OK)

```json
{
  "language_code": "en",
  "language_probability": 1,
  "text": "Full transcription text...",
  "words": [
    {
      "text": "Hello",
      "start": 0.119,
      "end": 0.459,
      "type": "word",
      "speaker_id": "speaker_0"
    },
    {
      "text": " ",
      "start": 0.439,
      "end": 0.52,
      "type": "spacing",
      "speaker_id": "speaker_0"
    }
  ]
}
```

### Word Object

| Field | Type | Values |
|---|---|---|
| `text` | string | Word text, space, or event description |
| `start` | number | Start time in seconds |
| `end` | number | End time in seconds |
| `type` | string | `word`, `spacing`, `audio_event` |
| `speaker_id` | string | Speaker identifier (e.g. `speaker_0`) |

### Type Values

- `word` — A word in the audio language
- `spacing` — Space between words (not present for CJK languages without spaces)
- `audio_event` — Non-speech sounds (laughter, applause, etc.)

## Error Responses

| Status | Description |
|---|---|
| 400 | Invalid parameters or missing required fields |
| 401 | Missing or invalid API key |
| 413 | Audio file exceeds size limit |
| 500 | Server error |
