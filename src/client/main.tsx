import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

// Modern Web Guidance (switch): Load polyfill ONLY when native <input type="checkbox" switch> is missing
if (!('switch' in HTMLInputElement.prototype)) {
  void import('input-switch-polyfill');
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
