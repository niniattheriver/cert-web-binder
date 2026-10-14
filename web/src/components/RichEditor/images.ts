/**
 * 자유형식 문서의 그림 규칙: 이 앱에 올린 첨부(/api/attachments/<sha256>)만 그림으로 둔다.
 * 서버(richdocs/service.ts RICH_IMAGE_SRC_RE)도 같은 규칙으로 저장을 거절한다. 바깥 주소 그림이 문서에 들어오면 문서를
 * 열 때마다 브라우저가 그 주소로 요청을 보내고(인터넷 없는 내부망 전제와 어긋난다), 백업을 옮긴 뒤에는 그림이 사라진다.
 * 편집기(RichEditor)와 읽기 전용 페인(RichDocPane)이 함께 쓴다.
 */
import Image from '@tiptap/extension-image';
import type { JSONContent } from '@tiptap/react';

const INTERNAL_SRC_RE = /^\/api\/attachments\/[0-9a-f]{64}$/;

export function isInternalImageSrc(src: unknown): boolean {
  return typeof src === 'string' && INTERNAL_SRC_RE.test(src);
}

/** 그림 확장: HTML 을 붙여 넣거나 끌어 놓을 때 <img> 는 이 앱의 첨부만 그림으로 받고 나머지는 버린다 */
export const InternalImage = Image.extend({
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (el) => (isInternalImageSrc((el as HTMLElement).getAttribute('src')) ? null : false),
      },
    ];
  },
});

/** 붙여 넣는 HTML 가운데 버려질 바깥 주소 그림 수 (안내용. DOMParser 문서는 그림을 내려받지 않는다) */
export function countExternalImagesInHtml(html: string): number {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('img')).filter((img) => !isInternalImageSrc(img.getAttribute('src'))).length;
}

/** 글줄을 담는 노드: 그 안의 그림은 빼기만 한다(문단을 넣을 수 없다) */
const TEXT_BLOCKS = new Set(['paragraph', 'heading']);

/**
 * 예전에 저장된 문서에서 바깥 주소 그림을 뺀다. 그림이 블록 자리에 있으면 빈 문단으로 바꿔 표 칸 같은 틀이 비지 않게
 * 한다. 뺀 수를 함께 돌려준다: 화면이 알리고, 편집기에서 저장하면 그 자리는 빠진다.
 */
export function withoutExternalImages(doc: JSONContent): { doc: JSONContent; removed: number } {
  let removed = 0;
  const walk = (n: JSONContent): JSONContent => {
    if (!n.content) return n;
    const inText = TEXT_BLOCKS.has(n.type ?? '');
    const content: JSONContent[] = [];
    for (const c of n.content) {
      if (c.type === 'image' && !isInternalImageSrc(c.attrs?.src)) {
        removed += 1;
        if (!inText) content.push({ type: 'paragraph' });
        continue;
      }
      content.push(walk(c));
    }
    return { ...n, content };
  };
  const out = walk(doc);
  return { doc: removed > 0 ? out : doc, removed };
}

/** 바깥 주소 그림을 뺐을 때의 안내 */
export function externalImagesNote(n: number, editable: boolean): string {
  return editable
    ? `바깥 주소의 그림 ${n}개는 표시하지 않았습니다. 이 문서를 저장하면 그 자리는 빠집니다. 필요하면 그림 파일을 내려받아 끌어다 놓아 주세요.`
    : `바깥 주소의 그림 ${n}개는 표시하지 않았습니다.`;
}
