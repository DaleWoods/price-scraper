import { useState } from 'react';

/**
 * A competitor's mark, shown next to their name.
 *
 * Falls back to a monogram badge whenever no logo is cached — which is the
 * normal state until logos have been fetched, and the permanent state for any
 * retailer whose site offers no usable icon. The fallback is deterministic, so a
 * given competitor always has the same colour and the eye learns it as an
 * identifier just like a real logo.
 */

/** Up to two initials: "Ernest Jones" -> EJ, "Beaverbrooks" -> B, "77 Diamonds" -> 7D. */
export function initialsFor(displayName: string): string {
  const words = displayName
    // Apostrophes are dropped rather than split on, so "Berry's Jewellers"
    // reads as BJ and not BS.
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);

  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase();
}

/**
 * Stable hue from the slug. Spread around the wheel so adjacent rows in a list
 * are easy to tell apart, and kept out of the red/green band that this app uses
 * to mean "cheaper" and "dearer" — a logo must not read as a price signal.
 */
export function hueFor(slug: string): number {
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) {
    hash = (hash * 31 + slug.charCodeAt(i)) % 100_000;
  }
  // 190°–330°: teals through blues, indigo and violet.
  return 190 + (hash % 141);
}

export type LogoSize = 'sm' | 'md' | 'lg';

const PIXELS: Record<LogoSize, number> = { sm: 20, md: 28, lg: 40 };

export function CompetitorLogo({
  slug,
  displayName,
  hasLogo = true,
  size = 'md',
  cacheBust,
}: {
  slug: string;
  displayName: string;
  /** Skip the network request entirely when we already know none is cached. */
  hasLogo?: boolean;
  size?: LogoSize;
  /** Changes the URL after an upload so the browser refetches the new image. */
  cacheBust?: number;
}) {
  const [failed, setFailed] = useState(false);
  const pixels = PIXELS[size];
  const hue = hueFor(slug);

  const style = {
    width: pixels,
    height: pixels,
    borderRadius: size === 'sm' ? 5 : 7,
  } as const;

  if (!hasLogo || failed) {
    return (
      <span
        className="clogo clogo--monogram"
        style={{
          ...style,
          background: `linear-gradient(140deg, hsl(${hue} 62% 52%), hsl(${hue + 22} 58% 42%))`,
          fontSize: pixels <= 20 ? 9 : pixels <= 28 ? 11 : 15,
        }}
        aria-hidden="true"
      >
        {initialsFor(displayName)}
      </span>
    );
  }

  return (
    <img
      className="clogo"
      style={style}
      src={`/api/competitors/${encodeURIComponent(slug)}/logo${cacheBust ? `?v=${cacheBust}` : ''}`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** Logo plus name, the pairing used everywhere a competitor is listed. */
export function CompetitorLabel({
  slug,
  displayName,
  hasLogo,
  size = 'md',
  className,
}: {
  slug: string;
  displayName: string;
  hasLogo?: boolean;
  size?: LogoSize;
  className?: string;
}) {
  return (
    <span className={`clogo-label${className ? ` ${className}` : ''}`}>
      <CompetitorLogo slug={slug} displayName={displayName} hasLogo={hasLogo} size={size} />
      <span>{displayName}</span>
    </span>
  );
}
