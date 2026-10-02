import { formatKr } from '@loanflow/core';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api';
import { errorMessage } from '../format';
import { useActionKey } from '../useActionKey';
import { usePolling } from '../usePolling';

export function LoanPage() {
  const { id = '' } = useParams();
  const load = useCallback(() => api.loan(id), [id]);
  const { data, error, refresh } = usePolling(load, 5000, (d) => d.loan.status === 'REPAID');
  const payAction = useActionKey();
  const paidInstalments = data?.loan.paidInstalments;
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string>();

  // A new instalment was recorded: the next click is a new payment, whatever the previous request did
  useEffect(() => {
    payAction.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paidInstalments]);

  if (!data) return <p className="muted">{error ?? 'Laddar…'}</p>;
  const { loan, ledger } = data;
  const next = loan.schedule[loan.paidInstalments];

  async function pay() {
    setPaying(true);
    setPayError(undefined);
    try {
      await api.pay(id, payAction.key());
      payAction.reset(); // the next click is a new payment
      refresh();
    } catch (err) {
      setPayError(errorMessage(err));
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="split">
      <section className="card">
        <Link to={`/applications/${loan.applicationId}`}>← Ansökan</Link>
        <h1>Kvar att betala: {formatKr(loan.balance)}</h1>
        <p className="muted">{loan.status === 'REPAID' ? 'Lånet är återbetalt.' : `Betalda delbetalningar: ${loan.paidInstalments} av ${loan.schedule.length}`}</p>
        {next && (
          <button onClick={pay} disabled={paying}>
            {paying ? 'Betalar…' : `Simulera inbetalning ${next.number}: ${formatKr(next.total)}`}
          </button>
        )}
        {payError && <p className="error">{payError}</p>}
        <table>
          <thead>
            <tr><th>#</th><th>Amortering</th><th>Avgift</th><th>Summa</th><th /></tr>
          </thead>
          <tbody>
            {loan.schedule.map((i) => (
              <tr key={i.number} className={i.number <= loan.paidInstalments ? 'paid' : ''}>
                <td>{i.number}</td>
                <td>{formatKr(i.principal)}</td>
                <td>{formatKr(i.fee)}</td>
                <td>{formatKr(i.total)}</td>
                <td>{i.number <= loan.paidInstalments ? '✓' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Huvudbok</h2>
        <table>
          <thead>
            <tr><th>Konto</th><th>Debet</th><th>Kredit</th></tr>
          </thead>
          {ledger.map((entry) => (
            <tbody key={entry.entryId}>
              <tr className="entry-head"><td colSpan={3}>{entry.reason} · {new Date(entry.occurredAt).toLocaleString('sv-SE')}</td></tr>
              {entry.lines.map((l) => (
                <tr key={l.account}>
                  <td><code>{l.account}</code></td>
                  <td>{l.debit ? formatKr(l.debit) : ''}</td>
                  <td>{l.credit ? formatKr(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </section>
    </div>
  );
}
