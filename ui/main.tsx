import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './conn';
import { startTheme } from './theme';
import './theme.css';
import './layout.css';
import './sidebar/sidebar.css';
import './controls/controls.css';
import './activity.css';

startTheme();
createRoot(document.getElementById('root')!).render(<App />);
connect();
