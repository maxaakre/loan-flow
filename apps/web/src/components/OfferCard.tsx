import { formatKr, maxMonthlyCost, type Offer } from '@loanflow/core';

export function OfferCard({ offer, expiresAt }: { offer: Offer; expiresAt?: string }) {
  return (
    <dl className="offer">
      <dt>Belopp</dt>
      <dd>{formatKr(offer.amount)}</dd>
      <dt>Löptid</dt>
      <dd>{offer.termMonths} månader</dd>
      <dt>Månadsavgift</dt>
      <dd>{formatKr(offer.monthlyFee)}</dd>
      <dt>Högsta månadskostnad</dt>
      <dd>{formatKr(maxMonthlyCost(offer))}</dd>
      <dt>Totala avgifter</dt>
      <dd>{formatKr(offer.totalFees)}</dd>
      <dt>
        <strong>Total kostnad</strong>
      </dt>
      <dd>
        <strong>{formatKr(offer.totalCost)}</strong>
      </dd>
      {expiresAt && (
        <>
          <dt>Gäller till</dt>
          <dd>{new Date(expiresAt).toLocaleString('sv-SE')}</dd>
        </>
      )}
    </dl>
  );
}
