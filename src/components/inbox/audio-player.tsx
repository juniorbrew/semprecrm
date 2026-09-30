"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/hooks/use-language";
import {
  formatClock,
  nextSpeed,
  readSpeed,
  speedLabel,
  writeSpeed,
  type AudioSpeed,
} from "@/lib/inbox/audio-speed";

/**
 * Compact voice-message player: play / pause, seek, elapsed / total and a
 * 1x / 1.5x / 2x speed toggle (remembered on the device). Colours inherit
 * from the bubble (`currentColor`), so it reads on both the primary and the
 * muted fill. If the browser cannot play the source, the native controls
 * take over.
 */
export function AudioPlayer({ src }: { src: string }) {
  const { t } = useLanguage();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(NaN);
  const [speed, setSpeed] = useState<AudioSpeed>(() => readSpeed());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.playbackRate = speed;
      // Only the element's `error` event means the source is unplayable; a
      // rejected play() (AbortError / NotAllowedError) is just a refused start.
      el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, [speed]);

  const cycleSpeed = useCallback(() => {
    const next = nextSpeed(speed);
    setSpeed(next);
    writeSpeed(next);
  }, [speed]);

  if (failed) {
    return <audio src={src} controls className="max-w-60" data-testid="audio-native" />;
  }

  // WebM voice notes can report Infinity: no seeking, elapsed still shows.
  const known = Number.isFinite(duration) && duration > 0;
  const btn =
    "inline-flex shrink-0 items-center justify-center rounded-full bg-current/15 transition-colors hover:bg-current/25 focus-visible:outline-2 focus-visible:outline-offset-1";

  return (
    <div className="flex w-56 max-w-full items-center gap-2" data-testid="audio-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={(e) => {
          setPlaying(true);
          // One voice message at a time.
          document.querySelectorAll("audio").forEach((other) => {
            if (other !== e.currentTarget && !other.paused) other.pause();
          });
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t("Pause") : t("Play")}
        className={cn(btn, "h-8 w-8")}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <input
          type="range"
          min={0}
          max={known ? duration : 0}
          step={0.1}
          value={known ? Math.min(current, duration) : 0}
          disabled={!known}
          aria-label={t("Seek")}
          onChange={(e) => {
            const el = audioRef.current;
            const value = Number(e.target.value);
            if (el) el.currentTime = value;
            setCurrent(value);
          }}
          className="h-3 w-full cursor-pointer accent-current disabled:cursor-default"
        />
        <span className="text-[10px] tabular-nums opacity-80" data-no-translate>
          {known ? `${formatClock(current)} / ${formatClock(duration)}` : formatClock(current)}
        </span>
      </div>
      <button
        type="button"
        onClick={cycleSpeed}
        aria-label={`${t("Playback speed")}: ${speedLabel(speed)}`}
        title={t("Playback speed")}
        data-no-translate
        className={cn(btn, "h-6 min-w-8 px-1.5 text-[11px] font-semibold tabular-nums")}
      >
        {speedLabel(speed)}
      </button>
    </div>
  );
}
