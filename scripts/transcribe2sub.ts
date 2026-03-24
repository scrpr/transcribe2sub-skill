import { execFile } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { EnvHttpProxyAgent, FormData, ProxyAgent, fetch as undiciFetch } from "undici";

type TokenType = "word" | "spacing" | "audio_event";

export interface Word {
  text: string;
  start: number;
  end: number;
  type: TokenType;
  speaker_id?: string;
}

export interface Token extends Word {
  id: number;
}

interface TranscribeResponse {
  language_code: string;
  language_probability: number;
  text: string;
  words: Word[];
}

interface SubtitleDraft {
  tokenStart: number;
  tokenEnd: number;
  start: number;
  end: number;
  text: string;
}

export interface Subtitle extends SubtitleDraft {
  index: number;
  wordStart: number | null;
  wordEnd: number | null;
  speakerIds: string[];
}

interface JsonSubtitle {
  index?: number;
  token_start: number;
  token_end: number;
  word_start: number | null;
  word_end: number | null;
  start: number;
  end: number;
  text: string;
  speaker_ids: string[];
  qa_flags?: QaFlag[];
}

export interface GlossaryEntry {
  canonical: string;
  aliases: string[];
  note?: string;
}

type QaFlagCode =
  | "too_short"
  | "too_long"
  | "ends_mid_word"
  | "starts_mid_word"
  | "contains_mixed_raw_token"
  | "glossary_unresolved";

type QaSeverity = "info" | "warning" | "error";

interface QaFlag {
  code: QaFlagCode;
  severity: QaSeverity;
  message: string;
}

interface NormalizationDiagnostic {
  code: "mixed_raw_token" | "long_short_token" | "mixed_script_span";
  severity: QaSeverity;
  token_start: number;
  token_end: number;
  raw_text: string;
  message: string;
}

interface ReviewMetadata {
  allow_asr_corrections: boolean;
  require_term_consistency: boolean;
  checklist: string[];
  normalization_diagnostics: NormalizationDiagnostic[];
  unresolved_qa_policy: "warn" | "fail";
}

interface GlossaryState {
  entries: GlossaryEntry[];
  collected: GlossaryEntry[];
  candidates: GlossaryEntry[];
}

export interface AgentTranscript {
  version: 2;
  source: {
    language_code: string;
    language_probability: number;
    text: string;
  };
  settings: {
    max_chars: number;
    max_duration: number;
  };
  review: ReviewMetadata;
  glossary: GlossaryState;
  instructions: string[];
  tokens: Token[];
  subtitles: JsonSubtitle[];
}

interface Config {
  mode: "transcribe" | "render" | "rebuild";
  input?: string;
  fromJson?: string;
  fromRawJson?: string;
  output: string;
  language?: string;
  maxChars: number;
  maxDuration: number;
  glossary?: string;
  rawOutput?: string;
  proxy?: string;
  format: "srt" | "json";
}

interface TimedTokenRef {
  tokenIndex: number;
  token: Token;
}

interface SegmentationPolicy {
  isCjk: boolean;
  idealChars: number;
  softChars: number;
  hardChars: number;
  idealDuration: number;
  softDuration: number;
  hardDuration: number;
  minReadableChars: number;
  minDuration: number;
}

interface BoundaryInfo {
  isForbidden: boolean;
  isSentenceEnd: boolean;
  isClauseEnd: boolean;
  hasSpeakerChange: boolean;
  pause: number;
}

const PAUSE_THRESHOLD = 0.7;
const MIN_SEGMENT_DURATION = 0.35;
const SENTENCE_END = /[.!?。！？]$/;
const CLAUSE_END = /[,;:—，；：、]$/;
const LEADING_SPLIT_PUNCTUATION = /^[。！？!?、，；：]+/u;
const TRAILING_SPLIT_PUNCTUATION = /[。！？!?、，；：]+$/u;
const CJK_LANGUAGE_CODE = /^(ja|zh|ko)(-|$)/i;
const JAPANESE_PARTICLE_BOUNDARY = /[はがをにへともでかねよのだてで]$/u;
const LONG_SHORT_TOKEN_DURATION_THRESHOLD = 1.1;
const MIXED_TOKEN_PUNCTUATION_DURATION = 0.05;
const MIXED_TOKEN_CJK_CHAR_DURATION = 0.18;
const MIXED_TOKEN_LATIN_CHAR_DURATION = 0.12;
const MIXED_TOKEN_OTHER_CHAR_DURATION = 0.16;
const MIXED_TOKEN_MIN_CORE_DURATION = 0.12;
const MIXED_TOKEN_MAX_CORE_DURATION = 0.72;
const SUBTITLE_END_GUARD = 0.04;
const MIN_SUBTITLE_DISPLAY_DURATION = 0.5;
const SHORT_TAIL_CLIP_MULTIPLIER = 2.6;
const SHORT_TAIL_CLIP_FALLBACK_DURATION = 0.45;
const SHORT_TAIL_CLIP_MAX_DURATION = 0.6;
const SHORT_TAIL_CLIP_TRIGGER_RATIO = 3.5;
const PUNCTUATION_TAIL_DISPLAY_DURATION = 0.18;
const MAX_PUNCTUATION_TAIL_DISPLAY_DURATION = 0.24;
const TRANSCRIBE_MAX_ATTEMPTS = 3;
const TRANSCRIBE_RETRY_BASE_DELAY_MS = 1_000;
const TRANSCRIBE_RETRY_JITTER_MS = 250;
const RETRYABLE_TRANSCRIBE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_TRANSCRIBE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const DEFAULT_REVIEW_CHECKLIST = [
  "修正明显的 ASR 错词、同音误识别和专有名词拼写错误。",
  "在纠正 ASR 错词的同时，抽取人名、品牌名、产品名、地名和领域术语。",
  "先把待确认术语写入 glossary.candidates，再把确认过的 canonical 写法写入 glossary.collected。",
  "发现新术语时，将 canonical 写法记录到 glossary.collected，必要时补充 aliases。",
  "对重复出现的人名、队名、作品名和系列名，优先统一 canonical 写法；不确定时保留原文并留在 glossary.candidates。",
  "保持每条字幕的 token range 连续、完整且不重叠。",
] as const;

function fail(message: string): never {
  console.error(`[ERROR] ${message}`);
  process.exit(1);
}

export function defaultRawOutputPath(outputPath: string): string {
  return join(dirname(outputPath), `${basename(outputPath, extname(outputPath))}.elevenlabs.json`);
}

export class TranscribeRequestError extends Error {
  status?: number;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "TranscribeRequestError";
    this.status = status;
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (typeof error.code === "string") {
    return error.code;
  }
  if (isRecord(error.cause) && typeof error.cause.code === "string") {
    return error.cause.code;
  }
  return undefined;
}

export function isRetryableTranscribeError(error: unknown): boolean {
  if (error instanceof TranscribeRequestError && error.status !== undefined) {
    return RETRYABLE_TRANSCRIBE_STATUS_CODES.has(error.status);
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const code = errorCodeOf(error);
  if (code && RETRYABLE_TRANSCRIBE_ERROR_CODES.has(code)) {
    return true;
  }

  if (error.name === "TypeError" && error.message === "fetch failed") {
    return true;
  }

  return error.cause !== undefined ? isRetryableTranscribeError(error.cause) : false;
}

export function transcribeRetryDelayMs(
  attempt: number,
  options: { baseMs?: number; jitterMs?: number; random?: () => number } = {},
): number {
  const baseMs = options.baseMs ?? TRANSCRIBE_RETRY_BASE_DELAY_MS;
  const jitterMs = options.jitterMs ?? TRANSCRIBE_RETRY_JITTER_MS;
  const random = options.random ?? Math.random;
  const backoff = baseMs * (2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * jitterMs);
  return backoff + jitter;
}

export async function retryTranscribeRequest<T>(
  runAttempt: (attempt: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    jitterMs?: number;
    random?: () => number;
    sleepFn?: (ms: number) => Promise<unknown>;
    logFn?: (message: string) => void;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? TRANSCRIBE_MAX_ATTEMPTS));
  const sleepFn = options.sleepFn ?? sleep;
  const logFn = options.logFn ?? console.error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runAttempt(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableTranscribeError(error)) {
        throw error;
      }

      const delayMs = transcribeRetryDelayMs(attempt, {
        baseMs: options.baseDelayMs,
        jitterMs: options.jitterMs,
        random: options.random,
      });
      const reason = error instanceof Error ? error.message : String(error);
      logFn(`[WARN] ElevenLabs 请求失败，将在 ${delayMs}ms 后重试 (${attempt + 1}/${maxAttempts}): ${reason}`);
      await sleepFn(delayMs);
    }
  }

  throw new Error("重试逻辑意外结束");
}

function cli(): Config {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      language: { type: "string", short: "l" },
      "max-chars": { type: "string", default: "42" },
      "max-duration": { type: "string", default: "5.0" },
      "raw-output": { type: "string" },
      glossary: { type: "string" },
      proxy: { type: "string" },
      format: { type: "string", default: "srt" },
      "from-json": { type: "string" },
      "from-raw-json": { type: "string" },
    },
  });

  const input = positionals[0] ? resolve(positionals[0]) : undefined;
  const fromJson = values["from-json"] ? resolve(values["from-json"]) : undefined;
  const fromRawJson = values["from-raw-json"] ? resolve(values["from-raw-json"]) : undefined;
  const glossary = values.glossary ? resolve(values.glossary) : undefined;
  const rawOutputOption = values["raw-output"] ? resolve(values["raw-output"]) : undefined;

  const providedInputs = [input, fromJson, fromRawJson].filter(Boolean).length;
  if (providedInputs > 1) {
    fail("不能同时提供音频输入、--from-json 和 --from-raw-json");
  }

  if (providedInputs === 0) {
    fail("用法: transcribe2sub <audio_file> [options] 或 transcribe2sub --from-raw-json <elevenlabs.json> [options] 或 transcribe2sub --from-json <transcript.json> [-o output.srt]");
  }

  if (input && !existsSync(input)) {
    fail(`文件不存在: ${input}`);
  }

  if (fromJson && !existsSync(fromJson)) {
    fail(`JSON 文件不存在: ${fromJson}`);
  }
  if (fromRawJson && !existsSync(fromRawJson)) {
    fail(`原始 JSON 文件不存在: ${fromRawJson}`);
  }
  if (glossary && !existsSync(glossary)) {
    fail(`词表文件不存在: ${glossary}`);
  }
  if (fromJson && glossary) {
    fail("--glossary 仅用于生成 review JSON；回写 SRT 时请直接使用包含词表的 transcript JSON");
  }
  if (fromJson && rawOutputOption) {
    fail("--raw-output 仅用于音频转录时保存 ElevenLabs 原始 JSON");
  }
  if (fromRawJson && rawOutputOption) {
    fail("--raw-output 仅用于音频转录时保存 ElevenLabs 原始 JSON");
  }

  const maxChars = Number(values["max-chars"]);
  const maxDuration = Number(values["max-duration"]);
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    fail(`--max-chars 必须是正数，当前值: ${values["max-chars"]}`);
  }
  if (!Number.isFinite(maxDuration) || maxDuration <= 0) {
    fail(`--max-duration 必须是正数，当前值: ${values["max-duration"]}`);
  }

  const mode: Config["mode"] = fromJson ? "render" : fromRawJson ? "rebuild" : "transcribe";
  const format = mode === "render" ? "srt" : values.format === "json" ? "json" : "srt";
  const basePath = fromJson ?? fromRawJson ?? input!;
  const ext = format === "json" ? ".json" : ".srt";
  const output = values.output
    ? resolve(values.output)
    : join(resolve("."), basename(basePath, extname(basePath)) + ext);
  const rawOutput = mode === "transcribe" ? (rawOutputOption ?? defaultRawOutputPath(output)) : undefined;

  if (rawOutput && rawOutput === output) {
    fail("--raw-output 不能与主输出路径相同");
  }

  return {
    mode,
    input,
    fromJson,
    fromRawJson,
    output,
    language: values.language,
    maxChars,
    maxDuration,
    glossary,
    rawOutput,
    proxy: values.proxy,
    format,
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }

  return result;
}

function normalizeGlossaryEntry(entry: GlossaryEntry, context: string): GlossaryEntry {
  const canonical = entry.canonical.trim();
  if (!canonical) {
    throw new Error(`${context} 的 canonical 不能为空`);
  }

  const aliases = dedupeStrings(
    entry.aliases
      .map((alias) => alias.trim())
      .filter(Boolean)
      .filter((alias) => alias !== canonical),
  );
  const note = entry.note?.trim();

  return note ? { canonical, aliases, note } : { canonical, aliases };
}

function mergeGlossaryEntries(entries: GlossaryEntry[]): GlossaryEntry[] {
  const merged = new Map<string, GlossaryEntry>();

  for (const entry of entries) {
    const normalized = normalizeGlossaryEntry(entry, "词表项");
    const current = merged.get(normalized.canonical);
    if (!current) {
      merged.set(normalized.canonical, normalized);
      continue;
    }

    const note = current.note ?? normalized.note;
    merged.set(normalized.canonical, {
      canonical: normalized.canonical,
      aliases: dedupeStrings([...current.aliases, ...normalized.aliases]),
      ...(note ? { note } : {}),
    });
  }

  return [...merged.values()];
}

function splitAliasList(raw: string): string[] {
  return raw
    .split(/[|,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseGlossaryText(raw: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];

  for (const [index, originalLine] of raw.split(/\r?\n/).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    let canonical = line;
    let aliases: string[] = [];

    if (line.includes("=>")) {
      const [left, right] = line.split(/=>/, 2);
      canonical = left.trim();
      aliases = splitAliasList(right ?? "");
    } else if (line.includes("|")) {
      const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
      canonical = parts[0] ?? "";
      aliases = parts.slice(1);
    }

    entries.push(normalizeGlossaryEntry({ canonical, aliases }, `词表第 ${index + 1} 行`));
  }

  return mergeGlossaryEntries(entries);
}

function parseGlossaryEntryValue(value: unknown, context: string): GlossaryEntry {
  if (typeof value === "string") {
    return normalizeGlossaryEntry({ canonical: value, aliases: [] }, context);
  }
  if (!isRecord(value)) {
    throw new Error(`${context} 必须是字符串或对象`);
  }

  const canonical = value.canonical;
  const aliases = value.aliases;
  const note = value.note;

  if (typeof canonical !== "string") {
    throw new Error(`${context}.canonical 必须是字符串`);
  }
  if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((item) => typeof item !== "string"))) {
    throw new Error(`${context}.aliases 必须是字符串数组`);
  }
  if (note !== undefined && typeof note !== "string") {
    throw new Error(`${context}.note 必须是字符串`);
  }

  return normalizeGlossaryEntry({
    canonical,
    aliases: Array.isArray(aliases) ? aliases : [],
    note: typeof note === "string" ? note : undefined,
  }, context);
}

function parseGlossaryEntryList(value: unknown, context: string): GlossaryEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} 必须是数组`);
  }

  return mergeGlossaryEntries(value.map((entry, index) => parseGlossaryEntryValue(entry, `${context}[${index}]`)));
}

export async function readGlossaryFile(glossaryPath: string): Promise<GlossaryEntry[]> {
  const raw = await readFile(glossaryPath, "utf-8");
  if (extname(glossaryPath).toLowerCase() !== ".json") {
    return parseGlossaryText(raw);
  }

  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parseGlossaryEntryList(parsed, "glossary");
  }
  if (!isRecord(parsed)) {
    throw new Error("词表 JSON 必须是数组或对象");
  }
  if (Array.isArray(parsed.entries)) {
    return parseGlossaryEntryList(parsed.entries, "glossary.entries");
  }
  if (Array.isArray(parsed.provided)) {
    return parseGlossaryEntryList(parsed.provided, "glossary.provided");
  }

  throw new Error("词表 JSON 必须是数组，或包含 entries/provided 数组");
}

function parseWord(value: unknown, index: number): Word {
  if (!isRecord(value)) {
    throw new Error(`words[${index}] 不是对象`);
  }

  const { text, start, end, type, speaker_id } = value;
  if (typeof text !== "string") {
    throw new Error(`words[${index}].text 必须是字符串`);
  }
  if (typeof start !== "number" || typeof end !== "number" || start > end) {
    throw new Error(`words[${index}] 的时间戳无效`);
  }
  if (type !== "word" && type !== "spacing" && type !== "audio_event") {
    throw new Error(`words[${index}].type 无效`);
  }
  if (speaker_id !== undefined && typeof speaker_id !== "string") {
    throw new Error(`words[${index}].speaker_id 必须是字符串`);
  }

  return { text, start, end, type, speaker_id };
}

export function parseTranscribeResponse(value: unknown): TranscribeResponse {
  if (!isRecord(value)) {
    throw new Error("原始 ElevenLabs JSON 根节点必须是对象");
  }

  const { language_code, language_probability, text, words } = value;
  if (typeof language_code !== "string") {
    throw new Error("raw.language_code 必须是字符串");
  }
  if (typeof language_probability !== "number") {
    throw new Error("raw.language_probability 必须是数字");
  }
  if (typeof text !== "string") {
    throw new Error("raw.text 必须是字符串");
  }
  if (!Array.isArray(words)) {
    throw new Error("raw.words 必须是数组");
  }

  return {
    language_code,
    language_probability,
    text,
    words: words.map(parseWord),
  };
}

function isPunctuationChar(char: string): boolean {
  return /[\p{P}\p{S}]/u.test(char);
}

function isHiraganaChar(char: string): boolean {
  return /\p{Script=Hiragana}/u.test(char);
}

function isKatakanaChar(char: string): boolean {
  return /\p{Script=Katakana}/u.test(char) || char === "ー";
}

function isHanChar(char: string): boolean {
  return /\p{Script=Han}/u.test(char);
}

function isLatinChar(char: string): boolean {
  return /\p{Script=Latin}/u.test(char);
}

function isNumberChar(char: string): boolean {
  return /\p{Number}/u.test(char);
}

function textLength(text: string): number {
  return [...text].length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function firstContentChar(text: string): string | undefined {
  return [...text].find((char) => !/\s/u.test(char));
}

function lastContentChar(text: string): string | undefined {
  const chars = [...text].filter((char) => !/\s/u.test(char));
  return chars.at(-1);
}

function isJapaneseWordChar(char: string): boolean {
  return isHiraganaChar(char) || isKatakanaChar(char) || isHanChar(char) || "々ゝゞヽヾヶ".includes(char);
}

function textHasUnexpectedMixedScripts(text: string): boolean {
  const classes = new Set<"japanese" | "latin" | "number" | "other">();

  for (const char of text) {
    if (/\s/u.test(char) || isPunctuationChar(char)) {
      continue;
    }
    if (isJapaneseWordChar(char)) {
      classes.add("japanese");
      continue;
    }
    if (isLatinChar(char)) {
      classes.add("latin");
      continue;
    }
    if (isNumberChar(char)) {
      classes.add("number");
      continue;
    }
    classes.add("other");
  }

  if (classes.size <= 1) {
    return false;
  }

  return classes.has("japanese") || classes.has("other");
}

function visibleSpeechCharCount(text: string): number {
  let count = 0;
  for (const char of text) {
    if (/\s/u.test(char) || isPunctuationChar(char)) {
      continue;
    }
    count += 1;
  }
  return count;
}

function estimatedSpeechDuration(text: string): number {
  let duration = 0;
  let counted = false;

  for (const char of text) {
    if (/\s/u.test(char) || isPunctuationChar(char)) {
      continue;
    }

    counted = true;
    if (isJapaneseWordChar(char) || /\p{Script=Hangul}/u.test(char)) {
      duration += MIXED_TOKEN_CJK_CHAR_DURATION;
    } else if (isLatinChar(char) || isNumberChar(char)) {
      duration += MIXED_TOKEN_LATIN_CHAR_DURATION;
    } else {
      duration += MIXED_TOKEN_OTHER_CHAR_DURATION;
    }
  }

  if (!counted) {
    return 0;
  }

  return clamp(duration, MIXED_TOKEN_MIN_CORE_DURATION, MIXED_TOKEN_MAX_CORE_DURATION);
}

function buildMixedWordPieces(word: Word, leading: string, core: string, trailing: string): Word[] {
  const totalDuration = Math.max(0, word.end - word.start);
  const leadingChars = textLength(leading);
  const trailingChars = textLength(trailing);
  const leadingDuration = Math.min(totalDuration, leadingChars * MIXED_TOKEN_PUNCTUATION_DURATION);
  const trailingDuration = Math.min(
    Math.max(0, totalDuration - leadingDuration),
    trailingChars * MIXED_TOKEN_PUNCTUATION_DURATION,
  );
  const availableCoreDuration = Math.max(0, totalDuration - leadingDuration - trailingDuration);
  const coreDuration = Math.min(availableCoreDuration, estimatedSpeechDuration(core));
  const slackDuration = Math.max(0, totalDuration - leadingDuration - coreDuration - trailingDuration);
  const slackBeforeCore = leadingChars > 0 ? (trailingChars > 0 ? slackDuration / 2 : slackDuration) : 0;
  const slackAfterTrailing = trailingChars > 0 ? slackDuration - slackBeforeCore : 0;

  const pieces: Word[] = [];
  let cursor = word.start;

  if (leading) {
    pieces.push({ ...word, text: leading, start: cursor, end: cursor + leadingDuration });
    cursor += leadingDuration + slackBeforeCore;
  }

  pieces.push({ ...word, text: core, start: cursor, end: cursor + coreDuration });
  cursor += coreDuration;

  if (trailing) {
    pieces.push({ ...word, text: trailing, start: cursor, end: cursor + trailingDuration });
    cursor += trailingDuration + slackAfterTrailing;
  }

  return pieces;
}

function normalizeWordPieces(word: Word): Word[] {
  if (word.type !== "word" || textLength(word.text) <= 1) {
    return [word];
  }

  const leading = word.text.match(LEADING_SPLIT_PUNCTUATION)?.[0] ?? "";
  const trailing = word.text.match(TRAILING_SPLIT_PUNCTUATION)?.[0] ?? "";
  const coreEnd = trailing ? word.text.length - trailing.length : word.text.length;
  const core = word.text.slice(leading.length, coreEnd);

  if ((!leading && !trailing) || !core) {
    return [word];
  }

  return buildMixedWordPieces(word, leading, core, trailing);
}

export function normalizeWordsForSegmentation(words: Word[]): { words: Word[]; diagnostics: NormalizationDiagnostic[] } {
  const normalized: Word[] = [];
  const diagnostics: NormalizationDiagnostic[] = [];

  for (const word of words) {
    const tokenStart = normalized.length;
    const pieces = normalizeWordPieces(word);
    normalized.push(...pieces);
    const tokenEnd = normalized.length - 1;

    const isMixedRawToken = pieces.length > 1;
    if (isMixedRawToken) {
      diagnostics.push({
        code: "mixed_raw_token",
        severity: "warning",
        token_start: tokenStart,
        token_end: tokenEnd,
        raw_text: word.text,
        message: `原始 token "${word.text}" 已按边界标点拆分，review 时请确认断句与文本正常。`,
      });
    }

    if (word.type === "word" && textLength(word.text) <= 2 && word.end - word.start >= LONG_SHORT_TOKEN_DURATION_THRESHOLD) {
      diagnostics.push({
        code: "long_short_token",
        severity: "warning",
        token_start: tokenStart,
        token_end: tokenEnd,
        raw_text: word.text,
        message: `短 token "${word.text}" 持续时间异常偏长，可能需要在 review 中校对。`,
      });
    }

    if (word.type === "word" && textHasUnexpectedMixedScripts(word.text)) {
      diagnostics.push({
        code: "mixed_script_span",
        severity: "warning",
        token_start: tokenStart,
        token_end: tokenEnd,
        raw_text: word.text,
        message: `token "${word.text}" 含异常混合脚本，可能是 ASR 粘连或术语问题。`,
      });
    }
  }

  return { words: normalized, diagnostics };
}

async function readRawTranscribeResponse(jsonPath: string): Promise<TranscribeResponse> {
  const raw = await readFile(jsonPath, "utf-8");
  return parseTranscribeResponse(JSON.parse(raw) as unknown);
}

async function writeRawTranscribeResponse(jsonPath: string, response: unknown): Promise<void> {
  await writeFile(jsonPath, JSON.stringify(response, null, 2), "utf-8");
}

function createReviewMetadata(normalizationDiagnostics: NormalizationDiagnostic[] = []): ReviewMetadata {
  return {
    allow_asr_corrections: true,
    require_term_consistency: true,
    checklist: [...DEFAULT_REVIEW_CHECKLIST],
    normalization_diagnostics: normalizationDiagnostics,
    unresolved_qa_policy: "warn",
  };
}

function createGlossaryState(entries: GlossaryEntry[] = [], candidates: GlossaryEntry[] = []): GlossaryState {
  return {
    entries: mergeGlossaryEntries(entries),
    collected: [],
    candidates: mergeGlossaryEntries(candidates),
  };
}

function preprocessAudio(input: string): Promise<string> {
  return new Promise((resolvePath, reject) => {
    const out = join(tmpdir(), `t2s_${Date.now()}.m4a`);
    execFile(
      "ffmpeg",
      ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k", out],
      { timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          reject(new Error(`ffmpeg 失败: ${msg}`));
        } else {
          resolvePath(out);
        }
      },
    );
  });
}

export function buildTranscribeRequest(
  file: File,
  options: { language?: string; useUnauth?: boolean } = {},
): { url: URL; form: FormData } {
  const { language, useUnauth = false } = options;
  const url = new URL("https://api.elevenlabs.io/v1/speech-to-text");
  if (useUnauth) {
    url.searchParams.set("allow_unauthenticated", "1");
  }

  const form = new FormData();
  form.set("model_id", "scribe_v2");
  form.set("file", file);
  form.set("timestamps_granularity", "word");
  form.set("diarize", "true");
  if (language) {
    form.set("language_code", language);
  }

  return { url, form };
}

async function transcribeAudio(audioPath: string, config: Config): Promise<unknown> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const useUnauth = !apiKey;

  if (useUnauth) {
    console.error("[WARN] ELEVENLABS_API_KEY 未设置，使用免鉴权模式");
  }

  const fileBuffer = await readFile(audioPath);
  const headers: Record<string, string> = {};
  if (apiKey) headers["xi-api-key"] = apiKey;

  const proxyUrl = config.proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new EnvHttpProxyAgent();

  return await retryTranscribeRequest(async () => {
    // Rebuild multipart payloads for every attempt because upload bodies are single-use.
    const file = new File([fileBuffer], basename(audioPath), { type: "audio/mp4" });
    const { url, form } = buildTranscribeRequest(file, {
      language: config.language,
      useUnauth,
    });
    const res = await undiciFetch(url.toString(), {
      method: "POST",
      headers,
      body: form,
      dispatcher,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new TranscribeRequestError(`API 错误 (${res.status}): ${body}`, res.status);
    }

    return await res.json();
  });
}

export function createTokens(words: Word[]): Token[] {
  return words.map((word, index) => ({ ...word, id: index }));
}

function buildTimedTokenRefs(tokens: Token[]): TimedTokenRef[] {
  return tokens.flatMap((token, tokenIndex) => (token.type === "spacing" ? [] : [{ tokenIndex, token }]));
}

function hasCjkContent(tokens: Token[], languageCode?: string): boolean {
  if (languageCode && CJK_LANGUAGE_CODE.test(languageCode)) {
    return true;
  }

  let visibleChars = 0;
  let cjkChars = 0;
  for (const token of tokens) {
    if (token.type === "spacing") {
      continue;
    }
    for (const char of token.text) {
      if (/\s/u.test(char) || isPunctuationChar(char)) {
        continue;
      }
      visibleChars += 1;
      if (isJapaneseWordChar(char) || /\p{Script=Hangul}/u.test(char)) {
        cjkChars += 1;
      }
    }
  }

  return visibleChars > 0 && cjkChars / visibleChars >= 0.35;
}

function resolveSegmentationPolicy(
  tokens: Token[],
  maxChars: number,
  maxDuration: number,
  languageCode?: string,
): SegmentationPolicy {
  const isCjk = hasCjkContent(tokens, languageCode);

  if (!isCjk) {
    return {
      isCjk: false,
      idealChars: maxChars,
      softChars: maxChars,
      hardChars: Math.max(maxChars + 4, Math.round(maxChars * 1.15)),
      idealDuration: maxDuration,
      softDuration: maxDuration,
      hardDuration: Math.max(maxDuration + 0.8, maxDuration * 1.15),
      minReadableChars: 4,
      minDuration: MIN_SEGMENT_DURATION,
    };
  }

  const idealChars = Math.min(maxChars, 24);
  const softChars = Math.max(idealChars, Math.min(28, Math.max(idealChars + 4, 26)));
  const hardChars = Math.max(softChars, Math.min(32, Math.max(idealChars + 8, 30)));
  const idealDuration = Math.min(maxDuration, 8);
  const softDuration = Math.min(9, Math.max(idealDuration + 1, 7));
  const hardDuration = Math.min(10, Math.max(idealDuration + 2, 8));

  return {
    isCjk: true,
    idealChars,
    softChars,
    hardChars,
    idealDuration,
    softDuration,
    hardDuration,
    minReadableChars: 3,
    minDuration: 0.45,
  };
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function renderTokenRange(tokens: Token[], tokenStart: number, tokenEnd: number): string {
  return normalizeText(tokens.slice(tokenStart, tokenEnd + 1).map((token) => token.text).join(""));
}

function isPunctuationOnlyToken(token: Token): boolean {
  const text = token.text.trim();
  return text.length > 0 && [...text].every((char) => isPunctuationChar(char));
}

function collectSpeakerIds(tokens: Token[], tokenStart: number, tokenEnd: number): string[] {
  const speakerIds = new Set<string>();
  for (let i = tokenStart; i <= tokenEnd; i++) {
    const speakerId = tokens[i]?.speaker_id;
    if (speakerId) {
      speakerIds.add(speakerId);
    }
  }
  return [...speakerIds];
}

function findWordBounds(tokens: Token[], tokenStart: number, tokenEnd: number): { wordStart: number | null; wordEnd: number | null } {
  let wordStart: number | null = null;
  let wordEnd: number | null = null;
  for (let i = tokenStart; i <= tokenEnd; i++) {
    if (tokens[i]?.type === "word") {
      wordStart ??= tokens[i].id;
      wordEnd = tokens[i].id;
    }
  }
  return { wordStart, wordEnd };
}

function findNextTimedTokenAfter(tokens: Token[], tokenIndex: number): Token | undefined {
  for (let i = tokenIndex + 1; i < tokens.length; i++) {
    if (tokens[i] && tokens[i].type !== "spacing") {
      return tokens[i];
    }
  }
  return undefined;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }

  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    return null;
  }
  return (left + right) / 2;
}

function shortTailClipBudget(priorVisibleTokens: Token[]): number {
  const baseline = median(
    priorVisibleTokens
      .map((token) => token.end - token.start)
      .filter((duration) => duration > 0),
  );

  if (baseline === null) {
    return SHORT_TAIL_CLIP_FALLBACK_DURATION;
  }

  return clamp(
    baseline * SHORT_TAIL_CLIP_MULTIPLIER,
    SHORT_TAIL_CLIP_FALLBACK_DURATION,
    SHORT_TAIL_CLIP_MAX_DURATION,
  );
}

function shouldClipShortTailToken(token: Token, priorVisibleTokens: Token[]): boolean {
  if (token.type !== "word" || isPunctuationOnlyToken(token) || visibleSpeechCharCount(token.text) === 0) {
    return false;
  }

  if (visibleSpeechCharCount(token.text) > 2 || priorVisibleTokens.length === 0) {
    return false;
  }

  const duration = token.end - token.start;
  if (duration < LONG_SHORT_TOKEN_DURATION_THRESHOLD) {
    return false;
  }

  const baseline = median(
    priorVisibleTokens
      .map((priorToken) => priorToken.end - priorToken.start)
      .filter((priorDuration) => priorDuration > 0),
  );

  if (baseline === null) {
    return false;
  }

  return duration >= Math.max(SHORT_TAIL_CLIP_FALLBACK_DURATION * 1.5, baseline * SHORT_TAIL_CLIP_TRIGGER_RATIO);
}

function punctuationTailBudget(trailingPunctuationTokens: Token[]): number {
  const visiblePunctuationChars = trailingPunctuationTokens.reduce(
    (count, token) => count + textLength(token.text.trim()),
    0,
  );
  return clamp(
    Math.max(PUNCTUATION_TAIL_DISPLAY_DURATION, visiblePunctuationChars * 0.1),
    PUNCTUATION_TAIL_DISPLAY_DURATION,
    MAX_PUNCTUATION_TAIL_DISPLAY_DURATION,
  );
}

function resolveSubtitleEnd(
  tokens: Token[],
  tokenEnd: number,
  subtitleStart: number,
  timedTokens: Token[],
): number {
  const last = timedTokens.at(-1);
  if (!last) {
    return subtitleStart;
  }

  const nextTimedToken = findNextTimedTokenAfter(tokens, tokenEnd);
  const hardUpperBound = nextTimedToken
    ? Math.max(subtitleStart, nextTimedToken.start - SUBTITLE_END_GUARD)
    : Number.POSITIVE_INFINITY;
  const absoluteUpperBound = Math.min(last.end, hardUpperBound);

  let trailingPunctuationStart = timedTokens.length;
  while (trailingPunctuationStart > 0 && isPunctuationOnlyToken(timedTokens[trailingPunctuationStart - 1]!)) {
    trailingPunctuationStart -= 1;
  }

  const trailingPunctuationTokens = timedTokens.slice(trailingPunctuationStart);
  const anchor = trailingPunctuationStart > 0 ? timedTokens[trailingPunctuationStart - 1] : undefined;
  let desiredEnd = absoluteUpperBound;

  if (anchor && anchor.type !== "audio_event") {
    const priorVisibleTokens = timedTokens
      .slice(0, trailingPunctuationStart - 1)
      .filter((token) => token.type === "word" && !isPunctuationOnlyToken(token) && visibleSpeechCharCount(token.text) > 0);
    const anchorEnd = shouldClipShortTailToken(anchor, priorVisibleTokens)
      ? Math.min(anchor.end, anchor.start + shortTailClipBudget(priorVisibleTokens))
      : anchor.end;

    desiredEnd = trailingPunctuationTokens.length > 0
      ? Math.min(absoluteUpperBound, anchorEnd + punctuationTailBudget(trailingPunctuationTokens))
      : Math.min(absoluteUpperBound, anchorEnd);
  } else if (trailingPunctuationTokens.length > 0) {
    const firstTrailingPunctuation = trailingPunctuationTokens[0]!;
    desiredEnd = Math.min(
      absoluteUpperBound,
      firstTrailingPunctuation.start + punctuationTailBudget(trailingPunctuationTokens),
    );
  }

  if (desiredEnd >= absoluteUpperBound) {
    return absoluteUpperBound;
  }

  const minCueEnd = Math.min(absoluteUpperBound, subtitleStart + MIN_SUBTITLE_DISPLAY_DURATION);
  return Math.max(desiredEnd, minCueEnd);
}

function resolveTimedRange(tokens: Token[], tokenStart: number, tokenEnd: number): { start: number; end: number } {
  const timedTokens = tokens.slice(tokenStart, tokenEnd + 1).filter((token) => token.type !== "spacing");
  const first = timedTokens[0];

  if (!first || timedTokens.length === 0) {
    throw new Error(`字幕范围 ${tokenStart}-${tokenEnd} 不包含可计时 token`);
  }

  return { start: first.start, end: resolveSubtitleEnd(tokens, tokenEnd, first.start, timedTokens) };
}

function toSubtitle(tokens: Token[], tokenStart: number, tokenEnd: number, index: number, textOverride?: string): Subtitle {
  const { start, end } = resolveTimedRange(tokens, tokenStart, tokenEnd);
  const { wordStart, wordEnd } = findWordBounds(tokens, tokenStart, tokenEnd);
  const text = normalizeText(textOverride ?? renderTokenRange(tokens, tokenStart, tokenEnd));

  if (!text) {
    throw new Error(`字幕范围 ${tokenStart}-${tokenEnd} 生成了空文本`);
  }

  return {
    index,
    tokenStart,
    tokenEnd,
    wordStart,
    wordEnd,
    start,
    end,
    text,
    speakerIds: collectSpeakerIds(tokens, tokenStart, tokenEnd),
  };
}

function textForRefRange(tokens: Token[], refs: TimedTokenRef[], startRefIndex: number, endRefIndex: number): string {
  return renderTokenRange(tokens, refs[startRefIndex].tokenIndex, refs[endRefIndex].tokenIndex);
}

function durationForRefRange(refs: TimedTokenRef[], startRefIndex: number, endRefIndex: number): number {
  return refs[endRefIndex].token.end - refs[startRefIndex].token.start;
}

function gapAfter(refs: TimedTokenRef[], index: number): number {
  if (index >= refs.length - 1) {
    return 0;
  }
  return refs[index + 1].token.start - refs[index].token.end;
}

function hasSpeakerChangeAfter(refs: TimedTokenRef[], index: number): boolean {
  if (index >= refs.length - 1) {
    return false;
  }
  const current = refs[index].token.speaker_id;
  const next = refs[index + 1].token.speaker_id;
  return Boolean(current && next && current !== next);
}

function isTightlyBoundBoundary(leftText: string, rightText: string): boolean {
  const leftChar = lastContentChar(leftText);
  const rightChar = firstContentChar(rightText);
  if (!leftChar || !rightChar || isPunctuationChar(leftChar) || isPunctuationChar(rightChar)) {
    return false;
  }

  if (isNaturalJapaneseFallbackBoundary(leftText, rightText)) {
    return false;
  }

  if (isJapaneseWordChar(leftChar) && isJapaneseWordChar(rightChar)) {
    return true;
  }

  const leftIsAsciiWord = isLatinChar(leftChar) || isNumberChar(leftChar);
  const rightIsAsciiWord = isLatinChar(rightChar) || isNumberChar(rightChar);
  return leftIsAsciiWord && rightIsAsciiWord;
}

function isNaturalJapaneseFallbackBoundary(leftText: string, rightText: string): boolean {
  const leftChar = lastContentChar(leftText);
  const rightChar = firstContentChar(rightText);
  if (!leftChar || !rightChar || !isJapaneseWordChar(leftChar) || !isJapaneseWordChar(rightChar)) {
    return false;
  }

  if (JAPANESE_PARTICLE_BOUNDARY.test(leftChar) && !isHiraganaChar(rightChar)) {
    return true;
  }

  return isKatakanaChar(leftChar) && isHanChar(rightChar);
}

function buildBoundaryInfo(left: Token, right: Token | undefined, pause: number, hasSpeakerChange: boolean): BoundaryInfo {
  const isSentenceEnd = SENTENCE_END.test(left.text);
  const isClauseEnd = CLAUSE_END.test(left.text);
  const isForbidden = right !== undefined && !hasSpeakerChange && !isSentenceEnd && !isClauseEnd
    && isTightlyBoundBoundary(left.text, right.text);

  return {
    isForbidden,
    isSentenceEnd,
    isClauseEnd,
    hasSpeakerChange,
    pause,
  };
}

function analyzeBoundary(refs: TimedTokenRef[], index: number): BoundaryInfo {
  if (index >= refs.length - 1) {
    return buildBoundaryInfo(refs[index].token, undefined, 0, false);
  }

  return buildBoundaryInfo(
    refs[index].token,
    refs[index + 1].token,
    gapAfter(refs, index),
    hasSpeakerChangeAfter(refs, index),
  );
}

function scoreRangeAgainstPolicy(chars: number, duration: number, policy: SegmentationPolicy): number {
  let score = 0;

  score -= Math.abs(chars - policy.idealChars) * (policy.isCjk ? 1.25 : 0.45);
  score -= Math.abs(duration - policy.idealDuration) * 6;

  if (chars >= policy.minReadableChars && chars <= policy.softChars) {
    score += 18;
  }
  if (duration >= policy.minDuration && duration <= policy.softDuration) {
    score += 18;
  }

  return score;
}

function shouldHardBreakAfter(
  tokens: Token[],
  refs: TimedTokenRef[],
  segmentStart: number,
  index: number,
  policy: SegmentationPolicy,
): boolean {
  if (index >= refs.length - 1) {
    return true;
  }

  const boundary = analyzeBoundary(refs, index);
  if (boundary.isSentenceEnd || boundary.hasSpeakerChange) {
    return true;
  }
  if (boundary.isForbidden) {
    return false;
  }

  const chars = textLength(textForRefRange(tokens, refs, segmentStart, index));
  const duration = durationForRefRange(refs, segmentStart, index);

  if (boundary.isClauseEnd) {
    return chars >= Math.max(policy.minReadableChars, Math.floor(policy.idealChars * 0.45))
      || duration >= Math.max(policy.minDuration, policy.idealDuration * 0.5);
  }

  if (boundary.pause > PAUSE_THRESHOLD) {
    return chars >= Math.max(policy.minReadableChars, Math.floor(policy.idealChars * 0.6))
      || duration >= Math.max(policy.minDuration, policy.idealDuration * 0.6);
  }

  return false;
}

function findBestSplitRefIndex(
  tokens: Token[],
  refs: TimedTokenRef[],
  startRefIndex: number,
  endRefIndex: number,
  policy: SegmentationPolicy,
  allowForbidden: boolean,
): number | null {
  let bestIndex: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = startRefIndex; i < endRefIndex; i++) {
    const leftText = textForRefRange(tokens, refs, startRefIndex, i);
    const rightText = textForRefRange(tokens, refs, i + 1, endRefIndex);
    const leftChars = textLength(leftText);
    const rightChars = textLength(rightText);
    const leftDuration = durationForRefRange(refs, startRefIndex, i);
    const rightDuration = durationForRefRange(refs, i + 1, endRefIndex);

    if (leftDuration < policy.minDuration || rightDuration < policy.minDuration) {
      continue;
    }

    const boundary = analyzeBoundary(refs, i);
    if (!allowForbidden && boundary.isForbidden) {
      continue;
    }

    let score = scoreRangeAgainstPolicy(leftChars, leftDuration, policy)
      + scoreRangeAgainstPolicy(rightChars, rightDuration, policy);

    if (boundary.isSentenceEnd) {
      score += 220;
    } else if (boundary.isClauseEnd) {
      score += 140;
    }

    if (boundary.hasSpeakerChange) {
      score += 180;
    }

    if (boundary.pause > PAUSE_THRESHOLD) {
      score += 70 + Math.min(80, Math.max(0, boundary.pause - PAUSE_THRESHOLD) * 40);
    }

    if (policy.isCjk && isNaturalJapaneseFallbackBoundary(refs[i].token.text, refs[i + 1].token.text)) {
      score += 55;
    }

    if (boundary.isForbidden) {
      score -= allowForbidden ? 160 : 320;
    }

    if (leftChars > policy.hardChars || rightChars > policy.hardChars) {
      score -= 200;
    }
    if (leftDuration > policy.hardDuration || rightDuration > policy.hardDuration) {
      score -= 220;
    }

    score -= Math.abs(leftChars - rightChars) * (policy.isCjk ? 0.35 : 0.15);

    if (!boundary.isSentenceEnd && !boundary.isClauseEnd && !boundary.hasSpeakerChange
      && boundary.pause <= PAUSE_THRESHOLD && !isNaturalJapaneseFallbackBoundary(refs[i].token.text, refs[i + 1].token.text)) {
      score -= 25;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === null) {
    return null;
  }

  if (!allowForbidden && bestScore < 10) {
    return null;
  }

  return bestIndex;
}

function speakerSetsOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return true;
  }
  return left.some((speakerId) => right.includes(speakerId));
}

function canMergeSubtitles(tokens: Token[], left: Subtitle, right: Subtitle, policy: SegmentationPolicy): boolean {
  if (!speakerSetsOverlap(left.speakerIds, right.speakerIds)) {
    return false;
  }
  if (right.start - left.end > PAUSE_THRESHOLD * 1.5) {
    return false;
  }

  const merged = toSubtitle(tokens, left.tokenStart, right.tokenEnd, 0);
  if (textLength(merged.text) > policy.hardChars || merged.end - merged.start > policy.hardDuration) {
    return false;
  }

  const lastTimedToken = [...tokens.slice(left.tokenStart, left.tokenEnd + 1)].reverse().find((token) => token.type !== "spacing");
  const firstTimedToken = tokens.slice(right.tokenStart, right.tokenEnd + 1).find((token) => token.type !== "spacing");
  if (!lastTimedToken || !firstTimedToken) {
    return false;
  }

  const boundary = buildBoundaryInfo(
    lastTimedToken,
    firstTimedToken,
    Math.max(0, firstTimedToken.start - lastTimedToken.end),
    Boolean(lastTimedToken.speaker_id && firstTimedToken.speaker_id && lastTimedToken.speaker_id !== firstTimedToken.speaker_id),
  );

  return boundary.isForbidden || (!boundary.isSentenceEnd && !boundary.hasSpeakerChange);
}

function scoreMergedSubtitle(subtitle: Subtitle, policy: SegmentationPolicy): number {
  return scoreRangeAgainstPolicy(textLength(subtitle.text), subtitle.end - subtitle.start, policy);
}

function rebalanceSubtitles(tokens: Token[], subtitles: Subtitle[], policy: SegmentationPolicy): Subtitle[] {
  const queue = [...subtitles];
  let changed = true;

  while (changed) {
    changed = false;

    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if (!current) {
        continue;
      }

      const chars = textLength(current.text);
      const duration = current.end - current.start;
      const isFlashCue = chars <= 2 || duration < policy.minDuration || (chars <= 4 && duration < 0.75);
      if (!isFlashCue) {
        continue;
      }

      const left = index > 0 ? queue[index - 1] : undefined;
      const right = index < queue.length - 1 ? queue[index + 1] : undefined;
      const candidates: Array<{ direction: "left" | "right"; merged: Subtitle; score: number }> = [];

      if (left && canMergeSubtitles(tokens, left, current, policy)) {
        const merged = toSubtitle(tokens, left.tokenStart, current.tokenEnd, 0);
        candidates.push({ direction: "left", merged, score: scoreMergedSubtitle(merged, policy) });
      }

      if (right && canMergeSubtitles(tokens, current, right, policy)) {
        const merged = toSubtitle(tokens, current.tokenStart, right.tokenEnd, 0);
        candidates.push({ direction: "right", merged, score: scoreMergedSubtitle(merged, policy) });
      }

      if (candidates.length === 0) {
        continue;
      }

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (!best) {
        continue;
      }

      if (best.direction === "left") {
        queue.splice(index - 1, 2, best.merged);
      } else {
        queue.splice(index, 2, best.merged);
      }
      changed = true;
      break;
    }
  }

  return queue.map((subtitle, index) => ({ ...subtitle, index: index + 1 }));
}

export function segmentIntoSubtitles(
  tokens: Token[],
  maxChars: number,
  maxDuration: number,
  options: { languageCode?: string } = {},
): Subtitle[] {
  const refs = buildTimedTokenRefs(tokens);
  if (refs.length === 0) {
    return [];
  }

  const policy = resolveSegmentationPolicy(tokens, maxChars, maxDuration, options.languageCode);
  const subtitles: Subtitle[] = [];
  let segmentStart = 0;
  let i = 0;

  while (i < refs.length) {
    const text = textForRefRange(tokens, refs, segmentStart, i);
    const chars = textLength(text);
    const duration = durationForRefRange(refs, segmentStart, i);
    const softOverflow = i > segmentStart && (chars > policy.softChars || duration > policy.softDuration);
    const hardOverflow = i > segmentStart && (chars > policy.hardChars || duration > policy.hardDuration);

    if (softOverflow) {
      const preferredSplit = findBestSplitRefIndex(tokens, refs, segmentStart, i, policy, false);
      if (preferredSplit !== null) {
        subtitles.push(
          toSubtitle(tokens, refs[segmentStart].tokenIndex, refs[preferredSplit].tokenIndex, subtitles.length + 1),
        );
        segmentStart = preferredSplit + 1;
        continue;
      }

      if (hardOverflow) {
        const fallbackSplit = findBestSplitRefIndex(tokens, refs, segmentStart, i, policy, true) ?? (i - 1);
        subtitles.push(
          toSubtitle(tokens, refs[segmentStart].tokenIndex, refs[fallbackSplit].tokenIndex, subtitles.length + 1),
        );
        segmentStart = fallbackSplit + 1;
        continue;
      }
    }

    if (shouldHardBreakAfter(tokens, refs, segmentStart, i, policy)) {
      subtitles.push(
        toSubtitle(tokens, refs[segmentStart].tokenIndex, refs[i].tokenIndex, subtitles.length + 1),
      );
      segmentStart = i + 1;
    }

    i += 1;
  }

  return rebalanceSubtitles(tokens, subtitles, policy);
}

function findFirstTimedTokenInRange(tokens: Token[], tokenStart: number, tokenEnd: number): Token | undefined {
  return tokens.slice(tokenStart, tokenEnd + 1).find((token) => token.type !== "spacing");
}

function findLastTimedTokenInRange(tokens: Token[], tokenStart: number, tokenEnd: number): Token | undefined {
  return [...tokens.slice(tokenStart, tokenEnd + 1)].reverse().find((token) => token.type !== "spacing");
}

function overlapsTokenRange(
  subtitle: Pick<Subtitle, "tokenStart" | "tokenEnd">,
  tokenStart: number,
  tokenEnd: number,
): boolean {
  return subtitle.tokenStart <= tokenEnd && subtitle.tokenEnd >= tokenStart;
}

function subtitleContainsGlossaryEntry(text: string, entry: GlossaryEntry): boolean {
  return text.includes(entry.canonical) || entry.aliases.some((alias) => text.includes(alias));
}

function unresolvedGlossaryEntries(glossary: GlossaryState): GlossaryEntry[] {
  const resolvedCanonicals = new Set(combinedGlossaryEntries(glossary).map((entry) => entry.canonical));
  return mergeGlossaryEntries(glossary.candidates).filter((entry) => !resolvedCanonicals.has(entry.canonical));
}

function dedupeQaFlags(flags: QaFlag[]): QaFlag[] {
  const seen = new Set<string>();
  const result: QaFlag[] = [];

  for (const flag of flags) {
    const key = `${flag.code}:${flag.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(flag);
  }

  return result;
}

function collectSubtitleQaFlags(
  tokens: Token[],
  subtitles: Subtitle[],
  review: ReviewMetadata,
  glossary: GlossaryState,
  config: Pick<Config, "maxChars" | "maxDuration">,
  languageCode?: string,
): QaFlag[][] {
  const policy = resolveSegmentationPolicy(tokens, config.maxChars, config.maxDuration, languageCode);
  const flagsBySubtitle = subtitles.map((): QaFlag[] => []);
  const pendingGlossary = unresolvedGlossaryEntries(glossary);

  for (const [index, subtitle] of subtitles.entries()) {
    const chars = textLength(subtitle.text);
    const duration = subtitle.end - subtitle.start;

    if (chars < policy.minReadableChars || duration < policy.minDuration) {
      flagsBySubtitle[index]?.push({
        code: "too_short",
        severity: "warning",
        message: `字幕过短（${chars} chars / ${duration.toFixed(2)}s），建议与相邻字幕一起检查。`,
      });
    }

    if (chars > policy.softChars || duration > policy.softDuration) {
      flagsBySubtitle[index]?.push({
        code: "too_long",
        severity: "warning",
        message: `字幕偏长（${chars} chars / ${duration.toFixed(2)}s），建议检查是否能在自然边界拆分。`,
      });
    }

    for (const diagnostic of review.normalization_diagnostics) {
      if (diagnostic.code !== "mixed_raw_token") {
        continue;
      }
      if (overlapsTokenRange(subtitle, diagnostic.token_start, diagnostic.token_end)) {
        flagsBySubtitle[index]?.push({
          code: "contains_mixed_raw_token",
          severity: diagnostic.severity,
          message: diagnostic.message,
        });
      }
    }

    if (pendingGlossary.some((entry) => subtitleContainsGlossaryEntry(subtitle.text, entry))) {
      flagsBySubtitle[index]?.push({
        code: "glossary_unresolved",
        severity: "warning",
        message: "该字幕涉及尚未确认的 glossary.candidates 条目，review 后请提升到 glossary.collected 或删除候选。",
      });
    }
  }

  for (let index = 0; index < subtitles.length - 1; index++) {
    const current = subtitles[index];
    const next = subtitles[index + 1];
    if (!current || !next) {
      continue;
    }

    const leftToken = findLastTimedTokenInRange(tokens, current.tokenStart, current.tokenEnd);
    const rightToken = findFirstTimedTokenInRange(tokens, next.tokenStart, next.tokenEnd);
    if (!leftToken || !rightToken) {
      continue;
    }

    const boundary = buildBoundaryInfo(
      leftToken,
      rightToken,
      Math.max(0, rightToken.start - leftToken.end),
      Boolean(leftToken.speaker_id && rightToken.speaker_id && leftToken.speaker_id !== rightToken.speaker_id),
    );

    if (boundary.isForbidden) {
      flagsBySubtitle[index]?.push({
        code: "ends_mid_word",
        severity: "error",
        message: "该字幕在紧密绑定的词/短语内部结束，建议回退到更自然的边界。",
      });
      flagsBySubtitle[index + 1]?.push({
        code: "starts_mid_word",
        severity: "error",
        message: "该字幕从紧密绑定的词/短语中间开始，建议与前后字幕一起调整。",
      });
    }
  }

  return flagsBySubtitle.map(dedupeQaFlags);
}

function summarizeQaWarnings(subtitles: Subtitle[], qaFlags: QaFlag[][]): string[] {
  const lines: string[] = [];

  for (const [index, flags] of qaFlags.entries()) {
    const severeFlags = flags.filter((flag) => flag.severity === "error");
    if (severeFlags.length === 0) {
      continue;
    }

    const subtitle = subtitles[index];
    if (!subtitle) {
      continue;
    }

    lines.push(`字幕 ${subtitle.index}: ${severeFlags.map((flag) => flag.code).join(", ")} (${subtitle.text})`);
  }

  return lines;
}

function buildArtifactsFromResponse(
  response: TranscribeResponse,
  config: Pick<Config, "maxChars" | "maxDuration" | "format">,
  glossaryEntries: GlossaryEntry[] = [],
): { tokens: Token[]; subtitles: Subtitle[]; content: string } {
  const { words, diagnostics } = normalizeWordsForSegmentation(response.words);
  const tokens = createTokens(words);
  console.error(`[INFO] 转录完成，语言: ${response.language_code}，可计时 token 数: ${tokens.filter((token) => token.type !== "spacing").length}`);
  if (diagnostics.length > 0) {
    console.error(`[WARN] 检测到 ${diagnostics.length} 个可疑 raw token，已写入 review.normalization_diagnostics`);
  }

  const subtitles = segmentIntoSubtitles(tokens, config.maxChars, config.maxDuration, { languageCode: response.language_code });
  console.error(`[INFO] 分段完成，共 ${subtitles.length} 条字幕`);

  const content = config.format === "json"
    ? formatAgentJSON(response, tokens, subtitles, config, glossaryEntries, diagnostics)
    : formatSRT(subtitles);

  return { tokens, subtitles, content };
}

function toJsonSubtitle(subtitle: Subtitle, qaFlags: QaFlag[] = []): JsonSubtitle {
  return {
    index: subtitle.index,
    token_start: subtitle.tokenStart,
    token_end: subtitle.tokenEnd,
    word_start: subtitle.wordStart,
    word_end: subtitle.wordEnd,
    start: subtitle.start,
    end: subtitle.end,
    text: subtitle.text,
    speaker_ids: subtitle.speakerIds,
    qa_flags: qaFlags,
  };
}

export function formatTimestamp(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1_000);
  const ms = totalMs % 1_000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function formatSRT(subtitles: Subtitle[]): string {
  return subtitles
    .map((subtitle) => `${subtitle.index}\n${formatTimestamp(subtitle.start)} --> ${formatTimestamp(subtitle.end)}\n${subtitle.text}\n`)
    .join("\n");
}

export function formatAgentJSON(
  response: TranscribeResponse,
  tokens: Token[],
  subtitles: Subtitle[],
  config: Pick<Config, "maxChars" | "maxDuration">,
  glossaryEntries: GlossaryEntry[] = [],
  normalizationDiagnostics: NormalizationDiagnostic[] = [],
): string {
  const review = createReviewMetadata(normalizationDiagnostics);
  const glossary = createGlossaryState(glossaryEntries);
  const qaFlags = collectSubtitleQaFlags(tokens, subtitles, review, glossary, config, response.language_code);

  const payload: AgentTranscript = {
    version: 2,
    source: {
      language_code: response.language_code,
      language_probability: response.language_probability,
      text: response.text,
    },
    settings: {
      max_chars: config.maxChars,
      max_duration: config.maxDuration,
    },
    review,
    glossary,
    instructions: [
      "先保证转写内容忠实和时间轴准确，再优化断句、标点和可读性。",
      "允许在 subtitles[].text 中修正明显的 ASR 错词、同音误识别和术语拼写错误，但不要脱离当前 token range 总结或扩写。",
      "在纠正 ASR 错词的同时，主动抽取人名、品牌名、产品名、地名和领域术语，先写入 glossary.candidates，再把确认过的 canonical 写法写入 glossary.collected。",
      "优先使用 glossary.entries 与 glossary.collected 中的 canonical 写法；glossary.candidates 只是 review 阶段的暂存区。",
      "如果字幕上带有 qa_flags，优先处理 ends_mid_word / starts_mid_word / contains_mixed_raw_token / glossary_unresolved 这些提示。",
      "优先让每条字幕对应完整句子、从句或自然停顿；不要跨 speaker change 强行合并。",
      "只修改 subtitles[].token_start、subtitles[].token_end、subtitles[].text。",
      "不要修改 tokens[].id、tokens[].start、tokens[].end、tokens[].type、tokens[].speaker_id。",
      "subtitles[].start、subtitles[].end、word_*、speaker_ids 是派生预览字段，渲染时会按 token range 重算。",
      "每个非 spacing token 必须且只能属于一条字幕，不能丢词或重叠；纠错应仅限于当前时段内真实说出的内容。",
      "subtitles[].text 是最终展示文本，可修正错词、标点、大小写和换行，并保持术语前后一致。",
      "对重复出现的人名、队名、作品名和系列名，先写入 glossary.candidates；确认后再提升到 glossary.collected。",
      "术语不确定时不要猜，保留原文并让 glossary.candidates 或 qa_flags 标出待确认项。",
    ],
    tokens,
    subtitles: subtitles.map((subtitle, index) => toJsonSubtitle(subtitle, qaFlags[index] ?? [])),
  };

  return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function parseToken(value: unknown, index: number): Token {
  if (!isRecord(value)) {
    throw new Error(`tokens[${index}] 不是对象`);
  }

  const { id, text, start, end, type, speaker_id } = value;
  if (!isInteger(id) || id !== index) {
    throw new Error(`tokens[${index}].id 必须与数组下标一致`);
  }
  if (typeof text !== "string") {
    throw new Error(`tokens[${index}].text 必须是字符串`);
  }
  if (typeof start !== "number" || typeof end !== "number" || start > end) {
    throw new Error(`tokens[${index}] 的时间戳无效`);
  }
  if (type !== "word" && type !== "spacing" && type !== "audio_event") {
    throw new Error(`tokens[${index}].type 无效`);
  }
  if (speaker_id !== undefined && typeof speaker_id !== "string") {
    throw new Error(`tokens[${index}].speaker_id 必须是字符串`);
  }

  return { id, text, start, end, type, speaker_id };
}

function parseJsonSubtitle(value: unknown, index: number): JsonSubtitle {
  if (!isRecord(value)) {
    throw new Error(`subtitles[${index}] 不是对象`);
  }

  const tokenStart = value.token_start;
  const tokenEnd = value.token_end;
  const text = value.text;
  const wordStart = value.word_start;
  const wordEnd = value.word_end;
  const start = value.start;
  const end = value.end;
  const speakerIds = value.speaker_ids;
  const subtitleIndex = value.index;
  const qaFlags = value.qa_flags;

  if (!isInteger(tokenStart) || !isInteger(tokenEnd)) {
    throw new Error(`subtitles[${index}] 的 token range 无效`);
  }
  if (tokenStart > tokenEnd) {
    throw new Error(`subtitles[${index}] 的 token range 无效`);
  }
  if (typeof text !== "string") {
    throw new Error(`subtitles[${index}].text 必须是字符串`);
  }
  if (wordStart !== null && wordStart !== undefined && !isInteger(wordStart)) {
    throw new Error(`subtitles[${index}].word_start 必须是整数或 null`);
  }
  if (wordEnd !== null && wordEnd !== undefined && !isInteger(wordEnd)) {
    throw new Error(`subtitles[${index}].word_end 必须是整数或 null`);
  }
  if (start !== undefined && typeof start !== "number") {
    throw new Error(`subtitles[${index}].start 必须是数字`);
  }
  if (end !== undefined && typeof end !== "number") {
    throw new Error(`subtitles[${index}].end 必须是数字`);
  }
  if (speakerIds !== undefined && (!Array.isArray(speakerIds) || speakerIds.some((item) => typeof item !== "string"))) {
    throw new Error(`subtitles[${index}].speaker_ids 必须是字符串数组`);
  }
  if (qaFlags !== undefined && (!Array.isArray(qaFlags) || qaFlags.some((item) => !isRecord(item)))) {
    throw new Error(`subtitles[${index}].qa_flags 必须是对象数组`);
  }

  const tokenStartValue = tokenStart as number;
  const tokenEndValue = tokenEnd as number;
  const subtitleIndexValue = isInteger(subtitleIndex) ? subtitleIndex : index + 1;

  return {
    index: subtitleIndexValue,
    token_start: tokenStartValue,
    token_end: tokenEndValue,
    word_start: wordStart === undefined ? null : (wordStart as number | null),
    word_end: wordEnd === undefined ? null : (wordEnd as number | null),
    start: typeof start === "number" ? start : 0,
    end: typeof end === "number" ? end : 0,
    text,
    speaker_ids: Array.isArray(speakerIds) ? (speakerIds as string[]) : [],
    qa_flags: Array.isArray(qaFlags) ? qaFlags.map(parseQaFlag) : [],
  };
}

function parseNormalizationDiagnostic(value: unknown, index: number): NormalizationDiagnostic {
  if (!isRecord(value)) {
    throw new Error(`review.normalization_diagnostics[${index}] 不是对象`);
  }

  const code = value.code;
  const severity = value.severity;
  const tokenStart = value.token_start;
  const tokenEnd = value.token_end;
  const rawText = value.raw_text;
  const message = value.message;

  if (code !== "mixed_raw_token" && code !== "long_short_token" && code !== "mixed_script_span") {
    throw new Error(`review.normalization_diagnostics[${index}].code 无效`);
  }
  if (severity !== "info" && severity !== "warning" && severity !== "error") {
    throw new Error(`review.normalization_diagnostics[${index}].severity 无效`);
  }
  if (!isInteger(tokenStart) || !isInteger(tokenEnd) || tokenStart > tokenEnd) {
    throw new Error(`review.normalization_diagnostics[${index}] 的 token range 无效`);
  }
  if (typeof rawText !== "string" || typeof message !== "string") {
    throw new Error(`review.normalization_diagnostics[${index}] 缺少 raw_text 或 message`);
  }

  return {
    code,
    severity,
    token_start: tokenStart,
    token_end: tokenEnd,
    raw_text: rawText,
    message,
  };
}

function parseQaFlag(value: unknown): QaFlag {
  if (!isRecord(value)) {
    throw new Error("qa_flag 不是对象");
  }

  const code = value.code;
  const severity = value.severity;
  const message = value.message;

  if (
    code !== "too_short"
    && code !== "too_long"
    && code !== "ends_mid_word"
    && code !== "starts_mid_word"
    && code !== "contains_mixed_raw_token"
    && code !== "glossary_unresolved"
  ) {
    throw new Error("qa_flag.code 无效");
  }
  if (severity !== "info" && severity !== "warning" && severity !== "error") {
    throw new Error("qa_flag.severity 无效");
  }
  if (typeof message !== "string") {
    throw new Error("qa_flag.message 必须是字符串");
  }

  return { code, severity, message };
}

function parseReviewMetadata(value: unknown): ReviewMetadata {
  if (value === undefined) {
    return createReviewMetadata();
  }
  if (!isRecord(value)) {
    throw new Error("review 字段无效");
  }

  const allowAsrCorrections = value.allow_asr_corrections;
  const requireTermConsistency = value.require_term_consistency;
  const checklist = value.checklist;
  const normalizationDiagnostics = value.normalization_diagnostics;
  const unresolvedQaPolicy = value.unresolved_qa_policy;

  if (allowAsrCorrections !== undefined && typeof allowAsrCorrections !== "boolean") {
    throw new Error("review.allow_asr_corrections 必须是布尔值");
  }
  if (requireTermConsistency !== undefined && typeof requireTermConsistency !== "boolean") {
    throw new Error("review.require_term_consistency 必须是布尔值");
  }
  if (checklist !== undefined && (!Array.isArray(checklist) || checklist.some((item) => typeof item !== "string"))) {
    throw new Error("review.checklist 必须是字符串数组");
  }
  if (
    normalizationDiagnostics !== undefined
    && (!Array.isArray(normalizationDiagnostics) || normalizationDiagnostics.some((item) => !isRecord(item)))
  ) {
    throw new Error("review.normalization_diagnostics 必须是对象数组");
  }
  if (unresolvedQaPolicy !== undefined && unresolvedQaPolicy !== "warn" && unresolvedQaPolicy !== "fail") {
    throw new Error("review.unresolved_qa_policy 必须是 warn 或 fail");
  }

  return {
    allow_asr_corrections: typeof allowAsrCorrections === "boolean" ? allowAsrCorrections : true,
    require_term_consistency: typeof requireTermConsistency === "boolean" ? requireTermConsistency : true,
    checklist: Array.isArray(checklist) ? checklist : [...DEFAULT_REVIEW_CHECKLIST],
    normalization_diagnostics: Array.isArray(normalizationDiagnostics)
      ? normalizationDiagnostics.map(parseNormalizationDiagnostic)
      : [],
    unresolved_qa_policy: unresolvedQaPolicy === "fail" ? "fail" : "warn",
  };
}

function parseGlossaryState(value: unknown): GlossaryState {
  if (value === undefined) {
    return createGlossaryState();
  }
  if (!isRecord(value)) {
    throw new Error("glossary 字段无效");
  }

  return {
    entries: value.entries === undefined ? [] : parseGlossaryEntryList(value.entries, "glossary.entries"),
    collected: value.collected === undefined ? [] : parseGlossaryEntryList(value.collected, "glossary.collected"),
    candidates: value.candidates === undefined ? [] : parseGlossaryEntryList(value.candidates, "glossary.candidates"),
  };
}

function combinedGlossaryEntries(glossary: GlossaryState): GlossaryEntry[] {
  return mergeGlossaryEntries([...glossary.entries, ...glossary.collected]);
}

function validateGlossaryConsistency(subtitles: Subtitle[], glossary: GlossaryState, enabled: boolean): void {
  if (!enabled) {
    return;
  }

  const violations: string[] = [];

  for (const entry of combinedGlossaryEntries(glossary)) {
    for (const alias of entry.aliases) {
      for (const subtitle of subtitles) {
        if (subtitle.text.includes(alias)) {
          violations.push(`字幕 ${subtitle.index} 仍包含别名 "${alias}"，应统一为 "${entry.canonical}"`);
        }
      }
    }
  }

  if (violations.length > 0) {
    const preview = violations.slice(0, 5).join("；");
    const suffix = violations.length > 5 ? `；其余 ${violations.length - 5} 处未展示` : "";
    throw new Error(`词表一致性校验失败: ${preview}${suffix}`);
  }
}

export function subtitlesFromAgentTranscript(data: AgentTranscript): Subtitle[] {
  const tokens = data.tokens;
  const timedRefs = buildTimedTokenRefs(tokens);
  const coveredTimedTokenIds = new Set<number>();

  const sorted = [...data.subtitles].sort((left, right) => (
    left.token_start - right.token_start || left.token_end - right.token_end
  ));

  const subtitles = sorted.map((subtitle, index) => {
    if (subtitle.token_start < 0 || subtitle.token_end >= tokens.length) {
      throw new Error(`subtitles[${index}] 的 token range 超出 tokens 长度`);
    }

    const built = toSubtitle(tokens, subtitle.token_start, subtitle.token_end, index + 1, subtitle.text);
    for (const ref of timedRefs) {
      if (ref.tokenIndex < subtitle.token_start || ref.tokenIndex > subtitle.token_end) {
        continue;
      }
      if (coveredTimedTokenIds.has(ref.token.id)) {
        throw new Error(`token ${ref.token.id} 被多条字幕重复覆盖`);
      }
      coveredTimedTokenIds.add(ref.token.id);
    }
    return built;
  });

  for (const ref of timedRefs) {
    if (!coveredTimedTokenIds.has(ref.token.id)) {
      throw new Error(`token ${ref.token.id} 未被任何字幕覆盖`);
    }
  }

  validateGlossaryConsistency(subtitles, data.glossary, data.review.require_term_consistency);
  return subtitles;
}

function validateQaPolicy(data: AgentTranscript, subtitles: Subtitle[]): void {
  const qaFlags = collectSubtitleQaFlags(
    data.tokens,
    subtitles,
    data.review,
    data.glossary,
    {
      maxChars: data.settings.max_chars,
      maxDuration: data.settings.max_duration,
    },
    data.source.language_code,
  );

  const severeLines = summarizeQaWarnings(subtitles, qaFlags);
  if (severeLines.length === 0) {
    return;
  }

  const preview = severeLines.slice(0, 5).join("；");
  const suffix = severeLines.length > 5 ? `；其余 ${severeLines.length - 5} 条未展示` : "";

  if (data.review.unresolved_qa_policy === "fail") {
    throw new Error(`未解决的严重 QA 标记: ${preview}${suffix}`);
  }

  console.error(`[WARN] review JSON 仍包含严重 QA 标记: ${preview}${suffix}`);
}

async function readAgentTranscript(jsonPath: string): Promise<AgentTranscript> {
  const raw = await readFile(jsonPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("JSON 根节点必须是对象");
  }
  if (parsed.version !== 2) {
    throw new Error("仅支持 version = 2 的 agent JSON");
  }
  if (!isRecord(parsed.source)) {
    throw new Error("source 字段缺失或无效");
  }
  if (!isRecord(parsed.settings)) {
    throw new Error("settings 字段缺失或无效");
  }
  if (!Array.isArray(parsed.tokens) || !Array.isArray(parsed.subtitles)) {
    throw new Error("tokens 或 subtitles 字段缺失");
  }

  return {
    version: 2,
    source: {
      language_code: typeof parsed.source.language_code === "string" ? parsed.source.language_code : "",
      language_probability: typeof parsed.source.language_probability === "number" ? parsed.source.language_probability : 0,
      text: typeof parsed.source.text === "string" ? parsed.source.text : "",
    },
    settings: {
      max_chars: typeof parsed.settings.max_chars === "number" ? parsed.settings.max_chars : 42,
      max_duration: typeof parsed.settings.max_duration === "number" ? parsed.settings.max_duration : 5,
    },
    review: parseReviewMetadata(parsed.review),
    glossary: parseGlossaryState(parsed.glossary),
    instructions: Array.isArray(parsed.instructions)
      ? parsed.instructions.filter((item): item is string => typeof item === "string")
      : [],
    tokens: parsed.tokens.map(parseToken),
    subtitles: parsed.subtitles.map(parseJsonSubtitle),
  };
}

async function renderFromJson(config: Config): Promise<void> {
  const transcript = await readAgentTranscript(config.fromJson!);
  const subtitles = subtitlesFromAgentTranscript(transcript);
  validateQaPolicy(transcript, subtitles);
  const content = formatSRT(subtitles);
  await writeFile(config.output, content, "utf-8");
  console.error(`[INFO] 从 JSON 渲染完成，共 ${subtitles.length} 条字幕`);
  console.error(`[INFO] 输出: ${config.output}`);
}

async function rebuildFromRaw(config: Config): Promise<void> {
  const glossaryEntries = config.glossary ? await readGlossaryFile(config.glossary) : [];
  if (config.glossary) {
    console.error(`[INFO] 载入词表 ${glossaryEntries.length} 条: ${config.glossary}`);
  }

  console.error(`[INFO] 读取 ElevenLabs 原始 JSON: ${config.fromRawJson}`);
  const response = await readRawTranscribeResponse(config.fromRawJson!);
  const { content } = buildArtifactsFromResponse(response, config, glossaryEntries);
  await writeFile(config.output, content, "utf-8");
  console.error(`[INFO] 从原始 JSON 重建完成: ${config.output}`);
}

async function main() {
  const config = cli();

  if (config.mode === "render") {
    console.error(`[INFO] 读取 Agent JSON: ${config.fromJson}`);
    await renderFromJson(config);
    return;
  }

  if (config.mode === "rebuild") {
    await rebuildFromRaw(config);
    return;
  }

  let audioPath: string | undefined;

  try {
    const glossaryEntries = config.glossary ? await readGlossaryFile(config.glossary) : [];
    if (config.glossary) {
      console.error(`[INFO] 载入词表 ${glossaryEntries.length} 条: ${config.glossary}`);
      if (config.format !== "json") {
        console.error("[WARN] --glossary 只会写入 review JSON；当前直出 SRT 不会自动纠正文本");
      }
    }

    console.error(`[INFO] 预处理音频: ${config.input}`);
    audioPath = await preprocessAudio(config.input!);

    console.error("[INFO] 调用 ElevenLabs STT API...");
    const rawResult = await transcribeAudio(audioPath, config);
    await writeRawTranscribeResponse(config.rawOutput!, rawResult);
    console.error(`[INFO] 已保存 ElevenLabs 原始 JSON: ${config.rawOutput}`);

    const result = parseTranscribeResponse(rawResult);
    const { content } = buildArtifactsFromResponse(result, config, glossaryEntries);

    await writeFile(config.output, content, "utf-8");
    console.error(`[INFO] 输出: ${config.output}`);
  } finally {
    if (audioPath && existsSync(audioPath)) {
      try {
        unlinkSync(audioPath);
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: Error) => {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  });
}
