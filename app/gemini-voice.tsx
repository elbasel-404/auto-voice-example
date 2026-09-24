"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";

type GeminiVoiceProps = {
  apiKey: string;
  model?: string;
  apiVersion?: string;
};

function base64ToBlob(base64: string, mimeType: string): Blob {
  const normalized = base64.replace(/^data:audio\/[^;]+;base64,/, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType || "audio/wav" });
}

export default function GeminiVoice({
  apiKey,
  model = "gemini-2.0-flash-live-preview-04-09",
  apiVersion,
}: GeminiVoiceProps) {
  const [status, setStatus] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastClose, setLastClose] = useState<string | null>(null);
  const [lastErrorEvent, setLastErrorEvent] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const aiRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<any>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const [micActive, setMicActive] = useState(false);

  const [modelInput, setModelInput] = useState(model);
  const [apiVersionInput, setApiVersionInput] = useState(apiVersion ?? "");

  const handleModelMessage = useCallback((message: LiveServerMessage) => {
    const part = message.serverContent?.modelTurn?.parts?.[0];

    if (part?.text) {
      setTranscript((prev) => `${prev}${prev ? "\n" : ""}${part.text}`);
    }

    if (part?.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || "audio/wav";
      const blob = base64ToBlob(part.inlineData.data, mimeType);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      audio.play().catch(() => {
        // Browsers often block autoplay until the user interacts.
      });
    }
  }, []);

  const startSession = useCallback(async () => {
    if (!apiKey) {
      setError("Missing Gemini API key.");
      return;
    }

    try {
      setError(null);
      setStatus("connecting");

      // always create client at start so apiVersion changes apply
      aiRef.current = new GoogleGenAI({
        ...(apiVersionInput ? { apiVersion: apiVersionInput } : {}),
        apiKey,
      });

      const session = await aiRef.current.live.connect({
        model: modelInput,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Zephyr",
              },
            },
          },
        },
        callbacks: {
          onopen: () => {
            console.debug("Gemini live: onopen");
            setStatus("connected");
            setConnected(true);
            setLastClose(null);
            setLastErrorEvent(null);
          },
          onmessage: (message: LiveServerMessage) => {
            console.debug("Gemini live: onmessage", message);
            handleModelMessage(message);
          },
          onerror: (event: ErrorEvent) => {
            console.error("Gemini live: onerror", event);
            setStatus("error");
            setLastErrorEvent(
              JSON.stringify(
                {
                  message: event.message,
                  filename: (event as any).filename,
                  lineno: (event as any).lineno,
                },
                null,
                2,
              ),
            );
            setError(event.message || "Live connection error");
          },
          onclose: (evt?: CloseEvent) => {
            console.warn("Gemini live: onclose", evt);
            const details = evt
              ? `code=${evt.code} reason=${evt.reason} wasClean=${evt.wasClean}`
              : "close event (no details)";
            setLastClose(details);
            setStatus("closed");
            setConnected(false);
          },
        },
      });

      sessionRef.current = session;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start Gemini session";
      setStatus("error");
      setError(message);
    }
  }, [apiKey, handleModelMessage, modelInput, apiVersionInput]);

  const startMic = useCallback(async () => {
    if (!sessionRef.current) {
      setError("Start a Gemini session before enabling microphone.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const options: MediaRecorderOptions = {} as any;
      try {
        // prefer opus webm
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          options.mimeType = "audio/webm;codecs=opus";
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          options.mimeType = "audio/webm";
        }
      } catch {}

      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev: BlobEvent) => {
        const blob = ev.data;
        if (!blob || blob.size === 0) return;

        try {
          // prefer sendRealtimeInput if available
          const sess = sessionRef.current;
          if (sess?.sendRealtimeInput) {
            sess.sendRealtimeInput({ audio: blob });
          } else if (sess?.sendClientContent) {
            // fallback: send as mediaChunks inside realtimeInput
            sess.sendClientContent({ realtimeInput: { audio: blob } });
          }
        } catch (e) {
          console.error("Failed to send realtime audio chunk", e);
        }
      };

      recorder.onstart = () => setMicActive(true);
      recorder.onstop = () => setMicActive(false);

      // small timeslice for low-latency
      recorder.start(250);
    } catch (e) {
      setError((e as Error).message || String(e));
    }
  }, []);

  const stopMic = useCallback(() => {
    try {
      mediaRecorderRef.current?.stop();
    } catch {}
    try {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    mediaRecorderRef.current = null;
    mediaStreamRef.current = null;
    setMicActive(false);
  }, []);

  const sendPrompt = useCallback((prompt: string) => {
    const session = sessionRef.current;
    if (!session) {
      setError("Gemini session is not connected yet.");
      return;
    }

    try {
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ text: prompt }] }],
      });
    } catch (e) {
      setError((e as Error).message || String(e));
    }
  }, []);

  const stopSession = useCallback(() => {
    try {
      stopMic();
    } catch {}
    try {
      sessionRef.current?.close();
    } catch {}
    sessionRef.current = null;
    setConnected(false);
    setStatus("stopped");
  }, [stopMic]);

  useEffect(() => {
    return () => {
      try {
        stopMic();
      } catch {}
      try {
        sessionRef.current?.close();
      } catch {}
    };
  }, [stopMic]);

  return (
    <div className="flex max-w-md flex-col gap-4 rounded-2xl border border-white/15 bg-white/5 p-4 text-white">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-xl border border-white/20 px-3 py-2 disabled:opacity-50"
          onClick={() => void startSession()}
          disabled={connected}
        >
          Connect
        </button>

        <button
          type="button"
          className="rounded-xl border border-white/20 px-3 py-2 disabled:opacity-50"
          onClick={() => void (micActive ? stopMic() : startMic())}
          disabled={!connected}
        >
          {micActive ? "Stop mic" : "Talk to model"}
        </button>

        <button
          type="button"
          className="rounded-xl border border-white/20 px-3 py-2 disabled:opacity-50"
          onClick={() => sendPrompt("Hello! Please respond briefly.")}
          disabled={!connected}
        >
          Send test prompt
        </button>

        <button
          type="button"
          className="rounded-xl border border-white/20 px-3 py-2"
          onClick={stopSession}
        >
          Stop
        </button>
      </div>

      <div className="flex gap-2 items-center">
        <label className="text-xs text-white/60">Model:</label>
        <select
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          className="rounded-md bg-black/10 px-2 py-1 text-sm"
        >
          <option value="gemini-2.0-flash-live-preview-04-09">
            gemini-2.0-flash-live-preview-04-09
          </option>
          <option value="gemini-2.5-flash-native-audio-preview-12-2025">
            gemini-2.5-flash-native-audio-preview-12-2025
          </option>
          <option value="gemini-live-2.5-flash-preview">
            gemini-live-2.5-flash-preview (legacy)
          </option>
        </select>

        <label className="text-xs text-white/60">API version:</label>
        <input
          value={apiVersionInput}
          onChange={(e) => setApiVersionInput(e.target.value)}
          placeholder="v1alpha or v1beta"
          className="rounded-md bg-black/10 px-2 py-1 text-sm"
        />
      </div>

      <div className="text-sm text-white/70">
        <p>Status: {status}</p>
        <p>Microphone: {micActive ? "live" : "off"}</p>
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {lastErrorEvent ? (
        <pre className="text-xs text-red-300">{lastErrorEvent}</pre>
      ) : null}
      {lastClose ? (
        <p className="text-xs text-yellow-300">Last close: {lastClose}</p>
      ) : null}

      <div className="rounded-xl bg-black/20 p-3 text-sm leading-6 text-white/90">
        {transcript || "No transcript yet."}
      </div>
    </div>
  );
}
