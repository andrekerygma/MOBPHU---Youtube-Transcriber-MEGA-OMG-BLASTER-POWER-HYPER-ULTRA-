import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import cors from "cors";
import ytdl from "@distube/ytdl-core";
import ytpl from "ytpl";
import ytsr from "ytsr";
import { v4 as uuidv4 } from "uuid";
import { mkdirp } from "mkdirp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { pipeline } from "@xenova/transformers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

const TEMP_DIR = path.join(__dirname, "temp");
mkdirp.sync(TEMP_DIR);

const jobs: Record<string, { status: string; progress: number; result?: string; error?: string; title?: string }> = {};

// Cache for transcribers by model name
const transcribers: Record<string, any> = {};
async function getTranscriber(modelName: string) {
  const fullModelName = `Xenova/whisper-${modelName}`;
  if (!transcribers[fullModelName]) {
    console.log(`Loading model: ${fullModelName}`);
    transcribers[fullModelName] = await pipeline("automatic-speech-recognition", fullModelName);
  }
  return transcribers[fullModelName];
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.post("/api/video-info", async (req, res) => {
    const { url } = req.body;
    try {
      // Playlist support
      if (ytpl.validateID(url)) {
        const playlist = await ytpl(url);
        return res.json({
          type: "playlist",
          title: playlist.title,
          videos: playlist.items.map(item => ({
            id: item.id,
            title: item.title,
            thumbnail: item.thumbnails[0]?.url,
            url: item.shortUrl
          }))
        });
      }

      // Channel support (basic detection)
      if (url.includes("/@") || url.includes("/channel/") || url.includes("/c/")) {
        const searchResults = await ytsr(url, { limit: 50 });
        const channelResult = searchResults.items.find(item => item.type === "channel") as any;
        
        if (channelResult) {
          // If it's a channel result, we might need to fetch its videos
          // ytsr doesn't directly list all videos of a channel easily from the search result
          // But we can try to get the channel ID and use ytpl with the uploads playlist ID
          const channelId = channelResult.channelID;
          const uploadsPlaylistId = channelId.replace(/^UC/, "UU");
          
          try {
            const playlist = await ytpl(uploadsPlaylistId, { limit: 50 });
            return res.json({
              type: "channel",
              title: channelResult.name,
              videos: playlist.items.map(item => ({
                id: item.id,
                title: item.title,
                thumbnail: item.thumbnails[0]?.url,
                url: item.shortUrl
              }))
            });
          } catch (e) {
            // Fallback: just return the videos found in search if any
            const videos = searchResults.items
              .filter(item => item.type === "video")
              .map((item: any) => ({
                id: item.id,
                title: item.title,
                thumbnail: item.thumbnails[0]?.url,
                url: item.url
              }));
            
            return res.json({
              type: "channel",
              title: channelResult.name,
              videos: videos
            });
          }
        }
      }

      if (ytdl.validateURL(url)) {
        const info = await ytdl.getBasicInfo(url);
        return res.json({
          type: "video",
          videos: [{
            id: info.videoDetails.videoId,
            title: info.videoDetails.title,
            thumbnail: info.videoDetails.thumbnails[0]?.url,
            url: url
          }]
        });
      }
      
      res.status(400).json({ error: "Invalid YouTube URL, Playlist ID or Channel" });
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
      try {
        const rawAudioPath = path.join(TEMP_DIR, `${jobId}_raw.mp3`);
        const wavAudioPath = path.join(TEMP_DIR, `${jobId}.wav`);
        
        // Download audio
        const stream = ytdl(url, {
          quality: "lowestaudio",
          filter: "audioonly",
        });

        const fileStream = fs.createWriteStream(rawAudioPath);
        stream.pipe(fileStream);

        await new Promise<void>((resolve, reject) => {
          fileStream.on("finish", () => resolve());
          fileStream.on("error", reject);
        });

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
        
        // Cleanup files
        if (fs.existsSync(rawAudioPath)) fs.unlinkSync(rawAudioPath);
        if (fs.existsSync(wavAudioPath)) fs.unlinkSync(wavAudioPath);
      } catch (error: any) {
        console.error("Transcription error:", error);
        jobs[jobId].status = "failed";
        jobs[jobId].error = error.message;
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
    res.setHeader("Content-Disposition", `attachment; filename="${job.title || 'transcription'}.txt"`);
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
