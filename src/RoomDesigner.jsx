import React, { useRef, useState } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

export default function RoomDesigner() {
  const containerRef = useRef(null)
  const [editor, setEditor] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [resultUrl, setResultUrl] = useState('')
  const [imgbbUrl, setImgbbUrl] = useState('')
  const [status, setStatus] = useState('')
  const [prompt, setPrompt] = useState(
    `I am uploading a 2D floor plan of a living room. Please interpret the blueprint carefully and generate a photo-realistic 3D render of the space as if I were standing inside it in real life. Follow these rules exactly:

Perspective & Camera Angles

- Provide the render from eye-level:
- A wide-angle view from the red arrow that shows as much of the room as possible.

Layout & Interpretation

- Use the blueprint as the absolute guide for wall placement, doors, and windows.
- Make sure to include all shown and labelled furniture.
- Position and all furniture exactly where it is indicated in the plan.
- Distances between furniture and features must match the layout provided.
- Windows are marked by white sections in the walls. Always place windows on their appropriate walls.
- If the blueprint contains built-ins (fireplace, shelving, cabinets), render them realistically in their correct location.

Scale & Proportions

- Ceiling height: assume 9 feet unless otherwise noted.
- Standard doors: 80 inches tall.
- Standard windows: sill 30–36 inches above the floor, total height 48–60 inches unless otherwise noted. Width must match the layout provided.
- Maintain correct proportions based on the blueprint dimensions.

Materials & Surfaces (default if not specified)

- Flooring: light oak hardwood.
- Walls: matte white paint.
- Ceiling: flat white plaster with simple trim.
- Baseboards: 6-inch white trim.
- Doors: smooth white or wood finish.
- Windows: clear glass with white frames.

Furniture & Decor (if shown)

- Seating: sofas, sectionals, or armchairs in neutral fabric tones (light gray, beige, white).
- Tables: wood or glass with simple modern lines.
- Rugs: neutral tones sized appropriately under main seating areas.
- Storage: media consoles, sideboards, or shelving units if marked.
- Dining sets (if included): wood or wood/metal hybrid, scaled to the blueprint.
- Lighting: ceiling fixtures, recessed lights, and floor/side lamps as indicated.
- Wall features: render fireplaces, accent walls, or niches if marked.
- Décor: minimal and realistic (plants, framed art, vases) — only where shown in the blueprint.

Lighting & Atmosphere

- Natural daylight entering from windows, balanced with warm interior lights (3000K).
- Soft shadows, realistic reflections, and natural contrast.
- No harsh artificial over-lighting.

Style Direction

- Contemporary minimalism with clean lines, uncluttered layout, and neutral color palette.

Output Rules

- Always output high-resolution, photo-realistic 3D renders.
- Never display the 2D floor plan in the renders.
- Do not invent extra walls, windows, or furniture not present in the blueprint.
- If walls are missing from the plan, fill it with logical, neutral defaults.
- Do not include labels in the output`
  )

  async function handleGenerate() {
    if (!editor) return
    try {
      setGenerating(true)
      setStatus('Capturing layout...')

      const ids = Array.from(editor.getCurrentPageShapeIds())
      // When the canvas is empty, exportToSvg returns undefined; guard it.
      if (ids.length === 0) {
        throw new Error('Draw something first before generating.')
      }

      const { url: dataUrl } = await editor.toImageDataUrl(ids, {
        format: 'png',
        pixelRatio: 2,
        background: 'white',
        padding: 32,
      })
      setStatus('Uploading to imgbb and sending to model...')

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Include the prompt so the server will forward the prompt+image to Gemini
        body: JSON.stringify({ imageDataUrl: dataUrl, prompt }),
      })
      const raw = await res.text().catch(() => '')
      let json = null
      try {
        json = raw ? JSON.parse(raw) : null
      } catch (e) {
        // Non‑JSON response (likely server not running / proxy error)
      }

      if (!res.ok) {
        const msg = json?.error || `${res.status} ${res.statusText}${raw ? ` — ${raw.slice(0,200)}` : ''}`
        throw new Error(`Server error: ${msg}`)
      }

      if (json?.imgbb?.url_viewer || json?.imgbb?.display_url || json?.imgbb?.url) {
        const link = json.imgbb.url_viewer || json.imgbb.display_url || json.imgbb.url
        setImgbbUrl(link)
      } else {
        setImgbbUrl('')
      }

      // If the server returned a model result, prefer displaying the generated image
      if (json?.model) {
        if (json.model.image) {
          // Server returned a data URL from Gemini — show that
          setResultUrl(json.model.image)
          setStatus('Generated by model')
        } else if (json.model.text) {
          setResultUrl('')
          setStatus(`Model response: ${json.model.text}`)
        } else if (json.model.error) {
          setResultUrl('')
          setStatus(`Model error: ${json.model.error}`)
        } else {
          setStatus('Uploaded (no model output)')
        }
      } else {
        // Fallback: show uploaded image if available
        if (json?.imgbb?.display_url || json?.imgbb?.url) {
          setResultUrl(json.imgbb.display_url || json.imgbb.url)
          setStatus('Uploaded')
        } else {
          setStatus('Uploaded (no image)')
        }
      }
    } catch (err) {
      console.error('Generate failed:', err)
      setStatus(String(err?.message || err))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="designer-root">
      <div className="designer-bar">
        <div className="title">Blueprint Designer</div>
        <div className="grow" />
        <input
          className="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the room you want..."
        />
        <button className="primary" disabled={generating} onClick={handleGenerate}>
          {generating ? 'Generating...' : 'Generate Room'}
        </button>
      </div>
      <div className="designer-main">
        <div className="canvas" ref={containerRef}>
          <Tldraw autoFocus persistenceKey="blueprints-tldraw" onMount={setEditor} />
        </div>
        <div className="result">
          {resultUrl ? (
            <img src={resultUrl} alt="Generated room" />
          ) : (
            <div className="placeholder">Generated image will appear here</div>
          )}
          {imgbbUrl && (
            <div className="status">
              Uploaded to <a href={imgbbUrl} target="_blank" rel="noreferrer">imgbb</a>
            </div>
          )}
          {status && <div className="status">{status}</div>}
        </div>
      </div>
    </div>
  )
}


