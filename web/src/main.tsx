import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth';
import './styles.css';

// StrictMode 미사용: react-pdf-highlighter-extended가 pdf.js 페이지 DOM에 명령형으로
// 하이라이트 레이어를 부착하는데, StrictMode의 이중 마운트가 레이어를 중복 생성함
// (하이라이트가 두 겹으로 렌더). 프로덕션 동작에는 영향 없음.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </BrowserRouter>,
);
