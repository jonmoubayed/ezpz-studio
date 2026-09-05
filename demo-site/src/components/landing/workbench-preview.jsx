import React, { useEffect, useRef, useState } from 'react'

const previewWidth = 1440
const previewHeight = 1165

export default function WorkbenchPreview() {
  const frameRef = useRef(null)
  const [scale, setScale] = useState(0)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / previewWidth))
    observer.observe(frameRef.current)
    return () => observer.disconnect()
  }, [])

  return <figure className="lp-preview" id="workflow">
    <div className="lp-preview-frame" ref={frameRef}>
      {scale > 0 && <iframe
        src="/studio/index.html#Overview"
        title="ezpz studio interactive workspace preview"
        width={previewWidth}
        height={previewHeight}
        style={{ transform: `scale(${scale})` }}
      />}
    </div>
    <figcaption>Workspace overview · Sample data</figcaption>
  </figure>
}
