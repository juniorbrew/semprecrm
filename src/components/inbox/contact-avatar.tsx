"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/** First letter of the display name, upper-cased ("?" when empty). */
export function avatarInitial(name: string | null | undefined): string {
  const first = (name ?? "").trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

/**
 * Contact photo with an initials fallback. `contacts.avatar_url` is filled
 * for QR-channel contacts only (migration 055 — the Meta Cloud API has no
 * profile photos), and a stored URL can still fail to load (photo removed
 * from storage, offline), so a load error falls back to the initial. The
 * failure is remembered per URL, so a new photo gets its own attempt.
 */
export function ContactAvatar({
  src,
  name,
  className,
}: {
  src: string | null | undefined;
  /** Display name — the fallback initial and the image's alt text. */
  name: string;
  /** Size / typography classes for the circle (e.g. "h-9 w-9 text-sm"). */
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPhoto = !!src && failedSrc !== src;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-foreground",
        className,
      )}
    >
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span>{avatarInitial(name)}</span>
      )}
    </div>
  );
}
