import { describe, expect, it } from 'vitest'
import { clampZoom, constrainPan, fitZoom } from '../src/viewport.js'

describe('viewport limits', () => {
  for (const [value, expected] of [[0.049, 0.05], [0.05, 0.05], [0.051, 0.051], [3.999, 3.999], [4, 4], [4.001, 4]]) {
    it(`constrains zoom ${value} to ${expected}`, () => {
      expect(clampZoom(value)).toBe(expected)
    })
  }

  it('fits a wide image within its viewport', () => {
    expect(fitZoom({ width: 800, height: 600 }, { width: 2048, height: 1024 })).toBe(800 / 2048)
  })

  it('fits a tall image within its viewport', () => {
    expect(fitZoom({ width: 800, height: 600 }, { width: 1024, height: 2048 })).toBe(600 / 2048)
  })

  it('keeps small embedded previews at their natural size', () => {
    expect(fitZoom({ width: 800, height: 600 }, { width: 300, height: 200 })).toBe(1)
  })

  it('centers an image smaller than the viewport', () => {
    expect(constrainPan({ x: 300, y: -300 }, { width: 800, height: 600 }, { width: 300, height: 200 }, 1)).toEqual({ x: 0, y: 0 })
  })

  for (const [requested, expected] of [[-201, -200], [-200, -200], [-199, -199], [199, 199], [200, 200], [201, 200]]) {
    it(`keeps pan ${requested} within the image edge at ${expected}`, () => {
      expect(constrainPan({ x: requested, y: requested }, { width: 800, height: 800 }, { width: 1200, height: 1200 }, 1)).toEqual({ x: expected, y: expected })
    })
  }
})
