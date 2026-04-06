import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { mkdirp } from "mkdirp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { pipeline as transformersPipeline } from "@xenova/transformers";
import wavefile from "wavefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const TEMP_DIR = path.join(__dirname, "temp");
const TOOLS_DIR = path.join(TEMP_DIR, "tools");
const MAX_COLLECTION_SIZE = 50;
const YOUTUBE_BASE_URL = "https://www.youtube.com";
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);
const PLAYLIST_ID_RE = /^(PL|UU|LL|RD|UL|OLAK5uy_|FL|WL)[A-Za-z0-9_-]+$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]+$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_DLP_FILENAME = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const YT_DLP_PATH = path.join(TOOLS_DIR, YT_DLP_FILENAME);
const YT_DLP_DOWNLOAD_URL =
  process.platform === "win32"
    ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

mkdirp.sync(TEMP_DIR);
mkdirp.sync(TOOLS_DIR);

type Job = {
  status: string;
  progress: number;
  result?: string;
  error?: string;
  title?: string;
};

type VideoEntry = {
  id?: string;
  url?: string;
  webpage_url?: string;
  original_url?: string;
  title?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
};

type YtDlpResponse = {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
  webpage_url?: string;
  original_url?: string;
  entries?: VideoEntry[];
};

const jobs: Record<string, Job> = {};
const { WaveFile } = wavefile;

const transcribers: Record<string, any> = {};
async function getTranscriber(modelName: string) {
  const fullModelName = `Xenova/whisper-${modelName}`;
  if (!transcribers[fullModelName]) {
    console.log(`Loading model: ${fullModelName}`);
    transcribers[fullModelName] = await transformersPipeline("automatic-speech-recognition", fullModelName);
  }
  return transcribers[fullModelName];
}

let ytDlpSetupPromise: Promise<string> | null = null;
async function ensureYtDlp() {
  if (fs.existsSync(YT_DLP_PATH)) {
    return YT_DLP_PATH;
  }

  if (!ytDlpSetupPromise) {
    ytDlpSetupPromise = (async () => {
      const tempPath = `${YT_DLP_PATH}.download`;
      const response = await fetch(YT_DLP_DOWNLOAD_URL);

      if (!response.ok || !response.body) {
        throw new Error(`Failed to download yt-dlp: ${response.status} ${response.statusText}`);
      }

      await streamPipeline(
        Readable.fromWeb(response.body as any),
        fs.createWriteStream(tempPath)
      );

      if (process.platform !== "win32") {
        fs.chmodSync(tempPath, 0o755);
      }

      fs.renameSync(tempPath, YT_DLP_PATH);
      return YT_DLP_PATH;
    })().catch((error) => {
      ytDlpSetupPromise = null;
      throw error;
    });
  }

  return ytDlpSetupPromise;
}

function normalizeYouTubeInput(input: string) {
  const trimmed = input.trim();

  if (trimmed.startsWith("@")) {
    return `${YOUTUBE_BASE_URL}/${trimmed}`;
  }

  if (/^(www\.)?(youtube\.com|youtu\.be)\//i.test(trimmed)) {
    return `https://${trimmed.replace(/^https?:\/\//i, "")}`;
  }

  return trimmed;
}

function parseYouTubeUrl(input: string) {
  try {
    const parsed = new URL(normalizeYouTubeInput(input));
    return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase()) ? parsed : null;
  } catch {
    return null;
  }
}

function extractPlaylistId(input: string) {
  const normalized = normalizeYouTubeInput(input);
  if (PLAYLIST_ID_RE.test(normalized)) {
    return normalized;
  }

  return parseYouTubeUrl(normalized)?.searchParams.get("list") ?? null;
}

function extractVideoId(input: string) {
  const normalized = normalizeYouTubeInput(input);
  if (VIDEO_ID_RE.test(normalized)) {
    return normalized;
  }

  const parsed = parseYouTubeUrl(normalized);
  if (!parsed) return null;

  if (parsed.hostname.toLowerCase() === "youtu.be") {
    const shortId = parsed.pathname.split("/").filter(Boolean)[0];
    return shortId && VIDEO_ID_RE.test(shortId) ? shortId : null;
  }

  const queryId = parsed.searchParams.get("v");
  if (queryId && VIDEO_ID_RE.test(queryId)) {
    return queryId;
  }

  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const pathId = pathSegments.find((segment) => VIDEO_ID_RE.test(segment));
  return pathId ?? null;
}

function isChannelInput(input: string) {
  const normalized = normalizeYouTubeInput(input);
  if (CHANNEL_ID_RE.test(normalized)) {
    return true;
  }

  const parsed = parseYouTubeUrl(normalized);
  if (!parsed) return false;

  const [firstSegment] = parsed.pathname.split("/").filter(Boolean);
  if (!firstSegment) return false;

  return (
    firstSegment.startsWith("@") ||
    firstSegment === "channel" ||
    firstSegment === "c" ||
    firstSegment === "user"
  );
}

function buildWatchUrl(videoId: string) {
  return `${YOUTUBE_BASE_URL}/watch?v=${videoId}`;
}

function pickThumbnail(
  value?: { thumbnail?: string; thumbnails?: Array<{ url?: string }> },
  fallbackVideoId?: string
) {
  return (
    value?.thumbnail ??
    value?.thumbnails?.find((thumbnail) => thumbnail?.url)?.url ??
    (fallbackVideoId ? `https://i.ytimg.com/vi/${fallbackVideoId}/hqdefault.jpg` : "")
  );
}

function toVideoRecord(entry: VideoEntry) {
  const id = entry.id ?? extractVideoId(entry.url ?? entry.webpage_url ?? entry.original_url ?? "");
  if (!id) return null;

  const url =
    entry.webpage_url ??
    entry.original_url ??
    (entry.url?.startsWith("http") ? entry.url : buildWatchUrl(id));

  return {
    id,
    title: entry.title ?? `Video ${id}`,
    thumbnail: pickThumbnail(entry, id),
    url,
  };
}

async function runYtDlp(args: string[]) {
  const binaryPath = await ensureYtDlp();

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error((stderr || stdout || `yt-dlp exited with code ${code}`).trim()));
    });
  });
}

async function runYtDlpJson(input: string, options?: { flatPlaylist?: boolean; noPlaylist?: boolean }) {
  const args = ["--dump-single-json", "--no-warnings", "--skip-download"];

  if (options?.flatPlaylist) {
    args.push("--flat-playlist", "--playlist-end", String(MAX_COLLECTION_SIZE));
  }

  if (options?.noPlaylist) {
    args.push("--no-playlist");
  }

  args.push(normalizeYouTubeInput(input));

  return JSON.parse(await runYtDlp(args)) as YtDlpResponse;
}

async function getCollectionInfo(input: string, type: "playlist" | "channel") {
  const data = await runYtDlpJson(input, { flatPlaylist: true });
  const videos = (data.entries ?? []).map(toVideoRecord).filter(Boolean);

  return {
    type,
    title: data.title ?? data.uploader ?? data.channel ?? (type === "channel" ? "Channel" : "Playlist"),
    videos,
  };
}

async function getSingleVideoInfo(input: string) {
  const data = await runYtDlpJson(input, { noPlaylist: true });
  const videoId = data.id ?? extractVideoId(input);

  if (!videoId) {
    throw new Error("Could not resolve the YouTube video.");
  }

  return {
    type: "video" as const,
    videos: [
      {
        id: videoId,
        title: data.title ?? `Video ${videoId}`,
        thumbnail: pickThumbnail(data, videoId),
        url: data.webpage_url ?? data.original_url ?? buildWatchUrl(videoId),
      },
    ],
  };
}

async function downloadAudioToFile(input: string, templateBasePath: string) {
  const template = `${templateBasePath}.%(ext)s`;
  const directory = path.dirname(templateBasePath);
  const basename = path.basename(templateBasePath);

  for (const file of fs.readdirSync(directory)) {
    if (file.startsWith(`${basename}.`)) {
      fs.unlinkSync(path.join(directory, file));
    }
  }

  await runYtDlp([
    "--no-warnings",
    "--no-playlist",
    "--no-part",
    "--force-overwrites",
    "-f",
    "bestaudio/best",
    "-o",
    template,
    normalizeYouTubeInput(input),
  ]);

  const outputFile = fs.readdirSync(directory).find((file) => file.startsWith(`${basename}.`));
  if (!outputFile) {
    throw new Error("yt-dlp did not produce an audio file.");
  }

  return path.join(directory, outputFile);
}

function sanitizeFilename(name: string) {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return cleaned || "transcription";
}

function loadWavSamples(filePath: string) {
  const wav = new WaveFile(fs.readFileSync(filePath));
  wav.toBitDepth("32f");

  const samples = wav.getSamples(true, Float32Array);
  if (samples instanceof Float32Array) {
    return samples;
  }

  if (Array.isArray(samples) && samples[0] instanceof Float32Array) {
    return samples[0];
  }

  return Float32Array.from(samples as ArrayLike<number>);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  app.post("/api/video-info", async (req, res) => {
    const input = typeof req.body?.url === "string" ? req.body.url.trim() : "";

    if (!input) {
      return res.status(400).json({ error: "Please provide a YouTube URL." });
    }

    try {
      if (extractPlaylistId(input)) {
        return res.json(await getCollectionInfo(input, "playlist"));
      }

      if (isChannelInput(input)) {
        return res.json(await getCollectionInfo(input, "channel"));
      }

      const videoId = extractVideoId(input);
      if (videoId) {
        return res.json(await getSingleVideoInfo(input));
      }

      return res.status(400).json({ error: "Invalid YouTube video, playlist or channel URL." });
    } catch (error: any) {
      console.error("Video info error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/transcribe", async (req, res) => {
    const { url, title, language = "portuguese", model = "tiny" } = req.body;
    const jobId = uuidv4();
    jobs[jobId] = { status: "downloading", progress: 0, title };

    res.json({ jobId });

    (async () => {
      const rawAudioTemplate = path.join(TEMP_DIR, `${jobId}_raw`);
      let rawAudioPath: string | null = null;
      const wavAudioPath = path.join(TEMP_DIR, `${jobId}.wav`);

      try {
        rawAudioPath = await downloadAudioToFile(url, rawAudioTemplate);

        jobs[jobId].status = "converting";

        await new Promise<void>((resolve, reject) => {
          ffmpeg(rawAudioPath!)
            .toFormat("wav")
            .audioChannels(1)
            .audioFrequency(16000)
            .on("end", () => resolve())
            .on("error", reject)
            .save(wavAudioPath);
        });

        jobs[jobId].status = "transcribing";

        const pipe = await getTranscriber(model);
        const output = await pipe(loadWavSamples(wavAudioPath), {
          chunk_length_s: 30,
          stride_length_s: 5,
          language,
          task: "transcribe",
        });

        jobs[jobId].status = "completed";
        jobs[jobId].result = output.text;
      } catch (error: any) {
        console.error("Transcription error:", error);
        jobs[jobId].status = "failed";
        jobs[jobId].error = error.message;
      } finally {
        if (rawAudioPath && fs.existsSync(rawAudioPath)) fs.unlinkSync(rawAudioPath);
        if (fs.existsSync(wavAudioPath)) fs.unlinkSync(wavAudioPath);
      }
    })();
  });

  app.get("/api/status/:jobId", (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  });

  app.get("/api/download/:jobId", (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job || !job.result) return res.status(404).json({ error: "Result not found" });

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilename(job.title || "transcription")}.txt"`);
    res.send(job.result);
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
