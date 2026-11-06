import './styles/theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { answerPings } from './chrome/chromeSource';
import { registerPanel, surface } from './chrome/dock';

// Only the standalone window answers the worker's "is the view alive?" ping: a docked panel
// answering it would make a blank standalone window look alive.
if (surface === 'window') answerPings();
else registerPanel();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
