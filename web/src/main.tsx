import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ClientProvider } from './lib/context';
import { MockClient } from './lib/mockClient';
import { App } from './App';
import './styles.css';

// Swap MockClient for the real GameClient implementation when the games are connected.
const client = new MockClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ClientProvider client={client}>
        <App />
      </ClientProvider>
    </BrowserRouter>
  </StrictMode>,
);
