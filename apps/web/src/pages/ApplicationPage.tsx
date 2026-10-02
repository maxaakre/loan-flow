import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api';
import { OfferCard } from '../components/OfferCard';
import { Timeline } from '../components/Timeline';
import { STATUS_SV } from '../format';
import { useActionKey } from '../useActionKey';
import { usePolling } from '../usePolling';

const REASON_SV: Record<string, string> = {
  PAYMENT_REMARKS: 'Företaget har betalningsanmärkningar.',
  BANKRUPTCY: 'Företaget är i konkurs.',
  COMPANY_TOO_YOUNG: 'Företaget är yngre än 6 månader.',
  LOW_CASHFLOW: 'Kassaflödet räcker inte för beloppet.',
};

const FINAL_STATUSES = new Set(['DISBURSED', 'DECLINED', 'EXPIRED', 'MANUAL_REVIEW']);
const isFinal = ([app]: Awaited<ReturnType<typeof loadBoth>>) => FINAL_STATUSES.has(app.status);
const loadBoth = (id: string) => Promise.all([api.application(id), api.events(id)]);

export function ApplicationPage() {
  const { id = '' } = useParams();
  const load = useCallback(() => loadBoth(id), [id]);
  const { data, error } = usePolling(load, 2000, isFinal);
  const signAction = useActionKey();
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string>();

  if (!data) return <p className="muted">{error ?? 'Laddar…'}</p>;
  const [app, events] = data;

  async function sign() {
    setSigning(true);
    setSignError(undefined);
    try {
      await api.sign(id, signAction.key());
    } catch (err) {
      setSignError(err instanceof Error ? err.message : 'Något gick fel.');
      setSigning(false);
    }
  }

  return (
    <div className="split">
      <section className="card">
        <p className="muted">{app.companyName}</p>
        <h1>{STATUS_SV[app.status]}</h1>
        {(app.status === 'SUBMITTED' || app.status === 'ASSESSING') && <p>Vi hämtar uppgifter om företaget…</p>}
        {app.status === 'OFFERED' && app.offer && (
          <>
            {app.decision?.outcome === 'APPROVED_WITH_CHANGES' && (
              <p>Vi kan inte låna ut hela beloppet, men vi kan erbjuda detta:</p>
            )}
            <OfferCard offer={app.offer} expiresAt={app.offerExpiresAt} />
            {signError && <p className="error">{signError}</p>}
            <button onClick={sign} disabled={signing}>
              {signing ? 'Signerar…' : 'Signera'}
            </button>
          </>
        )}
        {app.status === 'SIGNED' && <p>Signerat. Pengarna betalas ut nu.</p>}
        {app.status === 'DECLINED' && (
          <p>Vi kan tyvärr inte erbjuda ett lån just nu. {REASON_SV[app.decision?.reasons[0] ?? ''] ?? ''}</p>
        )}
        {app.status === 'MANUAL_REVIEW' && <p>En handläggare tittar på ansökan.</p>}
        {app.status === 'EXPIRED' && <p>Erbjudandet gick ut. Du är välkommen att ansöka igen.</p>}
        {app.status === 'DISBURSED' && <Link to={`/loans/${app.id}`}>Visa lånet →</Link>}
      </section>
      <section className="card">
        <h2>Händelser</h2>
        <Timeline items={events} />
      </section>
    </div>
  );
}
