/**
 * Read image files (from paste, drop, or a file picker) into bounded data URLs
 * we can show as thumbnails and ship to vision models. Large images are
 * downscaled so a pasted screenshot doesn't bloat the request / DB.
 */

/** An image staged in the composer before it's sent. */
export interface ComposerImage {
  id: string
  /** Data URL (data:image/...;base64,...). */
  dataUrl: string
  /** MIME type, e.g. 'image/png'. */
  mediaType: string
  /** Original (or synthesized) file name. */
  name: string
}

/** Longest-edge cap — keeps screenshots legible while bounding payload size. */
const MAX_DIM = 1568

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image.'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode image.'))
    img.src = src
  })
}

/**
 * Turn an image File/Blob into a ComposerImage, downscaling if either edge
 * exceeds MAX_DIM. PNGs stay PNG (crisp text/transparency); other types are
 * re-encoded as JPEG when downscaled to keep them small.
 */
export async function readImageFile(file: File): Promise<ComposerImage | null> {
  if (!file.type.startsWith('image/')) return null
  const original = await readAsDataUrl(file)
  const name = file.name || `pasted-${Date.now()}.${file.type.split('/')[1] || 'png'}`

  try {
    const img = await loadImage(original)
    const longest = Math.max(img.naturalWidth, img.naturalHeight)
    if (longest <= MAX_DIM) {
      return { id: crypto.randomUUID(), dataUrl: original, mediaType: file.type, name }
    }
    const scale = MAX_DIM / longest
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return { id: crypto.randomUUID(), dataUrl: original, mediaType: file.type, name }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const isPng = file.type === 'image/png'
    const mediaType = isPng ? 'image/png' : 'image/jpeg'
    const dataUrl = canvas.toDataURL(mediaType, isPng ? undefined : 0.9)
    return { id: crypto.randomUUID(), dataUrl, mediaType, name }
  } catch {
    // Decoding/canvas failed — fall back to the original bytes.
    return { id: crypto.randomUUID(), dataUrl: original, mediaType: file.type, name }
  }
}

/** Pull image files out of a paste or drop event's items/files. */
export function imageFilesFrom(
  source: DataTransfer | DataTransferItemList | FileList | null
): File[] {
  if (!source) return []
  const files: File[] = []
  if ('files' in source && source.files) {
    for (const f of Array.from(source.files)) if (f.type.startsWith('image/')) files.push(f)
  }
  if (files.length === 0 && 'length' in source && !('files' in source)) {
    for (const item of Array.from(source as DataTransferItemList)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
  }
  return files
}
