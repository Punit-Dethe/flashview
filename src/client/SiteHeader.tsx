export function SiteHeader({ landing, onHome }: { landing: boolean; onHome: () => void }) {
  return (
    <header className={'site-header reference-nav' + (landing ? ' is-landing' : ' is-scrolled')}>
      <button type="button" className="brand" onClick={onHome} aria-label="WarpView home">
        <span className="reference-logo-mark" aria-hidden="true">
          <svg viewBox="0 0 26 26"><rect width="26" height="26" rx="8" fill="#0e0f14"/>
            <path d="M14.5 4 7 14.5h5L10.5 22 19 11h-5z" fill="#fff"/></svg>
        </span>
        <span>warpview</span>
      </button>
    </header>
  );
}
