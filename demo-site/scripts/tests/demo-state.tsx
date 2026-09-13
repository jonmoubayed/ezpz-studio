import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server.edge'
import { StudioProvider, useStudio } from '../../src/studio-preview/store'

export function initialState() {
  let snapshot
  function Probe() {
    const studio = useStudio()
    snapshot = { mode: studio.mode, connection: studio.connection, documents: studio.documents.length, datasets: studio.datasets.length }
    return null
  }
  renderToStaticMarkup(<StudioProvider><Probe /></StudioProvider>)
  return snapshot
}
