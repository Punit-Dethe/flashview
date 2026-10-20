import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './styles.refined.css';
import './styles.immersive.css';
import './styles.premium.css';
import './styles.reference-v8.css';
const Presenter = lazy(() => import('./Presenter').then(module => ({ default: module.Presenter })));

createRoot(document.getElementById('root')!).render(
  window.location.pathname === '/present'
    ? <Suspense fallback={<div role="status">Opening presentation…</div>}><Presenter/></Suspense>
    : <React.StrictMode><App/></React.StrictMode>,
);
