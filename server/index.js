/* Simple Express API that accepts a TLDraw screenshot (data URL)
 * and forwards it to Gemini ("nano banana") to generate a room image.
 */
const path = require('path')
// Load .env from project root explicitly so it works regardless of CWD
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') })
const express = require('express')
const cors = require('cors')
const { GoogleGenAI } = require('@google/genai')
// Node 18+ has global fetch & FormData

const PORT = process.env.PORT || 8787
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || ''
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || process.env.VITE_IMGBB_API_KEY || ''

// Minimal fetch polyfill for Node < 18
const doFetch = (...args) =>
  (global.fetch ? global.fetch(...args) : import('node-fetch').then((m) => m.default(...args)))

const app = express()
// Allow CORS in development; in production the frontend is served from the same origin.
if (process.env.NODE_ENV !== 'production') {
  app.use(cors())
}
// Increase body limit to accommodate larger PNG data URLs
app.use(express.json({ limit: '50mb' }))

// Helper: upload base64 image to imgbb and return structured data
async function uploadToImgbb(base64, name) {
  if (!IMGBB_API_KEY) {
    return null
  }
  const approxBytes = Math.floor(base64.length * 0.75)
  if (approxBytes > 32 * 1024 * 1024) {
    const err = new Error('Image exceeds imgbb 32MB limit. Try lowering export resolution.')
    err.status = 413
    throw err
  }
  const endpoint = `https://api.imgbb.com/1/upload?key=${encodeURIComponent(IMGBB_API_KEY)}`
  const form = new URLSearchParams()
  form.append('image', base64)
  form.append('name', name || `blueprint_${Date.now()}`)
  const uploadRes = await doFetch(endpoint, { method: 'POST', body: form })
  const text = await uploadRes.text()
  let uploadJson
  try { uploadJson = text ? JSON.parse(text) : null } catch { uploadJson = null }
  if (!uploadRes.ok || !uploadJson?.success) {
    const e = new Error(uploadJson?.error?.message || `${uploadRes.status} ${uploadRes.statusText} ${text?.slice(0,200)}`)
    e.status = 502
    throw e
  }
  const d = uploadJson.data
  return {
    id: d?.id,
    url: d?.url,
    display_url: d?.display_url,
    url_viewer: d?.url_viewer,
    delete_url: d?.delete_url,
    width: d?.width,
    height: d?.height,
    size: d?.size,
  }
}

// Helper: call Gemini model with inline image data and prompt, returns { image, text }
async function callGemini(base64, mimeType = 'image/png', prompt) {
  if (!GEMINI_API_KEY) {
    const e = new Error('Missing GEMINI_API_KEY in environment.')
    e.status = 500
    throw e
  }
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  const model = 'gemini-2.5-flash-image-preview'
  const defaultPrompt =
    'Generate a photorealistic interior room render that follows the layout in the attached 2D floor plan sketch. Respect furniture placement and overall spatial arrangement. Return a single best image.'

  const contents = [
    {
      role: 'user',
      parts: [
        { text: (prompt && typeof prompt === 'string' ? prompt : defaultPrompt) },
        { inlineData: { mimeType, data: base64 } },
      ],
    },
  ]
  const config = { responseModalities: ['IMAGE', 'TEXT'] }
  const result = await ai.models.generateContent({ model, config, contents })
  const candidates = result?.response?.candidates || result?.candidates || []
  const parts = candidates?.[0]?.content?.parts || []
  let imagePart = parts.find((p) => p?.inlineData)
  let textParts = parts.filter((p) => p?.text).map((p) => p.text)
  if (!imagePart && candidates?.[0]?.content?.parts) {
    for (const part of candidates[0].content.parts) {
      if (part?.inlineData) {
        imagePart = part
        break
      }
    }
  }
  if (imagePart?.inlineData) {
    const { data, mimeType: outMime } = imagePart.inlineData
    const outType = outMime || 'image/png'
    const dataUrl = `data:${outType};base64,${data}`
    return { image: dataUrl, text: textParts?.join('\n') || '' }
  }
  return { text: textParts?.join('\n') || 'No image returned by model.' }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, hasGemini: !!GEMINI_API_KEY, hasImgbb: !!IMGBB_API_KEY })
})

// Simple route that only uploads the provided data URL image to imgbb
app.post('/api/upload', async (req, res) => {
  try {
    const { imageDataUrl, name, expiration, prompt } = req.body || {}
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
      return res.status(400).json({ error: 'imageDataUrl is required' })
    }
    const commaIdx = imageDataUrl.indexOf(',')
    const mimeMatch = imageDataUrl.match(/^data:(.*?);base64,/)
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png'
    const base64 = commaIdx >= 0 ? imageDataUrl.slice(commaIdx + 1) : imageDataUrl

    // Upload to imgbb if configured
    let imgbb = null
    try {
      imgbb = await uploadToImgbb(base64, name)
    } catch (e) {
      if (e.status === 413) return res.status(413).json({ error: e.message })
      console.error('[api/upload] imgbb upload failed:', e)
      // continue without imgbb if imgbb isn't critical
      imgbb = null
    }

    // If a prompt was provided and GEMINI is configured, call the model with inline image
    let modelResult = null
    if (prompt || GEMINI_API_KEY) {
      try {
        modelResult = await callGemini(base64, mimeType, prompt)
      } catch (e) {
        console.error('[api/upload] gemini call failed:', e)
        modelResult = { error: String(e?.message || e) }
      }
    }

    return res.json({ imgbb, model: modelResult })
  } catch (err) {
    console.error('Error in /api/upload:', err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

app.post('/api/generate', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Missing GEMINI_API_KEY in environment.' })
    }
    const { imageDataUrl, prompt } = req.body || {}
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
      return res.status(400).json({ error: 'imageDataUrl is required' })
    }
    const commaIdx = imageDataUrl.indexOf(',')
    const mimeMatch = imageDataUrl.match(/^data:(.*?);base64,/)
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png'
    const base64 = commaIdx >= 0 ? imageDataUrl.slice(commaIdx + 1) : imageDataUrl

    // 1) Upload to imgbb (if configured) before calling Gemini
    let imgbb = null
    if (!IMGBB_API_KEY) {
      console.warn('[imgbb] Missing IMGBB_API_KEY; skipping upload.')
    } else {
      try {
        // Verify size under imgbb's 32MB limit
        const approxBytes = Math.floor(base64.length * 0.75)
        if (approxBytes > 32 * 1024 * 1024) {
          return res.status(413).json({ error: 'Image exceeds imgbb 32MB limit. Try lowering export resolution.' })
        }

        const endpoint = `https://api.imgbb.com/1/upload?key=${encodeURIComponent(IMGBB_API_KEY)}`
        const form = new URLSearchParams()
        form.append('image', base64)
        form.append('name', `blueprint_${Date.now()}`)
        const uploadRes = await doFetch(endpoint, { method: 'POST', body: form })
        const text = await uploadRes.text()
        let uploadJson
        try { uploadJson = text ? JSON.parse(text) : null } catch { uploadJson = null }
        if (!uploadRes.ok || !uploadJson?.success) {
          throw new Error(uploadJson?.error?.message || `${uploadRes.status} ${uploadRes.statusText} ${text?.slice(0,200)}`)
        }
        imgbb = {
          id: uploadJson.data?.id,
          url: uploadJson.data?.url,
          display_url: uploadJson.data?.display_url,
          url_viewer: uploadJson.data?.url_viewer,
          delete_url: uploadJson.data?.delete_url,
          width: uploadJson.data?.width,
          height: uploadJson.data?.height,
          size: uploadJson.data?.size,
        }
      } catch (e) {
        console.error('[imgbb] upload failed:', e?.message || e)
        return res.status(502).json({ error: `imgbb upload failed: ${e?.message || e}` })
      }
    }

    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY })
    const model = 'gemini-2.5-flash-image-preview'
    const defaultPrompt =
      'Generate a photorealistic interior room render that follows the layout in the attached 2D floor plan sketch. Respect furniture placement and overall spatial arrangement. Return a single best image.'

    const urlNote = imgbb?.display_url || imgbb?.url || imgbb?.url_viewer
    const contents = [
      {
        role: 'user',
        parts: [
          { text: (prompt && typeof prompt === 'string' ? prompt : defaultPrompt) + (urlNote ? `\nFloor plan image URL: ${urlNote}` : '') },
          // Keep inline data to ensure the model sees the image even if it cannot fetch external URLs.
          { inlineData: { mimeType, data: base64 } },
        ],
      },
    ]
    const config = { responseModalities: ['IMAGE', 'TEXT'] }

    const result = await ai.models.generateContent({ model, config, contents })

    // Try both shapes: result.response.candidates... and result.candidates...
    const candidates = result?.response?.candidates || result?.candidates || []
    const parts = candidates?.[0]?.content?.parts || []

    let imagePart = parts.find((p) => p?.inlineData)
    let textParts = parts.filter((p) => p?.text).map((p) => p.text)

    if (!imagePart && candidates?.[0]?.content?.parts) {
      // fallback search across nested parts
      for (const part of candidates[0].content.parts) {
        if (part?.inlineData) {
          imagePart = part
          break
        }
      }
    }

    if (imagePart?.inlineData) {
      const { data, mimeType: outMime } = imagePart.inlineData
      const outType = outMime || 'image/png'
      const dataUrl = `data:${outType};base64,${data}`
      return res.json({ image: dataUrl, text: textParts?.join('\n') || '', imgbb })
    }

    // If no image returned, return any text we got
    const text = textParts?.join('\n') || 'No image returned by model.'
    return res.json({ text, imgbb })
  } catch (err) {
    console.error('Error in /api/generate:', err)
    res.status(500).json({ error: String(err?.message || err) })
  }
})

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})

// Serve static built files when running in production (after `npm start` runs `npm run build`).
// This ensures the front-end and API are available from the same origin.
const expressStatic = require('express').static
const fs = require('fs')
const distPath = path.resolve(__dirname, '..', 'dist')
if (process.env.NODE_ENV === 'production' || fs.existsSync(distPath)) {
  console.log('[server] serving static files from', distPath)
  app.use(expressStatic(distPath))
  // For SPA fallback: serve index.html for unknown routes
  // Use a regex-based route to avoid path-to-regexp errors with literal '*'
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}
