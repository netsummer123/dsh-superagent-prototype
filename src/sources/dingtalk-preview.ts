/** Appends a bounded in-chat preview of the local documents an outbound DingTalk message names by path. */
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'

/** Document extensions whose text is shown in the chat; any other path stays only a path. */
const DOCUMENT = /\.(?:md|markdown|txt)$/i
/** The largest file read for a preview, so an unrelated log or binary a reply names is left alone. */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** UTF-8 bytes a message's previews may add, keeping the whole message well inside DingTalk's 20 KB Markdown limit. */
const PREVIEW_BYTES = 12_000
/** Documents previewed from one message, so a reply naming many files does not flood the conversation. */
const MAX_DOCUMENTS = 3
/** One inline code span, the usual place for a path that contains spaces. */
const CODE_SPAN = /`([^`\n]+)`/g
/** A Windows path or file URL that ends in a document extension, not part of a URL's host or scheme. */
const WINDOWS_PATH = /(?<![:\w])[A-Za-z]:[\\/][^\s`"'<>|?*\n]+\.(?:md|markdown|txt)\b/gi
/** A POSIX path that ends in a document extension and does not start inside a URL or another path. */
const POSIX_PATH = /(?<![:\w/])\/(?:[^\s`"'<>|?*\n]+\/)*[^\s`"'<>|?*\n]+\.(?:md|markdown|txt)\b/g

/**
 * Finds the absolute local document paths a Markdown message names. Inline code spans come first because they keep a
 * path with spaces whole; a path is returned once, however often the message names it.
 */
export function documentPaths(text: string): string[] {
  const paths: string[] = []
  const add = (candidate: string): void => {
    const path = candidate.trim()
    if (path && isAbsolute(path) && DOCUMENT.test(path) && !paths.includes(path)) paths.push(path)
  }
  for (const span of text.matchAll(CODE_SPAN)) add(span[1]!)
  for (const pattern of [WINDOWS_PATH, POSIX_PATH]) for (const match of text.matchAll(pattern)) add(match[0])
  return paths.slice(0, MAX_DOCUMENTS)
}
/** Reads one referenced document, or nothing when the path is not a readable file of a supported document type. */
async function readDocument(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size <= MAX_FILE_BYTES ? await readFile(path, 'utf8') : undefined
  } catch { return undefined }
}
/** Cuts text to at most `maxBytes` UTF-8 bytes, preferring the last line break in its second half, and reports the cut. */
function cutBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  let bytes = 0
  let end = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes) {
      const line = text.lastIndexOf('\n', Math.max(0, end - 1))
      return { text: text.slice(0, line > end / 2 ? line : end).trimEnd(), cut: true }
    }
    bytes += size
    end += character.length
  }
  return { text, cut: false }
}
/** Builds one document's preview under `budget` bytes, or nothing when the document has no text to show. */
function previewBlock(path: string, content: string, chinese: boolean, budget: number): string | undefined {
  const body = content.replaceAll('\r\n', '\n').trim()
  if (!body) return undefined
  const { text, cut } = cutBytes(body, Math.max(200, budget - 300))
  const name = basename(path)
  const header = chinese ? `**文档预览：${name}**` : `**Document preview: ${name}**`
  const note = !cut ? '' : chinese ? `_（预览已截断，全文 ${[...body].length} 字）_` : `_(Preview truncated: the document has ${[...body].length} characters.)_`
  return [header, '', text, ...(note ? ['', note] : [])].join('\n')
}
/**
 * Appends a preview of each local document a DingTalk message names by path, so the conversation shows the document
 * itself rather than only a path its reader cannot open on another device. The message keeps its own text first;
 * previews share one byte budget; an unreadable file is skipped and never fails the reply.
 */
export async function withDocumentPreview(text: string): Promise<string> {
  let remaining = PREVIEW_BYTES - Buffer.byteLength(text)
  if (remaining < 500) return text
  // Chinese when the text has Han characters and no kana, the rule the PR notices also use.
  const chinese = /\p{Script=Han}/u.test(text) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
  const blocks: string[] = []
  for (const path of documentPaths(text)) {
    const block = previewBlock(path, await readDocument(path) ?? '', chinese, remaining)
    if (!block) continue
    blocks.push(block)
    remaining -= Buffer.byteLength(block) + 8
    if (remaining < 500) break
  }
  return blocks.length ? `${text}\n\n---\n\n${blocks.join('\n\n---\n\n')}` : text
}
