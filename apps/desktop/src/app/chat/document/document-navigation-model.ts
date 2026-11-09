import { markdownLanguage } from '@codemirror/lang-markdown'

export function documentOutline(text: string): { from: number; title: string; level: number }[] {
  const headings: { from: number; title: string; level: number }[] = []
  markdownLanguage.parser.parse(text).iterate({
    enter(node) {
      const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)

      if (match) {
        headings.push({
          from: node.from,
          title: text.slice(node.from, node.to).replace(/^#{1,6}\s+|\n[=-]+$/g, ''),
          level: Number(match[1])
        })
      }
    }
  })

  return headings
}

export function documentWordCount(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)).filter(
    word => word.isWordLike
  ).length
}

