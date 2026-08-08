import { useState } from 'react';
import { api, ApiError, type Competitor } from '../api';
import { CompetitorLogo } from './CompetitorLogo';
import { Card, useToast } from './ui';

/**
 * Logo housekeeping, kept out of the competitor listing.
 *
 * Only competitors that actually have a logo appear here, so the card is a list
 * of things you can act on rather than a second copy of the table. Uploading
 * stays on the badge in the listing itself; this is where one gets taken away.
 */
export function LogoAdminCard({
  competitors,
  onChange,
}: {
  competitors: Competitor[];
  onChange: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const withLogos = competitors.filter((competitor) => competitor.has_logo);

  const remove = async (competitor: Competitor) => {
    setBusySlug(competitor.slug);
    try {
      await api.clearLogo(competitor.slug);
      await onChange();
      toast(`${competitor.display_name} logo removed.`, 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove logo', 'error');
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <Card
      title="Logo administration"
      subtitle={
        withLogos.length === 0
          ? 'No logos uploaded yet'
          : `${withLogos.length} of ${competitors.length} competitors have a logo`
      }
    >
      {withLogos.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          Click a competitor's badge in the table above to upload one, or use{' '}
          <strong>Fetch logos</strong> to pull them from the retailers' own sites. Competitors
          without a logo show a monogram badge, which is a working state rather than a missing
          one — nothing here needs to be filled in.
        </p>
      ) : (
        <>
          <ul className="logo-admin">
            {withLogos.map((competitor) => (
              <li key={competitor.id} className="logo-admin__row">
                <CompetitorLogo
                  slug={competitor.slug}
                  displayName={competitor.display_name}
                  hasLogo
                  size="lg"
                />
                <div className="logo-admin__name">
                  <div className="cell-primary">{competitor.display_name}</div>
                  <div className="cell-secondary xs">
                    {competitor.logo_url ? (
                      <>
                        Fetched from <span className="mono">{hostOf(competitor.logo_url)}</span>
                      </>
                    ) : (
                      'Uploaded by hand'
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busySlug === competitor.slug}
                  onClick={() => void remove(competitor)}
                >
                  {busySlug === competitor.slug ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Removing a logo puts the monogram badge back. To change one, upload a replacement
            over its badge in the table above — no need to remove it first.
          </p>
        </>
      )}
    </Card>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
