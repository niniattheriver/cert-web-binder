// CLI: 문항 PDF → ParseResult JSON (stdout)
// 사용법: npm run parse:pdf -w server -- <pdf경로>

import path from 'node:path';
import { extractPdfPages } from './extract.js';
import { parseQuestionPdf } from './question-parser/index.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('사용법: parse:pdf <문항PDF 경로>\n');
    process.exit(2);
  }
  const file = path.resolve(arg);
  const pages = await extractPdfPages(file);
  const result = parseQuestionPdf(pages);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((err: unknown) => {
  const e = err as { name?: string; message?: string };
  process.stderr.write(`[parse:pdf 실패] ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}\n`);
  process.exit(1);
});
