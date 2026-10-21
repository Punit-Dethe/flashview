import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { PresentationTransition } from './PresentationTransition';
import './styles.css';
import './styles.refined.css';
import './styles.immersive.css';
import './styles.premium.css';
import './styles.reference-v8.css';
const Presenter = lazy(() => import('./Presenter').then(module => ({ default: module.Presenter })));
const Architecture = lazy(() => import('./Architecture'));
const App = lazy(() => import('./App').then(module => ({ default: module.App })));

createRoot(document.getElementById('root')!).render(
  window.location.pathname === '/present'
    ? <PresentationTransition><Suspense fallback={null}><Presenter/></Suspense></PresentationTransition>
    : window.location.pathname === '/architecture'
      ? <Suspense fallback={<div className="simple-state" role="status">Opening architecture…</div>}><Architecture/></Suspense>
    : <React.StrictMode><Suspense fallback={null}><App/></Suspense></React.StrictMode>,
);
