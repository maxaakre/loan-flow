import { TERMS, type TermMonths } from '@loanflow/core';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, type CompanyOption } from '../api';
import { errorMessage, toOre } from '../format';
import { useActionKey } from '../useActionKey';

export function ApplyPage() {
  const navigate = useNavigate();
  const action = useActionKey();
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [orgNr, setOrgNr] = useState('');
  const [amountText, setAmountText] = useState('200 000');
  const [termMonths, setTermMonths] = useState<TermMonths>(12);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.companies().then((list) => {
      setCompanies(list);
      setOrgNr((current) => current || list[0]?.orgNr || '');
    }, () => setError('Kunde inte hämta testföretagen.'));
  }, []);

  // Changing the form is a new action, so it needs a new idempotency key
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    action.reset();
    set(v);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amount = toOre(amountText);
    if (!amount.ok) return setError(amount.error);
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await api.apply({ orgNr, amount: amount.value, termMonths }, action.key());
      action.reset();
      navigate(`/applications/${id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card">
      <h1>Ansök om företagslån</h1>
      <label>
        Testföretag
        <select value={orgNr} onChange={(e) => edit(setOrgNr)(e.target.value)}>
          {companies.map((c) => (
            <option key={c.orgNr} value={c.orgNr}>
              {c.name} ({c.orgNr})
            </option>
          ))}
        </select>
      </label>
      <label>
        Belopp (kr)
        <input inputMode="numeric" value={amountText} onChange={(e) => edit(setAmountText)(e.target.value)} />
      </label>
      <label>
        Löptid
        <select value={termMonths} onChange={(e) => edit(setTermMonths)(Number(e.target.value) as TermMonths)}>
          {TERMS.map((t) => (
            <option key={t} value={t}>
              {t} månader
            </option>
          ))}
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy || !orgNr}>{busy ? 'Skickar…' : 'Skicka ansökan'}</button>
    </form>
  );
}
