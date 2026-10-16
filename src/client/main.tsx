import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Presenter } from './Presenter';
import './styles.css';
import './styles.refined.css';

createRoot(document.getElementById('root')!).render(
  window.location.pathname === '/present' ? <Presenter/> : <React.StrictMode><App/></React.StrictMode>,
);
