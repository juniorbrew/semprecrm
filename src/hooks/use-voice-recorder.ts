"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Worker that encodes mic input to Ogg/Opus entirely in the browser
 * (vendored from opus-recorder into /public). Recording client-side in
 * a widely accepted format means no server ffmpeg / transcode step.
 */
export const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";

/** Default hard cap on one take so it cannot blow the upload limits. */
export const VOICE_RECORDING_MAX_SECONDS = 5 * 60;

export interface UseVoiceRecorderOptions {
  /** Receives the finished Ogg/Opus file (never called for cancelled takes). */
  onRecorded: (file: File, seconds: number) => void;
  /** Called when the mic cannot be opened / the browser lacks support. */
  onError?: (reason: "unsupported" | "denied") => void;
  /** Auto-stop cap in seconds (default 5 min). */
  maxSeconds?: number;
}

export interface VoiceRecorder {
  recording: boolean;
  /** Elapsed seconds of the live take. */
  seconds: number;
  maxSeconds: number;
  start: () => Promise<void>;
  /** Stop and hand the file to `onRecorded`. */
  stop: () => void;
  /** Stop and discard. */
  cancel: () => void;
}

/**
 * Voice-note recorder shared by the inbox composer and the internal
 * chat. Lazy-loads `opus-recorder` (≈400 KB worker) on first use,
 * ticks a seconds counter while live, auto-stops at `maxSeconds` and
 * releases the microphone on unmount.
 */
export function useVoiceRecorder(options: UseVoiceRecorderOptions): VoiceRecorder {
  const maxSeconds = options.maxSeconds ?? VOICE_RECORDING_MAX_SECONDS;
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const secondsRef = useRef(0);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear down a live recording on unmount so a mid-record navigation
  // does not leak the mic.
  useEffect(() => {
    return () => {
      clearTimer();
      cancelledRef.current = true;
      // stop() releases the mic stream + audio context inside opus-recorder.
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
    };
  }, [clearTimer]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === "undefined"
    ) {
      optionsRef.current.onError?.("unsupported");
      return;
    }
    try {
      // Lazy-load the encoder only when the user records, keeping it out
      // of the main bundle.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        // Uint8Array is a valid BlobPart at runtime; the cast sidesteps the
        // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
        const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
          type: "audio/ogg",
        });
        if (file.size === 0) return; // empty take
        optionsRef.current.onRecorded(file, secondsRef.current);
      };
      recorderRef.current = recorder;
      await recorder.start();
      secondsRef.current = 0;
      setSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => {
        secondsRef.current += 1;
        setSeconds(secondsRef.current);
      }, 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      optionsRef.current.onError?.("denied");
    }
  }, []);

  const stop = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
    recorderRef.current = null;
  }, [clearTimer]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
    recorderRef.current = null;
  }, [clearTimer]);

  // Auto-stop at the cap so a forgotten recording cannot grow forever.
  useEffect(() => {
    if (recording && seconds >= maxSeconds) stop();
  }, [recording, seconds, maxSeconds, stop]);

  return { recording, seconds, maxSeconds, start, stop, cancel };
}
