import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Youtube, 
  Search, 
  FileText, 
  Download, 
  Loader2, 
  AlertCircle, 
  CheckCircle2, 
  Play, 
  List,
  Clock,
  ExternalLink,
  Square
} from "lucide-react";

interface Video {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
}

interface Job {
  jobId: string;
  status: "downloading" | "converting" | "transcribing" | "completed" | "failed";
  progress: number;
  result?: string;
  error?: string;
  title: string;
  videoId?: string;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [playlistTitle, setPlaylistTitle] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  
  // New state for transcription options
  const [language, setLanguage] = useState("portuguese");
  const [model, setModel] = useState("tiny");

  // Queue management
  const [queue, setQueue] = useState<Video[]>([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [currentQueueVideoId, setCurrentQueueVideoId] = useState<string | null>(null);

  const languages = [
    { value: "portuguese", label: "Português" },
    { value: "english", label: "English" },
    { value: "spanish", label: "Español" },
    { value: "french", label: "Français" },
    { value: "german", label: "Deutsch" },
    { value: "italian", label: "Italiano" },
    { value: "japanese", label: "日本語" },
    { value: "chinese", label: "中文" },
    { value: "russian", label: "Русский" },
  ];

  const models = [
    { value: "tiny", label: "Tiny (Rápido, ~75MB)", desc: "Ideal para testes rápidos" },
    { value: "base", label: "Base (Equilibrado, ~145MB)", desc: "Boa precisão e velocidade" },
    { value: "small", label: "Small (Preciso, ~480MB)", desc: "Alta precisão, mais lento" },
    { value: "medium", label: "Medium (Lento, ~1.5GB)", desc: "Máxima precisão local" },
  ];

  const fetchVideoInfo = async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    setVideos([]);
    setPlaylistTitle(null);
    setQueue([]);
    setIsProcessingQueue(false);

    try {
      const response = await fetch("/api/video-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      
      setVideos(data.videos);
      if (data.type === "playlist" || data.type === "channel") setPlaylistTitle(data.title);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const startTranscription = async (video: Video) => {
    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          url: video.url, 
          title: video.title,
          language,
          model
        }),
      });
      const { jobId } = await response.json();
      
      setJobs(prev => ({
        ...prev,
        [jobId]: { jobId, status: "downloading", progress: 0, title: video.title, videoId: video.id }
      }));
      return jobId;
    } catch (err: any) {
      console.error(err);
      return null;
    }
  };

  const startQueue = () => {
    if (videos.length === 0) return;
    setQueue(videos);
    setIsProcessingQueue(true);
  };

  const stopQueue = () => {
    setIsProcessingQueue(false);
    setQueue([]);
    setCurrentQueueVideoId(null);
  };

  // Effect to process queue
  useEffect(() => {
    if (!isProcessingQueue || queue.length === 0) return;

    const currentVideo = queue[0];
    setCurrentQueueVideoId(currentVideo.id);

    // Check if this video is already being processed or completed
    const existingJob = (Object.values(jobs) as Job[]).find((j: Job) => j.videoId === currentVideo.id);
    
    if (!existingJob) {
      startTranscription(currentVideo);
    } else if (existingJob.status === "completed" || existingJob.status === "failed") {
      // Move to next in queue
      setQueue(prev => prev.slice(1));
    }
  }, [isProcessingQueue, queue, jobs]);

  useEffect(() => {
    const interval = setInterval(() => {
      const activeJobs = (Object.values(jobs) as Job[]).filter((j: Job) => j.status !== "completed" && j.status !== "failed");
      if (activeJobs.length === 0) return;

      activeJobs.forEach(async (job: Job) => {
        try {
          const response = await fetch(`/api/status/${job.jobId}`);
          const data = await response.json();
          setJobs(prev => ({
            ...prev,
            [job.jobId]: { ...prev[job.jobId], ...data }
          }));
        } catch (err) {
          console.error(err);
        }
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [jobs]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      {/* Background Atmosphere */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-orange-900/20 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/10 blur-[120px] rounded-full" />
      </div>

      <div className="relative max-w-5xl mx-auto px-6 py-12">
        {/* Header */}
        <header className="mb-12">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3 mb-4"
          >
            <div className="p-2 bg-orange-600 rounded-lg">
              <Youtube className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight uppercase">YouTube Transcriber (Local)</h1>
          </motion.div>
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-gray-400 max-w-2xl"
          >
            Transcreva vídeos, playlists ou canais inteiros sem APIs externas. O processamento ocorre localmente no servidor usando Whisper. 
            <span className="block mt-2 text-xs text-orange-500/70 italic">* Na primeira execução de cada modelo, ele será baixado automaticamente.</span>
          </motion.p>
        </header>

        {/* Search Section */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-[#141414] border border-white/10 rounded-2xl p-6 mb-12 shadow-2xl"
        >
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
                <input 
                  type="text" 
                  placeholder="Link do vídeo, playlist ou canal (@nome)..."
                  className="w-full bg-black/50 border border-white/10 rounded-xl py-4 pl-12 pr-4 focus:outline-none focus:ring-2 focus:ring-orange-500/50 transition-all text-lg"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && fetchVideoInfo()}
                />
              </div>
              <button 
                onClick={fetchVideoInfo}
                disabled={loading || !url}
                className="bg-orange-600 hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-4 px-8 rounded-xl transition-all flex items-center justify-center gap-2 min-w-[160px]"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Analisar"}
              </button>
            </div>

            {/* Transcription Options */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                  <FileText className="w-3 h-3" /> Idioma da Transcrição
                </label>
                <select 
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full bg-black/50 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                >
                  {languages.map(lang => (
                    <option key={lang.value} value={lang.value}>{lang.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                  <Clock className="w-3 h-3" /> Modelo Whisper
                </label>
                <select 
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-black/50 border border-white/10 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                >
                  {models.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <p className="text-[10px] text-gray-600 italic">
                  {models.find(m => m.value === model)?.desc}
                </p>
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-4 flex items-center gap-2 text-red-400 text-sm bg-red-400/10 p-3 rounded-lg border border-red-400/20">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
        </motion.div>

        {/* Results Section */}
        <AnimatePresence mode="wait">
          {videos.length > 0 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {playlistTitle ? <List className="w-5 h-5 text-orange-500" /> : <Play className="w-5 h-5 text-orange-500" />}
                  <h2 className="text-xl font-bold uppercase tracking-wider">
                    {playlistTitle || "Vídeo Encontrado"}
                    <span className="ml-3 text-sm font-normal text-gray-500 bg-white/5 px-2 py-1 rounded">
                      {videos.length} {videos.length === 1 ? "vídeo" : "vídeos"}
                    </span>
                  </h2>
                </div>
                {videos.length > 1 && (
                  <div className="flex gap-2">
                    {!isProcessingQueue ? (
                      <button 
                        onClick={startQueue}
                        className="text-sm bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2 rounded-lg transition-all flex items-center gap-2"
                      >
                        <Play className="w-4 h-4" /> Processar Tudo (Sequencial)
                      </button>
                    ) : (
                      <button 
                        onClick={stopQueue}
                        className="text-sm bg-red-600/20 text-red-400 border border-red-400/30 px-4 py-2 rounded-lg transition-all flex items-center gap-2"
                      >
                        <Square className="w-4 h-4" /> Parar Processamento
                      </button>
                    )}
                  </div>
                )}
              </div>

              {isProcessingQueue && (
                <div className="bg-orange-600/10 border border-orange-600/20 p-4 rounded-xl flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
                    <span className="text-sm font-medium text-orange-500">
                      Processando fila: {videos.length - queue.length + 1} de {videos.length}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500">
                    Aguardando conclusão do vídeo atual...
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4">
                {videos.map((video) => {
                  const job = Object.values(jobs).find((j: any) => j.videoId === video.id) as Job | undefined;
                  const isCurrent = currentQueueVideoId === video.id;
                  return (
                    <div 
                      key={video.id}
                      className={`bg-[#141414] border rounded-xl p-4 flex flex-col md:flex-row items-center gap-6 group transition-all ${isCurrent ? 'border-orange-500/50 ring-1 ring-orange-500/20' : 'border-white/10 hover:border-white/20'}`}
                    >
                      <div className="relative w-full md:w-48 aspect-video rounded-lg overflow-hidden shrink-0">
                        <img 
                          src={video.thumbnail} 
                          alt={video.title} 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <a href={video.url} target="_blank" rel="noopener noreferrer" className="p-2 bg-white/20 rounded-full hover:bg-white/40 transition-all">
                            <ExternalLink className="w-5 h-5" />
                          </a>
                        </div>
                      </div>

                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-lg mb-2 truncate pr-4">{video.title}</h3>
                        <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500">
                          <div className="flex items-center gap-1">
                            <Clock className="w-4 h-4" />
                            <span>YouTube Audio</span>
                          </div>
                          {job && (
                            <div className={`flex items-center gap-1 ${
                              job.status === "completed" ? "text-green-400" : 
                              job.status === "failed" ? "text-red-400" : "text-orange-400"
                            }`}>
                              {job.status === "completed" ? <CheckCircle2 className="w-4 h-4" /> : 
                               job.status === "failed" ? <AlertCircle className="w-4 h-4" /> : 
                               <Loader2 className="w-4 h-4 animate-spin" />}
                              <span className="capitalize">{job.status}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="shrink-0 w-full md:w-auto">
                        {!job ? (
                          <button 
                            onClick={() => startTranscription(video)}
                            disabled={isProcessingQueue}
                            className="w-full md:w-auto bg-white text-black font-bold py-3 px-6 rounded-lg hover:bg-gray-200 disabled:opacity-30 transition-all flex items-center justify-center gap-2"
                          >
                            <FileText className="w-5 h-5" />
                            Transcrever
                          </button>
                        ) : job.status === "completed" ? (
                          <a 
                            href={`/api/download/${job.jobId}`}
                            className="w-full md:w-auto bg-green-600 hover:bg-green-500 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center justify-center gap-2"
                          >
                            <Download className="w-5 h-5" />
                            Baixar .TXT
                          </a>
                        ) : job.status === "failed" ? (
                          <button 
                            onClick={() => startTranscription(video)}
                            className="w-full md:w-auto bg-red-600/20 text-red-400 border border-red-400/30 font-bold py-3 px-6 rounded-lg hover:bg-red-600/30 transition-all flex items-center justify-center gap-2"
                          >
                            Tentar Novamente
                          </button>
                        ) : (
                          <div className="w-full md:w-48 bg-white/5 rounded-lg p-3 border border-white/10">
                            <div className="flex justify-between text-xs mb-2">
                              <span className="text-gray-400 uppercase tracking-tighter">Processando</span>
                              <span className="text-orange-400 font-mono">...</span>
                            </div>
                            <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                              <motion.div 
                                className="h-full bg-orange-500"
                                animate={{ x: ["-100%", "100%"] }}
                                transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Empty State */}
        {!loading && videos.length === 0 && !error && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-24 text-center"
          >
            <div className="inline-block p-6 bg-white/5 rounded-full mb-6 border border-white/5">
              <FileText className="w-12 h-12 text-gray-600" />
            </div>
            <h2 className="text-xl font-bold text-gray-400 mb-2">Pronto para transcrever</h2>
            <p className="text-gray-600 max-w-sm mx-auto">
              Insira um link do YouTube acima para começar a extrair o texto dos seus vídeos favoritos.
            </p>
          </motion.div>
        )}
      </div>

      {/* Footer */}
      <footer className="mt-24 border-t border-white/5 py-12 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6 text-gray-600 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            <span>Servidor Online</span>
          </div>
          <div className="flex gap-8">
            <span className="hover:text-gray-400 cursor-help transition-colors">Whisper API</span>
            <span className="hover:text-gray-400 cursor-help transition-colors">YouTube Audio</span>
            <span className="hover:text-gray-400 cursor-help transition-colors">MP3 Export</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
