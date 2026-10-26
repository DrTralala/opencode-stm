export const TITLE_MAX_CODE_POINTS = 120
const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u

export type TitleValidation = { ok: true; value: string } | { ok: false; reason: string }

export function validateTitle(raw: string): TitleValidation {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: "title-empty" }
  if ([...value].length > TITLE_MAX_CODE_POINTS) return { ok: false, reason: "title-too-long" }
  if (CONTROL_CHARACTERS.test(value)) return { ok: false, reason: "title-control-characters" }
  return { ok: true, value }
}
