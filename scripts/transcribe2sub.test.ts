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
  normalizeWordsForSegmentation,
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
    normalization_diagnostics: [],
    unresolved_qa_policy: "warn",
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

test("segmentIntoSubtitles avoids flash cue splits inside a Japanese word", () => {
  const tokens = createTokens(buildWords([
    { text: "あ", start: 9.2, end: 9.5, type: "word", speaker_id: "speaker_2" },
    { text: "、", start: 9.5, end: 9.5, type: "word", speaker_id: "speaker_2" },
    { text: "お", start: 9.54, end: 9.62, type: "word", speaker_id: "speaker_2" },
    { text: "は", start: 9.62, end: 9.78, type: "word", speaker_id: "speaker_2" },
    { text: "よ", start: 10.86, end: 10.87, type: "word", speaker_id: "speaker_2" },
    { text: "う", start: 10.87, end: 10.87, type: "word", speaker_id: "speaker_2" },
    { text: "。", start: 10.87, end: 10.87, type: "word", speaker_id: "speaker_2" },
  ]));

  const subtitles = segmentIntoSubtitles(tokens, 22, 6, { languageCode: "ja" });

  assert.deepEqual(
    subtitles.map((subtitle) => subtitle.text),
    ["あ、おはよう。"],
  );
});

test("segmentIntoSubtitles no longer reproduces million_ep08 mid-word Japanese splits", () => {
  const tokens = createTokens(buildWords([
    { text: "今", start: 29.7, end: 29.88, type: "word", speaker_id: "speaker_1" },
    { text: "ね", start: 29.88, end: 29.98, type: "word", speaker_id: "speaker_1" },
    { text: "、", start: 29.98, end: 29.98, type: "word", speaker_id: "speaker_1" },
    { text: "現", start: 30.54, end: 30.74, type: "word", speaker_id: "speaker_1" },
    { text: "場", start: 30.74, end: 30.94, type: "word", speaker_id: "speaker_1" },
    { text: "で", start: 30.94, end: 31.04, type: "word", speaker_id: "speaker_1" },
    { text: "ど", start: 31.04, end: 31.12, type: "word", speaker_id: "speaker_1" },
    { text: "う", start: 31.12, end: 31.26, type: "word", speaker_id: "speaker_1" },
    { text: "す", start: 31.26, end: 31.4, type: "word", speaker_id: "speaker_1" },
    { text: "れ", start: 31.4, end: 31.48, type: "word", speaker_id: "speaker_1" },
    { text: "ば", start: 31.48, end: 31.6, type: "word", speaker_id: "speaker_1" },
    { text: "い", start: 31.6, end: 31.76, type: "word", speaker_id: "speaker_1" },
    { text: "い", start: 31.76, end: 31.88, type: "word", speaker_id: "speaker_1" },
    { text: "か", start: 31.88, end: 32.2, type: "word", speaker_id: "speaker_1" },
    { text: "桃", start: 32.2, end: 32.439, type: "word", speaker_id: "speaker_1" },
    { text: "子", start: 32.439, end: 32.6, type: "word", speaker_id: "speaker_1" },
    { text: "ち", start: 32.6, end: 32.64, type: "word", speaker_id: "speaker_1" },
    { text: "ゃ", start: 32.64, end: 32.74, type: "word", speaker_id: "speaker_1" },
    { text: "ん", start: 32.74, end: 32.78, type: "word", speaker_id: "speaker_1" },
    { text: "に", start: 32.78, end: 32.9, type: "word", speaker_id: "speaker_1" },
    { text: "教", start: 32.9, end: 33.1, type: "word", speaker_id: "speaker_1" },
    { text: "え", start: 33.1, end: 33.22, type: "word", speaker_id: "speaker_1" },
    { text: "て", start: 33.22, end: 33.28, type: "word", speaker_id: "speaker_1" },
    { text: "も", start: 33.28, end: 33.4, type: "word", speaker_id: "speaker_1" },
    { text: "ら", start: 33.4, end: 33.54, type: "word", speaker_id: "speaker_1" },
    { text: "っ", start: 33.54, end: 33.58, type: "word", speaker_id: "speaker_1" },
    { text: "て", start: 33.58, end: 33.699, type: "word", speaker_id: "speaker_1" },
    { text: "た", start: 33.7, end: 33.8, type: "word", speaker_id: "speaker_1" },
    { text: "ん", start: 33.8, end: 33.84, type: "word", speaker_id: "speaker_1" },
    { text: "だ", start: 33.84, end: 33.96, type: "word", speaker_id: "speaker_1" },
    { text: "よ", start: 33.96, end: 34.28, type: "word", speaker_id: "speaker_1" },
    { text: "。", start: 34.28, end: 34.28, type: "word", speaker_id: "speaker_1" },
  ]));

  const subtitles = segmentIntoSubtitles(tokens, 22, 6, { languageCode: "ja" });
  const texts = subtitles.map((subtitle) => subtitle.text);

  assert.equal(texts.includes("今ね、現場でどうすれ"), false);
  assert.equal(texts.includes("ばいいか桃子ちゃんに教えてもらってたんだよ。"), false);
});

test("segmentIntoSubtitles keeps katakana runs intact under CJK soft limits", () => {
  const tokens = createTokens(buildWords([
    { text: "き", start: 420.312, end: 420.452, type: "word", speaker_id: "speaker_8" },
    { text: "っ", start: 420.452, end: 420.552, type: "word", speaker_id: "speaker_8" },
    { text: "と", start: 420.552, end: 421.112, type: "word", speaker_id: "speaker_8" },
    { text: "ゴ", start: 421.112, end: 421.152, type: "word", speaker_id: "speaker_8" },
    { text: "ー", start: 421.152, end: 421.292, type: "word", speaker_id: "speaker_8" },
    { text: "ジ", start: 421.292, end: 421.332, type: "word", speaker_id: "speaker_8" },
    { text: "ャ", start: 421.332, end: 421.412, type: "word", speaker_id: "speaker_8" },
    { text: "ス", start: 421.412, end: 421.552, type: "word", speaker_id: "speaker_8" },
    { text: "な", start: 421.552, end: 421.652, type: "word", speaker_id: "speaker_8" },
    { text: "ス", start: 421.652, end: 421.732, type: "word", speaker_id: "speaker_8" },
    { text: "テ", start: 421.732, end: 421.812, type: "word", speaker_id: "speaker_8" },
    { text: "ー", start: 421.812, end: 421.912, type: "word", speaker_id: "speaker_8" },
    { text: "ジ", start: 421.912, end: 422.032, type: "word", speaker_id: "speaker_8" },
    { text: "に", start: 422.032, end: 422.331, type: "word", speaker_id: "speaker_8" },
    { text: "違", start: 422.332, end: 422.412, type: "word", speaker_id: "speaker_8" },
    { text: "い", start: 422.412, end: 422.492, type: "word", speaker_id: "speaker_8" },
    { text: "あ", start: 422.492, end: 422.592, type: "word", speaker_id: "speaker_8" },
    { text: "り", start: 422.592, end: 422.672, type: "word", speaker_id: "speaker_8" },
    { text: "ま", start: 422.672, end: 422.831, type: "word", speaker_id: "speaker_8" },
    { text: "せ", start: 422.832, end: 422.852, type: "word", speaker_id: "speaker_8" },
    { text: "ん", start: 422.852, end: 422.992, type: "word", speaker_id: "speaker_8" },
    { text: "わ", start: 422.992, end: 423.072, type: "word", speaker_id: "speaker_8" },
    { text: "ね", start: 423.072, end: 423.252, type: "word", speaker_id: "speaker_8" },
    { text: "。", start: 423.252, end: 423.252, type: "word", speaker_id: "speaker_8" },
  ]));

  const subtitles = segmentIntoSubtitles(tokens, 22, 6, { languageCode: "ja" });

  assert.deepEqual(
    subtitles.map((subtitle) => subtitle.text),
    ["きっとゴージャスなステージに違いありませんわね。"],
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

test("normalizeWordsForSegmentation splits mixed raw tokens and records diagnostics", () => {
  const { words, diagnostics } = normalizeWordsForSegmentation(buildWords([
    { text: "。CD", start: 596.372, end: 598.952, type: "word", speaker_id: "speaker_12" },
    { text: "。ま", start: 736.492, end: 745.102, type: "word", speaker_id: "speaker_0" },
  ]));

  assert.deepEqual(
    words.map((word) => word.text),
    ["。", "CD", "。", "ま"],
  );
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "mixed_raw_token" && diagnostic.raw_text === "。CD"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "mixed_raw_token" && diagnostic.raw_text === "。ま"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "long_short_token" && diagnostic.raw_text === "。ま"));
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

test("formatAgentJSON emits normalization diagnostics and subtitle qa flags", () => {
  const normalized = normalizeWordsForSegmentation(buildWords([
    { text: "渋", start: 0, end: 0.2, type: "word" },
    { text: "滞", start: 0.2, end: 0.4, type: "word" },
    { text: "。CD", start: 0.4, end: 1.4, type: "word" },
    { text: "が", start: 1.4, end: 1.5, type: "word" },
    { text: "届", start: 1.5, end: 1.7, type: "word" },
    { text: "く", start: 1.7, end: 1.9, type: "word" },
  ]));
  const tokens = createTokens(normalized.words);
  const subtitles = segmentIntoSubtitles(tokens, 22, 6, { languageCode: "ja" });

  const json = JSON.parse(formatAgentJSON({
    language_code: "ja",
    language_probability: 1,
    text: "渋滞。CDが届く",
    words: normalized.words,
  }, tokens, subtitles, { maxChars: 22, maxDuration: 6 }, [], normalized.diagnostics)) as {
    review: AgentTranscript["review"];
    subtitles: Array<{ qa_flags?: Array<{ code: string }> }>;
  };

  assert.equal(json.review.unresolved_qa_policy, "warn");
  assert.ok(json.review.normalization_diagnostics.some((diagnostic) => diagnostic.code === "mixed_raw_token"));
  assert.ok(json.subtitles.some((subtitle) => subtitle.qa_flags?.some((flag) => flag.code === "contains_mixed_raw_token")));
});
