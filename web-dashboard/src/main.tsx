import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './portal.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (root === null) throw new TypeError('Dashboard root element is missing.');
createRoot(root).render(<StrictMode><App /></StrictMode>);
