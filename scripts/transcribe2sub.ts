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
}

export interface GlossaryEntry {
  canonical: string;
  aliases: string[];
  note?: string;
}

interface ReviewMetadata {
  allow_asr_corrections: boolean;
  require_term_consistency: boolean;
  checklist: string[];
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

const PAUSE_THRESHOLD = 0.7;
const MIN_SEGMENT_DURATION = 0.35;
const SENTENCE_END = /[.!?。！？]$/;
const CLAUSE_END = /[,;:—，；：、]$/;
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

async function readRawTranscribeResponse(jsonPath: string): Promise<TranscribeResponse> {
  const raw = await readFile(jsonPath, "utf-8");
  return parseTranscribeResponse(JSON.parse(raw) as unknown);
}

async function writeRawTranscribeResponse(jsonPath: string, response: unknown): Promise<void> {
  await writeFile(jsonPath, JSON.stringify(response, null, 2), "utf-8");
}

function createReviewMetadata(): ReviewMetadata {
  return {
    allow_asr_corrections: true,
    require_term_consistency: true,
    checklist: [...DEFAULT_REVIEW_CHECKLIST],
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
  if (language) {
    form.set("language_code", language);
  }
  if (useUnauth) {
    // ElevenLabs currently requires diarization on unauthenticated STT requests.
    form.set("diarize", "true");
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

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function renderTokenRange(tokens: Token[], tokenStart: number, tokenEnd: number): string {
  return normalizeText(tokens.slice(tokenStart, tokenEnd + 1).map((token) => token.text).join(""));
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

function resolveTimedRange(tokens: Token[], tokenStart: number, tokenEnd: number): { start: number; end: number } {
  let first: Token | undefined;
  let last: Token | undefined;

  for (let i = tokenStart; i <= tokenEnd; i++) {
    if (tokens[i] && tokens[i].type !== "spacing") {
      first ??= tokens[i];
      last = tokens[i];
    }
  }

  if (!first || !last) {
    throw new Error(`字幕范围 ${tokenStart}-${tokenEnd} 不包含可计时 token`);
  }

  return { start: first.start, end: last.end };
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

function shouldHardBreakAfter(refs: TimedTokenRef[], index: number): boolean {
  if (index >= refs.length - 1) {
    return true;
  }

  const tokenText = refs[index].token.text;
  if (SENTENCE_END.test(tokenText)) {
    return true;
  }

  if (hasSpeakerChangeAfter(refs, index)) {
    return true;
  }

  return gapAfter(refs, index) > PAUSE_THRESHOLD;
}

function findBestSplitRefIndex(
  tokens: Token[],
  refs: TimedTokenRef[],
  startRefIndex: number,
  endRefIndex: number,
  maxChars: number,
  maxDuration: number,
): number {
  const fullText = textForRefRange(tokens, refs, startRefIndex, endRefIndex);
  const fullDuration = durationForRefRange(refs, startRefIndex, endRefIndex);
  const targetChars = Math.min(maxChars, Math.max(1, Math.floor(fullText.length / 2)));
  const targetDuration = Math.min(maxDuration, fullDuration / 2);

  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = startRefIndex; i < endRefIndex; i++) {
    const leftText = textForRefRange(tokens, refs, startRefIndex, i);
    const leftDuration = durationForRefRange(refs, startRefIndex, i);
    const rightDuration = durationForRefRange(refs, i + 1, endRefIndex);

    if (leftDuration < MIN_SEGMENT_DURATION || rightDuration < MIN_SEGMENT_DURATION) {
      continue;
    }

    let score = 0;
    const tokenText = refs[i].token.text;
    const pause = gapAfter(refs, i);

    if (SENTENCE_END.test(tokenText)) {
      score += 120;
    } else if (CLAUSE_END.test(tokenText)) {
      score += 80;
    }

    if (pause > PAUSE_THRESHOLD) {
      score += 60 + Math.min(1.5, pause - PAUSE_THRESHOLD) * 20;
    }

    if (hasSpeakerChangeAfter(refs, i)) {
      score += 70;
    }

    score -= Math.abs(leftDuration - targetDuration) * 6;
    score -= Math.abs(leftText.length - targetChars) * 0.6;

    if (leftDuration > maxDuration * 1.1) {
      score -= 50;
    }
    if (leftText.length > maxChars * 1.15) {
      score -= 30;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex >= 0 ? bestIndex : endRefIndex - 1;
}

export function segmentIntoSubtitles(tokens: Token[], maxChars: number, maxDuration: number): Subtitle[] {
  const refs = buildTimedTokenRefs(tokens);
  if (refs.length === 0) {
    return [];
  }

  const subtitles: Subtitle[] = [];
  let segmentStart = 0;
  let i = 0;

  while (i < refs.length) {
    const text = textForRefRange(tokens, refs, segmentStart, i);
    const duration = durationForRefRange(refs, segmentStart, i);
    const overflow = i > segmentStart && (text.length > maxChars || duration > maxDuration);

    if (overflow) {
      const splitAt = findBestSplitRefIndex(tokens, refs, segmentStart, i, maxChars, maxDuration);
      subtitles.push(
        toSubtitle(tokens, refs[segmentStart].tokenIndex, refs[splitAt].tokenIndex, subtitles.length + 1),
      );
      segmentStart = splitAt + 1;
      continue;
    }

    if (shouldHardBreakAfter(refs, i)) {
      subtitles.push(
        toSubtitle(tokens, refs[segmentStart].tokenIndex, refs[i].tokenIndex, subtitles.length + 1),
      );
      segmentStart = i + 1;
    }

    i += 1;
  }

  return subtitles;
}

function buildArtifactsFromResponse(
  response: TranscribeResponse,
  config: Pick<Config, "maxChars" | "maxDuration" | "format">,
  glossaryEntries: GlossaryEntry[] = [],
): { tokens: Token[]; subtitles: Subtitle[]; content: string } {
  const tokens = createTokens(response.words);
  console.error(`[INFO] 转录完成，语言: ${response.language_code}，可计时 token 数: ${tokens.filter((token) => token.type !== "spacing").length}`);

  const subtitles = segmentIntoSubtitles(tokens, config.maxChars, config.maxDuration);
  console.error(`[INFO] 分段完成，共 ${subtitles.length} 条字幕`);

  const content = config.format === "json"
    ? formatAgentJSON(response, tokens, subtitles, config, glossaryEntries)
    : formatSRT(subtitles);

  return { tokens, subtitles, content };
}

function toJsonSubtitle(subtitle: Subtitle): JsonSubtitle {
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
): string {
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
    review: createReviewMetadata(),
    glossary: createGlossaryState(glossaryEntries),
    instructions: [
      "先保证转写内容忠实和时间轴准确，再优化断句、标点和可读性。",
      "允许在 subtitles[].text 中修正明显的 ASR 错词、同音误识别和术语拼写错误，但不要脱离当前 token range 总结或扩写。",
      "在纠正 ASR 错词的同时，主动抽取人名、品牌名、产品名、地名和领域术语，先写入 glossary.candidates，再把确认过的 canonical 写法写入 glossary.collected。",
      "优先使用 glossary.entries 与 glossary.collected 中的 canonical 写法；glossary.candidates 只是 review 阶段的暂存区。",
      "优先让每条字幕对应完整句子、从句或自然停顿；不要跨 speaker change 强行合并。",
      "只修改 subtitles[].token_start、subtitles[].token_end、subtitles[].text。",
      "不要修改 tokens[].id、tokens[].start、tokens[].end、tokens[].type、tokens[].speaker_id。",
      "subtitles[].start、subtitles[].end、word_*、speaker_ids 是派生预览字段，渲染时会按 token range 重算。",
      "每个非 spacing token 必须且只能属于一条字幕，不能丢词或重叠；纠错应仅限于当前时段内真实说出的内容。",
      "subtitles[].text 是最终展示文本，可修正错词、标点、大小写和换行，并保持术语前后一致。",
    ],
    tokens,
    subtitles: subtitles.map(toJsonSubtitle),
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
  };
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

  if (allowAsrCorrections !== undefined && typeof allowAsrCorrections !== "boolean") {
    throw new Error("review.allow_asr_corrections 必须是布尔值");
  }
  if (requireTermConsistency !== undefined && typeof requireTermConsistency !== "boolean") {
    throw new Error("review.require_term_consistency 必须是布尔值");
  }
  if (checklist !== undefined && (!Array.isArray(checklist) || checklist.some((item) => typeof item !== "string"))) {
    throw new Error("review.checklist 必须是字符串数组");
  }

  return {
    allow_asr_corrections: typeof allowAsrCorrections === "boolean" ? allowAsrCorrections : true,
    require_term_consistency: typeof requireTermConsistency === "boolean" ? requireTermConsistency : true,
    checklist: Array.isArray(checklist) ? checklist : [...DEFAULT_REVIEW_CHECKLIST],
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
