/** Decorative file-sharing symbols; the forms remain the only hero controls. */
export function HeroAccents() {
  return (
    <div className="hero-accents" aria-hidden="true">
      <div className="hero-accent hero-accent-speed">
        <svg viewBox="0 0 144 128" fill="none" focusable="false">
          <path d="M8 44h22M2 60h24M12 76h18" stroke="#fff" strokeWidth="5" strokeLinecap="round"/>
          <path d="M55 18h51l18 18v74H55z" fill="#ccddff"/>
          <path d="M41 9h51l18 18v74H41z" fill="#fff"/>
          <path d="M92 9v18h18" fill="#b9d0ff"/>
          <path d="M55 47h36M55 63h24M55 79h30" stroke="#172442" strokeWidth="5" strokeLinecap="round"/>
          <path d="m117 58-20 29h16l-9 26 30-38h-18z" fill="#ffdc8a" stroke="#253a71" strokeWidth="2" strokeLinejoin="round"/>
        </svg>
      </div>
      <div className="hero-accent hero-accent-account">
        <svg viewBox="0 0 128 128" fill="none" focusable="false">
          <rect x="16" y="12" width="96" height="104" rx="18" fill="#fff"/>
          <path d="M30 29h15" stroke="#b9d0ff" strokeWidth="5" strokeLinecap="round"/>
          <circle cx="64" cy="53" r="12" stroke="#172442" strokeWidth="5"/>
          <path d="M40 89c0-13 10-22 24-22s24 9 24 22" stroke="#172442" strokeWidth="5" strokeLinecap="round"/>
          <path d="m35 98 61-60" stroke="#fff" strokeWidth="13" strokeLinecap="round"/>
          <path d="m35 98 61-60" stroke="#2c5bda" strokeWidth="6" strokeLinecap="round"/>
        </svg>
      </div>
    </div>
  );
}
