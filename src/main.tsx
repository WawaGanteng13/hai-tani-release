import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Same-origin /api requests carry the tani_sid session cookie.
const __origFetch = window.fetch.bind(window);
window.fetch = ((input: any, init: any = {}) => {
  const url = typeof input === 'string' ? input : (input?.url ?? '');
  if (typeof url === 'string' && url.startsWith('/api')) {
    init = { ...init, credentials: 'same-origin' as RequestCredentials };
  }
  return __origFetch(input, init);
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
