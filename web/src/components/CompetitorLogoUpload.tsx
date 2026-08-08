import { useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { CompetitorLogo } from './CompetitorLogo';
import { useToast } from './ui';

/**
 * The competitor's mark, doubling as its own upload control: click or drop an
 * image on it to set the logo.
 *
 * This is the path that needs no egress — fetch the logo yourself and put it in
 * directly, which also lets a proper wordmark replace a poor 16px favicon.
 */
export function CompetitorLogoUpload({
  slug,
  displayName,
  hasLogo,
  onChange,
}: {
  slug: string;
  displayName: string;
  hasLogo: boolean;
  /** Called after a successful upload or removal so the row can refresh. */
  onChange: () => void | Promise<void>;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Bumped after each change to defeat the browser's cache of the old image. */
  const [version, setVersion] = useState(0);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      await api.uploadLogo(slug, file);
      setVersion((v) => v + 1);
      await onChange();
      toast(`${displayName} logo updated.`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Logo upload failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.clearLogo(slug);
      setVersion((v) => v + 1);
      await onChange();
      toast(`${displayName} logo removed.`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove logo', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="clogo-upload">
      <button
        type="button"
        className="clogo-drop"
        data-dragging={dragging}
        disabled={busy}
        title={hasLogo ? `Replace ${displayName} logo` : `Upload a logo for ${displayName}`}
        aria-label={hasLogo ? `Replace ${displayName} logo` : `Upload a logo for ${displayName}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const dropped = event.dataTransfer.files?.[0];
          if (dropped) void upload(dropped);
        }}
      >
        {busy ? (
          <span className="spinner" style={{ width: 40, height: 40 }} />
        ) : (
          <CompetitorLogo
            key={version}
            slug={slug}
            displayName={displayName}
            hasLogo={hasLogo}
            size="lg"
            cacheBust={version}
          />
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/svg+xml,image/jpeg,image/webp,image/gif,image/x-icon,.ico"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            // Reset so choosing the same file twice still fires a change.
            event.target.value = '';
          }}
        />
      </button>
      {/* Always rendered so a row does not change height when a logo is added. */}
      <div className="clogo-actions">
        {hasLogo && (
          <button type="button" className="clogo-link" onClick={() => void remove()} disabled={busy}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
