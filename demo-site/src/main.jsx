import './demo/install-network'
import React from 'react'
import { createRoot } from 'react-dom/client'
import LandingPage from './components/landing/landing-page'
import './landing-base.css'

// Every hash on the public site remains on the landing page. The original
// API-backed workbench is intentionally not part of this static build.
createRoot(document.getElementById('root')).render(<LandingPage />)
