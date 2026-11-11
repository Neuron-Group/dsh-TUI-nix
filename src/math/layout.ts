/**
 * Terminal-cell geometry for a typeset formula. Pure: no rasterization.
 *
 * MathJax reports a formula's size in ex. A formula starts at one base scale
 * tied to the terminal's text size (so every formula reads at the same size,
 * like text), shrinks uniformly only when it would exceed the width or height
 * it may occupy, and is never enlarged. The canvas is padded, never stretched,
 * to a whole number of cells.
 */
import type { TerminalCellSize } from '../ink/terminal-image.js'

/**
 * A terminal cell reports the font's advance width, not just the line box:
 * it is the one metric that follows the text size when a user changes the
 * terminal's line spacing. Programming fonts advance by about 0.6em.
 */
export const MONOSPACE_ADVANCE_EM = 0.6
/** TeX math fonts' x-height — the unit MathJax measures ex in — is ~0.43em. */
export const TEX_X_HEIGHT_EM = 0.43
/**
 * Pixels per ex at the base scale. Cell height would include the terminal's
 * configurable leading, which is why sizing from it made formulas read larger
 * than the body text.
 */
export const BASE_EX_TO_CELL_WIDTH = TEX_X_HEIGHT_EM / MONOSPACE_ADVANCE_EM
/**
 * The display-size steps (settings `mathImageScale`) multiply the base scale:
 * Large and Extra large set display math bigger than the body text, which
 * hands the terminal more device pixels per stroke — the only sharpness lever
 * a terminal image has. They keep the ratios the old cell-height-based
 * constants had (1.44x and 1.8x the text size). Inline formulas keep the base
 * scale — their single row of cells clamps the resolution anyway.
 */
export const LARGE_DISPLAY_SCALE = 1.44
/** The next step up: about 80% more pixels than the base scale. */
export const XLARGE_DISPLAY_SCALE = 1.8
/**
 * A fraction-bearing inline formula lifts its whole text line to two rows.
 * MathJax sets a stacked fraction's numerator and denominator at script size,
 * so the image gets this lift across those two rows; deeper nesting is
 * still scaled back so it does not take a third row.
 */
export const INLINE_FRACTION_SCALE = 1.5
/** Simple \frac/\tfrac (no \dfrac, no nesting) gets a smaller lift. */
export const SIMPLE_INLINE_FRACTION_SCALE = 1.25
/**
 * Below this fraction of the base scale the formula is unreadable as an
 * image; the caller keeps the Unicode rendering instead of shrinking further.
 */
export const MIN_SCALE_FRACTION = 0.5
/** Terminal-font descent, in em; the visual baseline sits above it. */
const MONOSPACE_DESCENT_EM = 0.25

/**
 * Whether TeX contains a fraction-like construct. Inline fraction images get
 * a small one-row lift; matrices, sums and other tall formulas do not.
 */
const FRACTION_COMMAND = /\\(?:[dtc]?frac|binom|dbinom|tbinom|genfrac|over|atop|above|choose)(?![A-Za-z])/
const COMPLEX_FRACTION = /\\(?:dfrac|cfrac|genfrac|over|atop|above|choose)(?![A-Za-z])/
const SIMPLE_FRACTION = /\\(?:t?frac|binom|dbinom|tbinom)(?![A-Za-z])/g

export function hasFraction(tex: string): boolean {
  return FRACTION_COMMAND.test(tex)
}

/** The next TeX argument: a balanced group, a control word, or one character. */
function readArgument(tex: string, start: number): { value: string; next: number } | undefined {
  let index = start
  while (index < tex.length && /\s/u.test(tex[index]!)) index++
  if (index >= tex.length) return undefined
  if (tex[index] === '{') {
    let depth = 0
    for (let end = index; end < tex.length; end++) {
      const char = tex[end]
      if (char === '\\') { end++; continue }
      if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        return { value: tex.slice(index + 1, end), next: end + 1 }
      }
    }
    return undefined
  }
  if (tex[index] === '\\') {
    const command = /^\\(?:[A-Za-z]+|.)/u.exec(tex.slice(index))
    return command === null ? undefined : { value: command[0], next: index + command[0].length }
  }
  const code = tex.codePointAt(index)
  const length = code !== undefined && code > 0xffff ? 2 : 1
  return { value: tex.slice(index, index + length), next: index + length }
}

/**
 * Whether an inline fraction needs the larger lift: an explicit display-style
 * fraction, another fraction command, or a fraction nested in a fraction
 * argument. Separate fractions in one formula (`\frac{a}{b}+\frac{c}{d}`)
 * stay simple.
 */
export function hasComplexFraction(tex: string): boolean {
  if (COMPLEX_FRACTION.test(tex)) return true
  SIMPLE_FRACTION.lastIndex = 0
  for (let match = SIMPLE_FRACTION.exec(tex); match !== null; match = SIMPLE_FRACTION.exec(tex)) {
    const numerator = readArgument(tex, SIMPLE_FRACTION.lastIndex)
    if (numerator === undefined) continue
    const denominator = readArgument(tex, numerator.next)
    if (denominator === undefined) continue
    if (hasFraction(numerator.value) || hasFraction(denominator.value)) return true
  }
  return false
}

/**
 * The body text's baseline inside one cell, in device-independent pixels.
 * Inline formula images pass this so they stand on the prose's line instead
 * of floating at the cell's vertical centre. The estimate follows the same
 * font metrics as the base scale: an ~0.25em descent under a ~0.6em advance.
 */
export function textBaselineY(cellSize: TerminalCellSize): number {
  const descent = cellSize.width * (MONOSPACE_DESCENT_EM / MONOSPACE_ADVANCE_EM)
  return Math.max(1, Math.min(cellSize.height - 1, cellSize.height - descent))
}

export interface FormulaSize {
  readonly widthEx: number
  readonly heightEx: number
  /** MathJax's baseline offset from the box bottom, in ex (negative). */
  readonly verticalAlignEx?: number
}

export interface FormulaConstraints {
  readonly cellSize: TerminalCellSize
  /** Multiplier on the text-size base scale; display settings pass 1.44/1.8. */
  readonly scale?: number
  readonly maxColumns: number
  readonly maxRows: number
  /**
   * Smallest cell box the formula takes even when its ink would fit fewer
   * rows (an inline fraction lifts its whole text line to two rows).
   */
  readonly minRows?: number
  /** Transparent margin around the ink, in device-independent pixels. */
  readonly bleed: number
  /**
   * Formula baseline distance from the canvas top, in device-independent
   * pixels. Inline formulas pass the body text's baseline so the image sits on
   * the same line as the prose; when absent the ink is centered.
   */
  readonly baseline?: number
  /**
   * Baseline distance from the canvas bottom, in device-independent pixels.
   * Inline formulas anchor to the bottom row's text baseline so a lifted
   * two-row line still shares one baseline.
   */
  readonly baselineFromBottom?: number
  /**
   * Smallest fraction of the text scale that still renders; defaults to
   * {@link MIN_SCALE_FRACTION}. Inline formulas pass 0 so a deeply nested
   * fraction stays an image and is scaled down inside its reserved rows.
   */
  readonly minScaleFraction?: number
  /** Largest canvas edge and RGBA byte size the raster may use. */
  readonly maxEdge: number
  readonly maxBytes: number
}

export interface FormulaLayoutPlan {
  readonly columns: number
  readonly rows: number
  /** Canvas size in device pixels (cells × cell size × deviceScale). */
  readonly canvasWidth: number
  readonly canvasHeight: number
  /** Ink box size in device pixels. */
  readonly contentWidth: number
  readonly contentHeight: number
  /** Top-left corner of the ink box in the device-pixel canvas. */
  readonly contentLeft: number
  readonly contentTop: number
  readonly pixelsPerEx: number
  readonly deviceScale: 1 | 2
}

export type FormulaLayoutFailure = 'invalid-dimensions' | 'too-small' | 'raster-limit'

export function planFormulaLayout(
  size: FormulaSize,
  constraints: FormulaConstraints,
): FormulaLayoutPlan | FormulaLayoutFailure {
  const { cellSize, maxColumns, maxRows, bleed } = constraints
  const scale = constraints.scale ?? 1
  const minScaleFraction = constraints.minScaleFraction ?? MIN_SCALE_FRACTION
  if (
    !(size.widthEx > 0) || !(size.heightEx > 0) ||
    !Number.isFinite(size.widthEx) || !Number.isFinite(size.heightEx) ||
    !Number.isFinite(scale) || scale <= 0 ||
    !Number.isFinite(minScaleFraction) || minScaleFraction < 0 ||
    (constraints.baseline !== undefined && (!Number.isFinite(constraints.baseline) || constraints.baseline < 0)) ||
    (constraints.baselineFromBottom !== undefined &&
      (!Number.isFinite(constraints.baselineFromBottom) || constraints.baselineFromBottom < 0)) ||
    (constraints.minRows !== undefined && (!Number.isInteger(constraints.minRows) || constraints.minRows < 1)) ||
    maxColumns < 1 || maxRows < 1
  ) {
    return 'invalid-dimensions'
  }
  const textPixelsPerEx = cellSize.width * BASE_EX_TO_CELL_WIDTH
  const basePixelsPerEx = textPixelsPerEx * scale
  const availableWidth = maxColumns * cellSize.width - bleed * 2
  const availableHeight = maxRows * cellSize.height - bleed * 2
  if (availableWidth <= 0 || availableHeight <= 0) return 'too-small'
  const pixelsPerEx = Math.min(
    basePixelsPerEx,
    availableWidth / size.widthEx,
    availableHeight / size.heightEx,
  )
  // Legibility is absolute, not relative to what the caller asked for: the
  // floor stays on the text-size scale so a larger display request shrinks
  // back to a readable size instead of flipping formulas to the Unicode
  // fallback.
  if (pixelsPerEx < textPixelsPerEx * minScaleFraction) return 'too-small'

  const contentWidth = size.widthEx * pixelsPerEx
  const contentHeight = size.heightEx * pixelsPerEx
  const columns = Math.min(maxColumns, Math.ceil((contentWidth + bleed * 2) / cellSize.width))
  const rows = Math.min(maxRows, Math.max(
    constraints.minRows ?? 1,
    Math.ceil((contentHeight + bleed * 2) / cellSize.height),
  ))
  const fits = (deviceScale: number): boolean => {
    const width = columns * cellSize.width * deviceScale
    const height = rows * cellSize.height * deviceScale
    return width <= constraints.maxEdge && height <= constraints.maxEdge &&
      width * height * 4 <= constraints.maxBytes
  }
  const deviceScale = fits(2) ? 2 : fits(1) ? 1 : undefined
  if (deviceScale === undefined) return 'raster-limit'
  const canvasWidth = columns * cellSize.width * deviceScale
  const canvasHeight = rows * cellSize.height * deviceScale
  const scaledWidth = contentWidth * deviceScale
  const scaledHeight = contentHeight * deviceScale
  const contentLeft = (canvasWidth - scaledWidth) / 2
  // A baseline-anchored image (inline math) sits on the prose's line; the
  // remaining space goes above it. Keep a transparent margin at the bottom:
  // an image clamped flush to the edge would be rejected by the rasterizer's
  // edge check and then retried at a larger bleed, which shrinks it instead.
  const margin = bleed * deviceScale
  const maxTop = Math.max(0, canvasHeight - scaledHeight - margin)
  const ascent = (size.heightEx + (size.verticalAlignEx ?? 0)) * pixelsPerEx * deviceScale
  const contentTop = constraints.baselineFromBottom !== undefined
    ? Math.max(0, Math.min(maxTop, canvasHeight - constraints.baselineFromBottom * deviceScale - ascent))
    : constraints.baseline === undefined
      ? (canvasHeight - scaledHeight) / 2
      : Math.max(0, Math.min(maxTop, constraints.baseline * deviceScale - ascent))
  return {
    columns,
    rows,
    canvasWidth,
    canvasHeight,
    contentWidth: scaledWidth,
    contentHeight: scaledHeight,
    contentLeft,
    contentTop,
    pixelsPerEx: pixelsPerEx * deviceScale,
    deviceScale,
  }
}
