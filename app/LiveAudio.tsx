"use client";

import { useEffect, useRef, useState } from "react";
import {
  GoogleGenAI,
  MediaResolution,
  Modality,
  type LiveConnectConfig,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { createLiveToken } from "./actions";

const MODEL = "models/gemini-3.8-live";

const CONFIG: LiveConnectConfig = {
  responseModalities: [Modality.AUDIO],
  mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  speechConfig: {
    voiceConfig: {
      prebuiltVoiceConfig: { voiceName: "Zephyr" },
    },
  },
  contextWindowCompression: {
    triggerTokens: "104857",
    slidingWindow: { targetTokens: "52428" },
  },
};

// ---------------------------------------------------------------------------
// Audio helpers (browser-only: atob, DataView, Blob - no Buffer, no fs)
// ---------------------------------------------------------------------------

interface WavOptions {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// e.g. "audio/pcm;rate=24000"
function parseMimeType(mimeType: string): WavOptions {
  const [fileType, ...params] = mimeType.split(";").map((s) => s.trim());
  const [, format] = fileType.split("/");

  const options: WavOptions = {
    numChannels: 1,
    sampleRate: 24000, // fallback if the mime type has no rate
    bitsPerSample: 16,
  };

  if (format && format.startsWith("L")) {
    const bits = parseInt(format.slice(1), 10);
    if (!isNaN(bits)) options.bitsPerSample = bits;
  }

  for (const param of params) {
    const [key, value] = param.split("=").map((s) => s.trim());
    if (key === "rate") {
      const rate = parseInt(value, 10);
      if (!isNaN(rate)) options.sampleRate = rate;
    }
  }

  return options;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function createWavHeader(dataLength: number, options: WavOptions): ArrayBuffer {
  const { numChannels, sampleRate, bitsPerSample } = options;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeAscii(view, 0, "RIFF"); // ChunkID
  view.setUint32(4, 36 + dataLength, true); // ChunkSize
  writeAscii(view, 8, "WAVE"); // Format
  writeAscii(view, 12, "fmt "); // Subchunk1ID
  view.setUint32(16, 16, true); // Subchunk1Size (PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data"); // Subchunk2ID
  view.setUint32(40, dataLength, true); // Subchunk2Size

  return header;
}

function convertToWavBlob(chunks: Uint8Array[], mimeType: string): Blob {
  const options = parseMimeType(mimeType);
  const dataLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const header = createWavHeader(dataLength, options);
  return new Blob([header, ...(chunks as BlobPart[])], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Status = "idle" | "connecting" | "responding" | "error";

export default function LiveAudio() {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const sessionRef = useRef<Session | null>(null);
  const audioChunksRef = useRef<Uint8Array[]>([]);
  const mimeTypeRef = useRef("");

  const addLog = (line: string) => setLog((prev) => [...prev, line]);

  // Close the socket and free the blob URL on unmount.
  useEffect(() => {
    return () => {
      sessionRef.current?.close();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  function handleModelTurn(message: LiveServerMessage) {
    const parts = message.serverContent?.modelTurn?.parts;
    if (!parts) return;

    for (const part of parts) {
      if (part.fileData?.fileUri) {
        addLog(`File: ${part.fileData.fileUri}`);
      }
      if (part.inlineData?.data) {
        audioChunksRef.current.push(base64ToBytes(part.inlineData.data));
        mimeTypeRef.current = part.inlineData.mimeType ?? mimeTypeRef.current;
      }
      if (part.text) {
        addLog(part.text);
      }
    }
  }

  async function handleSend() {
    if (!prompt.trim() || status === "connecting" || status === "responding") {
      return;
    }

    setStatus("connecting");
    setLog([]);
    setAudioUrl(null);
    audioChunksRef.current = [];
    mimeTypeRef.current = "";

    try {
      // The API key stays on the server; we only receive a short-lived token.
      const token = await createLiveToken();

      const ai = new GoogleGenAI({
        apiKey: token,
        httpOptions: { apiVersion: "v1alpha" },
      });

      const session = await ai.live.connect({
        model: MODEL,
        config: CONFIG,
        callbacks: {
          onopen: () => console.debug("Opened"),
          onmessage: (message: LiveServerMessage) => {
            handleModelTurn(message);

            if (message.serverContent?.turnComplete) {
              if (audioChunksRef.current.length > 0) {
                const blob = convertToWavBlob(
                  audioChunksRef.current,
                  mimeTypeRef.current,
                );
                setAudioUrl(URL.createObjectURL(blob));
              }
              setStatus("idle");
              sessionRef.current?.close();
              sessionRef.current = null;
            }
          },
          onerror: (e: ErrorEvent) => {
            console.debug("Error:", e.message);
            addLog(`Error: ${e.message}`);
            setStatus("error");
          },
          onclose: (e: CloseEvent) => {
            console.debug("Close:", e.reason);
            if (e.reason) addLog(`Closed: ${e.reason}`);
          },
        },
      });

      sessionRef.current = session;
      setStatus("responding");
      session.sendClientContent({ turns: [prompt] });
    } catch (err) {
      addLog(err instanceof Error ? err.message : "Something went wrong");
      setStatus("error");
    }
  }

  const busy = status === "connecting" || status === "responding";

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should Gemini say?"
        rows={4}
        className="w-full rounded-md border border-neutral-300 p-3"
      />

      <button
        onClick={handleSend}
        disabled={busy || !prompt.trim()}
        className="self-start rounded-md bg-neutral-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {status === "connecting"
          ? "Connecting…"
          : status === "responding"
            ? "Generating audio…"
            : "Send"}
      </button>

      {log.length > 0 && (
        <pre className="whitespace-pre-wrap rounded-md bg-neutral-100 p-3 text-sm">
          {log.join("\n")}
        </pre>
      )}

      {audioUrl && (
        <div className="flex flex-col gap-2">
          <audio controls src={audioUrl} className="w-full" />
          <a href={audioUrl} download="audio.wav" className="text-sm underline">
            Download audio.wav
          </a>
        </div>
      )}
    </div>
  );
}
