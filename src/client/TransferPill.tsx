/** The bottom status dock is deliberately connection-only.
 * File cards show transfer progress; don't repeat it in a second UI.
 */
export function TransferPill() {
  return (
    <div className="transfer-pill" role="status" aria-live="polite" aria-label="Connecting">
      <span className="transfer-pill-spinner" aria-hidden="true"/>
      <span className="transfer-pill-copy"><strong>Connecting…</strong></span>
    </div>
  );
}
