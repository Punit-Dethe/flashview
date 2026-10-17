type Props = { percent: number; complete?: boolean; label: string; className?: string };
const CIRCUMFERENCE = 2 * Math.PI * 16;

/** Shared circular progress and completion tick for the phone cards and status dock. */
export function TransferRing({ percent, complete = false, label, className = '' }: Props) {
  const value = complete ? 100 : Math.max(0, Math.min(100, percent));
  return (
    <span className={'transfer-ring ' + (complete ? 'is-complete ' : '') + className}
      role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round(value)} title={label}>
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle className="ring-track" cx="22" cy="22" r="16" strokeWidth="4.5" fill="none"/>
        <circle className="ring-fill" cx="22" cy="22" r="16" strokeWidth="4.5" fill="none"
          strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - value / 100)}/>
        {complete && <path d="M16 22.5l4.1 4.1L29 17.5" stroke="currentColor" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round" fill="none"/>}
      </svg>
    </span>
  );
}
