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
import { createLiveToken } from "./createLiveToken";

const MODEL = "models/gemini-3.8-live";
const INPUT_SAMPLE_RATE = 16000; // what the Live API expects for mic audio
const MAX_RETRIES = 5;

const BASE_CONFIG: LiveConnectConfig = {
  responseModalities: [Modality.AUDIO],
  mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  speechConfig: {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  contextWindowCompression: {
    triggerTokens: "104857",
    slidingWindow: { targetTokens: "52428" },
  },
};

// ---------------------------------------------------------------------------
// Mic capture worklet. Runs on the audio thread: downsamples the mic to 16 kHz
// mono, converts to 16-bit PCM and posts ~40 ms frames to the main thread.
// Inlined as a string + Blob URL so there's no separate file to serve.
// ---------------------------------------------------------------------------
const WORKLET_SRC = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${INPUT_SAMPLE_RATE};
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
    this.out = new Int16Array(640);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.count));
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.acc = 0;
        this.count = 0;
        if (this.n === this.out.length) {
          this.port.postMessage(this.out.buffer.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// e.g. "audio/pcm;rate=24000" -> 24000
function parseRate(mimeType: string, fallback = 24000): number {
  const match = /rate=(\d+)/.exec(mimeType);
  return match ? parseInt(match[1], 10) : fallback;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Status = "idle" | "connecting" | "live" | "reconnecting";
type Turn = { role: "you" | "gemini"; text: string };

export default function LiveAudio() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Turn[]>([]);

  // Session / connection
  const sessionRef = useRef<Session | null>(null);
  const generationRef = useRef(0); // invalidates callbacks from old sockets
  const stoppedRef = useRef(true); // true unless the user is live
  const retriesRef = useRef(0);
  const resumeHandleRef = useRef<string | null>(null);

  // Mic
  const micRef = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    node: AudioWorkletNode;
  } | null>(null);

  // Playback
  const playCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const playingRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Tear everything down if the component unmounts mid-conversation.
  useEffect(() => {
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- transcript ---------------------------------------------------------

  function appendTranscript(role: Turn["role"], text: string) {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role) {
        return [...prev.slice(0, -1), { role, text: last.text + text }];
      }
      return [...prev, { role, text }];
    });
  }

  // ---- playback -----------------------------------------------------------

  function playChunk(base64: string, mimeType: string) {
    const playAudioContext = playCtxRef.current;
    if (!playAudioContext) return;

    const bytes = base64ToBytes(base64);
    const pcm = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength >> 1,
    );
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 0x8000;

    const buffer = playAudioContext.createBuffer(
      1,
      floats.length,
      parseRate(mimeType),
    );
    buffer.copyToChannel(floats, 0);

    const source = playAudioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playAudioContext.destination);

    // Queue chunks back-to-back so playback is gapless.
    const startAt = Math.max(
      playAudioContext.currentTime + 0.03,
      nextPlayTimeRef.current,
    );
    source.start(startAt);
    nextPlayTimeRef.current = startAt + buffer.duration;

    playingRef.current.add(source);
    source.onended = () => playingRef.current.delete(source);
  }

  function stopPlayback() {
    for (const source of playingRef.current) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    playingRef.current.clear();
    nextPlayTimeRef.current = 0;
  }

  // ---- incoming messages --------------------------------------------------

  function handleMessage(message: LiveServerMessage) {
    console.log(message);
    // Remember the latest resumption handle so we can reconnect seamlessly.
    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      resumeHandleRef.current = update.newHandle;
    }

    const content = message.serverContent;
    if (!content) return;

    // The user talked over the model: drop whatever audio is still queued.
    if (content.interrupted) stopPlayback();

    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        playChunk(part.inlineData.data, part.inlineData.mimeType ?? "");
      }
    }

    if (content.inputTranscription?.text) {
      appendTranscript("you", content.inputTranscription.text);
    }
    if (content.outputTranscription?.text) {
      appendTranscript("gemini", content.outputTranscription.text);
    }
  }

  // ---- connection ---------------------------------------------------------

  async function openSession() {
    const generation = ++generationRef.current;

    // API key stays on the server; we only receive a short-lived token.
    const token = await createLiveToken();
    const ai = new GoogleGenAI({
      apiKey: token,
      httpOptions: { apiVersion: "v1alpha" },
    });

    const session = await ai.live.connect({
      model: MODEL,
      config: {
        ...BASE_CONFIG,
        sessionResumption: resumeHandleRef.current
          ? { handle: resumeHandleRef.current }
          : {},
      },
      callbacks: {
        onopen: () => {
          if (generation !== generationRef.current) return;
          retriesRef.current = 0;
          setStatus("live");
        },
        onmessage: (message: LiveServerMessage) => {
          if (generation !== generationRef.current) return;
          handleMessage(message);
        },
        onerror: (e: ErrorEvent) => {
          console.debug("Live error:", e.message);
        },
        onclose: (e: CloseEvent) => {
          if (generation !== generationRef.current || stoppedRef.current)
            return;
          console.debug("Live closed:", e.reason);
          sessionRef.current = null;
          void reconnect();
        },
      },
    });

    // The user may have hit Stop while we were connecting.
    if (generation !== generationRef.current) {
      session.close();
      return;
    }
    sessionRef.current = session;
  }

  // The socket dropped but the user didn't press Stop: reconnect and resume.
  async function reconnect() {
    if (stoppedRef.current) return;
    if (retriesRef.current >= MAX_RETRIES) {
      setError("Connection lost. Click Go live to start again.");
      await stop();
      return;
    }
    retriesRef.current += 1;
    setStatus("reconnecting");
    await new Promise((r) => setTimeout(r, 500 * retriesRef.current));
    if (stoppedRef.current) return;
    try {
      await openSession();
    } catch {
      void reconnect();
    }
  }

  // ---- microphone ---------------------------------------------------------

  async function startMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true, // keeps the model's voice out of the mic
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const audioContext = new AudioContext();
    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SRC], { type: "application/javascript" }),
    );
    try {
      await audioContext.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    const source = audioContext.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioContext, "pcm-capture");

    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const session = sessionRef.current;
      if (!session) return; // connecting/reconnecting: drop frames
      try {
        session.sendRealtimeInput({
          audio: {
            data: bytesToBase64(new Uint8Array(e.data)),
            mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
          },
        });
      } catch {
        /* socket is closing; onclose will handle reconnecting */
      }
    };

    // Route through a muted gain node so the worklet is pulled by the graph
    // without playing the mic back through the speakers.
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(audioContext.destination);

    micRef.current = { stream, ctx: audioContext, node };
  }

  // ---- start / stop -------------------------------------------------------

  async function start() {
    if (status !== "idle") return;

    stoppedRef.current = false;
    retriesRef.current = 0;
    resumeHandleRef.current = null;
    setError(null);
    setTranscript([]);
    setStatus("connecting");

    // Create the playback context synchronously inside the click handler so
    // the browser's autoplay policy lets it run.
    const playCtx = new AudioContext({ sampleRate: 24000 });
    void playCtx.resume();
    playCtxRef.current = playCtx;
    nextPlayTimeRef.current = 0;

    try {
      await startMic();
      await openSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not go live");
      await stop();
    }
  }

  async function stop() {
    stoppedRef.current = true;
    generationRef.current += 1; // ignore any late callbacks

    sessionRef.current?.close();
    sessionRef.current = null;

    const mic = micRef.current;
    micRef.current = null;
    if (mic) {
      mic.node.port.onmessage = null;
      mic.node.disconnect();
      mic.stream.getTracks().forEach((t) => t.stop());
      await mic.ctx.close().catch(() => {});
    }

    stopPlayback();
    const playCtx = playCtxRef.current;
    playCtxRef.current = null;
    await playCtx?.close().catch(() => {});

    setStatus("idle");
  }

  // ---- UI -----------------------------------------------------------------

  const isIdle = status === "idle";
  const statusLabel = {
    idle: "Not connected",
    connecting: "Connecting…",
    live: "Live: just start talking",
    reconnecting: "Reconnecting…",
  }[status];

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        {isIdle ? (
          <button
            onClick={start}
            className="rounded-md bg-neutral-900 px-4 py-2 text-white"
          >
            Go live
          </button>
        ) : (
          <button
            onClick={() => void stop()}
            className="rounded-md bg-red-600 px-4 py-2 text-white"
          >
            Stop
          </button>
        )}
        <span className="text-sm text-neutral-600" aria-live="polite">
          {statusLabel}
        </span>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {transcript.length > 0 && (
        <ul className="flex flex-col gap-2 rounded-md bg-neutral-100 p-3 text-sm">
          {transcript.map((turn, i) => (
            <li key={i}>
              <span className="font-medium">
                {turn.role === "you" ? "You" : "Gemini"}:
              </span>{" "}
              {turn.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
