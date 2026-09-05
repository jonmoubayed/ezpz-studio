import React, { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import WorkbenchPreview from './workbench-preview'
import readme from '../../../README.md?raw'
import playgroundImage from '../../../docs/images/playground.png'
import './landing.css'

const repositoryUrl = (import.meta.env.VITE_REPOSITORY_URL || 'https://github.com/jonmoubayed/ezpz-studio').replace(/\/$/, '')
const guideUrl = repositoryUrl ? `${repositoryUrl}#quick-start` : undefined
const studioUrl = '/studio/index.html#Overview'

export default function LandingPage() {
  const readmeRef = useRef(null)
  const projectLink = (label, href, arrow = false) => href
    ? <a className="lp-link" href={href}>{label}{arrow && <ArrowUpRight size={17} aria-hidden="true" />}</a>
    : <button className="lp-link" type="button" onClick={() => readmeRef.current.showModal()}>{label}{arrow && <ArrowUpRight size={17} aria-hidden="true" />}</button>
  return <div className="lp-page">
    <div className="lp-container">
      <a className="lp-skip" href="#workflow">Skip to studio preview</a>
      <header className="lp-header">
        <a className="lp-brand" href="/" aria-label="ezpz studio home">
          <img src="/assets/brand/field-mark.png" width="36" height="36" alt="" />
          <span><strong>ezpz</strong> studio</span>
        </a>
        {projectLink(repositoryUrl ? 'GitHub' : 'Project README', repositoryUrl, true)}
      </header>
      <main className="lp-main">
        <div className="lp-copy">
          <h1>Document extraction,<br />locally.</h1>
          <p className="lp-description">An open-source workspace for extracting data from documents, comparing models, and reviewing results.</p>
          <a className="lp-link lp-open" href={studioUrl}>Open demo <ArrowRight size={18} aria-hidden="true" /></a>
          <section className="lp-setup" id="get-started" aria-label="Run locally">
            <p>Run the frontend from a local checkout:</p>
            <pre><code>{'pnpm install\npnpm dev'}</code></pre>
            <div className="lp-guide">{projectLink("Setup and model configuration", guideUrl, true)}</div>
          </section>
        </div>
        <WorkbenchPreview />
      </main>
      <footer className="lp-footer" id="open-source">
        {projectLink(repositoryUrl ? "Source code" : "Project README", repositoryUrl)}
        <p>Contributions welcome.</p>
      </footer>
    </div>
    <dialog className="lp-readme" ref={readmeRef} aria-labelledby="lp-readme-title">
      <div className="lp-readme-header"><h2 id="lp-readme-title">Project README</h2><form method="dialog"><button type="submit">Close</button></form></div>
      <div className="lp-readme-content">
        <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
          a: ({ href, children }) => {
            // Local-server setup URLs are documentation, not runnable demo actions.
            const external = /^https:\/\//.test(href || '') && !/https:\/\/(?:localhost|127\.0\.0\.1)(?=[:/]|$)/.test(href)
            return external ? <a href={href}>{children}</a> : <span>{children}</span>
          },
          img: ({ alt }) => <img src={playgroundImage} alt={alt} />,
        }}>{readme}</ReactMarkdown>
      </div>
    </dialog>
  </div>
}
