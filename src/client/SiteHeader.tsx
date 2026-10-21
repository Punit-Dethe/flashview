import { useEffect, useState, type MouseEvent } from 'react';

export function SiteHeader({ landing, onHome, publicNavigation = false, architecture = false,
  onRoomAction }: { landing: boolean; onHome: () => void; publicNavigation?: boolean;
  architecture?: boolean; onRoomAction?: (action: 'create' | 'join') => void }) {
  const [scrolled, setScrolled] = useState(() => window.scrollY > 24);
  useEffect(() => {
    if (!publicNavigation || !landing) return;
    const update = () => setScrolled(window.scrollY > 24);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [publicNavigation, landing]);
  const roomAction = (event: MouseEvent<HTMLAnchorElement>, action: 'create' | 'join') => {
    if (!onRoomAction || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.replaceState(window.history.state, '', action === 'create' ? '#create-room' : '#join-room');
    onRoomAction(action);
  };
  return (
    <header className={'site-header reference-nav' + (publicNavigation ? ' public-header' : ' entry-header') +
      (landing ? ' is-landing' : '') + ((!landing || scrolled) ? ' is-scrolled' : '')}>
      <button type="button" className="brand" onClick={onHome} aria-label="WarpView home">
        <span>warpview</span>
      </button>
      {publicNavigation && <>
        <nav className="reference-nav-links" aria-label="Main navigation">
          <a href={architecture ? '/#instructions' : '#instructions'}>Instructions</a>
          <a href={architecture ? '/#how-it-works' : '#how-it-works'}>How it works</a>
          <a href="/architecture" aria-current={architecture ? 'page' : undefined}>Architecture</a>
        </nav>
        <div className="reference-nav-actions">
          <a className="header-join" href={architecture ? '/#join-room' : '#join-room'}
            onClick={event => roomAction(event, 'join')}>Join a room</a>
          <a className="header-create" href={architecture ? '/#create-room' : '#create-room'}
            onClick={event => roomAction(event, 'create')}>Create a room</a>
        </div>
      </>}
    </header>
  );
}
