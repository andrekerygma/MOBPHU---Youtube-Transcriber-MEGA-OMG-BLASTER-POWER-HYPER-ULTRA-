import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import { fileURLToPath } from "url";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { mkdirp } from "mkdirp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { pipeline as transformersPipeline } from "@xenova/transformers";
import { Innertube, UniversalCache } from "youtubei.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const TEMP_DIR = path.join(__dirname, "temp");
const YT_CACHE_DIR = path.join(TEMP_DIR, "youtubei-cache");
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

mkdirp.sync(TEMP_DIR);
mkdirp.sync(YT_CACHE_DIR);

const jobs: Record<string, { status: string; progress: number; result?: string; error?: string; title?: string }> = {};

// Cache for transcribers by model name
const transcribers: Record<string, any> = {};
async function getTranscriber(modelName: string) {
  const fullModelName = `Xenova/whisper-${modelName}`;
  if (!transcribers[fullModelName]) {
    console.log(`Loading model: ${fullModelName}`);
    transcribers[fullModelName] = await transformersPipeline("automatic-speech-recognition", fullModelName);
  }
  return transcribers[fullModelName];
}

let youtubeClientPromise: Promise<Innertube> | null = null;
async function getYoutubeClient() {
  if (!youtubeClientPromise) {
    youtubeClientPromise = Innertube.create({
      retrieve_player: true,
      generate_session_locally: true,
      fail_fast: false,
      enable_session_cache: true,
      cache: new UniversalCache(true, YT_CACHE_DIR),
    }).catch((error) => {
      youtubeClientPromise = null;
      throw error;
    });
  }

  return youtubeClientPromise;
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

function toAbsoluteYouTubeUrl(url: string) {
  return new URL(url, YOUTUBE_BASE_URL).toString();
}

function textValue(value: { toString?: () => string } | string | null | undefined) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.toString?.() ?? String(value);
}

function buildWatchUrl(videoId: string) {
  return `${YOUTUBE_BASE_URL}/watch?v=${videoId}`;
}

function pickThumbnail(thumbnails?: Array<{ url?: string }>, videoId?: string) {
  return thumbnails?.[0]?.url ?? (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "");
}

function getVideoItemId(item: any) {
  return item?.video_id ?? item?.id;
}

function mapVideoItem(item: any) {
  const id = getVideoItemId(item);
  if (!id) return null;

  const endpointUrl = item?.endpoint?.metadata?.url;
  return {
    id,
    title: textValue(item?.title) || `Video ${id}`,
    thumbnail: pickThumbnail(item?.thumbnails, id),
    url: endpointUrl ? toAbsoluteYouTubeUrl(endpointUrl) : buildWatchUrl(id),
  };
}

async function collectPaginatedItems<T>(
  initialPage: any,
  getItems: (page: any) => T[],
  limit = MAX_COLLECTION_SIZE
) {
  const collected: T[] = [];
  const seen = new Set<string>();
  let currentPage = initialPage;

  while (currentPage) {
    for (const item of getItems(currentPage)) {
      const id = getVideoItemId(item);
      if (!id || seen.has(id)) continue;

      seen.add(id);
      collected.push(item);

      if (collected.length >= limit) {
        return collected;
      }
    }

    if (!currentPage.has_continuation || typeof currentPage.getContinuation !== "function") {
      break;
    }

    currentPage = await currentPage.getContinuation();
  }

  return collected;
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

function getChannelFallbackQuery(input: string) {
  const trimmed = input.trim();
  if (trimmed.startsWith("@")) {
    return trimmed;
  }

  const parsed = parseYouTubeUrl(input);
  if (!parsed) {
    return CHANNEL_ID_RE.test(trimmed) ? trimmed : null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  return segments[0].startsWith("@") ? segments[0] : segments[segments.length - 1];
}

async function resolveChannelId(input: string) {
  const normalized = normalizeYouTubeInput(input);
  if (CHANNEL_ID_RE.test(normalized)) {
    return normalized;
  }

  const parsed = parseYouTubeUrl(normalized);
  const directId = parsed?.pathname.match(/^\/channel\/([^/?]+)/i)?.[1];
  if (directId) {
    return directId;
  }

  const yt = await getYoutubeClient();

  if (parsed) {
    try {
      const endpoint = await yt.resolveURL(parsed.toString());
      const browseId = endpoint.payload?.browseId ?? endpoint.payload?.browse_id;

      if (typeof browseId === "string" && CHANNEL_ID_RE.test(browseId)) {
        return browseId;
      }
    } catch (error) {
      console.warn("Channel resolve fallback triggered:", error);
    }
  }

  const fallbackQuery = getChannelFallbackQuery(input);
  if (!fallbackQuery) {
    return null;
  }

  const search = await yt.search(fallbackQuery, { type: "channel" });
  const firstChannel = search.channels[0];

  return firstChannel?.id ?? null;
}

async function getPlaylistVideos(playlistId: string) {
  const yt = await getYoutubeClient();
  const playlist = await yt.getPlaylist(playlistId);
  const items = await collectPaginatedItems(playlist, (page) => Array.from(page.items ?? []));

  return {
    title: playlist.info.title ?? "Playlist",
    videos: items.map(mapVideoItem).filter(Boolean),
  };
}

async function getChannelVideos(input: string) {
  const channelId = await resolveChannelId(input);
  if (!channelId) {
    throw new Error("Could not resolve the YouTube channel.");
  }

  const yt = await getYoutubeClient();
  const channel = await yt.getChannel(channelId);
  const videoFeed = channel.has_videos ? await channel.getVideos() : channel;
  const items = await collectPaginatedItems(videoFeed, (page) => Array.from(page.videos ?? []));

  return {
    title: channel.metadata.title ?? "Channel",
    videos: items.map(mapVideoItem).filter(Boolean),
  };
}

const AUDIO_DOWNLOAD_STRATEGIES = [
  { client: "ANDROID" as const, type: "audio" as const, quality: "best", format: "any" },
  { client: "IOS" as const, type: "audio" as const, quality: "best", format: "any" },
];

async function downloadAudioToFile(input: string, outputPath: string) {
  const videoId = extractVideoId(input);
  if (!videoId) {
    throw new Error("Invalid YouTube video URL.");
  }

  const yt = await getYoutubeClient();
  let lastError: unknown;

  for (const strategy of AUDIO_DOWNLOAD_STRATEGIES) {
    try {
      const audioStream = await yt.download(videoId, strategy);
      await streamPipeline(
        Readable.fromWeb(audioStream as any),
        fs.createWriteStream(outputPath)
      );
      return;
    } catch (error) {
      lastError = error;
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to download audio from YouTube.");
}

function sanitizeFilename(name: string) {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return cleaned || "transcription";
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.post("/api/video-info", async (req, res) => {
    const input = typeof req.body?.url === "string" ? req.body.url.trim() : "";

    if (!input) {
      return res.status(400).json({ error: "Please provide a YouTube URL." });
    }

    try {
      const yt = await getYoutubeClient();
      const playlistId = extractPlaylistId(input);

      if (playlistId) {
        const playlist = await getPlaylistVideos(playlistId);
        return res.json({
          type: "playlist",
          title: playlist.title,
          videos: playlist.videos,
        });
      }

      if (isChannelInput(input)) {
        const channel = await getChannelVideos(input);
        return res.json({
          type: "channel",
          title: channel.title,
          videos: channel.videos,
        });
      }

      const videoId = extractVideoId(input);
      if (videoId) {
        const info = await yt.getBasicInfo(videoId);
        const canonicalUrl = info.basic_info.url_canonical
          ? toAbsoluteYouTubeUrl(info.basic_info.url_canonical)
          : buildWatchUrl(videoId);

        return res.json({
          type: "video",
          videos: [{
            id: info.basic_info.id ?? videoId,
            title: info.basic_info.title ?? `Video ${videoId}`,
            thumbnail: pickThumbnail(info.basic_info.thumbnail, videoId),
            url: canonicalUrl,
          }],
        });
      }

      res.status(400).json({ error: "Invalid YouTube video, playlist or channel URL." });
    } catch (error: any) {
      console.error("Video info error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/transcribe", async (req, res) => {
    const { url, title, language = "portuguese", model = "tiny" } = req.body;
    const jobId = uuidv4();
    jobs[jobId] = { status: "downloading", progress: 0, title };

    res.json({ jobId });

    // Background process
    (async () => {
      const rawAudioPath = path.join(TEMP_DIR, `${jobId}_raw.audio`);
      const wavAudioPath = path.join(TEMP_DIR, `${jobId}.wav`);

      try {
        // Download audio
        await downloadAudioToFile(url, rawAudioPath);

        jobs[jobId].status = "converting";

        // Convert to 16kHz mono WAV for Whisper
        await new Promise<void>((resolve, reject) => {
          ffmpeg(rawAudioPath)
            .toFormat("wav")
            .audioChannels(1)
            .audioFrequency(16000)
            .on("end", () => resolve())
            .on("error", reject)
            .save(wavAudioPath);
        });

        jobs[jobId].status = "transcribing";
        
        // Transcribe with local Whisper
        const pipe = await getTranscriber(model);
        const output = await pipe(wavAudioPath, {
          chunk_length_s: 30,
          stride_length_s: 5,
          language: language,
          task: "transcribe",
        });

        jobs[jobId].status = "completed";
        jobs[jobId].result = output.text;
      } catch (error: any) {
        console.error("Transcription error:", error);
        jobs[jobId].status = "failed";
        jobs[jobId].error = error.message;
      } finally {
        if (fs.existsSync(rawAudioPath)) fs.unlinkSync(rawAudioPath);
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

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
