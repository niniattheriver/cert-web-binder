import { Navigate, Route, Routes } from 'react-router-dom';
import { RequireAuth } from './auth';
import AppShell from './components/AppShell';
import CategoryList from './pages/CategoryList';
import Dashboard from './pages/Dashboard';
import DocCompare from './pages/DocCompare';
import DocLibrary from './pages/DocLibrary';
import Guide from './pages/Guide';
import Home from './pages/Home';
import Users from './pages/Users';
import AdminOps from './pages/AdminOps';
import DocViewer from './pages/DocViewer';
import ImportPage from './pages/Import';
import Login from './pages/Login';
import OrgInfo from './pages/OrgInfo';
import Print from './pages/Print';
import QuestionDetail from './pages/QuestionDetail';
import Review from './pages/Review';
import RichEditor from './pages/RichEditor';
import Summary from './pages/Summary';

/**
 * 라우트 구성 (설계서 §4 — Day 1~3 + v1.5 Phase 1 네비 5메뉴)
 *  /login    로그인 (공개)
 *  /         연도별 홈 (연도 리스트) ┐
 *  /y/:year  연도별 대시보드        │
 *  /c/:id    문항 목록            │
 *  /q/:id    문항 상세            │
 *  /summary  결과 요약            │ 로그인 필수 (RequireAuth) + AppShell
 *  /docs     지침서 라이브러리    │
 *  /docs/:id 문서 뷰어            │
 *  /org      기관 정보            │
 *  /review   검수 큐              │
 *  /import   문항 PDF 가져오기    ┘
 *  /print/:categoryId  인쇄 뷰 (로그인 필수 · AppShell 없이 단독 렌더)
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        {/* 인쇄 뷰: 네비게이션 크롬 없이 종이 레이아웃만 (설계서 §6.4) */}
        <Route path="/print/:categoryId" element={<Print />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/y/:year" element={<Dashboard />} />
          <Route path="/c/:id" element={<CategoryList />} />
          <Route path="/q/:id" element={<QuestionDetail />} />
          <Route path="/rich/:id" element={<RichEditor />} />
          <Route path="/summary" element={<Summary />} />
          <Route path="/docs" element={<DocLibrary />} />
          <Route path="/docs/:id" element={<DocViewer />} />
          <Route path="/docs/:id/compare" element={<DocCompare />} />
          <Route path="/org" element={<OrgInfo />} />
          <Route path="/review" element={<Review />} />
          <Route path="/users" element={<Users />} />
          <Route path="/admin" element={<AdminOps />} />
          <Route path="/guide" element={<Guide />} />
          <Route path="/import" element={<ImportPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
