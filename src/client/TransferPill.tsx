type Props = { phase: 'connecting' | 'uploading' | 'done' };

/** A single compact dock beside New, no timers or progress polling.
 * The text alternation is purely CSS so it cannot touch the transfer socket.
 */
export function TransferPill({ phase }: Props) {
  return (
    <div className={'transfer-pill student-status-pill is-' + phase}
      role="status"
      aria-label={phase === 'done' ? 'Done. PDFs saved on host computer.' :
        phase === 'connecting' ? 'Connecting to room.' :
        'Uploading. Keep this window open until finished.'}>
      {phase === 'done' ?
        <span className="student-pill-check" aria-hidden="true">✓</span> :
        <span className="transfer-pill-spinner" aria-hidden="true"/>}
      {phase === 'uploading' ? (
        <span className="student-pill-message" aria-hidden="true">
          <span className="student-pill-stay">Keep this window open</span>
          <span className="student-pill-upload">Uploading</span>
        </span>
      ) : (
        <span className="student-pill-single" aria-hidden="true">
          {phase === 'connecting' ? 'Connecting' : 'Done'}
        </span>
      )}
    </div>
  );
}
