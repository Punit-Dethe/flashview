import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PresentationTransition } from './PresentationTransition';
import './styles.css';
import './styles.refined.css';
import './styles.immersive.css';
import './styles.premium.css';
import './styles.reference-v8.css';
const Presenter = lazy(() => import('./Presenter').then(module => ({ default: module.Presenter })));

createRoot(document.getElementById('root')!).render(
  window.location.pathname === '/present'
    ? <PresentationTransition><Suspense fallback={null}><Presenter/></Suspense></PresentationTransition>
    : <React.StrictMode><App/></React.StrictMode>,
);
