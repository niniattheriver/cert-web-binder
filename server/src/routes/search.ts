/**
 * 통합 검색 라우트 (설계서 §4 옴니박스, API 계약)
 * - GET /api/search?q=
 *   1) 번호 패스트패스: 50.210.420·50210420·210.420·210420 모두 해석,
 *      완전일치 → 없으면 뒤 6자리(그룹2+3) suffix 일치, "유일할 때만" fastpath.
 *   2) FTS trigram(3자 이상) / 3자 미만은 question 테이블 LIKE 폴백. ≤20건.
 *   3) docs 그룹: 문서 제목/코드 LIKE — {id,title,year(현재 판본)}.
 *   4) passages 그룹: 발췌 인용문 FTS(kind='passage', 3자 미만은 content LIKE 폴백)
 *      — {passageId, quote(스니펫), docTitle, questionNos}.
 *   5) pages 그룹: 지침서 PDF 본문 FTS(kind='page_text', 현재 판본만, 3자 미만은 content LIKE 폴백)
 *      — {documentId, versionId, docTitle, pageNo, year, snippet}.
 * 활성 주기·미삭제 문항/문서/발췌만 대상.
 */
import type Database from 'better-sqlite3';
import { Router } from 'express';
import { parseQuestionNoQuery } from '../domain/question-no.js';
import { requireAuth } from '../middleware/auth.js';
import { getActiveCycle } from './questions.js';

interface FastpathRow {
  id: number;
  question_no: string;
}

interface SearchQuestionRow {
  id: number;
  question_no: string;
  category_id: number;
  category_code: string;
  snippet: string;
}

const LIMIT = 20;
const GROUP_LIMIT = 10; // docs·passages 그룹별 상한
const SNIPPET_RADIUS = 40;

/** LIKE 패턴 이스케이프 (%·_·\) */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** LIKE 폴백용 스니펫: 첫 일치 주변을 잘라 반환 */
function makeSnippet(body: string, q: string): string {
  const idx = body.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return body.slice(0, SNIPPET_RADIUS * 2) + (body.length > SNIPPET_RADIUS * 2 ? '…' : '');
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(body.length, idx + q.length + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}

export function createSearchRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/', requireAuth(db), (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const empty = { fastpath: null, questions: [], docs: [], passages: [], pages: [] };
    if (q.length === 0) {
      res.json(empty);
      return;
    }
    const cycle = getActiveCycle(db);
    if (!cycle) {
      res.json(empty);
      return;
    }

    // 1) 번호 패스트패스
    let fastpath: { questionId: number; questionNo: string } | null = null;
    const noQuery = parseQuestionNoQuery(q);
    if (noQuery) {
      const base = `SELECT q.id, q.question_no
                    FROM question q
                    JOIN category c ON c.id = q.category_id AND c.deleted_at IS NULL
                    WHERE c.cycle_id = ? AND q.deleted_at IS NULL AND `;
      let rows: FastpathRow[] =
        noQuery.kind === 'full'
          ? (db.prepare(base + 'q.question_no = ? LIMIT 2').all(cycle.id, noQuery.canonical) as FastpathRow[])
          : [];
      if (rows.length === 0) {
        // 완전일치 실패(또는 suffix 입력) → 뒤 6자리 suffix 일치
        const suffix =
          noQuery.kind === 'full' ? noQuery.canonical.slice(3) : noQuery.canonical;
        rows = db
          .prepare(base + 'substr(q.question_no, 4) = ? LIMIT 2')
          .all(cycle.id, suffix) as FastpathRow[];
      }
      if (rows.length === 1) {
        fastpath = { questionId: rows[0]!.id, questionNo: rows[0]!.question_no };
      }
    }

    // 2) 문항 본문 검색: trigram FTS(3자 이상) / LIKE 폴백(3자 미만)
    let questions: SearchQuestionRow[];
    if (q.length >= 3) {
      // 구문 인용(FTS 연산자 무력화) + content 컬럼 한정(kind 값과의 trigram 오매치 방지)
      const match = 'content:"' + q.replaceAll('"', '""') + '"';
      questions = db
        .prepare(
          `SELECT q.id, q.question_no, q.category_id, c.code AS category_code,
                  snippet(fts, 2, '', '', '…', 12) AS snippet
           FROM fts
           JOIN question q ON q.id = fts.ref_id
           JOIN category c ON c.id = q.category_id AND c.deleted_at IS NULL
           WHERE fts.kind = 'question' AND fts MATCH ?
             AND q.deleted_at IS NULL AND c.cycle_id = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(match, cycle.id, LIMIT) as SearchQuestionRow[];
    } else {
      const like = `%${escapeLike(q)}%`;
      const rows = db
        .prepare(
          `SELECT q.id, q.question_no, q.category_id, c.code AS category_code, q.body
           FROM question q
           JOIN category c ON c.id = q.category_id AND c.deleted_at IS NULL
           WHERE c.cycle_id = ? AND q.deleted_at IS NULL
             AND (q.question_no LIKE ? ESCAPE '\\' OR q.body LIKE ? ESCAPE '\\'
                  OR COALESCE(q.answer_plain,'') LIKE ? ESCAPE '\\'
                  OR COALESCE(q.findings_text,'') LIKE ? ESCAPE '\\')
           ORDER BY q.question_no
           LIMIT ?`,
        )
        .all(cycle.id, like, like, like, like, LIMIT) as (SearchQuestionRow & { body: string })[];
      questions = rows.map((r) => ({
        id: r.id,
        question_no: r.question_no,
        category_id: r.category_id,
        category_code: r.category_code,
        snippet: makeSnippet(r.body, q),
      }));
    }

    // 3) docs 그룹: 문서 제목/코드 LIKE (미삭제) — year는 현재 판본의 연도 태그
    const likeQ = `%${escapeLike(q)}%`;
    const docs = db
      .prepare(
        `SELECT d.id, d.title, dv.year AS year FROM document d
         LEFT JOIN document_version dv ON dv.document_id = d.id AND dv.is_current = 1
         WHERE d.deleted_at IS NULL
           AND (d.title LIKE ? ESCAPE '\\' OR COALESCE(d.code,'') LIKE ? ESCAPE '\\')
         ORDER BY d.title LIMIT ?`,
      )
      .all(likeQ, likeQ, GROUP_LIMIT) as { id: number; title: string; year: number | null }[];

    // 4) passages 그룹: 발췌 인용문 FTS(kind='passage') / 3자 미만은 content LIKE 폴백
    interface PassageHitRow {
      passage_id: number;
      snippet: string;
      doc_title: string;
      question_nos: string | null;
    }
    const questionNosSub = `(SELECT GROUP_CONCAT(q2.question_no, ',')
                             FROM question_passage qp
                             JOIN question q2 ON q2.id = qp.question_id AND q2.deleted_at IS NULL
                             WHERE qp.passage_id = p.id)`;
    let passageHits: PassageHitRow[];
    if (q.length >= 3) {
      const match = 'content:"' + q.replaceAll('"', '""') + '"'; // content 한정 — kind 오매치 방지
      passageHits = db
        .prepare(
          `SELECT p.id AS passage_id, snippet(fts, 2, '', '', '…', 12) AS snippet,
                  d.title AS doc_title, ${questionNosSub} AS question_nos
           FROM fts
           JOIN passage p ON p.id = fts.ref_id AND p.deleted_at IS NULL
           JOIN document d ON d.id = p.document_id AND d.deleted_at IS NULL
           WHERE fts.kind = 'passage' AND fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(match, GROUP_LIMIT) as PassageHitRow[];
    } else {
      const rows = db
        .prepare(
          `SELECT p.id AS passage_id, fts.content AS content,
                  d.title AS doc_title, ${questionNosSub} AS question_nos
           FROM fts
           JOIN passage p ON p.id = fts.ref_id AND p.deleted_at IS NULL
           JOIN document d ON d.id = p.document_id AND d.deleted_at IS NULL
           WHERE fts.kind = 'passage' AND fts.content LIKE ? ESCAPE '\\'
           LIMIT ?`,
        )
        .all(likeQ, GROUP_LIMIT) as (Omit<PassageHitRow, 'snippet'> & { content: string })[];
      passageHits = rows.map((r) => ({
        passage_id: r.passage_id,
        snippet: makeSnippet(r.content, q),
        doc_title: r.doc_title,
        question_nos: r.question_nos,
      }));
    }

    // 5) pages 그룹: 지침서 PDF 본문 FTS(kind='page_text', 현재 판본만) / 3자 미만은 content LIKE 폴백
    interface PageHitRow {
      document_id: number;
      version_id: number;
      doc_title: string;
      page_no: number;
      year: number | null;
      snippet: string;
    }
    let pageHits: PageHitRow[];
    if (q.length >= 3) {
      const match = 'content:"' + q.replaceAll('"', '""') + '"'; // content 한정 — kind 오매치 방지
      pageHits = db
        .prepare(
          `SELECT dv.document_id AS document_id, pt.document_version_id AS version_id,
                  d.title AS doc_title, pt.page_no AS page_no, dv.year AS year,
                  snippet(fts, 2, '', '', '…', 16) AS snippet
           FROM fts
           JOIN page_text pt ON pt.rowid = fts.ref_id
           JOIN document_version dv ON dv.id = pt.document_version_id AND dv.is_current = 1
           JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
           WHERE fts.kind = 'page_text' AND fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(match, GROUP_LIMIT) as PageHitRow[];
    } else {
      const rows = db
        .prepare(
          `SELECT dv.document_id AS document_id, pt.document_version_id AS version_id,
                  d.title AS doc_title, pt.page_no AS page_no, dv.year AS year, fts.content AS content
           FROM fts
           JOIN page_text pt ON pt.rowid = fts.ref_id
           JOIN document_version dv ON dv.id = pt.document_version_id AND dv.is_current = 1
           JOIN document d ON d.id = dv.document_id AND d.deleted_at IS NULL
           WHERE fts.kind = 'page_text' AND fts.content LIKE ? ESCAPE '\\'
           LIMIT ?`,
        )
        .all(likeQ, GROUP_LIMIT) as (Omit<PageHitRow, 'snippet'> & { content: string })[];
      pageHits = rows.map((r) => ({
        document_id: r.document_id,
        version_id: r.version_id,
        doc_title: r.doc_title,
        page_no: r.page_no,
        year: r.year,
        snippet: makeSnippet(r.content, q),
      }));
    }

    res.json({
      fastpath,
      questions: questions.map((r) => ({
        id: r.id,
        questionNo: r.question_no,
        categoryId: r.category_id,
        categoryCode: r.category_code,
        snippet: r.snippet,
      })),
      docs,
      passages: passageHits.map((r) => ({
        passageId: r.passage_id,
        quote: r.snippet,
        docTitle: r.doc_title,
        questionNos: r.question_nos ? r.question_nos.split(',') : [],
      })),
      pages: pageHits.map((r) => ({
        documentId: r.document_id,
        versionId: r.version_id,
        docTitle: r.doc_title,
        pageNo: r.page_no,
        year: r.year,
        snippet: r.snippet.replace(/\n/g, ' '),
      })),
    });
  });

  return router;
}
