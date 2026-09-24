"use client";

import { useEffect, useRef, useState } from "react";

export default function Home() {
  const [result, setResult] = useState("none");
  const [shouldRestart, setShouldRestart] = useState(false);
  const shouldRestartRef = useRef(false);

  const recognitionRef = useRef(null);

  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    const recognition = new SpeechRecognition();
    // recognition.continuous = true;
    recognition.continuous = false;

    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0]?.[0]?.transcript || "";
      console.log(transcript);
      setResult(transcript);
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error", event);
      setResult(event.error);
    };

    recognition.onend = () => {
      if (!shouldRestartRef.current) return;
      recognition.start();
    };
    recognitionRef.current = recognition;

    // return () => {
    //   recognition.stop?.();
    //   recognitionRef.current = null;
    // };
  }, []);

  useEffect(() => {
    shouldRestartRef.current = shouldRestart;
  }, [shouldRestart]);

  const run = () => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      return;
    }
    (recognition as any).start();
  };

  return (
    <div className="h-screen">
      <button
        className="block border border-white rounded-3xl p-3"
        onClick={run}
      >
        Run
      </button>
      <button
        className="block border border-white rounded-3xl p-3"
        onClick={() => setShouldRestart((prev) => !prev)}
      >
        auto
      </button>

      <button
        className="block border border-white rounded-3xl p-3"
        onClick={() => setShouldRestart(false)}
      >
        stop
      </button>
      <p>Auto: {shouldRestart ? "On" : "Off"}</p>
      <output>result: {JSON.stringify(result)}</output>
    </div>
  );
}
