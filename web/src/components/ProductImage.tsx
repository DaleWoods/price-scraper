import { useState } from 'react';

/**
 * A product's photo, from our own sites' image server.
 *
 * The first photo on every Goldsmiths, Mappin & Webb and Watches of
 * Switzerland product page — watches, rings and everything else — lives at
 * content.thewosgroup.com/productimage/<SKU>/<SKU>_1.jpg. So a product shows
 * its photo even before one has been saved for it, from its SKU alone.
 *
 * The full-size photo is around 140 KB; the image server resizes on request
 * (`imwidth`), so each is fetched at twice the size it is shown — sharp on a
 * high-resolution screen, a fraction of the weight. A photo that fails to load
 * falls back to a plain placeholder rather than a broken-image icon.
 */
const IMAGE_HOST = 'content.thewosgroup.com';

export function productImageUrl(imageUrl: string | null | undefined, sku: string | null | undefined, width: number): string | null {
  let url = imageUrl?.trim() || null;
  if (!url && sku && /^[0-9A-Za-z-]{4,20}$/.test(sku)) {
    url = `https://${IMAGE_HOST}/productimage/${sku}/${sku}_1.jpg`;
  }
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === IMAGE_HOST) {
      parsed.searchParams.set('imwidth', String(Math.round(width * 2)));
      return parsed.toString();
    }
    return url;
  } catch {
    return null;
  }
}

export function ProductImage({
  imageUrl,
  sku,
  width,
  className,
  alt = '',
}: {
  imageUrl?: string | null;
  sku?: string | null;
  /** The size it is shown at, in CSS pixels. */
  width: number;
  className: string;
  alt?: string;
}) {
  const src = productImageUrl(imageUrl, sku, width);
  const [failed, setFailed] = useState<string | null>(null);

  if (!src || failed === src) {
    return (
      <span className={`${className} product-image--empty`} aria-hidden>
        ◇
      </span>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(src)}
    />
  );
}
