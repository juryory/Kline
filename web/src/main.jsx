import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import RenderPage from './RenderPage.jsx';
import ControlPage from './ControlPage.jsx';

// 只有两个页面，直接按 pathname 分发
function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/render') return <RenderPage preview={new URLSearchParams(location.search).has('preview')} />;
  return <ControlPage />;
}

document.body.style.margin = '0';
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
