import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import './styles.presentation-transition.css';

const PreviewReady = createContext<() => void>(() => {});
export const usePreviewReady = () => useContext(PreviewReady);

/** Stays mounted across the route, renderer import, cache read and first paint. */
export function PresentationTransition({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const reveal = useCallback(() => setReady(true), []);
  return <PreviewReady.Provider value={reveal}>
    <div className="presentation-shell">
      {children}
      <div className={'presentation-transition' + (ready ? ' is-revealed' : '')}
        aria-hidden={ready}>
        <div className="presentation-transition-brand" role="status" aria-label="Opening preview">
          <span aria-hidden="true">warpview</span>
          <span className="presentation-transition-spinner" aria-hidden="true"/>
        </div>
        <button className="presentation-transition-close" type="button" tabIndex={ready ? -1 : 0}
          onClick={() => { window.close(); setTimeout(() => location.replace('/'), 0); }}>Close</button>
      </div>
    </div>
  </PreviewReady.Provider>;
}
