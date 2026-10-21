import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';

export function SiteHeader({ landing, onHome, publicNavigation = false, architecture = false,
  onRoomAction }: { landing: boolean; onHome: () => void; publicNavigation?: boolean;
  architecture?: boolean; onRoomAction?: (action: 'create' | 'join') => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileNavigation, setMobileNavigation] = useState(() => window.matchMedia('(max-width: 940px)').matches);
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!publicNavigation) return;
    const mobile = window.matchMedia('(max-width: 940px)');
    const update = () => { setMobileNavigation(mobile.matches); setMenuOpen(false); };
    update();
    mobile.addEventListener('change', update);
    return () => mobile.removeEventListener('change', update);
  }, [publicNavigation]);
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);
  const roomAction = (event: MouseEvent<HTMLAnchorElement>, action: 'create' | 'join') => {
    if (!onRoomAction || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.replaceState(window.history.state, '', action === 'create' ? '#create-room' : '#join-room');
    onRoomAction(action);
  };
  return (
    <header ref={headerRef} className={'site-header reference-nav' + (publicNavigation ? ' public-header' : ' entry-header') +
      (landing ? ' is-landing' : '') + (menuOpen ? ' is-menu-open' : '')}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false); }}>
      <button type="button" className="brand" onClick={() => { setMenuOpen(false); onHome(); }} aria-label="WarpView home">
        <span>warpview</span>
      </button>
      {publicNavigation && <>
        <button ref={menuButtonRef} type="button" className="reference-menu-toggle"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} aria-controls={menuId}
          onClick={() => setMenuOpen(open => !open)}>
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            {menuOpen ? <path d="m6 6 12 12M6 18 18 6" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
          </svg>
        </button>
        <nav id={menuId} className="reference-nav-links" aria-label="Main navigation"
          inert={mobileNavigation && !menuOpen} aria-hidden={mobileNavigation && !menuOpen ? true : undefined} onClick={() => {
          if (!menuOpen) return;
          setMenuOpen(false);
          menuButtonRef.current?.focus({ preventScroll: true });
        }}>
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
