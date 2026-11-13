import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import { capText, redact } from './policy.js'

type ImageRef = Extract<ToolResult['content'][number], { type: 'image' }>['attachment']
type ScreenshotValue = string | { text: string, image: ImageRef }
export interface ScreenshotStore {
  saveImage(input: { data: Uint8Array, mediaType: 'image/png', name: string }): Promise<ImageRef>
}

// This is the Native/model projection, not presentResult's UI-only content.
// The reference is issued by DSH's authoritative decode/normalization service,
// exactly as in the host read_image tool; paths/base64 never stand in for images.
export const SCREENSHOT_OUTPUT = {
  schema: { oneOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: false, properties: {
      text: { type: 'string', required: true },
      image: { type: 'json', required: true },
    } },
  ] },
  render: (_args: unknown, value: ScreenshotValue): ToolResult['content'] => typeof value === 'string'
    ? [{ type: 'text', text: value }]
    : [{ type: 'text', text: value.text }, { type: 'image', attachment: value.image }],
} as const

export async function attachScreenshot(result: string, store?: ScreenshotStore): Promise<ScreenshotValue> {
  if (!result.startsWith('screenshot: ')) return result
  const path = result.slice('screenshot: '.length)
  if (!store) return `${result}\nImage not attached: no DSH attachments service is mounted. Use read_image on the saved path when available.`
  try {
    const image = await store.saveImage({ data: await readFile(path), mediaType: 'image/png', name: basename(path) })
    const original = image.originalDimensions
    const dimensions = original ? ` Normalized from ${original.width}x${original.height}; map image coordinates back to that size first.` : ''
    return { text: `${result}\nAttached image: ${image.width}x${image.height}.${dimensions}`, image }
  } catch (error) {
    return `${result}\nImage not attached: ${capText(redact(error instanceof Error ? error.message : String(error)), 500)}. The saved path remains available for read_image.`
  }
}
