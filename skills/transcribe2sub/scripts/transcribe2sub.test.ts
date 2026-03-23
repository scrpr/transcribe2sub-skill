import assert from "node:assert/strict";
import test from "node:test";

import {
  TranscribeRequestError,
  buildTranscribeRequest,
  createTokens,
  defaultRawOutputPath,
  formatAgentJSON,
  formatTimestamp,
  isRetryableTranscribeError,
  parseGlossaryText,
  parseTranscribeResponse,
  retryTranscribeRequest,
  segmentIntoSubtitles,
  subtitlesFromAgentTranscript,
  transcribeRetryDelayMs,
  type AgentTranscript,
  type GlossaryEntry,
  type Word,
} from "./transcribe2sub.ts";

function buildWords(words: Word[]): Word[] {
  return words;
}

function buildGlossary(entries: GlossaryEntry[] = []): AgentTranscript["glossary"] {
  return {
    entries,
    collected: [],
    candidates: [],
  };
}

function buildReview(): AgentTranscript["review"] {
  return {
    allow_asr_corrections: true,
    require_term_consistency: true,
    checklist: [],
  };
}

test("formatTimestamp carries rounded milliseconds into the next second", () => {
  assert.equal(formatTimestamp(1.9996), "00:00:02,000");
  assert.equal(formatTimestamp(59.9996), "00:01:00,000");
});

test("defaultRawOutputPath derives a sibling ElevenLabs cache path", () => {
  assert.equal(
    defaultRawOutputPath("/tmp/transcript.json"),
    "/tmp/transcript.elevenlabs.json",
  );
  assert.equal(
    defaultRawOutputPath("/tmp/final.srt"),
    "/tmp/final.elevenlabs.json",
  );
});

test("parseTranscribeResponse accepts ElevenLabs raw response JSON", () => {
  const response = parseTranscribeResponse({
    language_code: "en",
    language_probability: 0.99,
    text: "Hello world",
    words: [
      { text: "Hello", start: 0, end: 0.4, type: "word", speaker_id: "speaker_0" },
      { text: " ", start: 0.4, end: 0.45, type: "spacing", speaker_id: "speaker_0" },
      { text: "world", start: 0.45, end: 0.9, type: "word", speaker_id: "speaker_0" },
    ],
  });

  assert.equal(response.language_code, "en");
  assert.equal(response.words.length, 3);
  assert.equal(response.words[2]?.text, "world");
});

test("parseTranscribeResponse strips unsupported word fields before tokenization", () => {
  const response = parseTranscribeResponse({
    language_code: "ja",
    language_probability: 0.99,
    text: "こんにちは",
    words: [
      { text: "こんにちは", start: 0, end: 0.8, type: "word", speaker_id: "speaker_0", logprob: -0.01 },
    ],
  });

  assert.equal("logprob" in response.words[0]!, false);

  const tokens = createTokens(response.words);
  assert.equal("logprob" in tokens[0]!, false);
});

test("buildTranscribeRequest enables diarization for unauthenticated requests", () => {
  const file = new File(["audio"], "sample.m4a", { type: "audio/mp4" });
  const { url, form } = buildTranscribeRequest(file, { language: "ja", useUnauth: true });

  assert.equal(url.searchParams.get("allow_unauthenticated"), "1");
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("timestamps_granularity"), "word");
  assert.equal(form.get("language_code"), "ja");
  assert.equal(form.get("diarize"), "true");

  const requestFile = form.get("file");
  assert.ok(requestFile instanceof File);
  assert.equal(requestFile.name, "sample.m4a");
});

test("buildTranscribeRequest skips diarization for authenticated requests", () => {
  const file = new File(["audio"], "sample.m4a", { type: "audio/mp4" });
  const { url, form } = buildTranscribeRequest(file);

  assert.equal(url.searchParams.get("allow_unauthenticated"), null);
  assert.equal(form.get("diarize"), null);
});

test("transcribeRetryDelayMs applies exponential backoff with bounded jitter", () => {
  assert.equal(
    transcribeRetryDelayMs(1, { baseMs: 100, jitterMs: 20, random: () => 0 }),
    100,
  );
  assert.equal(
    transcribeRetryDelayMs(3, { baseMs: 100, jitterMs: 20, random: () => 0.5 }),
    410,
  );
});

test("isRetryableTranscribeError matches transient HTTP and network failures", () => {
  assert.equal(isRetryableTranscribeError(new TranscribeRequestError("busy", 503)), true);
  assert.equal(isRetryableTranscribeError(new TranscribeRequestError("unauthorized", 401)), false);

  const networkError = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
  networkError.cause = { code: "ECONNRESET" };
  assert.equal(isRetryableTranscribeError(networkError), true);
});

test("retryTranscribeRequest retries transient failures and preserves exponential delays", async () => {
  const delays: number[] = [];
  let attempts = 0;

  const result = await retryTranscribeRequest(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new TranscribeRequestError("service unavailable", 503);
    }
    return "ok";
  }, {
    baseDelayMs: 10,
    jitterMs: 0,
    sleepFn: async (ms) => {
      delays.push(ms);
    },
    logFn: () => {},
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("retryTranscribeRequest stops immediately on non-retryable failures", async () => {
  let attempts = 0;

  await assert.rejects(
    () => retryTranscribeRequest(async () => {
      attempts += 1;
      throw new TranscribeRequestError("bad request", 400);
    }, {
      sleepFn: async () => {},
      logFn: () => {},
    }),
    /bad request/,
  );

  assert.equal(attempts, 1);
});

test("segmentIntoSubtitles preserves source spacing and punctuation", () => {
  const tokens = createTokens(buildWords([
    { text: "Hello", start: 0, end: 0.4, type: "word" },
    { text: " ", start: 0.4, end: 0.45, type: "spacing" },
    { text: "world", start: 0.45, end: 0.9, type: "word" },
    { text: "!", start: 0.9, end: 1.0, type: "word" },
    { text: " ", start: 1.0, end: 1.05, type: "spacing" },
    { text: "你好", start: 1.05, end: 1.4, type: "word" },
    { text: "，", start: 1.4, end: 1.45, type: "word" },
    { text: "世界", start: 1.45, end: 1.9, type: "word" },
    { text: "。", start: 1.9, end: 2.0, type: "word" },
  ]));

  const subtitles = segmentIntoSubtitles(tokens, 42, 5);
  assert.deepEqual(
    subtitles.map((subtitle) => subtitle.text),
    ["Hello world!", "你好，世界。"],
  );
});

test("segmentIntoSubtitles breaks at speaker changes", () => {
  const tokens = createTokens(buildWords([
    { text: "Hi", start: 0, end: 0.35, type: "word", speaker_id: "speaker_0" },
    { text: " ", start: 0.35, end: 0.4, type: "spacing", speaker_id: "speaker_0" },
    { text: "there", start: 0.4, end: 0.8, type: "word", speaker_id: "speaker_0" },
    { text: " ", start: 0.8, end: 0.85, type: "spacing", speaker_id: "speaker_0" },
    { text: "Hello", start: 0.85, end: 1.2, type: "word", speaker_id: "speaker_1" },
    { text: ".", start: 1.2, end: 1.3, type: "word", speaker_id: "speaker_1" },
  ]));

  const subtitles = segmentIntoSubtitles(tokens, 42, 5);
  assert.deepEqual(
    subtitles.map((subtitle) => subtitle.text),
    ["Hi there", "Hello."],
  );
});

test("subtitlesFromAgentTranscript rebuilds subtitles from token ranges without losing timed tokens", () => {
  const tokens = createTokens(buildWords([
    { text: "Hello", start: 0, end: 0.4, type: "word" },
    { text: " ", start: 0.4, end: 0.45, type: "spacing" },
    { text: "world", start: 0.45, end: 0.9, type: "word" },
    { text: "!", start: 0.9, end: 1.0, type: "word" },
    { text: " ", start: 1.0, end: 1.05, type: "spacing" },
    { text: "How", start: 1.05, end: 1.3, type: "word" },
    { text: " ", start: 1.3, end: 1.35, type: "spacing" },
    { text: "are", start: 1.35, end: 1.6, type: "word" },
    { text: " ", start: 1.6, end: 1.65, type: "spacing" },
    { text: "you", start: 1.65, end: 1.9, type: "word" },
    { text: "?", start: 1.9, end: 2.0, type: "word" },
  ]));

  const transcript: AgentTranscript = {
    version: 2,
    source: {
      language_code: "en",
      language_probability: 1,
      text: "Hello world! How are you?",
    },
    settings: {
      max_chars: 42,
      max_duration: 5,
    },
    review: buildReview(),
    glossary: buildGlossary(),
    instructions: [],
    tokens,
    subtitles: [
      {
        token_start: 0,
        token_end: 3,
        word_start: 0,
        word_end: 3,
        start: 0,
        end: 1,
        text: "Hello, world!",
        speaker_ids: [],
      },
      {
        token_start: 5,
        token_end: 10,
        word_start: 5,
        word_end: 10,
        start: 1.05,
        end: 2,
        text: "How are you?",
        speaker_ids: [],
      },
    ],
  };

  const subtitles = subtitlesFromAgentTranscript(transcript);
  assert.deepEqual(
    subtitles.map((subtitle) => subtitle.text),
    ["Hello, world!", "How are you?"],
  );
  assert.deepEqual(
    subtitles.map((subtitle) => [subtitle.tokenStart, subtitle.tokenEnd]),
    [[0, 3], [5, 10]],
  );
});

test("parseGlossaryText supports canonical terms and aliases", () => {
  const glossary = parseGlossaryText(`
# comment
OpenAI | Open AI | Open A.I.
Sam Altman => Sam Alman, Sam Altmann
OpenAI
  `);

  assert.deepEqual(glossary, [
    { canonical: "OpenAI", aliases: ["Open AI", "Open A.I."] },
    { canonical: "Sam Altman", aliases: ["Sam Alman", "Sam Altmann"] },
  ]);
});

test("subtitlesFromAgentTranscript rejects leftover glossary aliases", () => {
  const tokens = createTokens(buildWords([
    { text: "Open", start: 0, end: 0.3, type: "word" },
    { text: " ", start: 0.3, end: 0.35, type: "spacing" },
    { text: "AI", start: 0.35, end: 0.7, type: "word" },
  ]));

  const transcript: AgentTranscript = {
    version: 2,
    source: {
      language_code: "en",
      language_probability: 1,
      text: "Open AI",
    },
    settings: {
      max_chars: 42,
      max_duration: 5,
    },
    review: buildReview(),
    glossary: buildGlossary([
      { canonical: "OpenAI", aliases: ["Open AI"] },
    ]),
    instructions: [],
    tokens,
    subtitles: [
      {
        token_start: 0,
        token_end: 2,
        word_start: 0,
        word_end: 2,
        start: 0,
        end: 0.7,
        text: "Open AI",
        speaker_ids: [],
      },
    ],
  };

  assert.throws(
    () => subtitlesFromAgentTranscript(transcript),
    /应统一为 "OpenAI"/,
  );
});

test("formatAgentJSON emits correction and glossary metadata", () => {
  const words = buildWords([
    { text: "Hello", start: 0, end: 0.4, type: "word" },
    { text: " ", start: 0.4, end: 0.45, type: "spacing" },
    { text: "world", start: 0.45, end: 0.9, type: "word" },
    { text: "!", start: 0.9, end: 1.0, type: "word" },
  ]);
  const tokens = createTokens(words);
  const subtitles = segmentIntoSubtitles(tokens, 42, 5);

  const json = JSON.parse(formatAgentJSON({
    language_code: "en",
    language_probability: 1,
    text: "Hello world!",
    words,
  }, tokens, subtitles, { maxChars: 42, maxDuration: 5 }, [
    { canonical: "OpenAI", aliases: ["Open AI"] },
  ])) as {
    instructions: string[];
    review: AgentTranscript["review"];
    glossary: AgentTranscript["glossary"];
  };

  assert.equal(json.review.allow_asr_corrections, true);
  assert.equal(json.review.require_term_consistency, true);
  assert.deepEqual(json.glossary.entries, [{ canonical: "OpenAI", aliases: ["Open AI"] }]);
  assert.deepEqual(json.glossary.candidates, []);
  assert.ok(json.instructions.some((line) => line.includes("完整句子、从句或自然停顿")));
  assert.ok(json.instructions.some((line) => line.includes("按 token range 重算")));
  assert.ok(json.instructions.some((line) => line.includes("ASR 错词")));
  assert.ok(json.instructions.some((line) => line.includes("glossary.candidates")));
  assert.ok(json.instructions.some((line) => line.includes("glossary.collected")));
});
