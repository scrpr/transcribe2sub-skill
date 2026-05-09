# Transcribe2sub Skill

一个提供音频/视频转高质量 SRT 字幕的能力的 Skill。基于 ElevenLabs STT API，支持:

- Word-level 时间戳
- Token 级边界控制
- Agent 可回放修订
- ASR 错词纠正
- 术语统一（支持用户词表）
- 语义分段优化

## Workflow

```mermaid
graph TB
    Start([音频文件]) --> First{首次处理?}
    
    First -->|是| Preprocess[音频预处理<br/>ffmpeg → m4a]
    Preprocess --> Transcribe[调用 ElevenLabs STT API]
    Transcribe --> SaveRaw[保存原始响应<br/>transcript.review.elevenlabs.json]
    
    First -->|否| LoadRaw[读取原始响应<br/>--from-raw-json]
    
    SaveRaw --> CreateTokens[创建 Tokens<br/>分配稳定 ID]
    LoadRaw --> CreateTokens
    
    CreateTokens --> Segment[语义分段<br/>标点/说话人/停顿/长度]
    Segment --> LoadGlossary[加载用户词表<br/>--glossary]
    LoadGlossary --> FormatJSON[生成 Agent JSON<br/>--format json]
    
    FormatJSON --> AgentReview[Agent 审核修正<br/>纠错/术语统一/分段优化]
    AgentReview --> SaveCorrected[保存修正 JSON<br/>transcript.corrected.json]
    
    SaveCorrected --> RenderSRT[回写生成 SRT<br/>--from-json]
    RenderSRT --> Final([最终字幕<br/>final.srt])
    
    style Start fill:#e1f5e1
    style Final fill:#e1f5e1
    style AgentReview fill:#fff4e6
    style Transcribe fill:#e3f2fd
```

### 典型使用流程

1. **首次转录**: 音频 → JSON
2. **Agent 修正**: 审核纠错、统一术语
3. **生成字幕**: JSON → SRT

推荐命名约定:

- 机器初稿: `<stem>.review.json`
- 原始缓存: `<basename>.elevenlabs.json`，由主输出路径去掉扩展名得到；例如 `transcript.review.json` 对应 `transcript.review.elevenlabs.json`
- review 后文件: `<stem>.corrected.json`


## 环境依赖

使用前请先确认本机已安装以下依赖，并且对应命令可以在当前 shell 中直接执行:

- Node.js >= 20: 运行 TypeScript 脚本和项目工具链
- pnpm: 安装依赖并执行项目脚本，本项目锁定的包管理器版本见 `package.json`
- ffmpeg: 系统级音视频工具，用于预处理音频/视频并转码为 ElevenLabs STT 使用的音频格式

可用以下命令快速检查:

```bash
node --version
pnpm --version
ffmpeg -version
```

## 安装

### 自动安装

使用 AI Agent 自带的 Skill 安装 Skill 进行安装。

安装完成后，第一次实际使用前，还需要进入 skill 目录运行一次 `pnpm install`。如果当前环境限制依赖安装，需要先批准提权再执行。

### 手动安装

```bash
cp -r /path/to/transcribe2sub /path/to/your/ai/agent/skills/transcribe2sub/
cd /path/to/your/ai/agent/skills/transcribe2sub/
pnpm install
```
