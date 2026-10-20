import { useEffect, useState } from 'react';

export function SiteHeader({ landing, onHome, entry = false }: { landing: boolean; onHome: () => void; entry?: boolean }) {
  const [scrolled, setScrolled] = useState(() => window.scrollY > 20);

  useEffect(() => {
    if (!landing) return;
    const update = () => setScrolled(window.scrollY > 20);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [landing]);

  function startRoom() {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    document.getElementById('start-room')?.scrollIntoView({ behavior, block: 'center' });
  }

  return (
    <header className={'site-header reference-nav' + (landing ? ' is-landing' : '') + (entry ? ' is-entry' : '') +
      (!landing || scrolled ? ' is-scrolled' : '')}>
      <button type="button" className="brand" onClick={onHome} aria-label="WarpView home">
        <span className="reference-logo-mark" aria-hidden="true">
          <svg viewBox="0 0 26 26"><rect width="26" height="26" rx="8" fill="#0e0f14"/>
            <path d="M14.5 4 7 14.5h5L10.5 22 19 11h-5z" fill="#fff"/></svg>
        </span>
        <span>warpview</span>
      </button>
      {!entry && <nav aria-label="Site navigation">
        <a href="#how">How it works</a>
        <a href="#privacy">Privacy</a>
        <a href="#start-room">Share any file</a>
      </nav>}
      {!entry && <button type="button" className="primary-button reference-pill nav-start" onClick={startRoom}>
        Start a room
      </button>}
    </header>
  );
}
