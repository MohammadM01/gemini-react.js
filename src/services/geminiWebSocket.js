import { TranscriptionService } from './transcriptionService';
import { pcmToWav } from '../utils/audioUtils';

const MODEL = "models/gemini-2.0-flash-exp";
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const HOST = "generativelanguage.googleapis.com";
const WS_URL = `wss://${HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

export class GeminiWebSocket {
  constructor(onMessage, onSetupComplete, onPlayingStateChange, onAudioLevelChange, onTranscription) {
    this.ws = null;
    this.isConnected = false;
    this.isSetupComplete = false;
    this.onMessageCallback = onMessage;
    this.onSetupCompleteCallback = onSetupComplete;
    this.onPlayingStateChange = onPlayingStateChange;
    this.onAudioLevelChange = onAudioLevelChange;
    this.onTranscriptionCallback = onTranscription;
    this.audioContext = new AudioContext({ sampleRate: 24000 });
    this.transcriptionService = new TranscriptionService();
    this.audioQueue = [];
    this.isPlaying = false;
    this.currentSource = null;
    this.isPlayingResponse = false;
    this.accumulatedPcmData = [];
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      this.isConnected = true;
      this.sendInitialSetup();
    };

    this.ws.onmessage = async (event) => {
      try {
        let messageText = event.data instanceof Blob
          ? new TextDecoder('utf-8').decode(new Uint8Array(await event.data.arrayBuffer()))
          : event.data;
        
        await this.handleMessage(messageText);
      } catch (error) {
        console.error("[WebSocket] Error processing message:", error);
      }
    };

    this.ws.onerror = (error) => console.error("[WebSocket] Error:", error);
    
    this.ws.onclose = (event) => {
      this.isConnected = false;
      if (!event.wasClean && this.isSetupComplete) setTimeout(() => this.connect(), 1000);
    };
  }

  sendInitialSetup() {
    this.ws?.send(JSON.stringify({
      setup: { model: MODEL, generation_config: { response_modalities: ["AUDIO"] } }
    }));
  }

  sendMediaChunk(b64Data, mimeType) {
    if (!this.isConnected || !this.ws || !this.isSetupComplete) return;

    this.ws.send(JSON.stringify({
      realtime_input: {
        media_chunks: [{ mime_type: mimeType === "audio/pcm" ? "audio/pcm" : mimeType, data: b64Data }]
      }
    }));
  }

  async playAudioResponse(base64Data) {
    if (!this.audioContext) return;

    try {
      const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      const pcmData = new Int16Array(bytes.buffer);
      const float32Data = Float32Array.from(pcmData, val => val / 32768.0);

      this.audioQueue.push(float32Data);
      this.playNextInQueue();
    } catch (error) {
      console.error("[WebSocket] Error processing audio:", error);
    }
  }

  async playNextInQueue() {
    if (!this.audioContext || this.isPlaying || this.audioQueue.length === 0) return;

    try {
      this.isPlaying = true;
      this.isPlayingResponse = true;
      this.onPlayingStateChange?.(true);

      const float32Data = this.audioQueue.shift();
      const level = Math.min((float32Data.reduce((sum, val) => sum + Math.abs(val), 0) / float32Data.length) * 500, 100);
      this.onAudioLevelChange?.(level);

      const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      this.currentSource = this.audioContext.createBufferSource();
      this.currentSource.buffer = audioBuffer;
      this.currentSource.connect(this.audioContext.destination);

      this.currentSource.onended = () => {
        this.isPlaying = false;
        this.currentSource = null;
        if (this.audioQueue.length === 0) {
          this.isPlayingResponse = false;
          this.onPlayingStateChange?.(false);
        }
        this.playNextInQueue();
      };

      this.currentSource.start();
    } catch (error) {
      console.error("[WebSocket] Error playing audio:", error);
      this.isPlaying = false;
      this.isPlayingResponse = false;
      this.onPlayingStateChange?.(false);
      this.currentSource = null;
      this.playNextInQueue();
    }
  }

  stopCurrentAudio() {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (e) {}
      this.currentSource = null;
    }
    this.isPlaying = false;
    this.isPlayingResponse = false;
    this.onPlayingStateChange?.(false);
    this.audioQueue = [];
  }

  async handleMessage(message) {
    try {
      const messageData = JSON.parse(message);

      if (messageData.setupComplete) {
        this.isSetupComplete = true;
        this.onSetupCompleteCallback?.();
        return;
      }

      if (messageData.serverContent?.modelTurn?.parts) {
        for (const part of messageData.serverContent.modelTurn.parts) {
          if (part.inlineData?.mimeType === "audio/pcm;rate=24000") {
            this.accumulatedPcmData.push(part.inlineData.data);
            this.playAudioResponse(part.inlineData.data);
          }
        }
      }

      if (messageData.serverContent?.turnComplete === true && this.accumulatedPcmData.length > 0) {
        try {
          const wavData = await pcmToWav(this.accumulatedPcmData.join(''), 24000);
          const transcription = await this.transcriptionService.transcribeAudio(wavData, "audio/wav");
          console.log("[Transcription]:", transcription);
          this.onTranscriptionCallback?.(transcription);
          this.accumulatedPcmData = [];
        } catch (error) {
          console.error("[WebSocket] Transcription error:", error);
        }
      }
    } catch (error) {
      console.error("[WebSocket] Error parsing message:", error);
    }
  }

  disconnect() {
    this.isSetupComplete = false;
    if (this.ws) {
      this.ws.close(1000, "Intentional disconnect");
      this.ws = null;
    }
    this.isConnected = false;
    this.accumulatedPcmData = [];
  }
}